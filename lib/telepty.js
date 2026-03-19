/**
 * Telepty/Bus domain — envelope building, bus subscription, session health,
 * pending turn request tracking, and process locator utilities.
 *
 * Extracted from index.js to keep the main entry point focused on MCP tool
 * registration while this module owns the Telepty wire protocol.
 */

import { z } from "zod";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import WebSocket from "ws";

// ── Dependency injection ────────────────────────────────────────
// Functions that live in index.js but are needed here.  Injected once
// via `initTeleptyDeps()` so we avoid circular imports.

let _deps = {
  appendRuntimeLog: () => {},
  normalizeSpeaker: (v) => v,
  getProjectSlug: () => "unknown",
  // Only needed by dispatchTeleptyTurnRequest:
  resolveTransportForSpeaker: () => ({ transport: "manual", reason: "not_initialized" }),
  generateTurnId: () => `t-${Date.now().toString(36)}`,
  buildClipboardTurnPrompt: () => "",
};

export function initTeleptyDeps(deps) {
  Object.assign(_deps, deps);
}

// ── Constants ───────────────────────────────────────────────────

const HOME = os.homedir();
export const TELEPTY_CONFIG_FILE = path.join(HOME, ".telepty", "config.json");
export const TELEPTY_DEFAULT_HOST = process.env.TELEPTY_HOST || "127.0.0.1";
export const TELEPTY_PORT = Number(process.env.TELEPTY_PORT || 3848);
export const TELEPTY_TRANSPORT_TIMEOUT_MS = 5_000;
export const TELEPTY_SEMANTIC_TIMEOUT_MS = 60_000;
export const TELEPTY_BUS_RECONNECT_MS = 5_000;
export const TELEPTY_SESSION_HEALTH_STALE_MS = 25_000;

// ── Zod schemas ─────────────────────────────────────────────────

export const StructuredActionableTaskSchema = z.object({
  id: z.number(),
  task: z.string(),
  files: z.array(z.string()).optional(),
  project: z.string().optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
});

export const StructuredExperimentOutcomeSchema = z.object({
  verdict: z.enum(["keep", "discard", "modify"]),
  confidence: z.number().min(0).max(1).optional(),
  measurement_window_hours: z.number().nonnegative().optional(),
  patches: z.array(z.unknown()).optional(),
  suggested_action: z.enum(["advance", "revert", "iterate"]).optional(),
});

export const StructuredSynthesisSchema = z.object({
  summary: z.string(),
  decisions: z.array(z.string()),
  actionable_tasks: z.array(StructuredActionableTaskSchema),
  experiment_outcome: StructuredExperimentOutcomeSchema.optional(),
});

export const StructuredExecutionContractSchema = z.object({
  schema_version: z.number().int().positive(),
  source_session_id: z.string().min(1),
  deliberation_id: z.string().min(1),
  summary: z.string(),
  decisions: z.array(z.string()),
  tasks: z.array(StructuredActionableTaskSchema),
  experiment_outcome: StructuredExperimentOutcomeSchema.nullable().optional(),
  unresolved_questions: z.array(z.string()),
  artifact_refs: z.array(z.string()),
  generated_from: z.object({
    structured_synthesis_hash: z.string().length(40),
  }),
});

export const TeleptyEnvelopeSchema = z.object({
  version: z.number().int().positive().optional(),
  message_id: z.string().min(1),
  session_id: z.string().min(1),
  project: z.string().min(1),
  kind: z.string().min(1),
  source: z.string().min(1),
  source_host: z.string().min(1).optional(),
  target: z.string().min(1),
  reply_to: z.string().nullable().optional(),
  trace: z.array(z.string()),
  payload: z.unknown(),
  ts: z.string().min(1),
});

export const TeleptyTurnRequestPayloadSchema = z.object({
  turn_id: z.string().min(1),
  round: z.number().int().positive(),
  max_rounds: z.number().int().positive(),
  speaker: z.string().min(1),
  role: z.string().nullable().optional(),
  prompt: z.string().min(1),
  content: z.string().min(1).describe("PTY-compatible alias for prompt field"),
  prompt_sha1: z.string().length(40),
  history_entries: z.number().int().nonnegative().optional(),
  transport_timeout_ms: z.number().int().positive(),
  semantic_timeout_ms: z.number().int().positive(),
});

export const TeleptyTurnCompletedPayloadSchema = z.object({
  turn_id: z.string().nullable().optional(),
  speaker: z.string().min(1),
  round: z.number().int().positive(),
  max_rounds: z.number().int().positive(),
  next_speaker: z.string().min(1),
  next_round: z.number().int().positive(),
  status: z.string().min(1),
  total_responses: z.number().int().nonnegative(),
  channel_used: z.string().nullable().optional(),
  fallback_reason: z.string().nullable().optional(),
  orchestrator_session_id: z.string().nullable().optional(),
});

export const TeleptyDeliberationCompletedPayloadSchema = z.object({
  topic: z.string(),
  synthesis: z.string(),
  structured_synthesis: StructuredSynthesisSchema.nullable().optional(),
  execution_contract: StructuredExecutionContractSchema.nullable().optional(),
});

export const TELEPTY_ENVELOPE_PAYLOAD_SCHEMAS = {
  turn_request: TeleptyTurnRequestPayloadSchema,
  turn_completed: TeleptyTurnCompletedPayloadSchema,
  deliberation_completed: TeleptyDeliberationCompletedPayloadSchema,
};

// ── Module-level state ──────────────────────────────────────────

export const teleptyBusState = {
  ws: null,
  status: "idle",
  connectPromise: null,
  reconnectTimer: null,
  lastError: null,
  lastConnectedAt: null,
  lastMessageAt: null,
  healthBySession: new Map(),
};

export const pendingTeleptyTurnRequests = new Map();

// ── Functions ───────────────────────────────────────────────────

export function hashPromptText(value) {
  return createHash("sha1").update(String(value || "")).digest("hex");
}

export function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortJsonValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

export function hashStructuredSynthesis(structured) {
  return hashPromptText(JSON.stringify(sortJsonValue(structured || null)));
}

/**
 * Build a deterministic execution contract from structured synthesis.
 *
 * Data model canonical roles:
 * - structured_synthesis: human + reasoning canonical — rich context for
 *   human review (decisions rationale, experiment outcomes, full task descriptions).
 * - execution_contract: automation canonical — minimal, deterministic task list
 *   derived from structured_synthesis via SHA-1 hash for provenance tracking.
 *   Consumers (inbox-watcher, devkit, registry, orchestrator) MUST prefer
 *   execution_contract when available; fall back to structured_synthesis only
 *   when execution_contract is absent.
 */
export function buildExecutionContract({ state, structured }) {
  if (!structured) return null;
  return {
    schema_version: 2,
    source_session_id: state.id,
    deliberation_id: state.id,
    summary: structured.summary || "",
    decisions: structured.decisions || [],
    tasks: structured.actionable_tasks || [],
    experiment_outcome: structured.experiment_outcome || null,
    unresolved_questions: [],
    artifact_refs: [],
    generated_from: {
      structured_synthesis_hash: hashStructuredSynthesis(structured),
    },
  };
}

export function createEnvelopeId(prefix = "env") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function validateTeleptyEnvelope(envelope) {
  const parsed = TeleptyEnvelopeSchema.parse(envelope);
  const payloadSchema = TELEPTY_ENVELOPE_PAYLOAD_SCHEMAS[parsed.kind];
  if (payloadSchema) {
    payloadSchema.parse(parsed.payload);
  }
  return parsed;
}

export function resolveTeleptySourceHost() {
  const explicit = process.env.TELEPTY_SOURCE_HOST;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  const hostname = os.hostname();
  return typeof hostname === "string" && hostname.trim() ? hostname.trim() : undefined;
}

export function buildTeleptyEnvelope({ session_id, project, kind, source, source_host = resolveTeleptySourceHost(), target, reply_to = null, trace = [], payload, ts = new Date().toISOString(), message_id = createEnvelopeId(kind) }) {
  return validateTeleptyEnvelope({
    version: 1,
    message_id,
    session_id,
    project,
    kind,
    source,
    source_host,
    target,
    reply_to,
    trace,
    payload,
    ts,
  });
}

export function buildTeleptyTurnRequestEnvelope({ state, speaker, turnId, turnPrompt, includeHistoryEntries = 0, profile }) {
  const role = (state.speaker_roles || {})[speaker] || null;
  const target = profile?.telepty_host && !["127.0.0.1", "localhost"].includes(profile.telepty_host)
    ? `${profile.telepty_session_id}@${profile.telepty_host}`
    : profile?.telepty_session_id || speaker;
  return buildTeleptyEnvelope({
    session_id: state.id,
    project: state.project || _deps.getProjectSlug(),
    kind: "turn_request",
    source: `deliberation:${state.id}`,
    target,
    reply_to: state.id,
    trace: [
      `project:${state.project || _deps.getProjectSlug()}`,
      `speaker:${speaker}`,
      `turn:${turnId}`,
    ],
    payload: {
      turn_id: turnId,
      round: state.current_round,
      max_rounds: state.max_rounds,
      speaker,
      role,
      prompt: turnPrompt,
      content: turnPrompt,
      prompt_sha1: hashPromptText(turnPrompt),
      history_entries: includeHistoryEntries,
      transport_timeout_ms: TELEPTY_TRANSPORT_TIMEOUT_MS,
      semantic_timeout_ms: TELEPTY_SEMANTIC_TIMEOUT_MS,
    },
  });
}

export function buildTeleptyTurnCompletedEnvelope({ state, entry }) {
  return buildTeleptyEnvelope({
    session_id: state.id,
    project: state.project || _deps.getProjectSlug(),
    kind: "turn_completed",
    source: `deliberation:${state.id}`,
    target: "telepty-bus",
    reply_to: state.orchestrator_session_id || state.id,
    trace: [
      `project:${state.project || _deps.getProjectSlug()}`,
      `speaker:${entry.speaker}`,
      `turn:${entry.turn_id || "none"}`,
    ],
    payload: {
      turn_id: entry.turn_id || null,
      speaker: entry.speaker,
      round: entry.round,
      max_rounds: state.max_rounds,
      next_speaker: state.current_speaker || "none",
      next_round: state.current_round,
      status: state.status,
      total_responses: Array.isArray(state.log) ? state.log.length : 0,
      channel_used: entry.channel_used || null,
      fallback_reason: entry.fallback_reason || null,
      orchestrator_session_id: state.orchestrator_session_id || null,
    },
  });
}

export function buildTeleptySynthesisEnvelope({ state, synthesis, structured, executionContract }) {
  const derivedExecutionContract =
    executionContract !== undefined
      ? executionContract
      : (structured ? buildExecutionContract({ state, structured }) : (state.execution_contract || null));
  return buildTeleptyEnvelope({
    session_id: state.id,
    project: state.project || _deps.getProjectSlug(),
    kind: "deliberation_completed",
    source: `deliberation:${state.id}`,
    target: "telepty-bus",
    reply_to: state.id,
    trace: [
      `project:${state.project || _deps.getProjectSlug()}`,
      "stage:synthesis",
    ],
    payload: {
      topic: state.topic,
      synthesis,
      structured_synthesis: structured || null,
      execution_contract: derivedExecutionContract || null,
    },
  });
}

export function resolveTeleptyBusUrl(host = TELEPTY_DEFAULT_HOST) {
  const url = new URL(`ws://${host}:${TELEPTY_PORT}/api/bus`);
  const token = loadTeleptyAuthToken();
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

export function cleanupPendingTeleptyTurn(messageId) {
  const entry = pendingTeleptyTurnRequests.get(messageId);
  if (!entry) return;
  if (entry.transportTimer) clearTimeout(entry.transportTimer);
  if (entry.semanticTimer) clearTimeout(entry.semanticTimer);
  pendingTeleptyTurnRequests.delete(messageId);
}

export function registerPendingTeleptyTurnRequest({ envelope, profile, speaker }) {
  const nowMs = Date.now();
  const entry = {
    message_id: envelope.message_id,
    deliberation_session_id: envelope.session_id,
    project: envelope.project,
    speaker,
    turn_id: envelope.payload.turn_id,
    target_session_id: profile?.telepty_session_id || speaker,
    target_host: profile?.telepty_host || TELEPTY_DEFAULT_HOST,
    prompt_sha1: envelope.payload.prompt_sha1,
    published_at: envelope.ts,
    transport_status: "pending",
    semantic_status: "pending",
    transport_deadline_at: new Date(nowMs + TELEPTY_TRANSPORT_TIMEOUT_MS).toISOString(),
    semantic_deadline_at: new Date(nowMs + TELEPTY_SEMANTIC_TIMEOUT_MS).toISOString(),
  };
  entry.transportPromise = new Promise(resolve => {
    entry.resolveTransport = resolve;
  });
  entry.semanticPromise = new Promise(resolve => {
    entry.resolveSemantic = resolve;
  });
  entry.transportTimer = setTimeout(() => {
    if (entry.transport_status !== "pending") return;
    entry.transport_status = "timeout";
    _deps.appendRuntimeLog("WARN", `TELEPTY_TRANSPORT_TIMEOUT: ${entry.deliberation_session_id} | speaker: ${entry.speaker} | target: ${entry.target_session_id}`);
    entry.resolveTransport?.({ ok: false, code: "transport_timeout" });
  }, TELEPTY_TRANSPORT_TIMEOUT_MS);
  entry.semanticTimer = setTimeout(() => {
    if (entry.semantic_status !== "pending") return;
    entry.semantic_status = "timeout";
    _deps.appendRuntimeLog("WARN", `TELEPTY_SEMANTIC_TIMEOUT: ${entry.deliberation_session_id} | speaker: ${entry.speaker} | target: ${entry.target_session_id}`);
    entry.resolveSemantic?.({ ok: false, code: "semantic_timeout" });
    setTimeout(() => cleanupPendingTeleptyTurn(entry.message_id), 5_000);
  }, TELEPTY_SEMANTIC_TIMEOUT_MS);
  pendingTeleptyTurnRequests.set(entry.message_id, entry);
  return entry;
}

export function ackPendingTeleptyTurn(event) {
  const promptHash = hashPromptText(event?.content || "");
  const targetSessionId = String(event?.target_agent || "");
  const candidate = [...pendingTeleptyTurnRequests.values()]
    .filter(entry =>
      entry.transport_status === "pending"
      && entry.target_session_id === targetSessionId
      && entry.prompt_sha1 === promptHash
    )
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  if (!candidate) return null;

  candidate.transport_status = "ack";
  candidate.inject_id = event.inject_id || null;
  candidate.transport_acked_at = new Date().toISOString();
  if (candidate.transportTimer) clearTimeout(candidate.transportTimer);
  candidate.resolveTransport?.({
    ok: true,
    code: "inject_written",
    inject_id: event.inject_id || null,
  });
  _deps.appendRuntimeLog("INFO", `TELEPTY_TRANSPORT_ACK: ${candidate.deliberation_session_id} | speaker: ${candidate.speaker} | target: ${candidate.target_session_id} | inject_id: ${event.inject_id || "n/a"}`);
  return candidate;
}

export function completePendingTeleptySemantic({ sessionId, speaker, turnId }) {
  const candidate = [...pendingTeleptyTurnRequests.values()]
    .filter(entry =>
      entry.semantic_status === "pending"
      && entry.deliberation_session_id === sessionId
      && _deps.normalizeSpeaker(entry.speaker) === _deps.normalizeSpeaker(speaker)
      && (!turnId || !entry.turn_id || entry.turn_id === turnId)
    )
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  if (!candidate) return null;

  candidate.semantic_status = "completed";
  candidate.semantic_completed_at = new Date().toISOString();
  if (candidate.semanticTimer) clearTimeout(candidate.semanticTimer);
  candidate.resolveSemantic?.({ ok: true, code: "responded" });
  _deps.appendRuntimeLog("INFO", `TELEPTY_SEMANTIC_COMPLETE: ${candidate.deliberation_session_id} | speaker: ${candidate.speaker} | target: ${candidate.target_session_id}`);
  setTimeout(() => cleanupPendingTeleptyTurn(candidate.message_id), 5_000);
  return candidate;
}

export function updateTeleptySessionHealth(event) {
  const sessionId = event?.session_id;
  if (!sessionId) return null;
  const health = {
    session_id: sessionId,
    payload: event.payload || {},
    timestamp: event.timestamp || new Date().toISOString(),
    seen_at: new Date().toISOString(),
  };
  teleptyBusState.healthBySession.set(sessionId, health);
  return health;
}

export function getTeleptySessionHealth(sessionId, nowMs = Date.now()) {
  const entry = teleptyBusState.healthBySession.get(sessionId);
  if (!entry) return null;
  const seenAtMs = Date.parse(entry.seen_at || entry.timestamp || "");
  const ageMs = Number.isFinite(seenAtMs) ? nowMs - seenAtMs : null;
  return {
    ...entry,
    age_ms: ageMs,
    stale: Number.isFinite(ageMs) ? ageMs > TELEPTY_SESSION_HEALTH_STALE_MS : true,
  };
}

export function handleTeleptyBusMessage(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  teleptyBusState.lastMessageAt = new Date().toISOString();
  if (!parsed || typeof parsed !== "object") return null;

  if (parsed.type === "inject_written") {
    return ackPendingTeleptyTurn(parsed);
  }
  if (parsed.type === "session_health") {
    return updateTeleptySessionHealth(parsed);
  }
  return parsed;
}

export async function ensureTeleptyBusSubscriber() {
  if (teleptyBusState.ws && teleptyBusState.ws.readyState === WebSocket.OPEN) {
    return { ok: true, status: "open" };
  }
  if (teleptyBusState.connectPromise) {
    return teleptyBusState.connectPromise;
  }

  teleptyBusState.connectPromise = new Promise((resolve) => {
    try {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      teleptyBusState.status = "connecting";
      const ws = new WebSocket(resolveTeleptyBusUrl());
      teleptyBusState.ws = ws;

      ws.once("open", () => {
        teleptyBusState.status = "open";
        teleptyBusState.lastConnectedAt = new Date().toISOString();
        teleptyBusState.lastError = null;
        _deps.appendRuntimeLog("INFO", "TELEPTY_BUS_CONNECTED");
        finish({ ok: true, status: "open" });
      });

      ws.on("message", (data) => {
        handleTeleptyBusMessage(data.toString());
      });

      ws.on("error", (err) => {
        teleptyBusState.lastError = String(err?.message || err);
        _deps.appendRuntimeLog("WARN", `TELEPTY_BUS_ERROR: ${teleptyBusState.lastError}`);
        if (ws.readyState !== WebSocket.OPEN) {
          teleptyBusState.status = "error";
          teleptyBusState.ws = null;
          teleptyBusState.connectPromise = null;
          finish({ ok: false, status: "error", error: teleptyBusState.lastError });
        }
      });

      ws.on("close", () => {
        teleptyBusState.status = "closed";
        teleptyBusState.ws = null;
        teleptyBusState.connectPromise = null;
        if (!settled) {
          finish({ ok: false, status: "closed", error: teleptyBusState.lastError || "socket closed" });
        }
        if (!teleptyBusState.reconnectTimer) {
          teleptyBusState.reconnectTimer = setTimeout(() => {
            teleptyBusState.reconnectTimer = null;
            ensureTeleptyBusSubscriber().catch(() => {});
          }, TELEPTY_BUS_RECONNECT_MS);
        }
      });
    } catch (err) {
      teleptyBusState.status = "error";
      teleptyBusState.lastError = String(err?.message || err);
      teleptyBusState.connectPromise = null;
      resolve({ ok: false, status: "error", error: teleptyBusState.lastError });
    }
  });

  const result = await teleptyBusState.connectPromise;
  if (!result.ok) {
    teleptyBusState.connectPromise = null;
  } else if (teleptyBusState.ws?.readyState === WebSocket.OPEN) {
    teleptyBusState.connectPromise = null;
  }
  return result;
}

export async function callBrainIngest(executionContract) {
  if (!executionContract) return { ok: false, reason: "no_contract" };
  try {
    const inboxDir = path.join(os.homedir(), ".aigentry", "inbox");
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true });
    }
    const fileName = `handoff-${executionContract.deliberation_id}.json`;
    const filePath = path.join(inboxDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(executionContract, null, 2), "utf8");
    _deps.appendRuntimeLog("INFO", `BRAIN_INGEST: wrote handoff file ${filePath}`);
    return { ok: true, path: filePath };
  } catch (err) {
    _deps.appendRuntimeLog("WARN", `BRAIN_INGEST: failed to write handoff file: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export async function notifyTeleptyBus(event) {
  const host = process.env.TELEPTY_HOST || "localhost";
  const port = process.env.TELEPTY_PORT || "3848";
  const token = loadTeleptyAuthToken();
  try {
    const res = await fetch(`http://${host}:${port}/api/bus/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "x-telepty-token": token } : {}),
      },
      body: JSON.stringify(event),
    });
    const data = await res.json().catch(() => null);
    if (res.ok) {
      _deps.appendRuntimeLog("INFO", `HANDOFF: Telepty bus notified: ${event.kind || event.type || "unknown"}`);
      return { ok: true, delivered: data?.delivered ?? null };
    }
    return { ok: false, status: res.status, error: data?.error || `HTTP ${res.status}` };
  } catch (err) {
    _deps.appendRuntimeLog("WARN", `HANDOFF: Telepty bus notification failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export function getDefaultOrchestratorSessionId() {
  // Check multiple env vars that may indicate an orchestrator context
  const candidates = [
    process.env.TELEPTY_SESSION_ID,
    process.env.DELIBERATION_ORCHESTRATOR_ID,
    process.env.ORCHESTRATOR_SESSION_ID,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function buildTurnCompletionNotificationText(state, entry) {
  const nextSpeaker = state.current_speaker || "none";
  const turnId = entry.turn_id || "(none)";
  if (state.status === "awaiting_synthesis") {
    return [
      `[deliberation turn complete]`,
      `session_id: ${state.id}`,
      `speaker: ${entry.speaker}`,
      `turn_id: ${turnId}`,
      `round: ${entry.round}/${state.max_rounds}`,
      `status: awaiting_synthesis`,
      `responses: ${state.log.length}`,
      `all rounds complete; run deliberation_synthesize(session_id: "${state.id}")`,
      `no further reply needed.`,
    ].join("\n");
  }

  return [
    `[deliberation turn complete]`,
    `session_id: ${state.id}`,
    `speaker: ${entry.speaker}`,
    `turn_id: ${turnId}`,
    `round: ${entry.round}/${state.max_rounds}`,
    `status: ${state.status}`,
    `next_speaker: ${nextSpeaker}`,
    `next_round: ${state.current_round}/${state.max_rounds}`,
    `responses: ${state.log.length}`,
    `informational notification only.`,
    `no further reply needed.`,
  ].join("\n");
}

export async function notifyTeleptySessionInject({ targetSessionId, prompt, fromSessionId, replyToSessionId = null, host = TELEPTY_DEFAULT_HOST }) {
  if (!targetSessionId || !prompt) return { ok: false, error: "missing target or prompt" };
  const token = loadTeleptyAuthToken();
  if (!token) return { ok: false, error: "telepty auth token unavailable" };

  try {
    const response = await fetch(`http://${host}:${TELEPTY_PORT}/api/sessions/${encodeURIComponent(targetSessionId)}/inject`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telepty-token": token,
      },
      body: JSON.stringify({
        prompt,
        from: fromSessionId || null,
        reply_to: replyToSessionId || null,
        deliberation_session_id: null,
        thread_id: null,
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, error: data?.error || `HTTP ${response.status}` };
    }
    return { ok: true, inject_id: data?.inject_id || null };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function dispatchTeleptyTurnRequest({ state, speaker, prompt = null, includeHistoryEntries = 4, awaitSemantic = false }) {
  const { profile } = _deps.resolveTransportForSpeaker(state, speaker);
  const turnId = state.pending_turn_id || _deps.generateTurnId();
  const turnPrompt = _deps.buildClipboardTurnPrompt(state, speaker, prompt, includeHistoryEntries);
  const busReady = await ensureTeleptyBusSubscriber();
  const envelope = buildTeleptyTurnRequestEnvelope({
    state,
    speaker,
    turnId,
    turnPrompt,
    includeHistoryEntries,
    profile,
  });
  const pending = registerPendingTeleptyTurnRequest({ envelope, profile, speaker });
  const publishResult = await notifyTeleptyBus(envelope);
  const health = profile?.telepty_session_id ? getTeleptySessionHealth(profile.telepty_session_id) : null;

  if (!publishResult.ok) {
    cleanupPendingTeleptyTurn(envelope.message_id);
    return {
      ok: false,
      stage: "publish",
      envelope,
      turnPrompt,
      publishResult,
      busReady,
      health,
    };
  }

  const transportResult = await pending.transportPromise;
  let semanticResult = null;
  if (awaitSemantic && transportResult.ok) {
    semanticResult = await pending.semanticPromise;
  }

  return {
    ok: !awaitSemantic ? transportResult.ok : Boolean(semanticResult?.ok),
    stage: awaitSemantic ? (semanticResult?.ok ? "semantic" : (semanticResult?.code || "semantic_timeout")) : (transportResult.ok ? "transport" : (transportResult?.code || "transport_timeout")),
    envelope,
    turnPrompt,
    publishResult,
    transportResult,
    semanticResult,
    busReady,
    health,
  };
}

export function loadTeleptyAuthToken() {
  try {
    const raw = fs.readFileSync(TELEPTY_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.authToken === "string" && parsed.authToken.trim()
      ? parsed.authToken.trim()
      : null;
  } catch {
    return null;
  }
}

export function formatTeleptyHostLabel(host) {
  return !host || host === "127.0.0.1" || host === "localhost" ? "Local" : host;
}

export async function collectTeleptySessions() {
  const token = loadTeleptyAuthToken();
  if (!token) {
    return { sessions: [], note: "telepty auth token not found." };
  }

  const host = TELEPTY_DEFAULT_HOST;
  try {
    const res = await fetch(`http://${host}:${TELEPTY_PORT}/api/sessions`, {
      headers: { "x-telepty-token": token },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      return { sessions: [], note: `telepty daemon unavailable (${res.status}).` };
    }
    const sessions = await res.json();
    if (!Array.isArray(sessions)) {
      return { sessions: [], note: "telepty session response format was invalid." };
    }
    ensureTeleptyBusSubscriber().catch(() => {});
    return {
      sessions: sessions.map(session => ({ host, ...session })),
      note: null,
    };
  } catch {
    return { sessions: [], note: null };
  }
}

export function scoreTeleptyProcessMatch(session, baseCommand = "", fullCommand = "") {
  const base = String(baseCommand || "").toLowerCase();
  const full = String(fullCommand || "").toLowerCase();
  const wanted = String(session?.command || "").trim().toLowerCase();
  let score = 0;

  if (wanted && (base === wanted || full.startsWith(`${wanted} `) || full.includes(` ${wanted} `))) {
    score += 10;
  }
  if (base === "node" || base === "telepty") {
    score -= 2;
  }
  if (full.includes("mcp-deliberation") || full.includes("oh-my-claudecode") || full.includes("bridge/mcp-server")) {
    score -= 3;
  }
  return score;
}

export function collectTeleptyProcessLocators(sessions = []) {
  const wantedSessions = new Map(
    sessions
      .filter(session => session?.id)
      .map(session => [String(session.id), session])
  );
  if (wantedSessions.size === 0) {
    return new Map();
  }

  try {
    const env = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      SHELL: process.env.SHELL,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      TERM: process.env.TERM,
    };
    const raw = execFileSync("ps", ["eww", "-axo", "pid=,tty=,comm=,command="], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 2500,
      maxBuffer: 8 * 1024 * 1024,
      env,
    });

    const best = new Map();
    for (const line of String(raw).split("\n")) {
      if (!line.includes("TELEPTY_SESSION_ID=")) continue;
      const match = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;
      const [, pid, tty, comm, command] = match;
      const sessionIdMatch = command.match(/(?:^|\s)TELEPTY_SESSION_ID=([^\s]+)/);
      const sessionId = sessionIdMatch?.[1];
      if (!sessionId || !wantedSessions.has(sessionId)) continue;

      const session = wantedSessions.get(sessionId);
      const score = scoreTeleptyProcessMatch(session, comm, command);
      const current = best.get(sessionId);
      if (!current || score > current.score) {
        best.set(sessionId, { pid: Number(pid), tty, score });
      }
    }

    return new Map(
      [...best.entries()].map(([sessionId, value]) => [
        sessionId,
        { pid: Number.isFinite(value.pid) ? value.pid : null, tty: value.tty || null },
      ])
    );
  } catch {
    return new Map();
  }
}
