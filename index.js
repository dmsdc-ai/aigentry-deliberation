#!/usr/bin/env node

// ── CLI command routing (must be before any imports) ──
// Supports: npx @dmsdc-ai/aigentry-deliberation install
//           npx @dmsdc-ai/aigentry-deliberation --help
const _cliArg = process.argv[2];
if (_cliArg === "install" || _cliArg === "uninstall" || _cliArg === "--uninstall") {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const __installDir = dirname(fileURLToPath(import.meta.url));
  const installArgs = _cliArg === "install" ? [] : ["--uninstall"];
  try {
    execFileSync(process.execPath, [join(__installDir, "install.js"), ...installArgs], { stdio: "inherit" });
  } catch (e) {
    process.exit(e.status || 1);
  }
  process.exit(0);
}
if (_cliArg === "--help" || _cliArg === "-h") {
  console.log(`
MCP Deliberation Server

Usage:
  npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-install     Install (preferred)
  npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-install --uninstall
  npx @dmsdc-ai/aigentry-deliberation              Run MCP server (stdio)
  npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-doctor      Diagnose MCP wiring

After installation, restart Claude Code to start using it.
`);
  process.exit(0);
}

/**
 * MCP Deliberation Server (Global) — Multi-Session + Transport Routing + Cross-Platform + Browser Control
 *
 * A global AI deliberation server usable across all projects.
 * Multiple deliberations can run in parallel simultaneously.
 *
 * State storage: $INSTALL_DIR/state/{project-slug}/sessions/{id}.json
 *   macOS/Linux: ~/.local/lib/mcp-deliberation/
 *   Windows:     %LOCALAPPDATA%/mcp-deliberation/
 *
 * Tools:
 *   deliberation_start        Start a new deliberation → returns session_id
 *   deliberation_status       Query session status (session_id optional)
 *   deliberation_list_active  List all active sessions
 *   deliberation_context      Load project context
 *   deliberation_respond      Submit a response (session_id required)
 *   deliberation_history      Query deliberation history (session_id optional)
 *   deliberation_synthesize   Generate synthesis report (session_id optional)
 *   deliberation_list         List past archives
 *   deliberation_reset        Reset session (session_id optional, resets all if omitted)
 *   deliberation_speaker_candidates      Query available speaker candidates (local CLI + browser LLM tabs)
 *   deliberation_browser_llm_tabs      Query browser LLM tab list
 *   deliberation_browser_auto_turn      Auto-send turn to browser LLM and collect response (CDP-based)
 *   deliberation_cli_auto_turn          Auto-send turn to CLI speaker and collect response
 *   deliberation_request_review         Request code review (auto-invoke CLI reviewers, sync/async mode)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { getModelSelectionForTurn } from "./model-router.js";
import {
  initSpeakerDeps,
  // Constants
  DEFAULT_SPEAKERS,
  DEFAULT_CLI_CANDIDATES,
  MAX_AUTO_DISCOVERED_SPEAKERS,
  DEFAULT_BROWSER_APPS,
  DEFAULT_LLM_DOMAINS,
  DEFAULT_WEB_SPEAKERS,
  SPEAKER_SELECTION_FILE,
  SPEAKER_SELECTION_TTL_MS,
  CLI_INVOCATION_HINTS,
  ROLE_KEYWORDS,
  ROLE_HEADING_MARKERS,
  DEGRADATION_TIERS,
  TRANSPORT_TYPES,
  // Utility
  commandExistsInPath,
  shellQuote,
  // Speaker normalization & ordering
  normalizeSpeaker,
  dedupeSpeakers,
  selectNextSpeaker,
  loadRolePrompt,
  inferSuggestedRole,
  parseVotes,
  loadRolePresets,
  applyRolePreset,
  loadExtensionProviderRegistry,
  isExtensionLlmTab,
  // Speaker selection tokens
  createSelectionToken,
  issueSpeakerSelectionToken,
  loadSpeakerSelectionToken,
  clearSpeakerSelectionToken,
  validateSpeakerSelectionSnapshot,
  confirmSpeakerSelectionToken,
  markSelectionTokenConsumed,
  validateSpeakerSelectionRequest,
  // Browser participant helpers
  hasExplicitBrowserParticipantSelection,
  resolveIncludeBrowserSpeakers,
  // CLI discovery
  resolveCliCandidates,
  checkCliLiveness,
  discoverLocalCliSpeakers,
  detectCallerSpeaker,
  // URL / domain helpers
  isLlmUrl,
  dedupeBrowserTabs,
  parseInjectedBrowserTabsFromEnv,
  // CDP helpers
  normalizeCdpEndpoint,
  resolveCdpEndpoints,
  fetchJson,
  inferBrowserFromCdpEndpoint,
  summarizeFailures,
  // Browser LLM tab collection
  collectBrowserLlmTabsViaCdp,
  ensureCdpAvailable,
  collectBrowserLlmTabsViaAppleScript,
  collectBrowserLlmTabs,
  // LLM provider inference
  inferLlmProvider,
  // Speaker candidate collection
  collectSpeakerCandidates,
  formatSpeakerCandidatesReport,
  mapParticipantProfiles,
  // Speaker ordering
  buildSpeakerOrder,
  normalizeSessionActors,
  // Transport routing
  resolveTransportForSpeaker,
  formatTransportGuidance,
  // Degradation
  detectDegradationLevels,
  formatDegradationReport,
} from "./lib/speaker-discovery.js";
import {
  initSessionDeps,
  DEFAULT_SESSION_TTL_MS,
  isSessionExpired,
  generateSessionId,
  generateTurnId,
  detectContextDirs,
  readContextFromDirs,
  getArchiveDir,
  findSessionRecord,
  ensureDirs,
  loadSession,
  saveSession,
  listActiveSessions,
  resolveSessionId,
  syncMarkdown,
  cleanupSyncMarkdown,
  formatSourceMetadataLine,
  stateToMarkdown,
  archiveState,
  multipleSessionsError,
  truncatePromptText,
  getPromptBudgetForSpeaker,
  formatRecentLogForPrompt,
  buildActiveReportingSection,
  buildClipboardTurnPrompt,
  submitDeliberationTurn,
} from "./lib/session.js";
import {
  initTransportDeps,
  // Constants
  TMUX_SESSION,
  MONITOR_SCRIPT,
  MONITOR_SCRIPT_WIN,
  // Terminal management
  tmuxWindowName,
  appleScriptQuote,
  tryExecFile,
  resolveMonitorShell,
  buildMonitorCommand,
  buildMonitorCommandWindows,
  hasTmuxSession,
  hasTmuxWindow,
  tmuxHasAttachedClients,
  isTmuxWindowViewed,
  tmuxWindowCount,
  buildTmuxAttachCommand,
  listPhysicalTerminalWindowIds,
  openPhysicalTerminal,
  spawnMonitorTerminal,
  closePhysicalTerminal,
  closeMonitorTerminal,
  getSessionWindowIds,
  closeAllMonitorTerminals,
  // Browser port singleton
  getBrowserPort,
  // CLI auto-turn helpers
  getCliAutoTurnTimeoutSec,
  getCliExecArgs,
  buildCliAutoTurnFailureText,
  // Auto-turn execution core
  runCliAutoTurnCore,
  runBrowserAutoTurnCore,
  runTeleptyBusAutoTurnCore,
  runUntilBlockedCore,
  generateAutoSynthesis,
  runAutoHandoff,
  // Review helpers
  invokeCliReviewer,
  buildReviewPrompt,
  synthesizeReviews,
} from "./lib/transport.js";
import { readClipboardText, writeClipboardText, hasClipboardImage, captureClipboardImage } from "./clipboard.js";
import { detectLang, t } from "./i18n.js";
// δ2 (#440) — telemetry emit wrapper. emit-skip-with-warning when role
// is unset; failures swallowed; never blocks the synthesis path.
import { emitSynthesisEvent, emitHandoffEvent } from "./logger-emit.js";
import {
  initTeleptyDeps,
  // Schemas
  StructuredActionableTaskSchema,
  StructuredExperimentOutcomeSchema,
  StructuredSynthesisSchema,
  StructuredExecutionContractSchema,
  TeleptyEnvelopeSchema,
  TeleptyTurnRequestPayloadSchema,
  TeleptyTurnCompletedPayloadSchema,
  TeleptyDeliberationCompletedPayloadSchema,
  TELEPTY_ENVELOPE_PAYLOAD_SCHEMAS,
  // Constants
  TELEPTY_CONFIG_FILE,
  TELEPTY_DEFAULT_HOST,
  TELEPTY_PORT,
  TELEPTY_TRANSPORT_TIMEOUT_MS,
  TELEPTY_SEMANTIC_TIMEOUT_MS,
  TELEPTY_BUS_RECONNECT_MS,
  TELEPTY_SESSION_HEALTH_STALE_MS,
  // State
  teleptyBusState,
  pendingTeleptyTurnRequests,
  // Functions
  hashPromptText,
  sortJsonValue,
  hashStructuredSynthesis,
  buildExecutionContract,
  createEnvelopeId,
  validateTeleptyEnvelope,
  resolveTeleptySourceHost,
  buildTeleptyEnvelope,
  buildTeleptyTurnRequestEnvelope,
  buildTeleptyTurnCompletedEnvelope,
  buildTeleptySynthesisEnvelope,
  resolveTeleptyBusUrl,
  cleanupPendingTeleptyTurn,
  registerPendingTeleptyTurnRequest,
  ackPendingTeleptyTurn,
  completePendingTeleptySemantic,
  updateTeleptySessionHealth,
  getTeleptySessionHealth,
  handleTeleptyBusMessage,
  ensureTeleptyBusSubscriber,
  callBrainIngest,
  notifyTeleptyBus,
  getDefaultOrchestratorSessionId,
  buildTurnCompletionNotificationText,
  notifyTeleptySessionInject,
  dispatchTeleptyTurnRequest,
  loadTeleptyAuthToken,
  formatTeleptyHostLabel,
  collectTeleptySessions,
  scoreTeleptyProcessMatch,
  collectTeleptyProcessLocators,
} from "./lib/telepty.js";

// ── Paths ──────────────────────────────────────────────────────

const HOME = os.homedir();
const IS_WIN = process.platform === "win32";
const INSTALL_DIR = IS_WIN
  ? path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "mcp-deliberation")
  : path.join(HOME, ".local", "lib", "mcp-deliberation");
const GLOBAL_STATE_DIR = path.join(INSTALL_DIR, "state");
const GLOBAL_RUNTIME_LOG = path.join(INSTALL_DIR, "runtime.log");
function loadDeliberationConfig() {
  const configPath = path.join(INSTALL_DIR, "config.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function saveDeliberationConfig(config) {
  const configPath = path.join(INSTALL_DIR, "config.json");
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  config.updated = new Date().toISOString();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

const PRODUCT_DISCLAIMER = "ℹ️ This tool does not permanently modify external websites. It reads browser context in read-only mode to route speakers.";
const LOCKS_SUBDIR = ".locks";
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 8000;
const LOCK_STALE_MS = 60000;
function getProjectSlug() {
  return path.basename(process.cwd());
}

function normalizeProjectSlug(projectSlug) {
  if (typeof projectSlug === "string" && projectSlug.trim()) {
    return projectSlug.trim();
  }
  return getProjectSlug();
}

function getProjectStateDir(projectSlug = getProjectSlug()) {
  return path.join(GLOBAL_STATE_DIR, normalizeProjectSlug(projectSlug));
}

function getSessionsDir(projectSlug = getProjectSlug()) {
  return path.join(getProjectStateDir(projectSlug), "sessions");
}

function getSessionProject(sessionRef, fallbackProject = getProjectSlug()) {
  if (sessionRef && typeof sessionRef === "object" && typeof sessionRef.project === "string" && sessionRef.project.trim()) {
    return sessionRef.project.trim();
  }
  return normalizeProjectSlug(fallbackProject);
}

function getSessionFile(sessionRef, projectSlug) {
  const sessionId = typeof sessionRef === "object" && sessionRef !== null
    ? sessionRef.id
    : sessionRef;
  return path.join(getSessionsDir(getSessionProject(sessionRef, projectSlug)), `${sessionId}.json`);
}

function getExecutionStatusFile(sessionId, projectSlug) {
  return path.join(getProjectStateDir(projectSlug || getProjectSlug()), `exec-status-${sessionId}.json`);
}

function loadExecutionStatus(sessionId, projectSlug) {
  // Search across all projects if projectSlug not given
  const projects = projectSlug
    ? [normalizeProjectSlug(projectSlug)]
    : [getProjectSlug(), ...listStateProjects()];
  for (const p of [...new Set(projects)]) {
    const file = getExecutionStatusFile(sessionId, p);
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (data && data.session_id === sessionId) return data;
    } catch { /* not found */ }
  }
  return null;
}

function saveExecutionStatus(sessionId, projectSlug, patch) {
  const file = getExecutionStatusFile(sessionId, normalizeProjectSlug(projectSlug || getProjectSlug()));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = (() => { try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return {}; } })();
  const updated = { ...existing, ...patch, session_id: sessionId, updated_at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(updated, null, 2));
  return updated;
}

function listStateProjects() {
  if (!fs.existsSync(GLOBAL_STATE_DIR)) return [];
  try {
    return fs.readdirSync(GLOBAL_STATE_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

// findSessionRecord — moved to lib/session.js
// getArchiveDir — moved to lib/session.js

function getLocksDir(projectSlug = getProjectSlug()) {
  return path.join(getProjectStateDir(projectSlug), LOCKS_SUBDIR);
}

function getSpeakerSelectionFile(projectSlug = getProjectSlug()) {
  return path.join(getProjectStateDir(projectSlug), SPEAKER_SELECTION_FILE);
}

// ── ADR-264 helpers ─────────────────────────────────────────────

// §2.2 Proxy Response Submission: verify external_output via SHA-256 digest
// so an orchestrator that pre-spawned a CLI/browser can submit responses
// without the server re-running the CLI. `verify: "none"` + source
// "trusted_orchestrator" is an explicit opt-out used only at a trust boundary.
export function verifyExternalOutputProof({
  external_output,
  external_output_proof,
  verify = "hash",
} = {}) {
  if (typeof external_output !== "string" || external_output.length === 0) {
    return { ok: false, code: "E_EXTERNAL_OUTPUT_MISSING" };
  }

  if (verify === "none") {
    if (external_output_proof?.source !== "trusted_orchestrator") {
      return { ok: false, code: "E_EXTERNAL_OUTPUT_PROOF_SOURCE_REQUIRED" };
    }
    return {
      ok: true,
      audit: {
        source: "trusted_orchestrator",
        verify: "none",
        length: Buffer.byteLength(external_output, "utf-8"),
      },
    };
  }

  if (!external_output_proof || typeof external_output_proof !== "object") {
    return { ok: false, code: "E_EXTERNAL_OUTPUT_PROOF_MISSING" };
  }
  if (external_output_proof.algo !== "sha256") {
    return { ok: false, code: "E_EXTERNAL_OUTPUT_PROOF_ALGO_UNSUPPORTED", algo: external_output_proof.algo };
  }
  const expected = String(external_output_proof.digest || "").toLowerCase();
  const actual = crypto.createHash("sha256").update(external_output, "utf-8").digest("hex");
  if (expected !== actual) {
    return { ok: false, code: "E_EXTERNAL_OUTPUT_PROOF_MISMATCH", expected, actual };
  }
  return {
    ok: true,
    audit: {
      source: external_output_proof.source || "unspecified",
      verify: "hash",
      digest: actual,
    },
  };
}

// §2.3 step 5 — reuse the same safeId regex as withSessionLock (lib/speaker-discovery
// invariant: only a-z A-Z 0-9 가-힣 . _ - survive). Prevents `../`, `/`, and
// null-byte path traversal when a caller supplies session_id.
export function sanitizeSessionDirName(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9가-힣._-]/g, "_");
}

// §2.3 steps 1-4, 7, 8 — resolve and audit an optional spawn_cwd against a
// prefix allowlist. Symlinks are allowed only if the realpath still satisfies
// the prefix check. Caller passes `allowedPrefixes` derived from
// ~/.config/mcp-deliberation/allowed-cwd-prefixes.json when present; otherwise
// defaults to $HOME + $TMPDIR so bench harnesses in /tmp work out of the box.
export function validateSpawnCwd(input, { allowedPrefixes } = {}) {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, code: "E_CWD_NOT_ABSOLUTE", input };
  }
  if (!path.isAbsolute(input)) {
    return { ok: false, code: "E_CWD_NOT_ABSOLUTE", input };
  }

  let resolved;
  try {
    resolved = fs.realpathSync(input);
  } catch (err) {
    const code = err && err.code === "ENOENT" ? "E_CWD_NOT_FOUND" : "E_CWD_NOT_FOUND";
    return { ok: false, code, input, error: err?.message };
  }

  const prefixesUnresolved = Array.isArray(allowedPrefixes) && allowedPrefixes.length > 0
    ? allowedPrefixes
    : [os.homedir(), os.tmpdir()];

  // Resolve the prefixes themselves so callers can pass "/tmp" and still match
  // realpath'd children like "/private/tmp/foo" on macOS.
  const prefixesResolved = prefixesUnresolved.map((p) => {
    try { return fs.realpathSync(p); } catch { return p; }
  });
  const prefixesAll = Array.from(new Set([...prefixesUnresolved, ...prefixesResolved]));

  const matches = (candidate, prefixList) =>
    prefixList.some((prefix) =>
      candidate === prefix || candidate.startsWith(prefix + path.sep),
    );

  const inputLooksAllowed = matches(input, prefixesAll);
  const resolvedLooksAllowed = matches(resolved, prefixesResolved);
  const symlinkCrossed = resolved !== input;

  // §2.3 step 3 — input path itself must be under an allowed prefix, so
  // passing "/etc/passwd" when tmpRoot is allowed immediately fails.
  if (!inputLooksAllowed) {
    return { ok: false, code: "E_CWD_NOT_ALLOWED", input, resolved, allowed_prefixes: prefixesResolved };
  }

  // §2.3 step 4 — input looked allowed, but realpath escapes → symlink attack.
  if (!resolvedLooksAllowed) {
    return { ok: false, code: "E_CWD_SYMLINK_ESCAPE", input, resolved, allowed_prefixes: prefixesResolved };
  }

  return { ok: true, input, resolved, allowed_prefixes: prefixesResolved, symlink_crossed: symlinkCrossed };
}

// §2.3 step 6 — create a per-session subdir under the resolved cwd so two
// concurrent cli_auto_turn calls do not share working state. Idempotent when
// the caller has already pointed at a matching session folder.
export function ensureSessionSubdir(resolvedCwd, sessionId) {
  let safe = sanitizeSessionDirName(sessionId);
  // `.` and `..` survive the ADR-specified regex but would climb out of
  // resolvedCwd when joined. Rewrite to a literal segment so the subdir is
  // always strictly nested.
  if (safe === "." || safe === "..") {
    safe = `_${safe.length === 2 ? "dotdot" : "dot"}`;
  }
  if (path.basename(resolvedCwd) === safe) {
    return resolvedCwd;
  }
  const target = path.join(resolvedCwd, safe);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

// §2.4 — normalize observability data into the {value, status} envelope that
// downstream aggregators skip (status !== "ok") before arithmetic. Fields not
// provided default to `adapter_missing`.
const OBS_FIELDS = [
  "tokens_in",
  "tokens_out",
  "estimated_cost_usd",
  "model_reported_by_cli",
  "actual_model_id",
];

export function buildObservabilityEnvelope(adapter) {
  const src = adapter && typeof adapter === "object" ? adapter : {};
  const out = {};
  for (const field of OBS_FIELDS) {
    const entry = src[field];
    if (entry && typeof entry === "object" && "status" in entry) {
      out[field] = { value: entry.value ?? null, status: String(entry.status) };
    } else {
      out[field] = { value: null, status: "adapter_missing" };
    }
  }
  return out;
}

function loadAllowedCwdPrefixes() {
  const overridePath = path.join(os.homedir(), ".config", "mcp-deliberation", "allowed-cwd-prefixes.json");
  try {
    const raw = fs.readFileSync(overridePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.prefixes) && parsed.prefixes.every((p) => typeof p === "string")) {
      return parsed.prefixes;
    }
    appendRuntimeLog("WARN", `ALLOWED_CWD_PREFIXES_SCHEMA: ${overridePath} lacks { prefixes: string[] }, falling back to defaults`);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      appendRuntimeLog("WARN", `ALLOWED_CWD_PREFIXES_LOAD: ${overridePath} parse failed (${err.message}), falling back to defaults`);
    }
  }
  return null;
}

function formatRuntimeError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

// ── Runtime log configuration (env-overridable) ────────────────
const LOG_MAX_SIZE_MB = Number(process.env.DELIBERATION_LOG_MAX_SIZE_MB) > 0
  ? Number(process.env.DELIBERATION_LOG_MAX_SIZE_MB)
  : 1;
const LOG_TOTAL_BUDGET_MB = Number(process.env.DELIBERATION_LOG_TOTAL_BUDGET_MB) > 0
  ? Number(process.env.DELIBERATION_LOG_TOTAL_BUDGET_MB)
  : 10;
const LOG_DEDUP_MS = Number.isFinite(Number(process.env.DELIBERATION_LOG_DEDUP_MS)) && Number(process.env.DELIBERATION_LOG_DEDUP_MS) >= 0
  ? Number(process.env.DELIBERATION_LOG_DEDUP_MS)
  : 1000;
const LOG_HARD_CAP_BYTES = LOG_MAX_SIZE_MB * 2 * 1024 * 1024; // race fallback: 2× per-file threshold
const LOG_TAIL_BYTES = 500 * 1024; // truncate to last 500 KB on hard-cap overflow
const LOG_PRE_UPGRADE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Module-level dedup state
let _dedupLastKey = null;
let _dedupLastWriteMs = 0;
let _dedupLastMessage = null;
let _dedupPendingCount = 0;

// Module-level upgrade-safety guard (once per process)
let _logUpgradeSafetyRan = false;

function _flushDedupToFile() {
  if (_dedupPendingCount <= 0) return;
  try {
    const elapsed = Date.now() - _dedupLastWriteMs;
    const summary = `${new Date().toISOString()} [DEDUP] [${_dedupPendingCount}x in ${elapsed}ms] ${_dedupLastMessage || ""}\n`;
    fs.appendFileSync(GLOBAL_RUNTIME_LOG, summary, "utf-8");
  } catch { /* ignore */ }
  _dedupPendingCount = 0;
}

function _runLogUpgradeSafetyOnce() {
  if (_logUpgradeSafetyRan) return;
  _logUpgradeSafetyRan = true;
  try {
    const dir = path.dirname(GLOBAL_RUNTIME_LOG);
    if (!fs.existsSync(dir)) return;
    const markerPath = path.join(dir, ".log-upgrade-v0.0.45");
    if (!fs.existsSync(markerPath)) {
      let totalSize = 0;
      const candidates = [];
      for (const name of fs.readdirSync(dir)) {
        if (!/^runtime\.log(\.|$)/.test(name)) continue;
        if (name.startsWith("runtime.log.pre-")) continue;
        const p = path.join(dir, name);
        try {
          const s = fs.statSync(p).size;
          totalSize += s;
          candidates.push(p);
        } catch { /* skip */ }
      }
      if (totalSize > 1024 * 1024) {
        const preBackup = GLOBAL_RUNTIME_LOG + ".pre-0.0.45";
        try {
          if (fs.existsSync(GLOBAL_RUNTIME_LOG) && !fs.existsSync(preBackup)) {
            fs.renameSync(GLOBAL_RUNTIME_LOG, preBackup);
          }
          // Any other rotated files (runtime.log.old etc.) — removed so normal
          // rotation can start fresh. The .pre-0.0.45 backup retains the latest.
          for (const p of candidates) {
            if (p === preBackup) continue;
            if (!fs.existsSync(p)) continue;
            try { fs.unlinkSync(p); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
      try { fs.writeFileSync(markerPath, new Date().toISOString()); } catch { /* ignore */ }
    }
    // Expire .pre-0.0.45 after 7 days OR on budget overflow
    try {
      const preBackup = GLOBAL_RUNTIME_LOG + ".pre-0.0.45";
      if (fs.existsSync(preBackup)) {
        const preStat = fs.statSync(preBackup);
        let totalDir = preStat.size;
        try {
          for (const name of fs.readdirSync(dir)) {
            if (!/^runtime\.log(\.|$)/.test(name)) continue;
            if (name === "runtime.log.pre-0.0.45") continue;
            try { totalDir += fs.statSync(path.join(dir, name)).size; } catch { /* skip */ }
          }
        } catch { /* skip */ }
        const age = Date.now() - preStat.mtimeMs;
        if (age > LOG_PRE_UPGRADE_EXPIRY_MS || totalDir > LOG_TOTAL_BUDGET_MB * 1024 * 1024) {
          try { fs.unlinkSync(preBackup); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  } catch { /* ignore */ }
}

function _rotateOrTruncate() {
  try {
    if (!fs.existsSync(GLOBAL_RUNTIME_LOG)) return;
    const stats = fs.statSync(GLOBAL_RUNTIME_LOG);
    // Hard cap: if file exceeds 2× per-file threshold (race under concurrent writers),
    // truncate in place to the last LOG_TAIL_BYTES to prevent runaway growth.
    if (stats.size > LOG_HARD_CAP_BYTES) {
      try {
        const fd = fs.openSync(GLOBAL_RUNTIME_LOG, "r");
        try {
          const tailStart = Math.max(0, stats.size - LOG_TAIL_BYTES);
          const buf = Buffer.alloc(stats.size - tailStart);
          fs.readSync(fd, buf, 0, buf.length, tailStart);
          fs.writeFileSync(GLOBAL_RUNTIME_LOG, buf, "utf-8");
        } finally {
          try { fs.closeSync(fd); } catch { /* ignore */ }
        }
      } catch { /* fall through */ }
      return;
    }
    if (stats.size > LOG_MAX_SIZE_MB * 1024 * 1024) {
      const oldLog = GLOBAL_RUNTIME_LOG + ".old";
      // Explicit cleanup: delete previous .old before rename (robustness over
      // atomic-rename-overwrite assumption, especially under concurrent writers).
      try {
        if (fs.existsSync(oldLog)) fs.unlinkSync(oldLog);
      } catch { /* ignore */ }
      try { fs.renameSync(GLOBAL_RUNTIME_LOG, oldLog); } catch { /* ignore */ }
    }
  } catch { /* ignore rotation failures */ }
}

function appendRuntimeLog(level, message) {
  try {
    fs.mkdirSync(path.dirname(GLOBAL_RUNTIME_LOG), { recursive: true });
    _runLogUpgradeSafetyOnce();

    const safeMessage = String(message ?? "");
    const key = `${level}:${safeMessage.slice(0, 200)}`;
    const now = Date.now();

    // Dedup: suppress repeated identical messages within window
    if (_dedupLastKey === key && (now - _dedupLastWriteMs) < LOG_DEDUP_MS) {
      _dedupPendingCount += 1;
      return;
    }

    // New key or window expired — flush prior suppression summary first
    if (_dedupPendingCount > 0) _flushDedupToFile();
    _dedupLastKey = key;
    _dedupLastWriteMs = now;
    _dedupLastMessage = `[${level}] ${safeMessage}`;

    _rotateOrTruncate();

    const line = `${new Date(now).toISOString()} [${level}] ${safeMessage}\n`;
    fs.appendFileSync(GLOBAL_RUNTIME_LOG, line, "utf-8");
  } catch {
    // ignore logging failures
  }
}

function safeToolHandler(toolName, handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      const message = formatRuntimeError(error);
      appendRuntimeLog("ERROR", `${toolName}: ${message}`);
      return { content: [{ type: "text", text: `❌ ${toolName} failed: ${message}` }] };
    }
  };
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, Math.floor(ms));
}

function writeTextAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, filePath);
}

function readJsonFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonFileAtomic(filePath, value) {
  writeTextAtomic(filePath, JSON.stringify(value, null, 2));
}

function acquireFileLock(lockPath, {
  timeoutMs = LOCK_TIMEOUT_MS,
  retryMs = LOCK_RETRY_MS,
  staleMs = LOCK_STALE_MS,
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, token, "utf-8");
      fs.closeSync(fd);
      return token;
    } catch (error) {
      const isExists = error && typeof error === "object" && "code" in error && error.code === "EEXIST";
      if (!isExists) {
        throw error;
      }

      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock might have been removed concurrently
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`lock timeout: ${lockPath}`);
      }
      sleepMs(retryMs);
    }
  }
}

function releaseFileLock(lockPath, token) {
  try {
    const current = fs.readFileSync(lockPath, "utf-8").trim();
    if (current === token) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // already released or replaced
  }
}

function withFileLock(lockPath, fn, options) {
  const token = acquireFileLock(lockPath, options);
  try {
    return fn();
  } finally {
    releaseFileLock(lockPath, token);
  }
}

function withProjectLock(projectSlug, fn, options) {
  if (typeof projectSlug === "function") {
    return withFileLock(path.join(getLocksDir(), "_project.lock"), projectSlug, fn);
  }
  return withFileLock(path.join(getLocksDir(projectSlug), "_project.lock"), fn, options);
}

function withSessionLock(sessionRef, fn, options) {
  const sessionId = typeof sessionRef === "object" && sessionRef !== null ? sessionRef.id : sessionRef;
  const explicitProject = typeof sessionRef === "object" && sessionRef !== null ? sessionRef.project : null;
  const record = findSessionRecord(sessionRef, { preferProject: explicitProject || getProjectSlug() });
  const projectSlug = explicitProject || record?.project || getProjectSlug();
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9가-힣._-]/g, "_");
  return withFileLock(path.join(getLocksDir(projectSlug), `${safeId}.lock`), fn, options);
}

// Speaker/Candidate Discovery functions moved to lib/speaker-discovery.js

// Browser control singleton — moved to lib/transport.js
// Session ID generation, context detection, state helpers, markdown sync,
// archival — all moved to lib/session.js
// Terminal management — moved to lib/transport.js

// multipleSessionsError, truncatePromptText, getPromptBudgetForSpeaker,
// formatRecentLogForPrompt — moved to lib/session.js
// getCliAutoTurnTimeoutSec, getCliExecArgs, buildCliAutoTurnFailureText — moved to lib/transport.js
// buildActiveReportingSection, buildClipboardTurnPrompt,
// submitDeliberationTurn — moved to lib/session.js

// ── MCP Server ─────────────────────────────────────────────────

// Gracefully handle EPIPE on stdout/stderr (MCP client disconnect)
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED") {
      process.exit(0);
    }
  });
}

// Module-level reentrance guard. Once a fatal handler has fired, subsequent
// invocations become no-ops. This breaks the EPIPE self-amplifying loop where
// writing the previous error's log line itself triggered another EPIPE.
let _hasHandledFatalError = false;

function _isBrokenStdioError(err) {
  if (!err) return false;
  const code = err.code;
  if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END") return true;
  const message = String(err?.message ?? err ?? "");
  return /EPIPE|write after end/i.test(message);
}

process.on("uncaughtException", (error) => {
  if (_hasHandledFatalError) return;
  if (_isBrokenStdioError(error)) {
    _hasHandledFatalError = true;
    try { _flushDedupToFile(); } catch { /* noop */ }
    try { appendRuntimeLog("INFO", "Client disconnected (EPIPE). Shutting down."); } catch { /* noop */ }
    try { process.exit(0); } catch { /* noop */ }
    return;
  }
  // Non-stdio fatal: log to file only. process.stderr.write was REMOVED here
  // because it was the re-trigger source when stdio was the broken channel.
  try { appendRuntimeLog("UNCAUGHT_EXCEPTION", formatRuntimeError(error)); } catch { /* noop */ }
});

process.on("unhandledRejection", (reason) => {
  if (_hasHandledFatalError) return;
  if (_isBrokenStdioError(reason)) {
    _hasHandledFatalError = true;
    try { _flushDedupToFile(); } catch { /* noop */ }
    try { appendRuntimeLog("INFO", "Client disconnected (EPIPE). Shutting down."); } catch { /* noop */ }
    try { process.exit(0); } catch { /* noop */ }
    return;
  }
  try { appendRuntimeLog("UNHANDLED_REJECTION", formatRuntimeError(reason)); } catch { /* noop */ }
});

// Flush any pending dedup summary on graceful exit so the tail summary is not lost
process.on("exit", () => {
  try { _flushDedupToFile(); } catch { /* noop */ }
});

// Read version from package.json (single source of truth)
const __pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "package.json");
const __pkgVersion = JSON.parse(fs.readFileSync(__pkgPath, "utf-8")).version;

// ── Initialize speaker-discovery module dependencies ──
initSpeakerDeps({
  appendRuntimeLog,
  loadDeliberationConfig,
  getProjectSlug,
  readJsonFileSafe,
  writeJsonFileAtomic,
  getSpeakerSelectionFile,
});

// ── Initialize telepty module dependencies ──
initTeleptyDeps({
  appendRuntimeLog,
  normalizeSpeaker,
  getProjectSlug,
  resolveTransportForSpeaker,
  generateTurnId,
  buildClipboardTurnPrompt,
});

// ── Initialize session module dependencies ──
initSessionDeps({
  appendRuntimeLog,
  writeTextAtomic,
  readJsonFileSafe,
  writeJsonFileAtomic,
  withSessionLock,
  getProjectSlug,
  normalizeProjectSlug,
  getProjectStateDir,
  getSessionsDir,
  getSessionFile,
  getSessionProject,
  listStateProjects,
  getLocksDir,
  GLOBAL_STATE_DIR,
});

// ── Initialize transport module dependencies ──
initTransportDeps({
  appendRuntimeLog,
  getProjectSlug,
  getSessionFile,
  withSessionLock,
  loadDeliberationConfig,
  resolveCdpEndpoints,
});

const server = new McpServer({
  name: "mcp-deliberation",
  version: __pkgVersion,
});

server.tool(
  "deliberation_start",
  "Start a new deliberation. Multiple deliberations can run simultaneously.",
  {
    topic: z.string().describe("Discussion topic"),
    session_id: z.string().trim().min(1).max(64).optional().describe("Explicit session ID to use. If omitted, one is generated from topic."),
    rounds: z.coerce.number().optional().describe("Number of rounds (defaults to config setting, default 3)"),
    first_speaker: z.string().trim().min(1).max(64).optional().describe("First speaker name (defaults to first item in speakers)"),
    selection_token: z.string().trim().min(1).max(128).optional().describe("Single-use token returned by deliberation_speaker_candidates. Required for fresh manual speaker selection."),
    speakers: z.preprocess(
      (v) => {
        const parsed = typeof v === "string" ? JSON.parse(v) : v;
        if (!Array.isArray(parsed)) return parsed;
        // Normalize: accept both string[] and {name, role?, instructions?}[]
        return parsed.map(item => (typeof item === "object" && item !== null && item.name) ? item.name : item);
      },
      z.array(z.string().trim().min(1).max(64)).min(1).optional()
    ).describe("Participant name list. Supports both string arrays and {name, role, instructions} object arrays"),
    speaker_instructions: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.record(z.string(), z.string()).optional()
    ).describe("Per-speaker additional instructions (e.g., {\"claude\": \"review critically\"})"),
    require_manual_speakers: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" : v),
      z.boolean().optional()
    ).describe("Deprecated toggle. Speakers are now always selected manually before start."),
    auto_discover_speakers: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" : v),
      z.boolean().optional()
    ).describe("Deprecated toggle. Auto-discovery no longer auto-joins participants; use deliberation_speaker_candidates instead."),
    include_browser_speakers: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" : v),
      z.boolean().optional()
    ).describe("Whether browser speakers are allowed to participate. Defaults to false unless explicitly enabled."),
    participant_types: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.record(z.string(), z.enum(["cli", "telepty", "browser", "browser_auto", "manual"])).optional()
    ).describe("Per-speaker type override (e.g., {\"chatgpt\": \"browser_auto\"})"),
    ordering_strategy: z.enum(["auto", "cyclic", "random", "weighted-random"]).optional()
      .describe("Ordering strategy: auto (automatic based on speaker count), cyclic (sequential), random (random each turn), weighted-random (less spoken speakers first)"),
    speaker_roles: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.record(z.string(), z.enum(["critic", "implementer", "mediator", "researcher", "free"])).optional()
    ).describe("Per-speaker role assignment (e.g., {\"claude\": \"critic\", \"codex\": \"implementer\"})"),
    role_preset: z.enum(["balanced", "debate", "research", "brainstorm", "review", "consensus"]).optional()
    .describe("Role preset (balanced/debate/research/brainstorm/review/consensus). Ignored if speaker_roles is specified"),
    auto_execute: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" : v),
      z.boolean().optional()
    ).describe("If true, automatically create a handoff task in the inbox when synthesis completes. Enables the Autonomous Deliberation Handoff pattern."),
    auto_synthesize: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" : v),
      z.boolean().optional()
    ).describe("If true, automatically generate synthesis when all rounds complete. Lighter than auto_execute (no handoff)."),
    mode: z.enum(["standard", "lite"]).default("standard").describe("Deliberation mode. 'lite' caps speakers to 3 and rounds to 2 for quick decisions."),
    session_ttl_ms: z.number().int().min(60000).max(86400000).optional()
      .describe("Session TTL in milliseconds. Sessions expire after this duration. Default: 7200000 (2 hours). Max: 86400000 (24 hours)."),
    orchestrator_session_id: z.string().trim().min(1).max(128).optional()
      .describe("Optional telepty session ID to notify on turn completion. Defaults to TELEPTY_SESSION_ID when available."),
  },
  safeToolHandler("deliberation_start", async ({ topic, session_id, rounds, first_speaker, selection_token, speakers, speaker_instructions, require_manual_speakers, auto_discover_speakers, include_browser_speakers, participant_types, ordering_strategy, speaker_roles, role_preset, auto_execute, auto_synthesize, mode, session_ttl_ms, orchestrator_session_id }) => {
    // ── First-time onboarding guard ──
    const config = loadDeliberationConfig();
    if (!config.setup_complete) {
      const candidateSnapshot = await collectSpeakerCandidates({ include_cli: true, include_browser: true });
      const candidateText = formatSpeakerCandidatesReport(candidateSnapshot);
      return {
        content: [{
          type: "text",
          text: `🎉 **Welcome to Deliberation!**\n\nPlease configure basic settings before starting.\n\n**Currently detected speakers:**\n${candidateText}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nYou can set the remaining defaults with:\n\n\`\`\`\ndeliberation_cli_config(\n  include_browser_speakers: false,\n  default_rounds: 3,\n  default_ordering: "auto"\n)\n\`\`\`\n\n**1. Speaker participation mode**\n   - Always manual — participants are selected fresh at every start from the current candidate snapshot\n\n**2. Browser speakers** (\`include_browser_speakers\`)\n   - \`false\` — CLI + telepty sessions only (recommended)\n   - \`true\` — Include browser LLM speakers too\n\n**3. Default rounds** (\`default_rounds\`)\n   - \`1\` — Quick consensus\n   - \`3\` — Default (recommended)\n   - \`5\` — Deep discussion\n\n**4. Ordering strategy** (\`default_ordering\`)\n   - \`"auto"\` — cyclic for 2 speakers, weighted-random for 3+ (recommended)\n   - \`"cyclic"\` — Fixed order\n   - \`"random"\` — Random each turn\n   - \`"weighted-random"\` — Less spoken speakers first`,
        }],
      };
    }

    const sessionId = session_id || generateSessionId(topic);
    if (session_id) {
      const existing = loadSession(session_id);
      if (existing && existing.status === "active") {
        return { content: [{ type: "text", text: `❌ Session "${session_id}" is already active. Please use a different ID or reset it first.` }] };
      }
    }
    const explicitBrowserSelection = hasExplicitBrowserParticipantSelection({ speakers, participant_types });
    const includeBrowserSpeakers = resolveIncludeBrowserSpeakers({
      include_browser_speakers,
      config,
      speakers,
      participant_types,
    });
    if (explicitBrowserSelection && !includeBrowserSpeakers) {
      return {
        content: [{
          type: "text",
          text: `❌ Browser speakers are currently disabled.\n\nThis deliberation server now defaults to CLI-only participation to avoid browser timeouts blocking the session.\n\nTo include browser speakers, opt in explicitly:\n\`\`\`\ndeliberation_start(\n  topic: "${topic.replace(/"/g, '\\"')}",\n  speakers: ${JSON.stringify(speakers || ["claude", "codex"])},\n  include_browser_speakers: true,\n  require_manual_speakers: true\n)\n\`\`\`\n\nOr save it in config:\n\`deliberation_cli_config(include_browser_speakers: true)\``,
        }],
      };
    }

    const candidateSnapshot = await collectSpeakerCandidates({
      include_cli: true,
      include_browser: includeBrowserSpeakers,
    });

    // Resolve effective settings from config
    const effectiveRequireManual = true;
    const effectiveAutoDiscover = false;
    rounds = rounds ?? config.default_rounds ?? 3;
    const rawOrdering = ordering_strategy ?? config.default_ordering ?? "auto";
    // Resolve "auto": 2 speakers → cyclic, 3+ → weighted-random
    ordering_strategy = rawOrdering === "auto" ? undefined : rawOrdering; // resolved after speakers are known

    const manualSpeakersProvided = Array.isArray(speakers) && speakers.length > 0;
    let selectionValidation = { ok: true };
    if (effectiveRequireManual && manualSpeakersProvided) {
      // ADR-264 §2.1 — read-validate-consume wrapped in withProjectLock so two
      // MCP server processes racing on the same speaker-selection.json cannot
      // both observe the same token as unconsumed.
      selectionValidation = withProjectLock(getProjectSlug(), () => {
        const persistedState = loadSpeakerSelectionToken();
        const result = validateSpeakerSelectionRequest({
          selectionState: persistedState,
          selection_token,
          speakers,
          includeBrowserSpeakers,
        });
        if (result.ok) {
          markSelectionTokenConsumed({ selectionState: persistedState });
        }
        return result;
      });
    }
    const hasManualSpeakers = manualSpeakersProvided && (!effectiveRequireManual || selectionValidation.ok);

    if (manualSpeakersProvided && effectiveRequireManual && !selectionValidation.ok) {
      const candidateText = formatSpeakerCandidatesReport(candidateSnapshot);
      const mismatchNote = selectionValidation.code === "speaker_mismatch"
        ? `\n\nRequested speakers not in the latest candidate snapshot: ${(selectionValidation.missing_speakers || []).join(", ")}`
        : selectionValidation.code === "selected_speakers_mismatch"
          ? `\n\nThis token is bound to a different speaker set.\nExpected: ${(selectionValidation.expected_speakers || []).join(", ")}\nRequested: ${(selectionValidation.requested_speakers || []).join(", ")}`
          : "";
      const confirmationNote = selectionValidation.code === "selection_not_confirmed"
        ? "\n\nThe token you passed is only a candidate snapshot token. You must confirm the exact user-picked speakers before start."
        : "";
      return {
        content: [{
          type: "text",
          text: `Fresh participant selection is required before each deliberation start.${confirmationNote}${mismatchNote}\n\n1. Call \`deliberation_speaker_candidates(include_cli: true, include_browser: ${includeBrowserSpeakers ? "true" : "false"})\`\n2. Show the speaker list in the TUI and let the user choose participants\n3. Call \`deliberation_confirm_speakers(selection_token: "<candidate-token>", speakers: [...])\`\n4. Pass the returned confirmed \`selection_token\` into \`deliberation_start(..., selection_token: "...", speakers: [...])\`\n\n${candidateText}`,
        }],
      };
    }

    if (!hasManualSpeakers && effectiveRequireManual) {
      const candidateText = formatSpeakerCandidatesReport(candidateSnapshot);
      const llmSuggested = Array.isArray(speakers) && speakers.length > 0
        ? `\n\n💡 **LLM suggested speakers:** ${speakers.join(", ")}\nShow the candidate list in the TUI, let the user confirm, then call \`deliberation_confirm_speakers\` with the final speaker list.`
        : "";
      const configNote = "\n\n⚙️ Manual speaker selection is enabled and requires a fresh confirmed `selection_token`.";
      return {
        content: [{
          type: "text",
          text: `Speakers must be manually selected to start a deliberation.${configNote}${llmSuggested}\n\n${candidateText}\n\nExample:\n\n1. \`deliberation_speaker_candidates(...)\`\n2. User picks speakers in the TUI\n3. \`deliberation_confirm_speakers(selection_token: "<candidate-token>", speakers: ["claude", "codex", "gemini"])\`\n4. \`deliberation_start(\n  topic: "${topic.replace(/"/g, '\\"')}",\n  selection_token: "<confirmed-token>",\n  rounds: ${rounds},\n  speakers: ["claude", "codex", "gemini"],\n  require_manual_speakers: true,\n  first_speaker: "codex"\n)\`\n\nFirst call deliberation_speaker_candidates to check currently available speakers.`,
        }],
      };
    }

    let autoDiscoveredSpeakers = [];
    let autoParticipantTypes = {};
    if (!hasManualSpeakers && effectiveAutoDiscover) {
      for (const c of candidateSnapshot.candidates) {
        autoDiscoveredSpeakers.push(c.speaker);
        if (c.type === "browser" && c.cdp_available) {
          autoParticipantTypes[c.speaker] = "browser_auto";
        } else if (c.type === "browser") {
          autoParticipantTypes[c.speaker] = "browser";
        } else {
          autoParticipantTypes[c.speaker] = "cli";
        }
      }
    }
    // Merge auto-detected participant_types with manual overrides
    if (!hasManualSpeakers && Object.keys(autoParticipantTypes).length > 0) {
      participant_types = { ...autoParticipantTypes, ...(participant_types || {}) };
    }
    const selectedSpeakers = dedupeSpeakers(hasManualSpeakers
      ? speakers
      : autoDiscoveredSpeakers);
    const callerSpeaker = (!hasManualSpeakers && !first_speaker)
      ? detectCallerSpeaker()
      : null;

    const normalizedFirstSpeaker = normalizeSpeaker(first_speaker)
      || normalizeSpeaker(hasManualSpeakers ? selectedSpeakers?.[0] : callerSpeaker)
      || normalizeSpeaker(selectedSpeakers?.[0])
      || DEFAULT_SPEAKERS[0];
    let speakerOrder = buildSpeakerOrder(selectedSpeakers, normalizedFirstSpeaker, "front");

    // ADR-264 §2.1 — selection token has already been stamped `consumed_at`
    // inside withProjectLock above. Leaving the file in place with the tombstone
    // lets any racing caller surface `token_already_consumed` instead of the
    // more ambiguous `missing_selection_state`. TTL garbage-collects it.

    // Lite mode: cap speakers and rounds for quick decisions
    if (mode === "lite") {
      if (speakerOrder.length > 3) {
        speakerOrder.splice(3);
      }
      if (rounds > 2) {
        rounds = 2;
      }
    }

    // Warn if only 1 speaker — deliberation requires 2+
    if (speakerOrder.length < 2) {
      const candidateText = formatSpeakerCandidatesReport(candidateSnapshot);
      return {
        content: [{
          type: "text",
          text: `⚠️ Deliberation requires at least 2 speakers. Currently only ${speakerOrder.length} specified: ${speakerOrder.join(", ")}\n\nAvailable speaker candidates:\n${candidateText}\n\nExample:\ndeliberation_start(topic: "${topic.slice(0, 50)}...", speakers: ["claude", "codex", "gemini"])`,
        }],
      };
    }

    // Liveness check: verify CLI speakers are actually executable
    const cliSpeakersInOrder = speakerOrder.filter(s => !s.startsWith("web-"));
    const nonLiveCli = [];
    for (const s of cliSpeakersInOrder) {
      if (!checkCliLiveness(s)) {
        nonLiveCli.push(s);
      }
    }
    // Warn but proceed — user explicitly selected these speakers.
    // cli_auto_turn will handle runtime errors per-turn.
    let detectWarningLiveness = "";
    if (nonLiveCli.length > 0) {
      detectWarningLiveness = `\n\n⚠️ Some CLIs are currently not executable but proceeding per user selection:\n${nonLiveCli.map(s => `  - \`${s}\` ❌`).join("\n")}\nCLI execution will be retried during turns. Errors will be reported on failure.`;
    }

    const participantMode = hasManualSpeakers
      ? "user-selected"
      : (autoDiscoveredSpeakers.length > 0 ? "auto-discovered (PATH)" : "default");

    const degradationLevels = await detectDegradationLevels();

    const state = {
      id: sessionId,
      project: getProjectSlug(),
      topic,
      lang: detectLang(topic),
      status: "active",
      max_rounds: rounds,
      current_round: 1,
      current_speaker: normalizedFirstSpeaker,
      speakers: speakerOrder,
      participant_profiles: mapParticipantProfiles(speakerOrder, candidateSnapshot.candidates, participant_types),
      log: [],
      synthesis: null,
      pending_turn_id: generateTurnId(),
      monitor_terminal_window_ids: [],
      ordering_strategy: ordering_strategy || (speakerOrder.length <= 2 ? "cyclic" : "weighted-random"),
      speaker_roles: speaker_roles || (role_preset ? applyRolePreset(role_preset, speakerOrder) : {}),
      degradation: degradationLevels,
      auto_execute: auto_execute || false,
      auto_synthesize: auto_synthesize || auto_execute || false,
      mode: mode || "standard",
      session_ttl_ms: session_ttl_ms || DEFAULT_SESSION_TTL_MS,
      orchestrator_session_id: orchestrator_session_id || getDefaultOrchestratorSessionId() || null,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };

    // Ensure CDP is ready if any speaker requires browser transport
    const hasBrowserSpeaker = state.participant_profiles.some(
      p => p.type === "browser" || p.type === "browser_auto"
    );
    if (hasBrowserSpeaker) {
      const cdpReady = await ensureCdpAvailable();
      if (!cdpReady.available) {
        return {
          content: [{
            type: "text",
            text: `❌ Browser LLM speakers included but cannot connect to CDP.\n\n${cdpReady.reason}\n\nCall deliberation_start again after establishing CDP connection.`,
          }],
        };
      }
    }

    withSessionLock(sessionId, () => {
      saveSession(state);
    });

    const active = listActiveSessions();
    const tmuxOpened = spawnMonitorTerminal(sessionId);
    const terminalOpenResult = tmuxOpened
      ? openPhysicalTerminal(sessionId)
      : { opened: false, windowIds: [] };
    const terminalWindowIds = Array.isArray(terminalOpenResult.windowIds)
      ? terminalOpenResult.windowIds
      : [];
    const physicalOpened = terminalOpenResult.opened === true;
    if (terminalWindowIds.length > 0) {
      withSessionLock(sessionId, () => {
        const latest = loadSession(sessionId);
        if (!latest) return;
        latest.monitor_terminal_window_ids = terminalWindowIds;
        saveSession(latest);
      });
      state.monitor_terminal_window_ids = terminalWindowIds;
    }
    const isWin = process.platform === "win32";
    const terminalMsg = !tmuxOpened
      ? isWin
        ? `\n⚠️ Windows Terminal not found, monitor terminal not created`
        : `\n⚠️ tmux not found, monitor terminal not created`
      : physicalOpened
        ? isWin
          ? `\n🖥️ Monitor terminal opened (Windows Terminal)`
          : `\n🖥️ Monitor terminal opened: tmux new-session -t ${TMUX_SESSION}`
        : isWin
          ? `\n⚠️ Monitor terminal auto-open failed`
          : `\n⚠️ tmux window created but external terminal auto-open failed. Manual run: tmux new-session -t ${TMUX_SESSION}`;
    const manualNotDetected = hasManualSpeakers
      ? speakerOrder.filter(s => !candidateSnapshot.candidates.some(c => c.speaker === s))
      : [];
    const detectWarning = manualNotDetected.length > 0
      ? `\n\n⚠️ Speakers not immediately detected in current environment: ${manualNotDetected.join(", ")}\n(Can still participate via manual specification)`
      : "";

    const transportSummary = state.participant_profiles.map(p => {
      const { transport } = resolveTransportForSpeaker(state, p.speaker);
      return `  - \`${p.speaker}\`: ${transport} (${p.type})`;
    }).join("\n");

    appendRuntimeLog("INFO", `SESSION_CREATED: ${sessionId} | topic: ${topic.slice(0, 60)} | speakers: ${speakerOrder.join(",")} | rounds: ${rounds}`);

    // Auto-handoff: kick off background orchestration
    // auto_execute = full handoff (turns + synthesis + bus notification)
    // auto_synthesize = lighter (turns + synthesis only, no bus notification)
    if (auto_execute || auto_synthesize) {
      // Fire-and-forget — runs in background
      runAutoHandoff(sessionId).catch(err => {
        appendRuntimeLog("ERROR", `AUTO_HANDOFF_SPAWN_ERROR: ${sessionId} | ${err.message}`);
      });
    }

    return {
      content: [{
        type: "text",
        text: `✅ Deliberation started! Forum created.\n\n**Session:** ${sessionId}\n**Project:** ${state.project}\n**Topic:** ${topic}\n**Rounds:** ${rounds}\n**Ordering:** ${state.ordering_strategy || "cyclic"}\n**Participant mode:** ${participantMode}\n**Participants:** ${speakerOrder.join(", ")}\n**First speaker:** ${state.current_speaker}\n**Concurrent sessions:** ${active.length}${terminalMsg}${detectWarning}${detectWarningLiveness}\n\n**Role assignments:**${role_preset ? ` (preset: ${role_preset})` : ""}\n${speakerOrder.map(s => `  - \`${s}\`: ${(state.speaker_roles || {})[s] || "free"}`).join("\n")}\n\n**Environment status:**\n${formatDegradationReport(state.degradation)}\n\n**Transport routing:**\n${transportSummary}\n\n💡 Use session_id: "${sessionId}" for subsequent tool calls.\n📋 Check forum status: \`deliberation_status(session_id: "${sessionId}")\``,
      }],
    };
  })
);

server.tool(
  "deliberation_speaker_candidates",
  "Query available speaker candidates (local CLI + telepty active sessions + browser LLM tabs).",
  {
    include_cli: z.boolean().default(true).describe("Include local CLI candidates"),
    include_browser: z.boolean().default(true).describe("Include browser LLM tab candidates"),
  },
  async ({ include_cli, include_browser }) => {
    const snapshot = await collectSpeakerCandidates({ include_cli, include_browser });
    // ADR-264 §2.1 — issue inside withProjectLock and warn when overwriting a
    // confirmed-but-not-consumed state so racing consumers cannot silently
    // invalidate a token already promised to a start call in flight.
    const selection = withProjectLock(getProjectSlug(), () => {
      const existing = loadSpeakerSelectionToken();
      if (existing?.phase === "confirmed" && !existing.consumed_at) {
        appendRuntimeLog(
          "WARN",
          `SELECTION_OVERWRITE_CONFIRMED: project=${getProjectSlug()} | token=${existing.token} | selected=${(existing.selected_speakers || []).join(",")}`,
        );
      }
      return issueSpeakerSelectionToken({
        candidates: snapshot.candidates,
        include_browser,
      });
    });
    const text = formatSpeakerCandidatesReport(snapshot);
    return {
      content: [{
        type: "text",
        text: `${text}\n\n**Candidate token:** \`${selection.token}\`\nAfter the user picks participants in the TUI, call \`deliberation_confirm_speakers(selection_token: "${selection.token}", speakers: [...])\` to mint a confirmed start token. Raw candidate tokens cannot start a deliberation.\n\n${PRODUCT_DISCLAIMER}`,
      }],
    };
  }
);

server.tool(
  "deliberation_confirm_speakers",
  "Bind a fresh candidate token to the exact CLI/telepty/browser speakers the user chose in the TUI.",
  {
    selection_token: z.string().trim().min(1).max(128).describe("Candidate token returned by deliberation_speaker_candidates."),
    speakers: z.array(z.string().trim().min(1)).min(1).describe("Exact speakers the user selected in the TUI."),
  },
  async ({ selection_token, speakers }) => {
    const selectionState = loadSpeakerSelectionToken();
    const includeBrowserSpeakers = !!selectionState?.include_browser;
    const confirmation = confirmSpeakerSelectionToken({
      selectionState,
      selection_token,
      speakers,
      includeBrowserSpeakers,
    });

    if (!confirmation.ok) {
      const candidateText = formatSpeakerCandidatesReport(await collectSpeakerCandidates({
        include_cli: true,
        include_browser: includeBrowserSpeakers,
      }));
      const mismatchNote = confirmation.code === "speaker_mismatch"
        ? `\n\nRequested speakers not in the latest candidate snapshot: ${(confirmation.missing_speakers || []).join(", ")}`
        : "";
      return {
        content: [{
          type: "text",
          text: `Speaker confirmation failed.${mismatchNote}\n\n1. Call \`deliberation_speaker_candidates\` for a fresh snapshot\n2. Let the user choose speakers in the TUI\n3. Call \`deliberation_confirm_speakers\` with that exact selection\n\n${candidateText}`,
        }],
      };
    }

    return {
      content: [{
        type: "text",
        text: `✅ Speaker selection confirmed.\n\n**Selected speakers:** ${confirmation.selectionState.selected_speakers.join(", ")}\n**Confirmed selection token:** \`${confirmation.selectionState.token}\`\n\nUse this exact token with the same speaker list in \`deliberation_start(..., selection_token: "...", speakers: [...])\`.\nIf the user changes the selection, call \`deliberation_speaker_candidates\` again for a fresh snapshot.`,
      }],
    };
  }
);

server.tool(
  "deliberation_list_active",
  "List all active deliberation sessions in the current project.",
  {},
  async () => {
    const active = listActiveSessions();
    if (active.length === 0) {
      return { content: [{ type: "text", text: "No active deliberations." }] };
    }

    let list = `## Active Deliberations (${getProjectSlug()}) — ${active.length}\n\n`;
    for (const s of active) {
      list += `### ${s.id}\n- **Topic:** ${s.topic}\n- **Status:** ${s.status} | Round ${s.current_round}/${s.max_rounds} | Next: ${s.current_speaker}\n- **Responses:** ${s.log.length}\n\n`;
    }
    return { content: [{ type: "text", text: list }] };
  }
);

server.tool(
  "deliberation_status",
  "Query deliberation status. Auto-selects if only one active session, requires session_id for multiple.",
  {
    session_id: z.string().optional().describe("Session ID (required if multiple sessions are active)"),
  },
  async ({ session_id }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: "No active deliberation. Start one with deliberation_start." }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state) {
      return { content: [{ type: "text", text: `Session "${resolved}" not found.` }] };
    }

    if (isSessionExpired(state)) {
      state.status = "expired";
      state.current_speaker = "none";
      state.expired_reason = "ttl_exceeded";
      saveSession(state);
      return {
        content: [{
          type: "text",
          text: `⏰ Session "${resolved}" has expired (TTL exceeded).\nTopic: ${state.topic}\nCreated: ${state.created}\n\nUse \`deliberation_reset(session_id: "${resolved}")\` to clean up, or start a new deliberation.`,
        }],
      };
    }

    const execStatus = loadExecutionStatus(state.id, state.project);
    const execLine = execStatus
      ? `\n**Execution status:** ${execStatus.execution_status}${execStatus.tasks_total > 0 ? ` (${execStatus.tasks_done}/${execStatus.tasks_total} tasks)` : ""}${execStatus.note ? ` — ${execStatus.note}` : ""}`
      : "";
    return {
      content: [{
        type: "text",
        text: `📋 **Forum Status** — ${state.id}\n\n**Project:** ${state.project}\n**Topic:** ${state.topic}\n**Status:** ${state.status === "active" ? "active" : state.status === "awaiting_synthesis" ? "awaiting synthesis" : state.status === "completed" ? "completed" : state.status} (Round ${state.current_round}/${state.max_rounds})${execLine}\n**Participants:** ${state.speakers.join(", ")}\n**Current turn:** ${state.current_speaker}\n**Accumulated responses:** ${state.log.length}${state.degradation ? `\n\n**Environment status:**\n${formatDegradationReport(state.degradation)}` : ""}`,
      }],
    };
  }
);

server.tool(
  "deliberation_context",
  "Load project context (markdown files) from the current working directory.",
  {},
  async () => {
    const dirs = detectContextDirs();
    const context = readContextFromDirs(dirs);
    return {
      content: [{
        type: "text",
        text: `## Project Context (${getProjectSlug()})\n\n**Source:** ${dirs.join(", ")}\n\n${context}`,
      }],
    };
  }
);

server.tool(
  "deliberation_browser_llm_tabs",
  "Query LLM tabs currently open in the browser (chatgpt/claude/gemini etc).",
  {},
  async () => {
    const { tabs, note } = await collectBrowserLlmTabs();
    if (tabs.length === 0) {
      const suffix = note ? `\n\n${note}` : "";
      return { content: [{ type: "text", text: `No LLM tabs detected.${suffix}` }] };
    }

    const lines = tabs.map((t, i) => `${i + 1}. [${t.browser}] ${t.title}\n   ${t.url}`).join("\n");
    const noteLine = note ? `\n\nℹ️ ${note}` : "";
    return { content: [{ type: "text", text: `## Browser LLM Tabs\n\n${lines}${noteLine}\n\n${PRODUCT_DISCLAIMER}` }] };
  }
);

server.tool(
  "deliberation_route_turn",
  "Auto-determine and guide the transport for the current turn's speaker. Routes CLI speakers to auto-response and browser speakers to clipboard.",
  {
    session_id: z.string().optional().describe("Session ID (required if multiple sessions are active)"),
    auto_prepare_clipboard: z.boolean().default(true).describe("Auto-run clipboard prepare for browser speakers"),
    prompt: z.string().optional().describe("Additional instructions to pass to browser LLM"),
    include_history_entries: z.number().int().min(0).max(12).default(4).describe("Number of recent log entries to include in prompt"),
  },
  safeToolHandler("deliberation_route_turn", async ({ session_id, auto_prepare_clipboard, prompt, include_history_entries }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: "No active deliberation." }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state || state.status !== "active") {
      return { content: [{ type: "text", text: `Session "${resolved}" is not active.` }] };
    }

    const speaker = state.current_speaker;
    let { transport, profile, reason } = resolveTransportForSpeaker(state, speaker);
    const turnId = state.pending_turn_id || null;

    // ── Self-speaker detection ──
    // If the current speaker is the same CLI as the orchestrator (caller),
    // cli_auto_turn would recursively spawn the same process and timeout.
    // Instead, instruct the orchestrator to respond directly.
    const callerSpeaker = detectCallerSpeaker();
    const isSelfSpeaker = callerSpeaker && speaker === callerSpeaker && transport === "cli_respond";

    let guidance;
    if (isSelfSpeaker) {
      guidance = t(
        `🟢 **It's your turn.** You (${speaker}) are the current speaker.\n\n` +
        `Write your response and submit via \`deliberation_respond(session_id: "${state.id}", speaker: "${speaker}", content: "...")\`.\n\n` +
        `⚠️ **Wait! Why can't I use cli_auto_turn?**\n` +
        `You are currently the **orchestrator** (the AI running this tool). If you try to spawn yourself automatically, it would create an infinite loop (you calling yourself calling yourself...) and timeout.\n\n` +
        `Please analyze the topic and history above, formulate your response, and call \`deliberation_respond\` directly.`,
        `🟢 **당신의 차례입니다.** 당신(${speaker})이 현재 발언자입니다.\n\n` +
        `응답을 작성하고 \`deliberation_respond(session_id: "${state.id}", speaker: "${speaker}", content: "...")\`를 통해 제출하세요.\n\n` +
        `⚠️ **잠깐! 왜 cli_auto_turn을 쓸 수 없나요?**\n` +
        `당신은 현재 **오케스트레이터**(이 도구를 실행 중인 AI)입니다. 자기 자신을 자동으로 spawn하려고 하면 무한 루프(자신이 자신을 호출하고 다시 호출하는...)가 발생하여 타임아웃이 됩니다.\n\n` +
        `위의 주제와 이력을 분석하여 응답을 작성한 뒤, \`deliberation_respond\`를 직접 호출해 주세요.`,
        state?.lang
      );
    } else {
      guidance = formatTransportGuidance(transport, state, speaker);
    }

    let extra = "";
    let turnPrompt = "";
    let manualFallbackPrompt = false;

    if (transport === "telepty_bus") {
      const dispatchResult = await dispatchTeleptyTurnRequest({
        state,
        speaker,
        prompt,
        includeHistoryEntries: include_history_entries,
        awaitSemantic: false,
      });
      turnPrompt = dispatchResult.turnPrompt;
      const { envelope, publishResult, transportResult, busReady, health } = dispatchResult;

      if (!dispatchResult.ok && dispatchResult.stage === "publish") {
        manualFallbackPrompt = true;
        extra += `\n\n❌ Telepty bus publish failed: ${publishResult.error || publishResult.status || "unknown error"}\n` +
                 `Fallback: use manual telepty inject for this turn.`;
        guidance = formatTransportGuidance("manual", state, speaker);
      } else {
        const healthLine = health
          ? `\n**Session health:** alive=${health.payload?.alive === true ? "yes" : "no"}, pid=${health.payload?.pid || "n/a"}, age=${Math.max(0, Math.round((health.age_ms || 0) / 1000))}s${health.stale ? " (stale)" : ""}`
          : "";
        const transportLine = transportResult.ok
          ? `✅ Transport ack received via \`inject_written\` within ${TELEPTY_TRANSPORT_TIMEOUT_MS / 1000}s.`
          : `⚠️ Transport ack not observed within ${TELEPTY_TRANSPORT_TIMEOUT_MS / 1000}s. The request was published, but delivery is still best-effort.`;
        const subscriberLine = busReady.ok
          ? "- Bus subscriber: connected"
          : `- Bus subscriber: unavailable (${busReady.error || busReady.status || "unknown"})`;
        if (!transportResult.ok) {
          manualFallbackPrompt = true;
        }
        extra += `\n\n### Telepty Bus Dispatch\n` +
                 `- Envelope: \`${envelope.message_id}\`\n` +
                 `- Kind: \`${envelope.kind}\`\n` +
                 `- Target: \`${envelope.target}\`\n` +
                 `- Delivered subscribers: ${publishResult.delivered ?? "unknown"}\n` +
                 `${subscriberLine}\n` +
                 `- Transport timeout: ${TELEPTY_TRANSPORT_TIMEOUT_MS / 1000}s\n` +
                 `- Semantic timeout: ${TELEPTY_SEMANTIC_TIMEOUT_MS / 1000}s${healthLine}\n\n` +
                 `${transportLine}\n\n` +
                 `The remote telepty session must still self-submit its response with \`deliberation_respond(session_id: "${state.id}", speaker: "${speaker}", ...)\` before the semantic timeout.`;
      }
    }

    if (transport === "browser_auto") {
      // Auto-execute browser_auto_turn
      try {
        const port = getBrowserPort();
        const sessionId = state.id;
        const turnSpeaker = speaker;
        const turnProvider = profile?.provider || "chatgpt";

        // Dynamic model selection
        const modelSelection = getModelSelectionForTurn(state, turnSpeaker, turnProvider);

        // Build prompt
        turnPrompt = buildClipboardTurnPrompt(state, turnSpeaker, prompt, include_history_entries);

        // Attach
        const attachResult = await port.attach(sessionId, { provider: turnProvider, url: profile?.url });
        if (!attachResult.ok) throw new Error(`attach failed: ${attachResult.error?.message}`);

        // Switch model if needed
        if (modelSelection.model !== 'default') {
          await port.switchModel(sessionId, modelSelection.model);
        }

        // Send turn
        const autoTurnId = turnId || `auto-${Date.now()}`;
        const sendResult = await port.sendTurnWithDegradation(sessionId, autoTurnId, turnPrompt);
        if (!sendResult.ok) throw new Error(`send failed: ${sendResult.error?.message}`);

        // Wait for response
        const waitResult = await port.waitTurnResult(sessionId, autoTurnId, 45);
        const degradationState = port.getDegradationState(sessionId);
        await port.detach(sessionId);

        if (waitResult.ok && waitResult.data?.response) {
          // Auto-submit the response
          submitDeliberationTurn({
            session_id: sessionId,
            speaker: turnSpeaker,
            content: waitResult.data.response,
            turn_id: state.pending_turn_id || generateTurnId(),
            channel_used: "browser_auto",
            fallback_reason: null,
          });
          const routeModelInfo = modelSelection.model !== 'default' ? ` | model: ${modelSelection.model}` : "";
          extra = `\n\n⚡ Auto-execution complete! Browser LLM response was automatically submitted. (${waitResult.data.elapsedMs}ms${routeModelInfo})`;
        } else {
          throw new Error(waitResult.error?.message || "no response received");
        }
      } catch (autoErr) {
        const errMsg = autoErr instanceof Error ? autoErr.message : String(autoErr);
        extra = `\n\n⚠️ Auto-execution failed (${errMsg}). Restart Chrome with --remote-debugging-port=9222.`;
        // Fallback to clipboard preparation
        transport = "clipboard";
        // Re-generate guidance for the new transport
        if (!isSelfSpeaker) {
          guidance = formatTransportGuidance(transport, state, speaker);
        }
      }
    }

    if (transport === "clipboard" || transport === "manual") {
      // Prepare prompt for manual/clipboard transport
      turnPrompt = buildClipboardTurnPrompt(state, speaker, prompt, include_history_entries);

      if (auto_prepare_clipboard) {
        try {
          writeClipboardText(turnPrompt);
        } catch (clipErr) {
          extra += `\n\n⚠️ Failed to copy to clipboard: ${clipErr.message}`;
        }
      }

      extra += `\n\n### [turn_prompt]\n\`\`\`markdown\n${turnPrompt}\n\`\`\``;
    }

    if (transport === "telepty_bus" && manualFallbackPrompt) {
      extra += `\n\n### [turn_prompt]\n\`\`\`markdown\n${turnPrompt}\n\`\`\``;
    }

    const profileInfo = profile
      ? `\n**Profile:** ${profile.type}${profile.url ? ` | ${profile.url}` : ""}${profile.command ? ` | command: ${profile.command}` : ""}`
        : "";

    return {
      content: [{
        type: "text",
        text: `## Turn Routing — ${state.id}\n\n**Current speaker:** ${speaker}\n**Transport:** ${transport}${reason ? ` (fallback: ${reason})` : ""}${profileInfo}\n**Role:** ${(state.speaker_roles || {})[speaker] || "free"}\n**Turn ID:** ${turnId || "(none)"}\n**Round:** ${state.current_round}/${state.max_rounds}\n**Ordering:** ${state.ordering_strategy || "cyclic"}\n\n${guidance}${extra}\n\n${PRODUCT_DISCLAIMER}`,
      }],
    };
  })
);

server.tool(
  "deliberation_browser_auto_turn",
  "Automatically send a turn to a browser LLM and collect the response (CDP-based).",
  {
    session_id: z.string().optional().describe("Session ID (required if multiple sessions are active)"),
    provider: z.string().optional().default("chatgpt").describe("LLM provider (chatgpt, claude, gemini)"),
    timeout_sec: z.number().optional().default(45).describe("Response wait timeout (seconds)"),
  },
  safeToolHandler("deliberation_browser_auto_turn", async ({ session_id, provider, timeout_sec }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: "No active deliberation." }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state || state.status !== "active") {
      return { content: [{ type: "text", text: `Session "${resolved}" is not active.` }] };
    }

    const speaker = state.current_speaker;
    if (speaker === "none") {
      return { content: [{ type: "text", text: t("No speaker currently has the turn.", "현재 발언 차례인 speaker가 없습니다.", state?.lang) }] };
    }

    const { transport } = resolveTransportForSpeaker(state, speaker);
    if (transport !== "browser_auto" && transport !== "clipboard") {
      return { content: [{ type: "text", text: t(`Speaker "${speaker}" is not a browser type (transport: ${transport}). CLI speakers should use deliberation_respond.`, `speaker "${speaker}"는 브라우저 타입이 아닙니다 (transport: ${transport}). CLI speaker는 deliberation_respond를 사용하세요.`, state?.lang) }] };
    }

    const turnId = state.pending_turn_id || generateTurnId();
    const port = getBrowserPort();
    const effectiveProvider = (state.participant_profiles || []).find(
      p => normalizeSpeaker(p.speaker) === normalizeSpeaker(speaker)
    )?.provider || provider;

    // Dynamic model selection based on prompt context
    const modelSelection = getModelSelectionForTurn(state, speaker, effectiveProvider);

    // Step 1: Attach (pass URL from participant profile for auto-tab-creation)
    const speakerProfile = (state.participant_profiles || []).find(
      p => normalizeSpeaker(p.speaker) === normalizeSpeaker(speaker)
    );
    const attachHint = {
      provider: speakerProfile?.provider || provider,
      url: speakerProfile?.url || undefined,
    };
    const attachResult = await port.attach(resolved, attachHint);
    if (!attachResult.ok) {
      return { content: [{ type: "text", text: `❌ Browser tab binding failed: ${attachResult.error.message}\n\n**Error code:** ${attachResult.error.code}\n**Domain:** ${attachResult.error.domain}\n\nEnsure a browser with CDP debugging port is running.\n\`google-chrome --remote-debugging-port=9222\`\n\n${PRODUCT_DISCLAIMER}` }] };
    }

    // Step 1.2: Login detection — check if user is logged in to the web LLM
    const loginCheck = await port.checkLogin(resolved);
    if (loginCheck && !loginCheck.loggedIn) {
      await port.detach(resolved);
      return { content: [{ type: "text", text: `⚠️ **${speaker} login required** — Not logged in to web LLM.\n\n**Detected status:** ${loginCheck.reason}\n**URL:** ${loginCheck.url || 'N/A'}\n\nThis speaker will be skipped. Log in to the LLM in the browser and try again.\n\n⛔ **Do not substitute with API calls.** Skipping unlogged-in speakers is the correct behavior.` }] };
    }

    // Step 1.5: Switch model based on context analysis
    if (modelSelection.model !== 'default') {
      await port.switchModel(resolved, modelSelection.model);
    }

    // Step 2: Build turn prompt
    const turnPrompt = buildClipboardTurnPrompt(state, speaker, null, 3);

    // Step 3: Send turn with degradation
    const sendResult = await port.sendTurnWithDegradation(resolved, turnId, turnPrompt);
    if (!sendResult.ok) {
      // Fallback to clipboard
      return submitDeliberationTurn({
        session_id: resolved,
        speaker,
        content: `[browser_auto failed — fallback] ${sendResult.error.message}`,
        turn_id: turnId,
        channel_used: "browser_auto_fallback",
        fallback_reason: sendResult.error.code,
      });
    }

    // Step 4: Wait for response
    const waitResult = await port.waitTurnResult(resolved, turnId, timeout_sec);
    if (!waitResult.ok) {
      return { content: [{ type: "text", text: `⏱️ Browser LLM response timeout (${timeout_sec}s)\n\n**Error:** ${waitResult.error.message}\n\nAuto-execution timed out. Ensure Chrome is running with --remote-debugging-port=9222.\n\n${PRODUCT_DISCLAIMER}` }] };
    }

    // Step 5: Submit the response
    const response = waitResult.data.response;
    const result = submitDeliberationTurn({
      session_id: resolved,
      speaker,
      content: response,
      turn_id: turnId,
      channel_used: "browser_auto",
      fallback_reason: null,
    });

    // Step 6: Capture degradation state before detach
    const degradationState = port.getDegradationState(resolved);

    await port.detach(resolved);
    const degradationInfo = degradationState
      ? `\n**Degradation:** ${JSON.stringify(degradationState)}`
      : "";

    const modelInfo = modelSelection.model !== 'default'
      ? `\n**Model:** ${modelSelection.model} (${modelSelection.reason})\n**Analysis:** category=${modelSelection.category}, complexity=${modelSelection.complexity}`
      : "";

    return {
      content: [{
        type: "text",
        text: `✅ Browser auto-turn complete!\n\n**Provider:** ${effectiveProvider}\n**Turn ID:** ${turnId}${modelInfo}\n**Response length:** ${response.length} chars\n**Elapsed:** ${waitResult.data.elapsedMs}ms${degradationInfo}\n\n${result.content[0].text}`,
      }],
    };
  })
);

// Auto-handoff orchestrator helpers — moved to lib/transport.js

server.tool(
  "deliberation_cli_auto_turn",
  "Automatically send a turn to a CLI speaker and collect the response.",
  {
    session_id: z.string().optional().describe("Session ID (required if multiple sessions are active)"),
    timeout_sec: z.number().optional().default(120).describe("CLI response wait timeout (seconds)"),
    // ADR-264 §2.3 — optional working directory for the spawned CLI. Validated
    // against an allowlist (default: $HOME + $TMPDIR; override via
    // ~/.config/mcp-deliberation/allowed-cwd-prefixes.json). The server creates
    // a session-unique subdirectory under the resolved cwd so concurrent
    // cli_auto_turn calls do not share working files.
    spawn_cwd: z.string().optional().describe("Absolute path under an allowed prefix to use as CLI working directory. Used to isolate project CLAUDE.md/GEMINI.md context from the server's cwd."),
  },
  safeToolHandler("deliberation_cli_auto_turn", async ({ session_id, timeout_sec, spawn_cwd }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: "No active deliberation." }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state || state.status !== "active") {
      return { content: [{ type: "text", text: `Session "${resolved}" is not active.` }] };
    }

    const speaker = state.current_speaker;
    if (speaker === "none") {
      return { content: [{ type: "text", text: t("No speaker currently has the turn.", "현재 발언 차례인 speaker가 없습니다.", state?.lang) }] };
    }

    const { transport } = resolveTransportForSpeaker(state, speaker);
    if (transport !== "cli_respond") {
      return { content: [{ type: "text", text: t(`Speaker "${speaker}" is not a CLI type (transport: ${transport}). Browser speakers should use deliberation_browser_auto_turn.`, `speaker "${speaker}"는 CLI 타입이 아닙니다 (transport: ${transport}). 브라우저 speaker는 deliberation_browser_auto_turn을 사용하세요.`, state?.lang) }] };
    }

    const callerSpeaker = detectCallerSpeaker();
    if (callerSpeaker && speaker === callerSpeaker) {
      return { content: [{ type: "text", text: t(
        `🟢 **It's your turn.** You (${speaker}) are the current speaker.\n\n` +
        `Write your response and submit via \`deliberation_respond(session_id: "${resolved}", speaker: "${speaker}", content: "...")\`.\n\n` +
        `⚠️ **Wait! Why can't I use cli_auto_turn?**\n` +
        `You are currently the **orchestrator** (the AI running this tool). If you try to spawn yourself automatically, it would create an infinite loop (you calling yourself calling yourself...) and timeout.\n\n` +
        `Please analyze the topic and history above, formulate your response, and call \`deliberation_respond\` directly.`,
        `🟢 **당신의 차례입니다.** 당신(${speaker})이 현재 발언자입니다.\n\n` +
        `응답을 작성하고 \`deliberation_respond(session_id: "${resolved}", speaker: "${speaker}", content: "...")\`를 통해 제출하세요.\n\n` +
        `⚠️ **잠깐! 왜 cli_auto_turn을 쓸 수 없나요?**\n` +
        `당신은 현재 **오케스트레이터**(이 도구를 실행 중인 AI)입니다. 자기 자신을 자동으로 spawn하려고 하면 무한 루프(자신이 자신을 호출하고 다시 호출하는...)가 발생하여 타임아웃이 됩니다.\n\n` +
        `위의 주제와 이력을 분석하여 응답을 작성한 뒤, \`deliberation_respond\`를 직접 호출해 주세요.`,
        state?.lang)
      }] };
    }

    const speakerPriorTurns = state.log.filter(e => e.speaker === speaker).length;
    const hint = CLI_INVOCATION_HINTS[speaker];
    if (!hint) {
      return { content: [{ type: "text", text: t(`No CLI invocation info for speaker "${speaker}". This speaker is not registered in CLI_INVOCATION_HINTS.`, `speaker "${speaker}"에 대한 CLI 호출 정보가 없습니다. CLI_INVOCATION_HINTS에 등록되지 않은 speaker입니다.`, state?.lang) }] };
    }

    // Check CLI liveness
    if (!checkCliLiveness(hint.cmd)) {
      return { content: [{ type: "text", text: t(`❌ CLI "${hint.cmd}" is not installed or cannot be executed.`, `❌ CLI "${hint.cmd}"가 설치되어 있지 않거나 실행할 수 없습니다.`, state?.lang) }] };
    }

    const turnId = state.pending_turn_id || generateTurnId();
    const turnPrompt = buildClipboardTurnPrompt(state, speaker, null, 3);
    const effectiveTimeout = getCliAutoTurnTimeoutSec({
      speaker,
      requestedTimeoutSec: timeout_sec,
      promptLength: turnPrompt.length,
      priorTurns: speakerPriorTurns,
    });

    // ADR-264 §2.3 — validate optional spawn_cwd and allocate a session-unique
    // subdirectory before we spawn the child. Structured error codes (E_CWD_*)
    // surface via the return envelope so orchestrators can diagnose misuse.
    let resolvedSpawnCwd;
    if (typeof spawn_cwd === "string" && spawn_cwd.length > 0) {
      const override = loadAllowedCwdPrefixes();
      const cwdCheck = validateSpawnCwd(spawn_cwd, override ? { allowedPrefixes: override } : undefined);
      if (!cwdCheck.ok) {
        appendRuntimeLog(
          "WARN",
          `SPAWN_CWD_REJECTED: ${resolved} | speaker=${speaker} | code=${cwdCheck.code} | input=${cwdCheck.input} | resolved=${cwdCheck.resolved || "n/a"}`,
        );
        return {
          content: [{
            type: "text",
            text: `❌ **spawn_cwd rejected**: \`${cwdCheck.code}\`\n\nInput: \`${cwdCheck.input}\`\nResolved: \`${cwdCheck.resolved || "n/a"}\`\nAllowed prefixes: ${(cwdCheck.allowed_prefixes || []).map((p) => `\`${p}\``).join(", ") || "(none)"}\n\nProvide an absolute path under one of the allowed prefixes, or configure \`~/.config/mcp-deliberation/allowed-cwd-prefixes.json\`.`,
          }],
        };
      }
      if (cwdCheck.symlink_crossed) {
        appendRuntimeLog(
          "WARN",
          `SPAWN_CWD_SYMLINK: ${resolved} | speaker=${speaker} | input=${cwdCheck.input} | resolved=${cwdCheck.resolved}`,
        );
      }
      resolvedSpawnCwd = ensureSessionSubdir(cwdCheck.resolved, resolved);
    }

    // Spawn CLI process
    const startTime = Date.now();
    try {
      const response = await new Promise((resolve, reject) => {
        const env = { ...process.env };
        // Unset CLAUDECODE for claude to avoid nested session errors
        if (hint.envPrefix?.includes("CLAUDECODE=")) {
          delete env.CLAUDECODE;
        }
        const spawnOpts = { env, windowsHide: true };
        if (resolvedSpawnCwd) spawnOpts.cwd = resolvedSpawnCwd;

        let child;
        let stdout = "";
        let stderr = "";
        let settled = false;
        let forceKillTimer = null;

        const resolveOnce = (value) => {
          if (settled) return;
          settled = true;
          if (forceKillTimer) clearTimeout(forceKillTimer);
          resolve(value);
        };
        const rejectOnce = (error) => {
          if (settled) return;
          settled = true;
          if (forceKillTimer) clearTimeout(forceKillTimer);
          reject(error);
        };

        // Different invocation patterns per CLI
        switch (speaker) {
          case "claude":
            child = spawn("claude", getCliExecArgs("claude"), spawnOpts);
            child.stdin.write(turnPrompt);
            child.stdin.end();
            break;
          case "codex":
            child = spawn("codex", getCliExecArgs("codex"), spawnOpts);
            child.stdin.write(turnPrompt);
            child.stdin.end();
            break;
          case "gemini":
            child = spawn("gemini", ["-p", turnPrompt], spawnOpts);
            break;
          default: {
            // Generic: try command with prompt as argument
            const flags = hint.flags ? hint.flags.split(/\s+/) : [];
            child = spawn(hint.cmd, [...flags, turnPrompt], spawnOpts);
            break;
          }
        }

        const timer = setTimeout(() => {
          appendRuntimeLog("WARN", `CLI_TURN_TIMEOUT: ${resolved} | speaker: ${speaker} | cli: ${hint.cmd} | timeout: ${effectiveTimeout}s | prompt_len: ${turnPrompt.length} | prior_turns: ${speakerPriorTurns}`);
          try {
            child.kill("SIGTERM");
          } catch { /* ignore */ }
          forceKillTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch { /* ignore */ }
          }, 5000);
          if (typeof forceKillTimer.unref === "function") {
            forceKillTimer.unref();
          }
          rejectOnce(new Error(`CLI timeout (${effectiveTimeout}s)`));
        }, effectiveTimeout * 1000);

        child.stdout.on("data", (data) => { stdout += data.toString(); });
        child.stderr.on("data", (data) => { stderr += data.toString(); });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0 && !stdout.trim()) {
            appendRuntimeLog("ERROR", `CLI_TURN_EXIT: ${resolved} | speaker: ${speaker} | cli: ${hint.cmd} | code: ${code} | stderr: ${stderr.slice(0, 200).replace(/\s+/g, " ")}`);
            rejectOnce(new Error(`CLI exit code ${code}: ${stderr.slice(0, 500)}`));
          } else {
            // Clean up output noise
            let cleaned = stdout;
            if (speaker === "codex") {
              // Codex output includes the prompt and metadata.
              // Find the line starting with "codex" and take everything after it.
              const lines = stdout.split("\n");
              const codexLineIdx = lines.findIndex(l => l.trim() === "codex");
              if (codexLineIdx !== -1) {
                cleaned = lines.slice(codexLineIdx + 1)
                  .filter(line => !/^(tokens used$|^[0-9,]*$|^mcp:.*)/.test(line))
                  .join("\n");
              } else {
                // Fallback regex cleaning
                cleaned = stdout.split("\n")
                  .filter(line => !/^(OpenAI Codex|--------|workdir:|model:|provider:|approval:|sandbox:|reasoning|session id:|user$|mcp:.*|thinking$|tokens used$|^[0-9,]*$)/.test(line))
                  .join("\n");
              }
            } else if (speaker === "gemini") {
              cleaned = stdout.split("\n")
                .filter(line => !/^(Loaded cached|Error during discovery|\[MCP error\]| {4}at| {2}errno:| {2}code:| {2}syscall:| {2}path:| {2}spawnargs:|MCP issues detected|Server .* supports tool updates)/.test(line))
                .join("\n");
            }
            resolveOnce(cleaned.trim());
          }
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          appendRuntimeLog("ERROR", `CLI_TURN_ERROR: ${resolved} | speaker: ${speaker} | cli: ${hint.cmd} | error: ${String(err.message || err).replace(/\s+/g, " ")}`);
          rejectOnce(err);
        });
      });

      const elapsedMs = Date.now() - startTime;
      appendRuntimeLog("INFO", `CLI_TURN: ${resolved} | speaker: ${speaker} | cli: ${hint.cmd} | elapsed: ${elapsedMs}ms | response_len: ${response.length} | prior_turns: ${speakerPriorTurns} | effective_timeout: ${effectiveTimeout}s`);

      if (!response) {
        return { content: [{ type: "text", text: t(`⚠️ CLI "${speaker}" returned an empty response.`, `⚠️ CLI "${speaker}"가 빈 응답을 반환했습니다.`, state?.lang) }] };
      }

      // Submit the response
      const result = submitDeliberationTurn({
        session_id: resolved,
        speaker,
        content: response,
        turn_id: turnId,
        channel_used: "cli_auto",
        fallback_reason: null,
      });

      // ADR-264 §2.4 — Phase 0 observability envelope. Per-CLI adapters
      // (claude/codex/gemini) that parse usage from stdout are a follow-up;
      // until then every field reports `adapter_missing` so downstream
      // aggregators can skip non-`ok` entries without NaN propagation.
      const observability = buildObservabilityEnvelope(null);

      return {
        content: [{
          type: "text",
          text: `✅ CLI auto-turn complete!\n\n**Speaker:** ${speaker}\n**CLI:** ${hint.cmd}\n**Turn ID:** ${turnId}\n**Response length:** ${response.length} chars\n**Elapsed:** ${elapsedMs}ms${resolvedSpawnCwd ? `\n**spawn_cwd:** \`${resolvedSpawnCwd}\`` : ""}\n\n**Observability (ADR-264 §2.4, Phase 0):**\n- tokens_in: ${observability.tokens_in.status}\n- tokens_out: ${observability.tokens_out.status}\n- estimated_cost_usd: ${observability.estimated_cost_usd.status}\n- model_reported_by_cli: ${observability.model_reported_by_cli.status}\n- actual_model_id: ${observability.actual_model_id.status}\n\n${result.content[0].text}`,
        }],
        structuredContent: {
          speaker,
          cli: hint.cmd,
          turn_id: turnId,
          response_length: response.length,
          elapsed_ms: elapsedMs,
          spawn_cwd: resolvedSpawnCwd ?? null,
          ...observability,
        },
      };

    } catch (err) {
      return {
        content: [{
          type: "text",
          text: buildCliAutoTurnFailureText({
            state,
            speaker,
            hint,
            err,
            effectiveTimeout,
            promptLength: turnPrompt.length,
            priorTurns: speakerPriorTurns,
          }),
        }],
      };
    }
  })
);

server.tool(
  "deliberation_run_until_blocked",
  "Auto-run a deliberation across mixed transports until it completes or reaches a manual/blocking turn.",
  {
    session_id: z.string().optional().describe("Session ID (required if multiple sessions are active)"),
    max_turns: z.number().int().min(1).max(50).default(12).describe("Maximum number of turns to auto-run before stopping"),
    cli_timeout_sec: z.number().int().min(30).max(900).default(120).describe("CLI auto-turn timeout (seconds)"),
    browser_timeout_sec: z.number().int().min(15).max(300).default(45).describe("Browser auto-turn timeout (seconds)"),
    include_history_entries: z.number().int().min(0).max(12).default(4).describe("Recent log entries to include for telepty turns"),
  },
  safeToolHandler("deliberation_run_until_blocked", async ({ session_id, max_turns, cli_timeout_sec, browser_timeout_sec, include_history_entries }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: "No active deliberation." }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const initialState = loadSession(resolved);
    if (!initialState || initialState.status !== "active") {
      return { content: [{ type: "text", text: `Session "${resolved}" is not active.` }] };
    }

    const result = await runUntilBlockedCore(resolved, {
      maxTurns: max_turns,
      cliTimeoutSec: cli_timeout_sec,
      browserTimeoutSec: browser_timeout_sec,
      includeHistoryEntries: include_history_entries,
    });
    const finalState = loadSession(resolved);
    const stepsText = (result.steps || []).length > 0
      ? result.steps.map((step, index) => `- ${index + 1}. ${step.speaker} [${step.transport}] → ${step.ok ? "ok" : (step.blocked ? `blocked (${step.error || "blocked"})` : `error (${step.error || "unknown"})`)}${step.elapsedMs ? ` (${step.elapsedMs}ms)` : ""}`).join("\n")
      : "- none";

    let summary = `## Run Until Blocked — ${resolved}\n\n`;
    summary += `**Result:** ${result.status}\n`;
    summary += `**Current state:** ${finalState?.status || initialState.status}\n`;
    summary += `**Current speaker:** ${finalState?.current_speaker || initialState.current_speaker}\n`;
    if (result.block_reason) summary += `**Block reason:** ${result.block_reason}\n`;
    if (result.error) summary += `**Error:** ${result.error}\n`;
    if (result.turn_prompt) {
      summary += `\n### [turn_prompt]\n\`\`\`markdown\n${result.turn_prompt}\n\`\`\`\n`;
    }
    summary += `\n### Steps\n${stepsText}\n`;

    return { content: [{ type: "text", text: summary }] };
  })
);

server.tool(
  "deliberation_respond",
  "Submit a response for the current turn.",
  {
    session_id: z.string().optional().describe("Session ID (required if multiple sessions are active)"),
    speaker: z.string().trim().min(1).max(64).describe("Responder name"),
    content: z.string().optional().describe("Response content (markdown). Either content or content_file is required."),
    content_file: z.string().optional().describe("File path containing response content. For avoiding JSON escape issues. File content is used as-is for content."),
    use_clipboard: z.boolean().optional().describe("Read content from system clipboard (alternative to content/content_file)"),
    include_clipboard_image: z.boolean().optional().describe("Capture and include image from system clipboard"),
    turn_id: z.string().optional().describe("Turn verification ID (value received from deliberation_route_turn)"),
    // ADR-264 §2.2 — optional proxy submission. An orchestrator that pre-spawned
    // the CLI/browser itself can submit the collected response here instead of
    // asking the server to re-run the CLI. Default behavior (fields absent) is
    // unchanged: proxy is blocked.
    external_output: z.string().optional().describe("Pre-collected response body that the orchestrator obtained from a CLI/browser it spawned itself. Requires external_output_proof."),
    external_output_proof: z.object({
      algo: z.literal("sha256"),
      digest: z.string().describe("Lowercase hex sha256 digest of external_output bytes."),
      source: z.enum(["cli_stdout", "browser_dom", "trusted_orchestrator"]),
    }).optional().describe("Proof payload for external_output. sha256 of the raw UTF-8 bytes."),
    verify: z.enum(["hash", "none"]).optional().default("hash").describe("Proof verification mode. 'none' requires source=trusted_orchestrator and logs an explicit audit entry."),
  },
  safeToolHandler("deliberation_respond", async ({ session_id, speaker, content, content_file, use_clipboard, include_clipboard_image, turn_id, external_output, external_output_proof, verify }) => {
    // Guard: prevent orchestrator from fabricating responses for CLI/browser speakers
    const resolved = resolveSessionId(session_id);
    let externalAcceptedContent = null;
    if (resolved && resolved !== "MULTIPLE") {
      const state = loadSession(resolved);
      if (state) {
        const { transport } = resolveTransportForSpeaker(state, speaker);
        if (transport === "cli_respond" || transport === "browser_auto") {
          // Check if caller is the same speaker (legitimate self-response) or an impersonator
          const callerSpeaker = detectCallerSpeaker();
          const callerIsSpeaker = callerSpeaker && (speaker === callerSpeaker);
          if (!callerIsSpeaker) {
            // ADR-264 §2.2 — accept pre-collected external_output when a proof
            // is supplied. Failed verification surfaces a structured error code
            // instead of falling back to the opaque "proxy blocked" message.
            if (typeof external_output === "string" && external_output.length > 0) {
              const proof = verifyExternalOutputProof({ external_output, external_output_proof, verify });
              if (proof.ok) {
                externalAcceptedContent = external_output;
                appendRuntimeLog(
                  "INFO",
                  `EXTERNAL_OUTPUT_ACCEPTED: ${resolved} | speaker=${speaker} | transport=${transport} | source=${proof.audit?.source} | verify=${proof.audit?.verify} | len=${external_output.length}`,
                );
              } else {
                const digestDetail = proof.expected
                  ? `\n\nExpected digest: ${proof.expected}\nActual digest: ${proof.actual}`
                  : "";
                appendRuntimeLog(
                  "WARN",
                  `EXTERNAL_OUTPUT_REJECTED: ${resolved} | speaker=${speaker} | code=${proof.code}${proof.expected ? ` | expected=${proof.expected} | actual=${proof.actual}` : ""}`,
                );
                return {
                  content: [{
                    type: "text",
                    text: t(
                      `⚠️ **Proxy response rejected**: \`${proof.code}\`\n\nThe supplied external_output did not pass verification (verify=\"${verify || "hash"}\").${digestDetail}\n\nSupply a correct sha256 proof, or call \`deliberation_cli_auto_turn\` / \`deliberation_browser_auto_turn\` to let the server run the transport.`,
                      `⚠️ **대리 응답 거부**: \`${proof.code}\`\n\n제공된 external_output 검증 실패 (verify=\"${verify || "hash"}\").${digestDetail}\n\n올바른 sha256 proof를 제공하거나, \`deliberation_cli_auto_turn\` / \`deliberation_browser_auto_turn\` 으로 서버가 직접 transport를 실행하게 하세요.`,
                      state?.lang),
                  }],
                };
              }
            } else {
              return {
                content: [{
                  type: "text",
                  text: t(
                    `⚠️ **Proxy response blocked**: Speaker "${speaker}" has ${transport} transport.\n\nThe orchestrator is not allowed to write responses on behalf of other speakers.\nUse the following tools instead:\n- CLI speaker → \`deliberation_route_turn\` or \`deliberation_cli_auto_turn\`\n- Browser speaker → \`deliberation_route_turn\` or \`deliberation_browser_auto_turn\`\n\nThese tools run the actual CLI/browser to collect genuine responses.\n\nAlternatively, the orchestrator can submit a response it spawned itself via \`external_output\` + \`external_output_proof\` (sha256 hex of the UTF-8 bytes).`,
                    `⚠️ **대리 응답 차단**: speaker "${speaker}"는 ${transport} transport입니다.\n\n오케스트레이터가 다른 speaker를 대신하여 응답을 작성하는 것은 허용되지 않습니다.\n대신 다음 도구를 사용하세요:\n- CLI speaker → \`deliberation_route_turn\` 또는 \`deliberation_cli_auto_turn\`\n- 브라우저 speaker → \`deliberation_route_turn\` 또는 \`deliberation_browser_auto_turn\`\n\n이 도구들이 실제 CLI/브라우저를 실행하여 진짜 응답을 수집합니다.\n\n또는 오케스트레이터가 직접 spawn한 결과는 \`external_output\` + \`external_output_proof\` (sha256 hex) 로 제출할 수 있습니다.`,
                    state?.lang),
                }],
              };
            }
          }
        }
      }
    }

    // Support reading content from file or clipboard to avoid JSON escaping issues
    // ADR-264 §2.2 — external_output (when verified) takes precedence so proxy
    // submissions don't conflict with stale content/content_file values.
    let finalContent = externalAcceptedContent ?? content;
    if (use_clipboard && !content) {
      try {
        finalContent = readClipboardText();
      } catch (e) {
        return { content: [{ type: "text", text: t(`❌ Failed to read from clipboard: ${e.message}`, `❌ 클립보드 읽기 실패: ${e.message}`, state?.lang) }] };
      }
    } else if (content_file && !content) {
      try {
        finalContent = fs.readFileSync(content_file, "utf-8").trim();
      } catch (e) {
        return { content: [{ type: "text", text: t(`❌ Failed to read content_file: ${e.message}`, `❌ content_file 읽기 실패: ${e.message}`, state?.lang) }] };
      }
    }
    if (!finalContent && !include_clipboard_image) {
      return { content: [{ type: "text", text: "❌ Either content, content_file, or include_clipboard_image must be provided." }] };
    }

    const attachments = [];
    if (include_clipboard_image) {
      if (process.platform !== "darwin") {
        return { content: [{ type: "text", text: "❌ Clipboard image capture is currently only supported on macOS." }] };
      }
      if (!hasClipboardImage()) {
        return { content: [{ type: "text", text: t("❌ No image found on clipboard.", "❌ 클립보드에서 이미지를 찾을 수 없습니다.", state?.lang) }] };
      }

      const attachmentsDir = path.join(getSessionsDir(), `${resolved}_attachments`);
      if (!fs.existsSync(attachmentsDir)) fs.mkdirSync(attachmentsDir, { recursive: true });
      
      const imgName = `img_${Date.now()}.png`;
      const imgPath = path.join(attachmentsDir, imgName);
      
      if (captureClipboardImage(imgPath)) {
        attachments.push({ type: "image", path: `attachments/${imgName}`, localPath: imgPath });
      } else {
        return { content: [{ type: "text", text: "❌ Failed to capture image from clipboard." }] };
      }
    }

    return submitDeliberationTurn({ session_id, speaker, content: finalContent || "(Image response)", turn_id, channel_used: "cli_respond", attachments });
  })
);

server.tool(
  "deliberation_ingest_remote_reply",
  "Canonical semantic ingress for replies produced on another machine/session. Use this instead of reconstructing deliberation state from transport events.",
  {
    session_id: z.string().describe("Deliberation session ID"),
    speaker: z.string().describe("Speaker name"),
    turn_id: z.string().min(1).describe("Turn ID associated with the issued turn_request"),
    content: z.string().min(1).describe("Remote reply content"),
    source_machine_id: z.string().min(1).describe("Source machine or peer identifier"),
    source_session_id: z.string().min(1).describe("Source remote session identifier"),
    transport_scope: z.string().min(1).describe("Transport scope used to carry the remote reply"),
    artifact_refs: z.array(z.string().min(1)).optional().describe("Optional artifact references the reply depends on"),
    reply_origin: z.string().optional().describe("Optional origin hint, e.g. remote_mcp, telepty_thread"),
    timestamp: z.string().optional().describe("Optional source timestamp"),
  },
  safeToolHandler("deliberation_ingest_remote_reply", async ({
    session_id,
    speaker,
    turn_id,
    content,
    source_machine_id,
    source_session_id,
    transport_scope,
    artifact_refs,
    reply_origin,
    timestamp,
  }) => {
    return submitDeliberationTurn({
      session_id,
      speaker,
      content,
      turn_id,
      channel_used: `remote_ingress:${transport_scope}`,
      source_metadata: {
        source_machine_id,
        source_session_id,
        transport_scope,
        artifact_refs: artifact_refs || [],
        reply_origin: reply_origin || null,
        timestamp: timestamp || new Date().toISOString(),
      },
    });
  })
);

server.tool(
  "deliberation_inject_context",
  "Inject additional context or instructions into a specific active session. (Useful for local or remote context injection via Tailscale)",
  {
    session_id: z.string().describe("Session ID to inject context into"),
    context: z.string().describe("The context text to inject"),
    speaker: z.string().default("system").describe("Optional label for who injected the context (default: 'system')"),
    remote_url: z.string().optional().describe("Optional Tailscale IP/Host and port (e.g., '100.100.100.5:3847') of the remote machine running the session. If provided, context is injected remotely."),
  },
  safeToolHandler("deliberation_inject_context", async ({ session_id, context, speaker, remote_url }) => {
    if (remote_url) {
      try {
        const baseUrl = remote_url.startsWith("http") ? remote_url : `http://${remote_url}`;
        // Ensure trailing slash is removed
        const cleanBaseUrl = baseUrl.replace(/\/$/, "");
        const response = await fetch(`${cleanBaseUrl}/api/sessions/${encodeURIComponent(session_id)}/context`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ context, speaker: speaker || "system" })
        });
        
        if (!response.ok) {
          let errText = await response.text();
          try { errText = JSON.parse(errText).error || errText; } catch { /* ignore */ }
          return { content: [{ type: "text", text: `❌ Remote context injection failed (${response.status}): ${errText}` }] };
        }
        return { content: [{ type: "text", text: `✅ Context successfully injected remotely into session "${session_id}" at ${remote_url}.` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Error connecting to remote observer at ${remote_url}: ${e.message}` }] };
      }
    }

    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: "No active deliberation." }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    return withSessionLock(resolved, () => {
      const state = loadSession(resolved);
      if (!state || state.status !== "active") {
        return { content: [{ type: "text", text: `Session "${resolved}" is not active.` }] };
      }

      state.log.push({
        round: state.current_round,
        speaker: speaker || "system",
        content: `[Context Injection]\n${context}`,
        timestamp: new Date().toISOString(),
        event: "context_injection",
      });

      appendRuntimeLog("INFO", `CONTEXT_INJECTION: ${state.id} | speaker: ${speaker || "system"} | length: ${context.length}`);
      saveSession(state);

      return {
        content: [{
          type: "text",
          text: `✅ Context successfully injected into session "${state.id}".`,
        }],
      };
    });
  })
);

server.tool(
  "deliberation_history",
  "Return the deliberation history.",
  {
    session_id: z.string().optional().describe("Session ID (required if multiple sessions are active)"),
  },
  async ({ session_id }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: "No active deliberation." }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state) {
      return { content: [{ type: "text", text: `Session "${resolved}" not found.` }] };
    }

    if (state.log.length === 0) {
      return {
        content: [{
          type: "text",
          text: t(`**Session:** ${state.id}\n**Topic:** ${state.topic}\n\nNo responses yet. **${state.current_speaker}** should respond first.`, `**세션:** ${state.id}\n**주제:** ${state.topic}\n\n아직 응답이 없습니다. **${state.current_speaker}**가 먼저 응답하세요.`, state?.lang),
        }],
      };
    }

    let history = `**Session:** ${state.id}\n**Topic:** ${state.topic} | **Status:** ${state.status}\n\n`;
    for (const e of state.log) {
      history += `### ${e.speaker} — Round ${e.round}\n\n${e.content}\n\n---\n\n`;
    }
    return { content: [{ type: "text", text: history }] };
  }
);

server.tool(
  "deliberation_synthesize",
  "End the deliberation and submit a synthesis report. Optionally include structured actionable tasks for automated handoff.",
  {
    session_id: z.string().optional().describe("Session ID (required if multiple sessions are active)"),
    synthesis: z.string().describe("Synthesis report (markdown)"),
    structured: z.preprocess(
      (v) => {
        if (typeof v === "string") {
          try { return JSON.parse(v); }
          catch { return v; }
        }
        return v;
      },
      StructuredSynthesisSchema.optional()
    ).describe("Structured synthesis data for automated handoff. If omitted, only markdown synthesis is stored."),
  },
  safeToolHandler("deliberation_synthesize", async ({ session_id, synthesis, structured }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: "No active deliberation." }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    let state = null;
    let archivePath = null;
    const lockedResult = withSessionLock(resolved, () => {
      const loaded = loadSession(resolved);
      if (!loaded) {
        return { content: [{ type: "text", text: `Session "${resolved}" not found.` }] };
      }

      loaded.synthesis = synthesis;
      loaded.structured_synthesis = structured || null;
      loaded.execution_contract = buildExecutionContract({ state: loaded, structured: structured || null });
      loaded.status = "completed";
      loaded.current_speaker = "none";
      saveSession(loaded);
      archivePath = archiveState(loaded);
      cleanupSyncMarkdown(loaded);
      // Write execution_status sidecar (persists after session file is deleted)
      saveExecutionStatus(loaded.id, loaded.project, {
        execution_status: loaded.auto_execute ? "executing" : "pending",
        tasks_total: loaded.execution_contract?.tasks?.length ?? 0,
        tasks_done: 0,
        project: loaded.project,
        topic: loaded.topic,
      });

      // Clean up the active session JSON file upon completion
      const sessionFile = getSessionFile(loaded);
      try { if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile); } catch { /* ignore */ }
      state = loaded;
      return null;
    });
    if (lockedResult) {
      return lockedResult;
    }

    appendRuntimeLog("INFO", `SYNTHESIZED: ${resolved} | turns: ${state.log.length} | rounds: ${state.max_rounds}`);
    emitSynthesisEvent(
      {
        session: resolved,
        turns: state.log.length,
        max_rounds: state.max_rounds,
        speakers: state.speakers || [],
        auto_execute: !!state.auto_execute,
        has_structured: !!structured,
      },
      resolved,
    );
    if (state.execution_contract) {
      emitHandoffEvent(
        {
          session: resolved,
          tasks_total: state.execution_contract?.tasks?.length ?? 0,
          auto_execute: !!state.auto_execute,
        },
        resolved,
      );
    }
    const synthesisEnvelope = buildTeleptySynthesisEnvelope({
      state,
      synthesis,
      structured,
      executionContract: state.execution_contract || null,
    });

    // Immediately force-close monitor terminal (including physical Terminal) on deliberation end
    closeMonitorTerminal(state.id, getSessionWindowIds(state));

    // Notify telepty bus with full structured data for dustcraw to consume
    if (state.auto_execute) {
      notifyTeleptyBus(synthesisEnvelope).catch(() => {}); // fire-and-forget
    }

    // Notify brain ingest if endpoint configured
    callBrainIngest(state.execution_contract).catch(() => {}); // fire-and-forget

    // Emit lesson_learned events for orchestrator lessons.json auto-population
    if (state.execution_contract?.decisions?.length > 0) {
      const lessonEvent = {
        type: "lesson_learned",
        session_id: state.id,
        timestamp: new Date().toISOString(),
        project: state.project || getProjectSlug(),
        category: "decision",
        lesson: state.execution_contract.summary || state.synthesis?.slice(0, 200) || "",
        decisions: state.execution_contract.decisions,
      };
      notifyTeleptyBus(lessonEvent).catch(() => {}); // fire-and-forget
      appendRuntimeLog("INFO", `LESSON_LEARNED: ${state.id} | decisions: ${state.execution_contract.decisions.length} | project: ${lessonEvent.project}`);
    }

    return {
      content: [{
        type: "text",
        text: `✅ [${state.id}] Deliberation complete! Forum finalized.\n\n**Project:** ${state.project}\n**Topic:** ${state.topic}\n**Rounds:** ${state.max_rounds}\n**Responses:** ${state.log.length}\n\n📁 Final forum: ${archivePath}\n🖥️ Monitor terminal force-closed.`,
      }],
    };
  })
);

server.tool(
  "deliberation_list",
  "Return the list of past deliberation archives.",
  {},
  async () => {
    ensureDirs();
    const archiveDir = getArchiveDir();
    if (!fs.existsSync(archiveDir)) {
      return { content: [{ type: "text", text: "No past deliberations." }] };
    }

    const files = fs.readdirSync(archiveDir)
      .filter(f => f.startsWith("deliberation-") && f.endsWith(".md"))
      .sort().reverse();

    if (files.length === 0) {
      return { content: [{ type: "text", text: "No past deliberations." }] };
    }

    const list = files.map((f, i) => `${i + 1}. ${f.replace(".md", "")}`).join("\n");
    return { content: [{ type: "text", text: `## Past Deliberations (${getProjectSlug()})\n\n${list}` }] };
  }
);

server.tool(
  "deliberation_reset",
  "Reset deliberation. Resets specific session if session_id provided, otherwise resets all.",
  {
    session_id: z.string().optional().describe("Session ID to reset (resets all if omitted)"),
  },
  safeToolHandler("deliberation_reset", async ({ session_id }) => {
    ensureDirs();
    const sessionsDir = getSessionsDir();

    if (session_id) {
      // Reset specific session only
      let toCloseIds = [];
      const result = withSessionLock(session_id, () => {
        const state = loadSession(session_id);
        if (!state) {
          return { content: [{ type: "text", text: `Session "${session_id}" not found.` }] };
        }
        const file = getSessionFile(state);
        if (state && state.log.length > 0) {
          archiveState(state);
        }
        if (state) cleanupSyncMarkdown(state);
        toCloseIds = getSessionWindowIds(state);
        fs.unlinkSync(file);
        return { content: [{ type: "text", text: `✅ Session "${session_id}" reset complete. 🖥️ Monitor terminal closed.` }] };
      });
      if (toCloseIds.length > 0) {
        closeMonitorTerminal(session_id, toCloseIds);
      }
      return result;
    }

    // Reset all
    const resetResult = withProjectLock(() => {
      if (!fs.existsSync(sessionsDir)) {
        return { files: [], archived: 0, terminalWindowIds: [], noSessions: true };
      }

      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".json"));
      let archived = 0;
      const terminalWindowIds = [];

      for (const f of files) {
        const filePath = path.join(sessionsDir, f);
        try {
          const state = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          for (const id of getSessionWindowIds(state)) {
            terminalWindowIds.push(id);
          }
          if (state.log && state.log.length > 0) {
            archiveState(state);
            archived++;
          }
          cleanupSyncMarkdown(state);
          fs.unlinkSync(filePath);
        } catch {
          try {
            fs.unlinkSync(filePath);
          } catch {
            // ignore deletion race
          }
        }
      }

      return { files, archived, terminalWindowIds, noSessions: false };
    });

    if (resetResult.noSessions) {
      return { content: [{ type: "text", text: "No sessions to reset." }] };
    }

    for (const windowId of resetResult.terminalWindowIds) {
      closePhysicalTerminal(windowId);
    }
    closeAllMonitorTerminals();

    return {
      content: [{
        type: "text",
        text: `✅ Full reset complete. ${resetResult.files.length} sessions deleted, ${resetResult.archived} archived. 🖥️ All monitor terminals closed.`,
      }],
    };
  })
);

server.tool(
  "deliberation_cli_config",
  "Query or update deliberation participant CLI settings. Saves when enabled_clis is provided.",
  {
    enabled_clis: z.array(z.string()).optional().describe("CLI list to enable (e.g., [\"claude\", \"codex\", \"gemini\"]). Shows current settings if omitted"),
    require_speaker_selection: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" : v),
      z.boolean().optional()
    ).describe("Deprecated toggle. Speaker selection is now always manual; any provided value is normalized to true."),
    include_browser_speakers: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" : v),
      z.boolean().optional()
    ).describe("true: browser LLM speakers may join when requested, false: CLI + telepty candidate mode"),
    default_rounds: z.coerce.number().int().min(1).max(10).optional()
      .describe("Default number of rounds (1-10, default 3)"),
    default_ordering: z.enum(["auto", "cyclic", "random", "weighted-random"]).optional()
      .describe("Default ordering strategy: auto (automatic based on speaker count), cyclic, random, weighted-random"),
    chrome_profile: z.string().optional()
      .describe("Chrome profile directory name for CDP (e.g., \"Default\", \"Profile 1\"). Stored for auto-launch."),
  },
  safeToolHandler("deliberation_cli_config", async ({ enabled_clis, require_speaker_selection, include_browser_speakers, default_rounds, default_ordering, chrome_profile }) => {
    const config = loadDeliberationConfig();

    // Handle setup config updates
    let configChanged = false;
    if (require_speaker_selection !== undefined && require_speaker_selection !== null) {
      config.require_speaker_selection = true;
      configChanged = true;
    }
    if (include_browser_speakers !== undefined && include_browser_speakers !== null) {
      config.include_browser_speakers = include_browser_speakers;
      configChanged = true;
    }
    if (default_rounds !== undefined && default_rounds !== null) {
      config.default_rounds = default_rounds;
      configChanged = true;
    }
    if (default_ordering !== undefined && default_ordering !== null) {
      config.default_ordering = default_ordering;
      configChanged = true;
    }
    if (chrome_profile !== undefined && chrome_profile !== null) {
      config.chrome_profile = chrome_profile;
      configChanged = true;
    }
    if (configChanged) {
      config.setup_complete = true;
      saveDeliberationConfig(config);
    }

    if (!enabled_clis) {
      // Read mode: show current config + detected CLIs
      const detected = discoverLocalCliSpeakers();
      const configured = Array.isArray(config.enabled_clis) ? config.enabled_clis : [];
      const mode = configured.length > 0 ? "config" : "auto-detect";

      return {
        content: [{
          type: "text",
          text: `## Deliberation CLI Settings\n\n**Mode:** ${mode}\n**Speaker selection:** manual only (fresh user selection required every start)\n**Browser speakers:** ${config.include_browser_speakers === true ? "enabled" : "disabled (CLI + telepty default)"}\n**Default rounds:** ${config.default_rounds || 3}\n**Ordering:** ${config.default_ordering || "auto"}\n**Chrome profile:** ${config.chrome_profile || "Default"} (env: DELIBERATION_CHROME_PROFILE)\n**Configured CLIs:** ${configured.length > 0 ? configured.join(", ") : "(none — full auto-detection)"}\n**Currently detected CLIs:** ${detected.join(", ") || "(none)"}\n**All supported CLIs:** ${DEFAULT_CLI_CANDIDATES.join(", ")}\n\nℹ️ Every start now requires two steps: \`deliberation_speaker_candidates\` for a fresh snapshot, then \`deliberation_confirm_speakers\` for the exact user-picked set. Telepty active sessions are included in the candidate list automatically.\n\nTo change defaults:\n\`deliberation_cli_config(include_browser_speakers: false, default_rounds: 3, default_ordering: "auto")\`\n\nTo enable browser speakers:\n\`deliberation_cli_config(include_browser_speakers: true)\`\n\nTo set Chrome profile for CDP:\n\`deliberation_cli_config(chrome_profile: "Profile 1")\`\n\nTo revert CLI filters to full auto-detection:\n\`deliberation_cli_config(enabled_clis: [])\``,
        }],
      };
    }

    // Write mode: save new config
    if (enabled_clis.length === 0) {
      // Empty array = reset to auto-detect all
      delete config.enabled_clis;
      saveDeliberationConfig(config);
      return {
        content: [{
          type: "text",
          text: `✅ CLI settings reset. Switched to full auto-detection mode.\nDetection targets: ${DEFAULT_CLI_CANDIDATES.join(", ")}`,
        }],
      };
    }

    // Validate CLIs
    const valid = [];
    const invalid = [];
    for (const cli of enabled_clis) {
      const normalized = cli.trim().toLowerCase();
      if (normalized) valid.push(normalized);
    }

    config.enabled_clis = valid;
    saveDeliberationConfig(config);

    // Check which are actually installed
    const installed = valid.filter(cli => {
      try {
        execFileSync(process.platform === "win32" ? "where" : "which", [cli], { stdio: "ignore" });
        return true;
      } catch { return false; }
    });
    const notInstalled = valid.filter(cli => !installed.includes(cli));

    let result = `✅ CLI settings saved!\n\n**Enabled CLIs:** ${valid.join(", ")}`;
    if (installed.length > 0) result += `\n**Installed:** ${installed.join(", ")}`;
    if (notInstalled.length > 0) result += `\n**⚠️ Not installed:** ${notInstalled.join(", ")} (not found in PATH)`;

    return { content: [{ type: "text", text: result }] };
  })
);

// invokeCliReviewer, buildReviewPrompt, synthesizeReviews — moved to lib/transport.js

server.tool(
  "deliberation_request_review",
  "Request a code review. Sends review requests to multiple CLI reviewers simultaneously and synthesizes results.",
  {
    context: z.string().describe("Description of changes to review (code, diff, design, etc.)"),
    question: z.string().describe("Review question (e.g., 'Is this error handling sufficient?')"),
    reviewers: z.array(z.string().trim().min(1).max(64)).min(1).describe("Reviewer CLI list (e.g., [\"claude\", \"codex\"])"),
    mode: z.enum(["sync", "async"]).default("sync").describe("sync: wait for results then return, async: return session_id immediately"),
    deadline_ms: z.number().int().min(5000).max(600000).default(60000).describe("Total timeout (milliseconds, default 60s)"),
    min_reviews: z.number().int().min(1).default(1).describe("Minimum required reviews (default 1)"),
    on_timeout: z.enum(["partial", "fail"]).default("partial").describe("Timeout behavior: partial=return partial results, fail=error"),
  },
  safeToolHandler("deliberation_request_review", async ({ context, question, reviewers, mode, deadline_ms, min_reviews, on_timeout }) => {
    // Validate reviewers exist in PATH
    const validReviewers = [];
    const invalidReviewers = [];
    for (const r of reviewers) {
      const normalized = normalizeSpeaker(r);
      if (!normalized) continue;
      if (commandExistsInPath(normalized)) {
        validReviewers.push(normalized);
      } else {
        invalidReviewers.push(normalized);
      }
    }

    if (validReviewers.length === 0) {
      return {
        content: [{
          type: "text",
          text: `❌ No valid reviewers. CLIs not found in PATH: ${invalidReviewers.join(", ")}\n\nCall deliberation_speaker_candidates to check available CLIs.`,
        }],
      };
    }

    // Create mini-session
    const sessionId = generateSessionId("review");
    const callerSpeaker = detectCallerSpeaker() || "requester";
    const now = new Date().toISOString();

    const state = {
      id: sessionId,
      project: getProjectSlug(),
      topic: question.slice(0, 80),
      type: "auto_review",
      status: "active",
      max_rounds: 1,
      current_round: 1,
      current_speaker: validReviewers[0],
      speakers: validReviewers,
      participant_profiles: validReviewers.map(r => ({ speaker: r, type: "cli", command: r })),
      log: [],
      synthesis: null,
      requester: callerSpeaker,
      review_context: context,
      review_question: question,
      review_mode: mode,
      review_deadline_ms: deadline_ms,
      review_min_reviews: min_reviews,
      review_on_timeout: on_timeout,
      pending_turn_id: generateTurnId(),
      monitor_terminal_window_ids: [],
      created: now,
      updated: now,
    };

    withSessionLock(sessionId, () => {
      ensureDirs();
      saveSession(state);
    });

    // Async mode: return immediately
    if (mode === "async") {
      const warn = invalidReviewers.length > 0
        ? `\n⚠️ Reviewers not found in PATH (excluded): ${invalidReviewers.join(", ")}`
        : "";
      return {
        content: [{
          type: "text",
          text: `✅ Async review session created\n\n**Session ID:** ${sessionId}\n**Reviewers:** ${validReviewers.join(", ")}\n**Mode:** async${warn}\n\nCheck progress with \`deliberation_status(session_id: "${sessionId}")\`.`,
        }],
      };
    }

    // Sync mode: invoke each reviewer sequentially with deadline enforcement
    const globalStart = Date.now();
    const softBudgetPerReviewer = Math.floor(deadline_ms / validReviewers.length);
    const completedReviews = [];
    const timedOutReviewers = [];
    const failedReviewers = [];

    for (const reviewer of validReviewers) {
      const elapsed = Date.now() - globalStart;
      const remaining = deadline_ms - elapsed;

      // Global deadline check
      if (remaining <= 1000) {
        timedOutReviewers.push(reviewer);
        continue;
      }

      // Per-reviewer timeout: min of soft budget and remaining global time
      const reviewerTimeout = Math.min(softBudgetPerReviewer, remaining);

      const prompt = buildReviewPrompt(context, question, completedReviews);
      const result = invokeCliReviewer(reviewer, prompt, reviewerTimeout);

      if (result.ok) {
        const entry = { reviewer, response: result.response };
        completedReviews.push(entry);

        // Add to session log
        withSessionLock(sessionId, () => {
          const latest = loadSession(sessionId);
          if (!latest) return;
          latest.log.push({
            round: 1,
            speaker: reviewer,
            content: result.response,
            timestamp: new Date().toISOString(),
            turn_id: generateTurnId(),
            channel_used: "cli_auto_review",
            fallback_reason: null,
          });
          latest.updated = new Date().toISOString();
          saveSession(latest);
        });
      } else if (result.error === "timeout") {
        timedOutReviewers.push(reviewer);
      } else {
        failedReviewers.push({ reviewer, error: result.error });
      }
    }

    // Check min_reviews threshold
    if (completedReviews.length < min_reviews) {
      if (on_timeout === "fail") {
        // Mark session as failed
        withSessionLock(sessionId, () => {
          const latest = loadSession(sessionId);
          if (!latest) return;
          latest.status = "completed";
          latest.synthesis = `Review failed: only ${completedReviews.length}/${min_reviews} required reviews completed.`;
          saveSession(latest);
          archiveState(latest);
          cleanupSyncMarkdown(latest);
        });

        return {
          content: [{
            type: "text",
            text: `❌ Review failed: minimum ${min_reviews} reviews required, only ${completedReviews.length} completed\n\n**Session:** ${sessionId}\n**Completed:** ${completedReviews.map(r => r.reviewer).join(", ") || "(none)"}\n**Timed out:** ${timedOutReviewers.join(", ") || "(none)"}\n**Failed:** ${failedReviewers.map(r => `${r.reviewer}: ${r.error}`).join(", ") || "(none)"}`,
          }],
        };
      }
      // on_timeout === "partial": fall through to return partial results
    }

    // Synthesize
    const synthesis = synthesizeReviews(context, question, completedReviews);

    // Complete session
    let archivePath = null;
    withSessionLock(sessionId, () => {
      const latest = loadSession(sessionId);
      if (!latest) return;
      latest.status = "completed";
      latest.synthesis = synthesis;
      latest.current_speaker = "none";
      saveSession(latest);
      archivePath = archiveState(latest);
      cleanupSyncMarkdown(latest);
    });

    const totalMs = Date.now() - globalStart;
    const coverage = `${completedReviews.length}/${validReviewers.length}`;
    const warn = invalidReviewers.length > 0
      ? `\n**Excluded reviewers (not installed):** ${invalidReviewers.join(", ")}`
      : "";
    const timeoutInfo = timedOutReviewers.length > 0
      ? `\n**Timed out reviewers:** ${timedOutReviewers.join(", ")}`
      : "";
    const failInfo = failedReviewers.length > 0
      ? `\n**Failed reviewers:** ${failedReviewers.map(r => `${r.reviewer}: ${r.error}`).join(", ")}`
      : "";

    const resultPayload = {
      synthesis,
      completed_reviewers: completedReviews.map(r => r.reviewer),
      timed_out_reviewers: timedOutReviewers,
      failed_reviewers: failedReviewers.map(r => r.reviewer),
      coverage,
      mode: "sync",
      session_id: sessionId,
      elapsed_ms: totalMs,
    };

    return {
      content: [{
        type: "text",
        text: `## Review Complete\n\n**Session:** ${sessionId}\n**Coverage:** ${coverage}\n**Elapsed:** ${totalMs}ms\n**Completed reviewers:** ${completedReviews.map(r => r.reviewer).join(", ") || "(none)"}${timeoutInfo}${failInfo}${warn}\n\n${synthesis}\n\n---\n\n\`\`\`json\n${JSON.stringify(resultPayload, null, 2)}\n\`\`\``,
      }],
    };
  })
);

// ── Start ──────────────────────────────────────────────────────

// Only start server when run directly (not imported for testing)
const __currentFile = new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const __entryFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (__entryFile && path.resolve(__currentFile) === __entryFile) {
  const transport = new StdioServerTransport();

  // ── Gemini CLI compatibility: strip $schema from tool inputSchemas ──
  // Gemini CLI strictly validates MCP tool schemas and rejects $schema metadata
  // that zod-to-json-schema adds. Intercept transport.send to patch tools/list responses.
  const _origSend = transport.send.bind(transport);
  transport.send = (message) => {
    if (message.result && Array.isArray(message.result.tools)) {
      for (const tool of message.result.tools) {
        if (tool.inputSchema) {
          delete tool.inputSchema["$schema"];
          if (!tool.inputSchema.type) tool.inputSchema.type = "object";
        }
      }
    }
    return _origSend(message);
  };

  await server.connect(transport);
}

// ── Test exports (used by vitest) ──
export { appendRuntimeLog, _flushDedupToFile, _isBrokenStdioError, selectNextSpeaker, loadRolePrompt, inferSuggestedRole, parseVotes, ROLE_KEYWORDS, ROLE_HEADING_MARKERS, loadRolePresets, applyRolePreset, detectDegradationLevels, formatDegradationReport, DEGRADATION_TIERS, hasExplicitBrowserParticipantSelection, resolveIncludeBrowserSpeakers, confirmSpeakerSelectionToken, validateSpeakerSelectionRequest, markSelectionTokenConsumed, truncatePromptText, getPromptBudgetForSpeaker, formatRecentLogForPrompt, getCliAutoTurnTimeoutSec, getCliExecArgs, buildCliAutoTurnFailureText, buildClipboardTurnPrompt, getProjectStateDir, loadSession, saveSession, listActiveSessions, multipleSessionsError, findSessionRecord, mapParticipantProfiles, formatSpeakerCandidatesReport, buildTeleptyTurnRequestEnvelope, buildTeleptyTurnCompletedEnvelope, buildTeleptySynthesisEnvelope, validateTeleptyEnvelope, registerPendingTeleptyTurnRequest, handleTeleptyBusMessage, completePendingTeleptySemantic, cleanupPendingTeleptyTurn, getTeleptySessionHealth, TELEPTY_TRANSPORT_TIMEOUT_MS, TELEPTY_SEMANTIC_TIMEOUT_MS };
