/**
 * Session State Machine domain — session CRUD, lifecycle, prompt building,
 * markdown sync, archival, and core turn submission.
 *
 * Extracted from index.js to keep the main entry point focused on MCP tool
 * registration while this module owns all session state management logic.
 */

import fs from "fs";
import path from "path";
import os from "os";

// ── Direct imports from sibling modules ──────────────────────────
import {
  completePendingTeleptySemantic,
  notifyTeleptyBus,
  notifyTeleptySessionInject,
  buildTeleptyTurnCompletedEnvelope,
  buildTeleptyTurnRespondedEnvelope,
  getDefaultOrchestratorSessionId,
  buildTurnCompletionNotificationText,
} from "./telepty.js";
import {
  selectNextSpeaker,
  buildSpeakerOrder,
  loadRolePrompt,
  normalizeSpeaker,
  parseVotes,
  inferSuggestedRole,
  normalizeSessionActors,
  DELEGATION_FIELD_MAX_LENGTH,
} from "./speaker-discovery.js";
import { t } from "../i18n.js";
// δ2 (#440) — telemetry emit wrapper. emit-skip-with-warning when role
// is unset; failures swallowed; never blocks the turn-submission path.
import { emitTurnEvent } from "../logger-emit.js";

// ── Dependency injection ────────────────────────────────────────
// Functions that live in index.js but are needed here.  Injected once
// via `initSessionDeps()` so we avoid circular imports.

let _deps = {
  appendRuntimeLog: () => {},
  writeTextAtomic: () => {},
  readJsonFileSafe: () => null,
  writeJsonFileAtomic: () => {},
  withSessionLock: (ref, fn) => fn(),
  getProjectSlug: () => path.basename(process.cwd()),
  normalizeProjectSlug: (v) => (typeof v === "string" && v.trim()) ? v.trim() : path.basename(process.cwd()),
  getProjectStateDir: () => "",
  getSessionsDir: () => "",
  getSessionFile: () => "",
  getSessionProject: () => path.basename(process.cwd()),
  listStateProjects: () => [],
  getLocksDir: () => "",
  GLOBAL_STATE_DIR: "",
};

export function initSessionDeps(deps) {
  Object.assign(_deps, deps);
}

// ── Session TTL ──────────────────────────────────────────────

export const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function isSessionExpired(state) {
  if (!state || !state.created) return false;
  // Only expire sessions that explicitly opted in to TTL
  if (!state.session_ttl_ms) return false;
  const createdAt = new Date(state.created).getTime();
  if (isNaN(createdAt)) return false;
  return Date.now() - createdAt > state.session_ttl_ms;
}

// ── Session ID generation ─────────────────────────────────────

export function generateSessionId(topic) {
  const slug = topic
    .replace(/[^a-zA-Z0-9가-힣\s-]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 20);
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${slug}-${ts}${rand}`;
}

export function generateTurnId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Context detection ──────────────────────────────────────────

export function detectContextDirs() {
  const dirs = [];
  const slug = _deps.getProjectSlug();

  if (process.env.DELIBERATION_CONTEXT_DIR) {
    dirs.push(process.env.DELIBERATION_CONTEXT_DIR);
  }
  dirs.push(process.cwd());

  return [...new Set(dirs)];
}

export function readContextFromDirs(dirs, maxChars = 15000) {
  let context = "";
  const seen = new Set();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith(".md") && !f.startsWith("_") && !f.startsWith("."))
      .sort();

    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);

      const fullPath = path.join(dir, file);
      let raw;
      try { raw = fs.readFileSync(fullPath, "utf-8"); } catch { continue; }

      let body = raw;
      if (body.startsWith("---")) {
        const end = body.indexOf("---", 3);
        if (end !== -1) body = body.slice(end + 3).trim();
      }

      const truncated = body.length > 1200
        ? body.slice(0, 1200) + "\n(...)"
        : body;

      context += `### ${file.replace(".md", "")}\n${truncated}\n\n---\n\n`;

      if (context.length > maxChars) {
        context = context.slice(0, maxChars) + "\n\n(...context truncated)";
        return context;
      }
    }
  }
  return context || "(No context files found)";
}

// ── Archive directory ──────────────────────────────────────────

export function getArchiveDir(projectSlug) {
  const slug = _deps.normalizeProjectSlug(projectSlug);
  return path.join(_deps.getProjectStateDir(slug), "archive");
}

// ── Session record lookup ──────────────────────────────────────

export function findSessionRecord(sessionRef, { preferProject, activeOnly = false } = {}) {
  if (!sessionRef) return null;

  if (typeof sessionRef === "object" && sessionRef !== null && sessionRef.id) {
    const project = _deps.getSessionProject(sessionRef, preferProject);
    const file = _deps.getSessionFile(sessionRef.id, project);
    const state = _deps.readJsonFileSafe(file);
    if (!state) return null;
    const normalized = normalizeSessionActors(state);
    if (activeOnly && normalized.status !== "active" && normalized.status !== "awaiting_synthesis") {
      return null;
    }
    if (activeOnly && isSessionExpired(normalized)) {
      return null;
    }
    return { file, project, state: normalized };
  }

  const sessionId = String(sessionRef);
  const preferred = _deps.normalizeProjectSlug(preferProject);
  const projects = [...new Set([preferred, ..._deps.listStateProjects()])];
  for (const project of projects) {
    const file = _deps.getSessionFile(sessionId, project);
    const state = _deps.readJsonFileSafe(file);
    if (!state) continue;
    const normalized = normalizeSessionActors(state);
    if (activeOnly && normalized.status !== "active" && normalized.status !== "awaiting_synthesis") {
      continue;
    }
    if (activeOnly && isSessionExpired(normalized)) {
      continue;
    }
    return { file, project: normalized.project || project, state: normalized };
  }
  return null;
}

// ── State helpers ──────────────────────────────────────────────

export function ensureDirs(projectSlug) {
  const slug = projectSlug || _deps.getProjectSlug();
  fs.mkdirSync(_deps.getSessionsDir(slug), { recursive: true });
  fs.mkdirSync(getArchiveDir(slug), { recursive: true });
  fs.mkdirSync(_deps.getLocksDir(slug), { recursive: true });
}

export function loadSession(sessionRef) {
  const record = findSessionRecord(sessionRef);
  return record?.state || null;
}

export function saveSession(state) {
  ensureDirs(state.project);
  state.updated = new Date().toISOString();
  _deps.writeTextAtomic(_deps.getSessionFile(state), JSON.stringify(state, null, 2));
  syncMarkdown(state);
}

export function listActiveSessions(projectSlug) {
  const projects = projectSlug
    ? [_deps.normalizeProjectSlug(projectSlug)]
    : [...new Set([_deps.getProjectSlug(), ..._deps.listStateProjects()])];

  return projects.flatMap(project => {
    const dir = _deps.getSessionsDir(project);
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
          return normalizeSessionActors(data);
        } catch {
          return null;
        }
      })
      .filter(s => s && (s.status === "active" || s.status === "awaiting_synthesis") && !isSessionExpired(s));
  });
}

export function resolveSessionId(sessionId) {
  // Use session_id directly if provided — do not load or expire here;
  // individual tool handlers check expiry when needed.
  if (sessionId) return sessionId;

  // Auto-select when only one active session (listActiveSessions now checks TTL)
  const active = listActiveSessions();
  if (active.length === 0) return null;
  if (active.length === 1) return active[0].id;

  // null if multiple (need to show list)
  return "MULTIPLE";
}

export function syncMarkdown(state) {
  const filename = `deliberation-${state.id}.md`;
  const mdPath = path.join(_deps.getProjectStateDir(state.project), filename);
  try {
    _deps.writeTextAtomic(mdPath, stateToMarkdown(state));
  } catch { /* ignore sync failures */ }
}

export function cleanupSyncMarkdown(state) {
  const filename = `deliberation-${state.id}.md`;
  const statePath = path.join(_deps.getProjectStateDir(state.project), filename);
  try { fs.unlinkSync(statePath); } catch { /* ignore */ }
  // Also clean up legacy files in CWD (from older versions)
  const cwdPath = path.join(process.cwd(), filename);
  try { fs.unlinkSync(cwdPath); } catch { /* ignore */ }
}

export function formatSourceMetadataLine(meta) {
  if (!meta || typeof meta !== "object") return "";
  const parts = [];
  if (meta.source_machine_id) parts.push(`machine: ${meta.source_machine_id}`);
  if (meta.source_session_id) parts.push(`session: ${meta.source_session_id}`);
  if (meta.transport_scope) parts.push(`transport: ${meta.transport_scope}`);
  if (meta.reply_origin) parts.push(`origin: ${meta.reply_origin}`);
  if (meta.timestamp) parts.push(`timestamp: ${meta.timestamp}`);
  if (Array.isArray(meta.artifact_refs) && meta.artifact_refs.length > 0) {
    parts.push(`artifacts: ${meta.artifact_refs.join(", ")}`);
  }
  return parts.length > 0 ? `> _source: ${parts.join(" | ")}_\n\n` : "";
}

// Task #1172 — speaker-selection provenance as archived audit metadata.
//
// This renders WHO composed the speaker set. It is NOT a human-authentication
// claim, NOT approval, and NOT execution authority — `delegation` is a claim the
// caller supplied and the server never verified. The reference is recorded as an
// opaque string and is NEVER opened, resolved or fetched.
//
// Everything here is untrusted text that lands in a Markdown document, so each
// field is whitelisted (no selection token, no caller extras can leak through),
// bounded by the same `DELEGATION_FIELD_MAX_LENGTH` the mint boundary uses, and
// rejected outright if it carries control characters or line breaks. Rejected
// fields are reported as rejected — never truncated into something that looks
// like it passed. The result is emitted inside a fenced JSON block, where
// JSON.stringify escapes quotes/newlines/control characters, so a hostile
// `task_id` cannot forge a YAML frontmatter key, close the fence, or inject a
// Markdown field.
const ARCHIVE_UNSAFE_TEXT = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/;

function boundedArchiveField(value, maxLength) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  if (ARCHIVE_UNSAFE_TEXT.test(trimmed)) return null;
  return trimmed;
}

export function buildArchiveSelectionProvenance(selection) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) return null;

  const origin = boundedArchiveField(selection.origin, DELEGATION_FIELD_MAX_LENGTH);
  const provenance = {
    origin: origin || "unrecorded",
    // Strict `=== true`: any other stored value reads as "not confirmed by a
    // human". A damaged or absent flag must never round-trip into a human claim.
    human_selection_confirmed: selection.human_selection_confirmed === true,
    legacy_unlabeled: selection.legacy_unlabeled === true,
    recorded_at: boundedArchiveField(selection.recorded_at, DELEGATION_FIELD_MAX_LENGTH),
    note: "Unverified audit metadata: records how the speaker set was composed. Not human authentication, approval, or execution authority. `reference` is never dereferenced.",
  };

  const rawDelegation = selection.delegation;
  if (rawDelegation === undefined || rawDelegation === null) {
    provenance.delegation = null;
    provenance.delegation_status = "absent";
    return provenance;
  }
  if (typeof rawDelegation !== "object" || Array.isArray(rawDelegation)) {
    provenance.delegation = null;
    provenance.delegation_status = "rejected_malformed";
    return provenance;
  }
  const taskId = boundedArchiveField(rawDelegation.task_id, DELEGATION_FIELD_MAX_LENGTH);
  const reference = boundedArchiveField(rawDelegation.reference, DELEGATION_FIELD_MAX_LENGTH);
  if (!taskId || !reference) {
    provenance.delegation = null;
    provenance.delegation_status = `rejected_unbounded_or_malformed (max_length ${DELEGATION_FIELD_MAX_LENGTH})`;
    return provenance;
  }
  provenance.delegation = { task_id: taskId, reference, claim: true };
  provenance.delegation_status = "recorded";
  return provenance;
}

// `includeSelectionProvenance` defaults off so every existing caller — the
// in-place `syncMarkdown` state mirror above — renders byte-identically to
// before. Only `archiveState` opts in: the archive is the durable audit surface
// the contract names, and state/output/history already carry the origin.
export function stateToMarkdown(s, { includeSelectionProvenance = false } = {}) {
  const speakerOrder = buildSpeakerOrder(s.speakers, s.current_speaker, "end");
  let md = `---
title: "Deliberation - ${s.topic}"
session_id: "${s.id}"
created: ${s.created}
updated: ${s.updated || new Date().toISOString()}
type: deliberation
status: ${s.status}
project: "${s.project}"
participants: ${JSON.stringify(speakerOrder)}
rounds: ${s.max_rounds}
current_round: ${s.current_round}
current_speaker: "${s.current_speaker}"
tags: [deliberation]
---

# Deliberation: ${s.topic}

**Session:** ${s.id} | **Project:** ${s.project} | **Status:** ${s.status} | **Round:** ${s.current_round}/${s.max_rounds} | **Next:** ${s.current_speaker}

---

`;

  if (s.synthesis) {
    md += `## Synthesis\n\n${s.synthesis}\n\n---\n\n`;
  }

  if (s.structured_synthesis) {
    md += `## Structured Synthesis\n\n\`\`\`json\n${JSON.stringify(s.structured_synthesis, null, 2)}\n\`\`\`\n\n---\n\n`;
  }

  // Task #1172 — provenance is emitted from `state.speaker_selection` directly and
  // unconditionally, so it survives into the archive for any session that carries
  // it. It must NOT depend on `execution_contract` below: that block only exists
  // once a session has been synthesised into one, and a deliberation archived
  // without ever reaching that point would otherwise be indistinguishable from a
  // human-selected one. Archiving the audit trail may not require an executed turn.
  const selectionProvenance = includeSelectionProvenance
    ? buildArchiveSelectionProvenance(s.speaker_selection)
    : null;
  if (selectionProvenance) {
    md += `## Speaker Selection Provenance\n\n\`\`\`json\n${JSON.stringify(selectionProvenance, null, 2)}\n\`\`\`\n\n---\n\n`;
  }

  if (s.execution_contract) {
    md += `## Execution Contract\n\n\`\`\`json\n${JSON.stringify(s.execution_contract, null, 2)}\n\`\`\`\n\n---\n\n`;
  }

  md += `## Debate Log\n\n`;
  for (const entry of s.log) {
    md += `### ${entry.speaker} — Round ${entry.round}\n\n`;
    if (entry.channel_used || entry.fallback_reason) {
      const parts = [];
      if (entry.channel_used) parts.push(`channel: ${entry.channel_used}`);
      if (entry.fallback_reason) parts.push(`fallback: ${entry.fallback_reason}`);
      md += `> _${parts.join(" | ")}_\n\n`;
    }
    md += formatSourceMetadataLine(entry.source_metadata);
    md += `${entry.content}\n\n`;
    if (entry.attachments && entry.attachments.length > 0) {
      for (const att of entry.attachments) {
        if (att.type === "image") {
          md += `![Attachment](${att.path})\n\n`;
        }
      }
    }
    md += `---\n\n`;
  }
  return md;
}

export function archiveState(state) {
  ensureDirs(state.project);
  const slug = state.topic
    .replace(/[^a-zA-Z0-9가-힣\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 30);
  const ts = new Date().toISOString().slice(0, 16).replace(/:/g, "");
  const filename = `deliberation-${ts}-${slug}.md`;
  const dest = path.join(getArchiveDir(state.project), filename);
  // Task #1172 — the archive always records how the speaker set was composed,
  // independently of whether this session ever produced an execution_contract.
  _deps.writeTextAtomic(dest, stateToMarkdown(state, { includeSelectionProvenance: true }));

  // Write machine-readable execution_contract sidecar for automation consumers
  if (state.execution_contract) {
    const contractDest = dest.replace(/\.md$/, ".contract.json");
    _deps.writeTextAtomic(contractDest, JSON.stringify({
      ...state.execution_contract,
      _meta: {
        archived_from: state.id,
        project: state.project,
        topic: state.topic,
        archived_at: new Date().toISOString(),
      },
    }, null, 2));
  }

  return dest;
}

// ── Multiple sessions error ────────────────────────────────────

export function multipleSessionsError() {
  const active = listActiveSessions();
  const list = active.map(s => `- **${s.id}** [${s.project || "unknown"}]: "${s.topic}" (Round ${s.current_round}/${s.max_rounds}, next: ${s.current_speaker})`).join("\n");
  return t(`Multiple active sessions found. Please specify session_id:\n\n${list}`, `여러 활성 세션이 있습니다. session_id를 지정하세요:\n\n${list}`, "en");
}

// ── Prompt building ────────────────────────────────────────────

export function truncatePromptText(text, maxChars) {
  const value = String(text || "").trim();
  if (!value || !Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) {
    return value;
  }
  const remaining = value.length - maxChars;
  return `${value.slice(0, maxChars).trimEnd()}\n...(truncated ${remaining} chars)`;
}

export function getPromptBudgetForSpeaker(speaker, includeHistoryEntries = 4) {
  const defaultBudget = {
    maxEntries: Math.max(0, includeHistoryEntries),
    maxCharsPerEntry: 1600,
    maxTotalChars: 6400,
    maxTopicChars: 3200,
  };
  switch (speaker) {
    case "codex":
      return {
        maxEntries: Math.min(Math.max(0, includeHistoryEntries), 3),
        maxCharsPerEntry: 1200,
        maxTotalChars: 3600,
        maxTopicChars: 2200,
      };
    case "gemini":
      return {
        maxEntries: Math.min(Math.max(0, includeHistoryEntries), 4),
        maxCharsPerEntry: 1400,
        maxTotalChars: 5600,
        maxTopicChars: 2800,
      };
    default:
      return defaultBudget;
  }
}

export function formatRecentLogForPrompt(state, maxEntries = 4, options = {}) {
  const entries = Array.isArray(state.log) ? state.log.slice(-Math.max(0, maxEntries)) : [];
  if (entries.length === 0) {
    return "(No previous responses yet)";
  }
  const maxCharsPerEntry = options.maxCharsPerEntry || 1600;
  const maxTotalChars = options.maxTotalChars || maxCharsPerEntry * entries.length;
  const rendered = [];
  let usedChars = 0;

  for (const entry of entries) {
    const header = `- ${entry.speaker} (Round ${entry.round})`;
    const remainingChars = Math.max(0, maxTotalChars - usedChars - header.length - 1);
    const entryBudget = Math.max(200, Math.min(maxCharsPerEntry, remainingChars || maxCharsPerEntry));
    const content = truncatePromptText(entry.content, entryBudget);
    const block = `${header}\n${content}`;
    rendered.push(block);
    usedChars += block.length + 2;
    if (usedChars >= maxTotalChars) {
      break;
    }
  }

  return rendered.join("\n\n");
}

export function buildActiveReportingSection(state, speaker) {
  const orchestratorSessionId = state?.orchestrator_session_id;
  if (!orchestratorSessionId) return "";

  return `\n[active_reporting_rule]
- After you successfully submit this turn with \`deliberation_respond(...)\`, send a brief status update to the orchestrator session.
- Primary method (telepty available):
\`telepty inject --from \"$TELEPTY_SESSION_ID\" --reply-to ${orchestratorSessionId} ${orchestratorSessionId} \"[deliberation status] session_id: ${state.id} speaker: ${speaker} round: ${state.current_round}/${state.max_rounds} submitted. no further reply needed.\"\`
- Fallback (telepty unavailable): Include the status in your next tool call or response context.
- Keep it to one short line. Do not wait for a reply.
- This rule applies regardless of transport type (CLI, browser, telepty_bus).
[/active_reporting_rule]
`;
}

export function buildClipboardTurnPrompt(state, speaker, prompt, includeHistoryEntries = 4, opts = {}) {
  // cli_auto transport spawns the speaker CLI headlessly and captures its stdout
  // as the turn response. Agentic CLIs (grok/agy) execute "submit via deliberation_respond"
  // as a tool command instead of answering, so for this channel we strip the
  // self-submit/reporting guidance and require plain stdout output only.
  const cliAuto = opts.cliAuto === true;
  const promptBudget = getPromptBudgetForSpeaker(speaker, includeHistoryEntries);
  const recent = formatRecentLogForPrompt(state, promptBudget.maxEntries, promptBudget);
  const extraPrompt = prompt ? `\n[Additional instructions]\n${prompt}\n` : "";
  const topic = truncatePromptText(state.topic, promptBudget.maxTopicChars);
  const noToolRule = speaker === "codex"
    ? `\n- Do not inspect files, run shell commands, browse, or call tools. Answer only from the provided discussion context.`
    : "";
  const cliAutoRule = cliAuto
    ? `\n- Output ONLY your analysis as plain text to stdout. Do NOT call any tools, functions, or MCP servers, and do NOT run shell commands or browse. Your stdout is captured automatically as your turn response.`
    : "";
  const activeReportingSection = cliAuto ? "" : buildActiveReportingSection(state, speaker);

  // Role prompt injection
  const speakerRole = (state.speaker_roles || {})[speaker] || "free";
  const rolePromptText = loadRolePrompt(speakerRole);
  const roleSection = rolePromptText
    ? `\n[role]\nrole: ${speakerRole}\n${rolePromptText}\n[/role]\n`
    : "";

  return `[deliberation_turn_request]
session_id: ${state.id}
project: ${state.project}
topic: ${topic}
round: ${state.current_round}/${state.max_rounds}
target_speaker: ${speaker}
required_turn: ${state.current_speaker}${roleSection}${activeReportingSection}

[recent_log]
${recent}
[/recent_log]${extraPrompt}

[response_rule]
- Write only ${speaker}'s response for this turn reflecting the discussion context above
- Output markdown body only (no unnecessary headers/footers)${speakerRole !== "free" ? `\n- Analyze and respond from the perspective of assigned role (${speakerRole})` : ""}
- Keep the response concise and decision-oriented${noToolRule}${cliAutoRule}
- Must include one of [AGREE], [DISAGREE], or [CONDITIONAL: reason] at the end of response
[/response_rule]
[/deliberation_turn_request]
`;
}

// ── Core turn submission ───────────────────────────────────────

export function submitDeliberationTurn({ session_id, speaker, content, turn_id, channel_used, fallback_reason, attachments, source_metadata }) {
  const resolved = resolveSessionId(session_id);
  if (!resolved) {
    return { content: [{ type: "text", text: t("No active deliberation.", "활성 deliberation이 없습니다.", "en") }] };
  }
  if (resolved === "MULTIPLE") {
    return { content: [{ type: "text", text: multipleSessionsError() }] };
  }

  let completionState = null;
  let completionEntry = null;
  const result = _deps.withSessionLock(resolved, () => {
    const state = loadSession(resolved);
    if (!state || state.status !== "active") {
      return { content: [{ type: "text", text: t(`Session "${resolved}" is not active.`, `세션 "${resolved}"이 활성 상태가 아닙니다.`, "en") }] };
    }

    const normalizedSpeaker = normalizeSpeaker(speaker);
    if (!normalizedSpeaker) {
      return { content: [{ type: "text", text: t("Speaker value is empty. Please specify a speaker name.", "speaker 값이 비어 있습니다. 응답자 이름을 지정하세요.", "en") }] };
    }

    state.speakers = buildSpeakerOrder(state.speakers, state.current_speaker, "end");
    const normalizedCurrentSpeaker = normalizeSpeaker(state.current_speaker);
    if (!normalizedCurrentSpeaker || !state.speakers.includes(normalizedCurrentSpeaker)) {
      state.current_speaker = state.speakers[0];
    } else {
      state.current_speaker = normalizedCurrentSpeaker;
    }

    if (state.current_speaker !== normalizedSpeaker) {
      return {
        content: [{
          type: "text",
          text: t(`[${state.id}] It is currently **${state.current_speaker}**'s turn. ${normalizedSpeaker} please wait.`, `[${state.id}] 지금은 **${state.current_speaker}** 차례입니다. ${normalizedSpeaker}는 대기하세요.`, state?.lang),
        }],
      };
    }

    // turn_id validation (optional — must match if provided)
    if (turn_id && state.pending_turn_id && turn_id !== state.pending_turn_id) {
      return {
        content: [{
          type: "text",
          text: t(`[${state.id}] turn_id mismatch. Expected: "${state.pending_turn_id}", received: "${turn_id}". May be a stale request or duplicate submission.`, `[${state.id}] turn_id 불일치. 예상: "${state.pending_turn_id}", 수신: "${turn_id}". 오래된 요청이거나 중복 제출일 수 있습니다.`, state?.lang),
        }],
      };
    }

    const votes = parseVotes(content);
    if (votes.length === 0) {
      _deps.appendRuntimeLog("WARN", `INVALID_TURN: ${state.id} | R${state.current_round} | speaker: ${normalizedSpeaker} | reason: no_vote_marker`);
    }
    const suggestedRole = inferSuggestedRole(content);
    const assignedRole = (state.speaker_roles || {})[normalizedSpeaker] || "free";
    const roleDrift = assignedRole !== "free" && suggestedRole !== "free" && assignedRole !== suggestedRole;
    const logEntry = {
      round: state.current_round,
      speaker: normalizedSpeaker,
      content,
      timestamp: new Date().toISOString(),
      turn_id: state.pending_turn_id || null,
      channel_used: channel_used || null,
      fallback_reason: fallback_reason || null,
      votes: votes.length > 0 ? votes : undefined,
      suggested_next_role: suggestedRole !== "free" ? suggestedRole : undefined,
      role_drift: roleDrift || undefined,
      attachments: attachments || undefined,
      source_metadata: source_metadata || undefined,
    };
    state.log.push(logEntry);
    completePendingTeleptySemantic({
      sessionId: state.id,
      speaker: normalizedSpeaker,
      turnId: state.pending_turn_id || turn_id || null,
    });
    // Cross-process semantic completion: notify other MCP processes via bus
    const turnRespondedEnvelope = buildTeleptyTurnRespondedEnvelope({
      state,
      speaker: normalizedSpeaker,
      turnId: state.pending_turn_id || turn_id || null,
    });
    notifyTeleptyBus(turnRespondedEnvelope).catch(() => {});
    _deps.appendRuntimeLog("INFO", `TURN: ${state.id} | R${state.current_round} | speaker: ${normalizedSpeaker} | votes: ${votes.length > 0 ? votes.map(v => v.vote).join(",") : "none"} | channel: ${channel_used || "respond"} | attachments: ${attachments ? attachments.length : 0}${source_metadata?.source_machine_id ? ` | source_machine: ${source_metadata.source_machine_id}` : ""}`);

    state.current_speaker = selectNextSpeaker(state);

    // Round transition: check if all speakers have spoken this round
    const roundEntries = state.log.filter(e => e.round === state.current_round);
    const spokeSpeakers = new Set(roundEntries.map(e => e.speaker));
    const allSpoke = state.speakers.every(s => spokeSpeakers.has(s));

    if (allSpoke) {
      if (state.current_round >= state.max_rounds) {
        state.status = "awaiting_synthesis";
        state.current_speaker = "none";
        saveSession(state);
        return {
          content: [{
            type: "text",
            text: t(`✅ [${state.id}] ${normalizedSpeaker} Round ${state.log[state.log.length - 1].round} complete. Forum updated (${state.log.length} responses accumulated).\n\n🏁 **All rounds complete!**\nCreate a synthesis report with deliberation_synthesize(session_id: "${state.id}").`, `✅ [${state.id}] ${normalizedSpeaker} Round ${state.log[state.log.length - 1].round} 완료. Forum 업데이트됨 (${state.log.length}건 응답 축적).\n\n🏁 **모든 라운드 종료!**\ndeliberation_synthesize(session_id: "${state.id}")로 합성 보고서를 작성하세요.`, state?.lang),
          }],
        };
      }
      state.current_round += 1;
    }

    if (state.status === "active") {
      state.pending_turn_id = generateTurnId();
    }

    if (!state.orchestrator_session_id) {
      state.orchestrator_session_id = getDefaultOrchestratorSessionId() || null;
    }
    completionEntry = {
      ...logEntry,
      turn_id: logEntry.turn_id || turn_id || null,
    };
    completionState = {
      ...state,
      log: [...state.log],
    };
    saveSession(state);
    return {
      content: [{
        type: "text",
        text: t(`✅ [${state.id}] ${normalizedSpeaker} Round ${state.log[state.log.length - 1].round} complete. Forum updated (${state.log.length} responses accumulated).\n\n**Next:** ${state.current_speaker} (Round ${state.current_round})`, `✅ [${state.id}] ${normalizedSpeaker} Round ${state.log[state.log.length - 1].round} 완료. Forum 업데이트됨 (${state.log.length}건 응답 축적).\n\n**다음:** ${state.current_speaker} (Round ${state.current_round})`, state?.lang),
      }],
    };
  });

  if (completionState && completionEntry) {
    emitTurnEvent(
      "turn_complete",
      {
        session: completionState.id,
        speaker: completionEntry.speaker,
        round: completionEntry.round,
        max_rounds: completionState.max_rounds,
        next_speaker: completionState.current_speaker,
        votes_count: Array.isArray(completionEntry.votes) ? completionEntry.votes.length : 0,
      },
      completionEntry.turn_id || undefined,
    );
    const envelope = buildTeleptyTurnCompletedEnvelope({ state: completionState, entry: completionEntry });
    notifyTeleptyBus(envelope).catch(() => {});

    const orchestratorSessionId = completionState.orchestrator_session_id || null;
    if (orchestratorSessionId) {
      const notificationText = buildTurnCompletionNotificationText(completionState, completionEntry);
      notifyTeleptySessionInject({
        targetSessionId: orchestratorSessionId,
        prompt: notificationText,
        fromSessionId: `deliberation:${completionState.id}`,
      }).catch(() => {});
    }
  }

  return result;
}
