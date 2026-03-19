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
 * MCP Deliberation Server (Global) — Multi-Session + Transport Routing + Cross-Platform + BrowserControlPort
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
 *   decision_start             Start a new decision session (template support)
 *   decision_status            Query decision session status
 *   decision_respond           Submit user responses to user_probe conflict questions
 *   decision_resume            Resume a paused session
 *   decision_history           Query past decision history
 *   decision_templates         Micro-Decision template list
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { OrchestratedBrowserPort } from "./browser-control-port.js";
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
import { readClipboardText, writeClipboardText, hasClipboardImage, captureClipboardImage } from "./clipboard.js";
import {
  DECISION_STAGES, STAGE_TRANSITIONS,
  createDecisionSession, advanceStage, buildConflictMap,
  parseOpinionFromResponse, buildOpinionPrompt,
  generateConflictQuestions, buildSynthesis, buildActionPlan,
  loadTemplates, matchTemplate,
} from "./decision-engine.js";
import { detectLang, t } from "./i18n.js";
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
const OBSIDIAN_VAULT = path.join(HOME, "Documents", "Obsidian Vault");
const OBSIDIAN_PROJECTS = path.join(OBSIDIAN_VAULT, "10-Projects");
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

function findSessionRecord(sessionRef, { preferProject, activeOnly = false } = {}) {
  if (!sessionRef) return null;

  if (typeof sessionRef === "object" && sessionRef !== null && sessionRef.id) {
    const project = getSessionProject(sessionRef, preferProject);
    const file = getSessionFile(sessionRef.id, project);
    const state = readJsonFileSafe(file);
    if (!state) return null;
    const normalized = normalizeSessionActors(state);
    if (activeOnly && normalized.status !== "active" && normalized.status !== "awaiting_synthesis") {
      return null;
    }
    return { file, project, state: normalized };
  }

  const sessionId = String(sessionRef);
  const preferred = normalizeProjectSlug(preferProject);
  const projects = [...new Set([preferred, ...listStateProjects()])];
  for (const project of projects) {
    const file = getSessionFile(sessionId, project);
    const state = readJsonFileSafe(file);
    if (!state) continue;
    const normalized = normalizeSessionActors(state);
    if (activeOnly && normalized.status !== "active" && normalized.status !== "awaiting_synthesis") {
      continue;
    }
    return { file, project: normalized.project || project, state: normalized };
  }
  return null;
}

function getArchiveDir(projectSlug = getProjectSlug()) {
  const slug = normalizeProjectSlug(projectSlug);
  const obsidianDir = path.join(OBSIDIAN_PROJECTS, slug, "deliberations");
  if (fs.existsSync(path.join(OBSIDIAN_PROJECTS, slug))) {
    return obsidianDir;
  }
  return path.join(getProjectStateDir(slug), "archive");
}

function getLocksDir(projectSlug = getProjectSlug()) {
  return path.join(getProjectStateDir(projectSlug), LOCKS_SUBDIR);
}

function getSpeakerSelectionFile(projectSlug = getProjectSlug()) {
  return path.join(getProjectStateDir(projectSlug), SPEAKER_SELECTION_FILE);
}

function formatRuntimeError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function appendRuntimeLog(level, message) {
  try {
    fs.mkdirSync(path.dirname(GLOBAL_RUNTIME_LOG), { recursive: true });
    
    // Simple rotation: if log > 1MB, truncate it
    try {
      if (fs.existsSync(GLOBAL_RUNTIME_LOG)) {
        const stats = fs.statSync(GLOBAL_RUNTIME_LOG);
        if (stats.size > 1024 * 1024) { // 1MB
          const oldLog = GLOBAL_RUNTIME_LOG + ".old";
          fs.renameSync(GLOBAL_RUNTIME_LOG, oldLog);
        }
      }
    } catch { /* ignore rotation failures */ }

    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
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
      return { content: [{ type: "text", text: t(`❌ ${toolName} failed: ${message}`, `❌ ${toolName} 실패: ${message}`, "en") }] };
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

// BrowserControlPort singleton — initialized lazily on first use
let _browserPort = null;
function getBrowserPort() {
  if (!_browserPort) {
    const cdpEndpoints = resolveCdpEndpoints();
    _browserPort = new OrchestratedBrowserPort({ cdpEndpoints });
  }
  return _browserPort;
}
// ── Session ID generation ─────────────────────────────────────

function generateSessionId(topic) {
  const slug = topic
    .replace(/[^a-zA-Z0-9가-힣\s-]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 20);
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${slug}-${ts}${rand}`;
}

function generateTurnId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Context detection ──────────────────────────────────────────

function detectContextDirs() {
  const dirs = [];
  const slug = getProjectSlug();

  if (process.env.DELIBERATION_CONTEXT_DIR) {
    dirs.push(process.env.DELIBERATION_CONTEXT_DIR);
  }
  dirs.push(process.cwd());

  const obsidianProject = path.join(OBSIDIAN_PROJECTS, slug);
  if (fs.existsSync(obsidianProject)) {
    dirs.push(obsidianProject);
  }

  return [...new Set(dirs)];
}

function readContextFromDirs(dirs, maxChars = 15000) {
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

// ── State helpers ──────────────────────────────────────────────

function ensureDirs(projectSlug = getProjectSlug()) {
  fs.mkdirSync(getSessionsDir(projectSlug), { recursive: true });
  fs.mkdirSync(getArchiveDir(projectSlug), { recursive: true });
  fs.mkdirSync(getLocksDir(projectSlug), { recursive: true });
}

function loadSession(sessionRef) {
  const record = findSessionRecord(sessionRef);
  return record?.state || null;
}

function saveSession(state) {
  ensureDirs(state.project);
  state.updated = new Date().toISOString();
  writeTextAtomic(getSessionFile(state), JSON.stringify(state, null, 2));
  syncMarkdown(state);
}

function listActiveSessions(projectSlug) {
  const projects = projectSlug
    ? [normalizeProjectSlug(projectSlug)]
    : [...new Set([getProjectSlug(), ...listStateProjects()])];

  return projects.flatMap(project => {
    const dir = getSessionsDir(project);
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
      .filter(s => s && (s.status === "active" || s.status === "awaiting_synthesis"));
  });
}

function resolveSessionId(sessionId) {
  // Use session_id directly if provided
  if (sessionId) return sessionId;

  // Auto-select when only one active session
  const active = listActiveSessions();
  if (active.length === 0) return null;
  if (active.length === 1) return active[0].id;

  // null if multiple (need to show list)
  return "MULTIPLE";
}

function syncMarkdown(state) {
  const filename = `deliberation-${state.id}.md`;
  const mdPath = path.join(getProjectStateDir(state.project), filename);
  try {
    writeTextAtomic(mdPath, stateToMarkdown(state));
  } catch { /* ignore sync failures */ }
}

function cleanupSyncMarkdown(state) {
  const filename = `deliberation-${state.id}.md`;
  const statePath = path.join(getProjectStateDir(state.project), filename);
  try { fs.unlinkSync(statePath); } catch { /* ignore */ }
  // Also clean up legacy files in CWD (from older versions)
  const cwdPath = path.join(process.cwd(), filename);
  try { fs.unlinkSync(cwdPath); } catch { /* ignore */ }
}

function formatSourceMetadataLine(meta) {
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

function stateToMarkdown(s) {
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

function archiveState(state) {
  ensureDirs(state.project);
  const slug = state.topic
    .replace(/[^a-zA-Z0-9가-힣\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 30);
  const ts = new Date().toISOString().slice(0, 16).replace(/:/g, "");
  const filename = `deliberation-${ts}-${slug}.md`;
  const dest = path.join(getArchiveDir(state.project), filename);
  writeTextAtomic(dest, stateToMarkdown(state));

  // Write machine-readable execution_contract sidecar for automation consumers
  if (state.execution_contract) {
    const contractDest = dest.replace(/\.md$/, ".contract.json");
    writeTextAtomic(contractDest, JSON.stringify({
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

// ── Terminal management ────────────────────────────────────────

const TMUX_SESSION = "deliberation";
const MONITOR_SCRIPT = path.join(INSTALL_DIR, "session-monitor.sh");
const MONITOR_SCRIPT_WIN = path.join(INSTALL_DIR, "session-monitor-win.js");

function tmuxWindowName(sessionId) {
  // Keep tmux window name short (remove last part, 20 chars)
  return sessionId.replace(/[^a-zA-Z0-9가-힣-]/g, "").slice(0, 25);
}

function appleScriptQuote(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tryExecFile(command, args = []) {
  try {
    execFileSync(command, args, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function resolveMonitorShell() {
  if (commandExistsInPath("bash")) return "bash";
  if (commandExistsInPath("sh")) return "sh";
  return null;
}

function buildMonitorCommand(sessionId, project) {
  const shell = resolveMonitorShell();
  if (!shell) return null;
  return `${shell} ${shellQuote(MONITOR_SCRIPT)} ${shellQuote(sessionId)} ${shellQuote(project)}`;
}

function buildMonitorCommandWindows(sessionId, project) {
  return `node "${MONITOR_SCRIPT_WIN}" "${sessionId}" "${project}"`;
}

function hasTmuxSession(name) {
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function hasTmuxWindow(sessionName, windowName) {
  try {
    const output = execFileSync("tmux", ["list-windows", "-t", sessionName, "-F", "#{window_name}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return String(output).split("\n").map(s => s.trim()).includes(windowName);
  } catch {
    return false;
  }
}

function tmuxHasAttachedClients(sessionName) {
  try {
    const output = execFileSync("tmux", ["list-clients", "-t", sessionName], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return String(output).trim().split("\n").filter(Boolean).length > 0;
  } catch {
    return false;
  }
}

function isTmuxWindowViewed(sessionName, windowName) {
  try {
    // List all clients and check for matching window name.
    // Grouped sessions (created via 'new-session -t') share the same windows,
    // so checking for the window name anywhere in the client list is sufficient.
    const output = execFileSync("tmux", ["list-clients", "-F", "#{window_name}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return String(output).split("\n").map(s => s.trim()).filter(Boolean).includes(windowName);
  } catch {
    return false;
  }
}

function tmuxWindowCount(name) {
  try {
    const output = execFileSync("tmux", ["list-windows", "-t", name], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return String(output)
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

function buildTmuxAttachCommand(sessionId) {
  const winName = tmuxWindowName(sessionId);
  // Use grouped session (new-session -t) so each terminal has independent active window.
  // This prevents window-switching conflicts when multiple deliberations run concurrently.
  return `tmux new-session -t ${shellQuote(TMUX_SESSION)} \\; select-window -t ${shellQuote(`${TMUX_SESSION}:${winName}`)}`;
}

function listPhysicalTerminalWindowIds() {
  if (process.platform !== "darwin") {
    return [];
  }
  try {
    const output = execFileSync(
      "osascript",
      [
        "-e",
        'tell application "Terminal"',
        "-e",
        "if not running then return \"\"",
        "-e",
        "set outText to \"\"",
        "-e",
        "repeat with w in windows",
        "-e",
        "set outText to outText & (id of w as string) & linefeed",
        "-e",
        "end repeat",
        "-e",
        "return outText",
        "-e",
        "end tell",
      ],
      { encoding: "utf-8" }
    );
    return String(output)
      .split("\n")
      .map(s => Number.parseInt(s.trim(), 10))
      .filter(n => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function openPhysicalTerminal(sessionId) {
  const winName = tmuxWindowName(sessionId);
  // Use grouped session (new-session -t) for independent active window per client
  const attachCmd = `tmux new-session -t "${TMUX_SESSION}" \\; select-window -t "${TMUX_SESSION}:${winName}"`;

  // Prevent duplicate windows for the SAME session:
  // If a client is already viewing this specific window, just activate Terminal.app
  if (isTmuxWindowViewed(TMUX_SESSION, winName)) {
    appendRuntimeLog("INFO", `TMUX_WINDOW_ALREADY_VIEWED: ${winName}. Activating existing Terminal.`);
    if (process.platform === "darwin") {
      try {
        execFileSync("osascript", ["-e", 'tell application "Terminal" to activate'], { stdio: "ignore" });
      } catch { /* ignore */ }
    }
    return { opened: true, windowIds: [] };
  }

  // If a terminal is already attached to OTHER windows, open a NEW grouped session
  // instead of select-window (which would hijack all attached clients' views).
  if (tmuxHasAttachedClients(TMUX_SESSION)) {
    if (process.platform === "darwin") {
      const groupAttachCmd = `tmux new-session -t "${TMUX_SESSION}" \\; select-window -t "${TMUX_SESSION}:${winName}"`;
      try {
        execFileSync(
          "osascript",
          [
            "-e", 'tell application "Terminal"',
            "-e", "activate",
            "-e", `do script ${appleScriptQuote(groupAttachCmd)}`,
            "-e", "end tell",
          ],
          { encoding: "utf-8" }
        );
        return { opened: true, windowIds: [] };
      } catch { /* fall through to default behavior */ }
    }
    // Non-macOS or fallback: don't force select-window, just report success
    // The monitor window already exists in tmux; user can switch manually
    return { opened: true, windowIds: [] };
  }

  if (process.platform === "darwin") {
    const before = new Set(listPhysicalTerminalWindowIds());
    try {
      const output = execFileSync(
        "osascript",
        [
          "-e",
          'tell application "Terminal"',
          "-e",
          "activate",
          "-e",
          `do script ${appleScriptQuote(attachCmd)}`,
          "-e",
          "delay 0.15",
          "-e",
          "return id of front window",
          "-e",
          "end tell",
        ],
        { encoding: "utf-8" }
      );
      const frontId = Number.parseInt(String(output).trim(), 10);
      const after = listPhysicalTerminalWindowIds();
      const opened = after.filter(id => !before.has(id));
      if (opened.length > 0) {
        return { opened: true, windowIds: [...new Set(opened)] };
      }
      if (Number.isInteger(frontId) && frontId > 0) {
        return { opened: true, windowIds: [frontId] };
      }
      return { opened: false, windowIds: [] };
    } catch {
      return { opened: false, windowIds: [] };
    }
  }

  if (process.platform === "linux") {
    const shell = resolveMonitorShell() || "sh";
    const launchCmd = `${buildTmuxAttachCommand(sessionId)}; exec ${shell}`;
    const attempts = [
      ["gnome-terminal", ["--", shell, "-lc", launchCmd]],
      ["kgx", ["--", shell, "-lc", launchCmd]],
      ["konsole", ["-e", shell, "-lc", launchCmd]],
      ["x-terminal-emulator", ["-e", shell, "-lc", launchCmd]],
      ["xterm", ["-e", shell, "-lc", launchCmd]],
      ["alacritty", ["-e", shell, "-lc", launchCmd]],
      ["kitty", [shell, "-lc", launchCmd]],
      ["wezterm", ["start", "--", shell, "-lc", launchCmd]],
    ];

    for (const [command, args] of attempts) {
      if (!commandExistsInPath(command)) continue;
      if (tryExecFile(command, args)) {
        return { opened: true, windowIds: [] };
      }
    }
    return { opened: false, windowIds: [] };
  }

  if (process.platform === "win32") {
    // Windows: monitor is launched directly by spawnMonitorTerminal (no tmux)
    // Physical terminal opening is handled there, so just return success
    return { opened: true, windowIds: [] };
  }

  return { opened: false, windowIds: [] };
}

function spawnMonitorTerminal(sessionId) {
  // Windows: use Windows Terminal or PowerShell directly (no tmux needed)
  if (process.platform === "win32") {
    const project = getProjectSlug();
    const monitorCmd = buildMonitorCommandWindows(sessionId, project);

    // Try Windows Terminal (wt.exe)
    if (commandExistsInPath("wt") || commandExistsInPath("wt.exe")) {
      if (tryExecFile("wt", ["new-tab", "--title", "Deliberation Monitor", "cmd", "/c", monitorCmd])) {
        return true;
      }
    }

    // Fallback: new PowerShell window
    const shell = ["pwsh.exe", "pwsh", "powershell.exe", "powershell"].find(c => commandExistsInPath(c));
    if (shell) {
      const escaped = monitorCmd.replace(/'/g, "''");
      if (tryExecFile(shell, ["-NoProfile", "-Command", `Start-Process cmd -ArgumentList '/c','${escaped}'`])) {
        return true;
      }
    }

    return false;
  }

  // macOS/Linux: use tmux (existing logic)
  if (!commandExistsInPath("tmux")) {
    return false;
  }

  const project = getProjectSlug();
  const winName = tmuxWindowName(sessionId);
  const cmd = buildMonitorCommand(sessionId, project);
  if (!cmd) {
    return false;
  }

  try {
    if (hasTmuxSession(TMUX_SESSION)) {
      // Skip if a window with the same name already exists (prevents duplicates)
      if (hasTmuxWindow(TMUX_SESSION, winName)) {
        appendRuntimeLog("INFO", `TMUX_WINDOW_EXISTS: ${winName} in ${TMUX_SESSION}`);
        return true;
      }
      execFileSync("tmux", ["new-window", "-t", TMUX_SESSION, "-n", winName, cmd], {
        stdio: "ignore",
        windowsHide: true,
      });
      appendRuntimeLog("INFO", `TMUX_WINDOW_CREATED: ${winName} in existing ${TMUX_SESSION}`);
    } else {
      execFileSync("tmux", ["new-session", "-d", "-s", TMUX_SESSION, "-n", winName, cmd], {
        stdio: "ignore",
        windowsHide: true,
      });
      appendRuntimeLog("INFO", `TMUX_SESSION_CREATED: ${TMUX_SESSION} with window ${winName}`);
    }
    return true;
  } catch {
    return false;
  }
}

function closePhysicalTerminal(windowId) {
  if (process.platform !== "darwin") {
    return false;
  }
  if (!Number.isInteger(windowId) || windowId <= 0) {
    return false;
  }

  const windowExists = () => {
    try {
      const out = execFileSync(
        "osascript",
        [
          "-e",
          'tell application "Terminal"',
          "-e",
          `if exists window id ${windowId} then return "1"`,
          "-e",
          'return "0"',
          "-e",
          "end tell",
        ],
        { encoding: "utf-8" }
      ).trim();
      return out === "1";
    } catch {
      return false;
    }
  };

  const dismissCloseDialogs = () => {
    try {
      execFileSync(
        "osascript",
        [
          "-e",
          'tell application "System Events"',
          "-e",
          'if exists process "Terminal" then',
          "-e",
          'tell process "Terminal"',
          "-e",
          "repeat with w in windows",
          "-e",
          "try",
          "-e",
          "if exists (sheet 1 of w) then",
          "-e",
          "if exists button \"종료\" of sheet 1 of w then",
          "-e",
          'click button "종료" of sheet 1 of w',
          "-e",
          "else if exists button \"Terminate\" of sheet 1 of w then",
          "-e",
          'click button "Terminate" of sheet 1 of w',
          "-e",
          "else if exists button \"확인\" of sheet 1 of w then",
          "-e",
          'click button "확인" of sheet 1 of w',
          "-e",
          "else",
          "-e",
          "click button 1 of sheet 1 of w",
          "-e",
          "end if",
          "-e",
          "end if",
          "-e",
          "end try",
          "-e",
          "end repeat",
          "-e",
          "end tell",
          "-e",
          "end if",
          "-e",
          "end tell",
        ],
        { stdio: "ignore" }
      );
    } catch {
      // ignore
    }
  };

  for (let i = 0; i < 5; i += 1) {
    try {
      execFileSync(
        "osascript",
        [
          "-e",
          'tell application "Terminal"',
          "-e",
          "activate",
          "-e",
          `if exists window id ${windowId} then`,
          "-e",
          "try",
          "-e",
          `do script "exit" in window id ${windowId}`,
          "-e",
          "end try",
          "-e",
          "delay 0.12",
          "-e",
          "try",
          "-e",
          `close (window id ${windowId})`,
          "-e",
          "end try",
          "-e",
          "end if",
          "-e",
          "end tell",
        ],
        { stdio: "ignore" }
      );
    } catch {
      // ignore
    }

    dismissCloseDialogs();

    if (!windowExists()) {
      return true;
    }
  }

  return !windowExists();
}

function closeMonitorTerminal(sessionId, terminalWindowIds = []) {
  if (process.platform !== "win32") {
    const winName = tmuxWindowName(sessionId);
    try {
      execFileSync("tmux", ["kill-window", "-t", `${TMUX_SESSION}:${winName}`], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch { /* ignore */ }

    try {
      if (tmuxWindowCount(TMUX_SESSION) === 0) {
        execFileSync("tmux", ["kill-session", "-t", TMUX_SESSION], {
          stdio: "ignore",
          windowsHide: true,
        });
      }
    } catch { /* ignore */ }
  }

  for (const windowId of terminalWindowIds) {
    closePhysicalTerminal(windowId);
  }
}

function getSessionWindowIds(state) {
  if (!state || typeof state !== "object") {
    return [];
  }
  const ids = [];
  if (Array.isArray(state.monitor_terminal_window_ids)) {
    for (const id of state.monitor_terminal_window_ids) {
      if (Number.isInteger(id) && id > 0) {
        ids.push(id);
      }
    }
  }
  if (Number.isInteger(state.monitor_terminal_window_id) && state.monitor_terminal_window_id > 0) {
    ids.push(state.monitor_terminal_window_id);
  }
  return [...new Set(ids)];
}

function closeAllMonitorTerminals() {
  try {
    execFileSync("tmux", ["kill-session", "-t", TMUX_SESSION], { stdio: "ignore", windowsHide: true });
  } catch { /* ignore */ }
}

function multipleSessionsError() {
  const active = listActiveSessions();
  const list = active.map(s => `- **${s.id}** [${s.project || "unknown"}]: "${s.topic}" (Round ${s.current_round}/${s.max_rounds}, next: ${s.current_speaker})`).join("\n");
  return t(`Multiple active sessions found. Please specify session_id:\n\n${list}`, `여러 활성 세션이 있습니다. session_id를 지정하세요:\n\n${list}`, "en");
}

function truncatePromptText(text, maxChars) {
  const value = String(text || "").trim();
  if (!value || !Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) {
    return value;
  }
  const remaining = value.length - maxChars;
  return `${value.slice(0, maxChars).trimEnd()}\n...(truncated ${remaining} chars)`;
}

function getPromptBudgetForSpeaker(speaker, includeHistoryEntries = 4) {
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

function formatRecentLogForPrompt(state, maxEntries = 4, options = {}) {
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

function getCliAutoTurnTimeoutSec({ speaker, requestedTimeoutSec, promptLength, priorTurns }) {
  const requested = Number.isFinite(requestedTimeoutSec) ? requestedTimeoutSec : 120;
  if (speaker === "codex") {
    let recommended = Math.max(requested, priorTurns === 0 ? 240 : 180);
    if (promptLength > 6000) {
      recommended = Math.max(recommended, 300);
    }
    if (promptLength > 10000 || priorTurns >= 1) {
      recommended = Math.max(recommended, 420);
    }
    return recommended;
  }
  return priorTurns === 0 ? Math.max(requested, 180) : requested;
}

function getCliExecArgs(speaker) {
  switch (speaker) {
    case "claude":
      return ["-p", "--output-format", "text"];
    case "codex":
      return [
        "exec",
        "--ephemeral",
        "-c", 'approval_policy="never"',
        "-c", 'sandbox_mode="read-only"',
        "-c", 'model_reasoning_effort="low"',
        "-",
      ];
    case "gemini":
      return null;
    default:
      return null;
  }
}

function buildCliAutoTurnFailureText({ state, speaker, hint, err, effectiveTimeout, promptLength, priorTurns }) {
  const isTimeout = /CLI timeout \(/.test(String(err?.message || ""));
  if (!isTimeout) {
    return `❌ CLI auto-turn failed: ${err.message}\n\n**Speaker:** ${speaker}\n**CLI:** ${hint.cmd}\n\nYou can submit a manual response via deliberation_respond(speaker: "${speaker}", content: "...").`;
  }

  const retryTimeout = speaker === "codex"
    ? Math.min(Math.max(effectiveTimeout, 420), 600)
    : Math.min(effectiveTimeout + 60, 300);

  return t(
    `⏱️ CLI auto-turn timed out.\n\n` +
    `**Speaker:** ${speaker}\n` +
    `**CLI:** ${hint.cmd}\n` +
    `**Timeout:** ${effectiveTimeout}s\n` +
    `**Prompt size:** ${promptLength} chars\n` +
    `**Prior turns by speaker:** ${priorTurns}\n` +
    `**Session state:** still waiting on ${speaker} for Round ${state.current_round}\n\n` +
    `This usually means the CLI stayed busy longer than the timeout. It does **not** necessarily mean the model is down.\n` +
    `${speaker === "codex" ? `Codex is the slowest CLI in recent deliberation logs, especially when recent_log contains long prior responses.\n` : ""}` +
    `Recommended next step: retry with \`deliberation_cli_auto_turn(session_id: "${state.id}", timeout_sec: ${retryTimeout})\`.\n` +
    `Manual fallback: \`deliberation_respond(session_id: "${state.id}", speaker: "${speaker}", content: "...")\`.`,
    `⏱️ CLI 자동 턴이 타임아웃되었습니다.\n\n` +
    `**Speaker:** ${speaker}\n` +
    `**CLI:** ${hint.cmd}\n` +
    `**Timeout:** ${effectiveTimeout}s\n` +
    `**Prompt 크기:** ${promptLength} chars\n` +
    `**이 speaker의 이전 발언 수:** ${priorTurns}\n` +
    `**세션 상태:** Round ${state.current_round}에서 아직 ${speaker} 응답을 기다리는 중\n\n` +
    `이건 보통 CLI가 제한 시간 안에 응답을 끝내지 못했다는 뜻입니다. 모델이 완전히 죽었다는 의미는 아닙니다.\n` +
    `${speaker === "codex" ? `최근 딜리버레이션 로그 기준으로 Codex는 이전 응답 전문이 길게 들어가면 가장 느린 편입니다.\n` : ""}` +
    `권장 조치: \`deliberation_cli_auto_turn(session_id: "${state.id}", timeout_sec: ${retryTimeout})\` 로 재시도하세요.\n` +
    `수동 대안: \`deliberation_respond(session_id: "${state.id}", speaker: "${speaker}", content: "...")\`.`,
    state?.lang
  );
}

function buildActiveReportingSection(state, speaker) {
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

function buildClipboardTurnPrompt(state, speaker, prompt, includeHistoryEntries = 4) {
  const promptBudget = getPromptBudgetForSpeaker(speaker, includeHistoryEntries);
  const recent = formatRecentLogForPrompt(state, promptBudget.maxEntries, promptBudget);
  const extraPrompt = prompt ? `\n[Additional instructions]\n${prompt}\n` : "";
  const topic = truncatePromptText(state.topic, promptBudget.maxTopicChars);
  const noToolRule = speaker === "codex"
    ? `\n- Do not inspect files, run shell commands, browse, or call tools. Answer only from the provided discussion context.`
    : "";
  const activeReportingSection = buildActiveReportingSection(state, speaker);

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
- Keep the response concise and decision-oriented${noToolRule}
- Must include one of [AGREE], [DISAGREE], or [CONDITIONAL: reason] at the end of response
[/response_rule]
[/deliberation_turn_request]
`;
}

function submitDeliberationTurn({ session_id, speaker, content, turn_id, channel_used, fallback_reason, attachments, source_metadata }) {
  const resolved = resolveSessionId(session_id);
  if (!resolved) {
    return { content: [{ type: "text", text: t("No active deliberation.", "활성 deliberation이 없습니다.", "en") }] };
  }
  if (resolved === "MULTIPLE") {
    return { content: [{ type: "text", text: multipleSessionsError() }] };
  }

  let completionState = null;
  let completionEntry = null;
  const result = withSessionLock(resolved, () => {
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
      appendRuntimeLog("WARN", `INVALID_TURN: ${state.id} | R${state.current_round} | speaker: ${normalizedSpeaker} | reason: no_vote_marker`);
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
    appendRuntimeLog("INFO", `TURN: ${state.id} | R${state.current_round} | speaker: ${normalizedSpeaker} | votes: ${votes.length > 0 ? votes.map(v => v.vote).join(",") : "none"} | channel: ${channel_used || "respond"} | attachments: ${attachments ? attachments.length : 0}${source_metadata?.source_machine_id ? ` | source_machine: ${source_metadata.source_machine_id}` : ""}`);

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

// ── MCP Server ─────────────────────────────────────────────────

process.on("uncaughtException", (error) => {
  const message = formatRuntimeError(error);
  appendRuntimeLog("UNCAUGHT_EXCEPTION", message);
  try {
    process.stderr.write(`[mcp-deliberation] uncaughtException: ${message}\n`);
  } catch {
    // ignore stderr write failures
  }
});

process.on("unhandledRejection", (reason) => {
  const message = formatRuntimeError(reason);
  appendRuntimeLog("UNHANDLED_REJECTION", message);
  try {
    process.stderr.write(`[mcp-deliberation] unhandledRejection: ${message}\n`);
  } catch {
    // ignore stderr write failures
  }
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
    mode: z.enum(["standard", "lite"]).default("standard").describe("Deliberation mode. 'lite' caps speakers to 3 and rounds to 2 for quick decisions."),
    orchestrator_session_id: z.string().trim().min(1).max(128).optional()
      .describe("Optional telepty session ID to notify on turn completion. Defaults to TELEPTY_SESSION_ID when available."),
  },
  safeToolHandler("deliberation_start", async ({ topic, session_id, rounds, first_speaker, selection_token, speakers, speaker_instructions, require_manual_speakers, auto_discover_speakers, include_browser_speakers, participant_types, ordering_strategy, speaker_roles, role_preset, auto_execute, mode, orchestrator_session_id }) => {
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
      selectionValidation = validateSpeakerSelectionRequest({
        selectionState: loadSpeakerSelectionToken(),
        selection_token,
        speakers,
        includeBrowserSpeakers,
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

    if (effectiveRequireManual) {
      clearSpeakerSelectionToken();
    }

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
      mode: mode || "standard",
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
    if (auto_execute) {
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
    const selection = issueSpeakerSelectionToken({
      candidates: snapshot.candidates,
      include_browser,
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
      return { content: [{ type: "text", text: t("No active deliberations.", "진행 중인 deliberation이 없습니다.", "en") }] };
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
      return { content: [{ type: "text", text: t("No active deliberation. Start one with deliberation_start.", "활성 deliberation이 없습니다. deliberation_start로 시작하세요.", "en") }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state) {
      return { content: [{ type: "text", text: t(`Session "${resolved}" not found.`, `세션 "${resolved}"을 찾을 수 없습니다.`, "en") }] };
    }

    return {
      content: [{
        type: "text",
        text: `📋 **Forum Status** — ${state.id}\n\n**Project:** ${state.project}\n**Topic:** ${state.topic}\n**Status:** ${state.status === "active" ? "active" : state.status === "awaiting_synthesis" ? "awaiting synthesis" : state.status === "completed" ? "completed" : state.status} (Round ${state.current_round}/${state.max_rounds})\n**Participants:** ${state.speakers.join(", ")}\n**Current turn:** ${state.current_speaker}\n**Accumulated responses:** ${state.log.length}${state.degradation ? `\n\n**Environment status:**\n${formatDegradationReport(state.degradation)}` : ""}`,
      }],
    };
  }
);

server.tool(
  "deliberation_context",
  "Load project context (markdown files). Auto-detects CWD + Obsidian.",
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
      return { content: [{ type: "text", text: t(`No LLM tabs detected.${suffix}`, `감지된 LLM 탭이 없습니다.${suffix}`, "en") }] };
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
      return { content: [{ type: "text", text: t("No active deliberation.", "활성 deliberation이 없습니다.", "en") }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state || state.status !== "active") {
      return { content: [{ type: "text", text: t(`Session "${resolved}" is not active.`, `세션 "${resolved}"이 활성 상태가 아닙니다.`, "en") }] };
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
      return { content: [{ type: "text", text: t("No active deliberation.", "활성 deliberation이 없습니다.", "en") }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state || state.status !== "active") {
      return { content: [{ type: "text", text: t(`Session "${resolved}" is not active.`, `세션 "${resolved}"이 활성 상태가 아닙니다.`, "en") }] };
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

// ────────────────────────────────────────────────────────────────────────────
// Auto-handoff orchestrator helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run a single CLI auto-turn for the given session and speaker.
 * Returns { ok: true, response, elapsedMs } or { ok: false, error }.
 */
async function runCliAutoTurnCore(sessionId, speaker, timeoutSec = 120) {
  const state = loadSession(sessionId);
  if (!state || state.status !== "active") {
    return { ok: false, error: "Session not active" };
  }

  const { transport } = resolveTransportForSpeaker(state, speaker);
  if (transport !== "cli_respond") {
    return { ok: false, error: `Speaker "${speaker}" is not CLI type` };
  }

  const hint = CLI_INVOCATION_HINTS[speaker];
  if (!hint) return { ok: false, error: `No CLI hints for "${speaker}"` };
  if (!checkCliLiveness(hint.cmd)) return { ok: false, error: `CLI "${hint.cmd}" not available` };

  const turnId = state.pending_turn_id || generateTurnId();
  const turnPrompt = buildClipboardTurnPrompt(state, speaker, null, 3);
  const speakerPriorTurns = state.log.filter(e => e.speaker === speaker).length;
  const effectiveTimeout = getCliAutoTurnTimeoutSec({
    speaker,
    requestedTimeoutSec: timeoutSec,
    promptLength: turnPrompt.length,
    priorTurns: speakerPriorTurns,
  });

  const startTime = Date.now();
  try {
    const response = await new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (hint.envPrefix?.includes("CLAUDECODE=")) delete env.CLAUDECODE;

      let child;
      let stdout = "";
      let stderr = "";
      let settled = false;
      let forceKillTimer = null;

      const resolveOnce = (v) => { if (!settled) { settled = true; if (forceKillTimer) clearTimeout(forceKillTimer); resolve(v); } };
      const rejectOnce = (e) => { if (!settled) { settled = true; if (forceKillTimer) clearTimeout(forceKillTimer); reject(e); } };

      switch (speaker) {
        case "claude":
          child = spawn("claude", getCliExecArgs("claude"), { env, windowsHide: true });
          child.stdin.write(turnPrompt);
          child.stdin.end();
          break;
        case "codex":
          child = spawn("codex", getCliExecArgs("codex"), { env, windowsHide: true });
          child.stdin.write(turnPrompt);
          child.stdin.end();
          break;
        case "gemini":
          child = spawn("gemini", ["-p", turnPrompt], { env, windowsHide: true });
          break;
        default: {
          const flags = hint.flags ? hint.flags.split(/\s+/) : [];
          child = spawn(hint.cmd, [...flags, turnPrompt], { env, windowsHide: true });
          break;
        }
      }

      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        forceKillTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
        if (typeof forceKillTimer?.unref === "function") forceKillTimer.unref();
        rejectOnce(new Error(`CLI timeout (${effectiveTimeout}s)`));
      }, effectiveTimeout * 1000);

      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim()) {
          rejectOnce(new Error(`CLI exit code ${code}: ${stderr.slice(0, 500)}`));
        } else {
          resolveOnce(stdout.trim());
        }
      });

      child.on("error", (err) => rejectOnce(err));
    });

    // Submit the turn
    submitDeliberationTurn({
      session_id: sessionId,
      speaker,
      content: response,
      turn_id: turnId,
      channel_used: "cli_auto",
    });

    return { ok: true, response, elapsedMs: Date.now() - startTime };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function runBrowserAutoTurnCore(sessionId, speaker, timeoutSec = 45) {
  const state = loadSession(sessionId);
  if (!state || state.status !== "active") {
    return { ok: false, error: "Session not active" };
  }

  const { transport, profile } = resolveTransportForSpeaker(state, speaker);
  if (transport !== "browser_auto") {
    return { ok: false, error: `Speaker "${speaker}" is not browser_auto type` };
  }

  const turnId = state.pending_turn_id || generateTurnId();
  const port = getBrowserPort();
  const effectiveProvider = profile?.provider || "chatgpt";
  const modelSelection = getModelSelectionForTurn(state, speaker, effectiveProvider);
  const turnPrompt = buildClipboardTurnPrompt(state, speaker, null, 3);
  const startTime = Date.now();

  try {
    const attachResult = await port.attach(sessionId, {
      provider: effectiveProvider,
      url: profile?.url || undefined,
    });
    if (!attachResult.ok) {
      return { ok: false, error: `attach failed: ${attachResult.error?.message || "unknown error"}` };
    }

    const loginCheck = await port.checkLogin(sessionId);
    if (loginCheck && !loginCheck.loggedIn) {
      await port.detach(sessionId);
      return { ok: false, error: `login required: ${loginCheck.reason || "not logged in"}` };
    }

    if (modelSelection.model !== "default") {
      await port.switchModel(sessionId, modelSelection.model);
    }

    const sendResult = await port.sendTurnWithDegradation(sessionId, turnId, turnPrompt);
    if (!sendResult.ok) {
      await port.detach(sessionId);
      return { ok: false, error: `send failed: ${sendResult.error?.message || "unknown error"}` };
    }

    const waitResult = await port.waitTurnResult(sessionId, turnId, timeoutSec);
    await port.detach(sessionId);
    if (!waitResult.ok || !waitResult.data?.response) {
      return { ok: false, error: waitResult.error?.message || "no response received" };
    }

    submitDeliberationTurn({
      session_id: sessionId,
      speaker,
      content: waitResult.data.response,
      turn_id: turnId,
      channel_used: "browser_auto",
    });

    return {
      ok: true,
      response: waitResult.data.response,
      elapsedMs: Date.now() - startTime,
      model: modelSelection.model,
      provider: effectiveProvider,
    };
  } catch (err) {
    try { await port.detach(sessionId); } catch {}
    return { ok: false, error: err?.message || String(err) };
  }
}

async function runTeleptyBusAutoTurnCore(sessionId, speaker, includeHistoryEntries = 4) {
  const state = loadSession(sessionId);
  if (!state || state.status !== "active") {
    return { ok: false, error: "Session not active" };
  }

  const { transport } = resolveTransportForSpeaker(state, speaker);
  if (transport !== "telepty_bus") {
    return { ok: false, error: `Speaker "${speaker}" is not telepty_bus type` };
  }

  const startTime = Date.now();
  const dispatchResult = await dispatchTeleptyTurnRequest({
    state,
    speaker,
    includeHistoryEntries,
    awaitSemantic: true,
  });
  if (!dispatchResult.publishResult?.ok) {
    return {
      ok: false,
      blocked: true,
      error: dispatchResult.publishResult?.error || dispatchResult.publishResult?.status || "telepty bus publish failed",
      envelope: dispatchResult.envelope,
      turnPrompt: dispatchResult.turnPrompt,
    };
  }
  if (!dispatchResult.transportResult?.ok) {
    return {
      ok: false,
      blocked: true,
      error: dispatchResult.transportResult?.code || "transport timeout",
      envelope: dispatchResult.envelope,
      turnPrompt: dispatchResult.turnPrompt,
    };
  }
  if (!dispatchResult.semanticResult?.ok) {
    return {
      ok: false,
      blocked: true,
      error: dispatchResult.semanticResult?.code || "semantic timeout",
      envelope: dispatchResult.envelope,
      turnPrompt: dispatchResult.turnPrompt,
    };
  }

  return {
    ok: true,
    elapsedMs: Date.now() - startTime,
    envelope: dispatchResult.envelope,
    publishResult: dispatchResult.publishResult,
    transportResult: dispatchResult.transportResult,
    semanticResult: dispatchResult.semanticResult,
  };
}

async function runUntilBlockedCore(sessionId, {
  maxTurns = 12,
  cliTimeoutSec = 120,
  browserTimeoutSec = 45,
  includeHistoryEntries = 4,
} = {}) {
  const steps = [];

  for (let iteration = 0; iteration < maxTurns; iteration += 1) {
    const state = loadSession(sessionId);
    if (!state) {
      return { ok: false, status: "missing", error: "Session not found", steps };
    }
    if (state.status !== "active" || state.current_speaker === "none") {
      return { ok: true, status: state.status, steps };
    }

    const speaker = state.current_speaker;
    const { transport } = resolveTransportForSpeaker(state, speaker);
    const callerSpeaker = detectCallerSpeaker();
    if (transport === "cli_respond" && callerSpeaker && normalizeSpeaker(callerSpeaker) === normalizeSpeaker(speaker)) {
      return {
        ok: true,
        status: "blocked",
        block_reason: "self_turn",
        speaker,
        transport,
        turn_prompt: buildClipboardTurnPrompt(state, speaker, null, includeHistoryEntries),
        steps,
      };
    }

    if (transport === "manual" || transport === "clipboard") {
      return {
        ok: true,
        status: "blocked",
        block_reason: "manual_transport",
        speaker,
        transport,
        turn_prompt: buildClipboardTurnPrompt(state, speaker, null, includeHistoryEntries),
        steps,
      };
    }

    let result = null;
    if (transport === "cli_respond") {
      result = await runCliAutoTurnCore(sessionId, speaker, cliTimeoutSec);
    } else if (transport === "browser_auto") {
      result = await runBrowserAutoTurnCore(sessionId, speaker, browserTimeoutSec);
    } else if (transport === "telepty_bus") {
      result = await runTeleptyBusAutoTurnCore(sessionId, speaker, includeHistoryEntries);
    } else {
      return {
        ok: true,
        status: "blocked",
        block_reason: "unsupported_transport",
        speaker,
        transport,
        turn_prompt: buildClipboardTurnPrompt(state, speaker, null, includeHistoryEntries),
        steps,
      };
    }

    steps.push({
      speaker,
      transport,
      ok: Boolean(result?.ok),
      error: result?.error || null,
      elapsedMs: result?.elapsedMs || null,
      blocked: Boolean(result?.blocked),
    });

    if (!result?.ok) {
      return {
        ok: Boolean(result?.blocked),
        status: result?.blocked ? "blocked" : "error",
        block_reason: result?.blocked ? (result.error || "transport_blocked") : null,
        speaker,
        transport,
        error: result?.error || null,
        turn_prompt: result?.turnPrompt || null,
        steps,
      };
    }
  }

  const finalState = loadSession(sessionId);
  return {
    ok: true,
    status: finalState?.status === "active" ? "max_turns_reached" : (finalState?.status || "completed"),
    steps,
  };
}

/**
 * Generate structured synthesis by calling a CLI speaker with a synthesis prompt.
 */
async function generateAutoSynthesis(sessionId) {
  const state = loadSession(sessionId);
  if (!state) return null;

  const historyText = state.log.map(e => `[${e.speaker}] ${e.content}`).join("\n\n---\n\n");

  const synthesisPrompt = `You are a deliberation synthesizer. Analyze this discussion and produce ONLY a JSON response (no markdown, no explanation).

Topic: ${state.topic}
Project: ${state.project}
Rounds: ${state.max_rounds}

Discussion:
${historyText}

Respond with EXACTLY this JSON structure:
{
  "summary": "Brief summary of the outcome",
  "decisions": ["Decision 1", "Decision 2"],
  "actionable_tasks": [
    {"id": 1, "task": "What to do", "files": ["path/to/file.ts"], "project": "${state.project}", "priority": "high|medium|low"}
  ],
  "markdown_synthesis": "# Full synthesis in markdown\\n\\n..."
}`;

  // Use the first available CLI speaker to generate synthesis
  const speaker = state.speakers.find(s => {
    const hint = CLI_INVOCATION_HINTS[s];
    return hint && checkCliLiveness(hint.cmd);
  });

  if (!speaker) return null;

  const hint = CLI_INVOCATION_HINTS[speaker];

  try {
    const response = await new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (hint.envPrefix?.includes("CLAUDECODE=")) delete env.CLAUDECODE;

      let child;
      let stdout = "";

      switch (speaker) {
        case "claude":
          child = spawn("claude", getCliExecArgs("claude"), { env, windowsHide: true });
          child.stdin.write(synthesisPrompt);
          child.stdin.end();
          break;
        case "codex":
          child = spawn("codex", getCliExecArgs("codex"), { env, windowsHide: true });
          child.stdin.write(synthesisPrompt);
          child.stdin.end();
          break;
        case "gemini":
          child = spawn("gemini", ["-p", synthesisPrompt], { env, windowsHide: true });
          break;
        default: {
          const flags = hint.flags ? hint.flags.split(/\s+/) : [];
          child = spawn(hint.cmd, [...flags, synthesisPrompt], { env, windowsHide: true });
          break;
        }
      }

      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        reject(new Error("Synthesis generation timeout"));
      }, 180000); // 3 min timeout for synthesis

      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(stdout.trim());
      });
      child.on("error", reject);
    });

    // Extract JSON from response (may have markdown wrapping)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { markdown_synthesis: response };

    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return { markdown_synthesis: response };
    }
  } catch (err) {
    appendRuntimeLog("ERROR", `AUTO_SYNTHESIS_FAILED: ${sessionId} | ${err.message}`);
    return null;
  }
}

/**
 * Orchestrate full auto-handoff: run all turns -> synthesize -> inbox -> telepty.
 * Called as fire-and-forget from deliberation_start when auto_execute is true.
 */
async function runAutoHandoff(sessionId) {
  appendRuntimeLog("INFO", `AUTO_HANDOFF_START: ${sessionId}`);

  try {
    // Phase 1: Run all deliberation turns
    let maxIterations = 100; // safety limit
    while (maxIterations-- > 0) {
      const state = loadSession(sessionId);
      if (!state) {
        appendRuntimeLog("ERROR", `AUTO_HANDOFF: Session ${sessionId} disappeared`);
        return;
      }
      if (state.status !== "active") {
        appendRuntimeLog("INFO", `AUTO_HANDOFF: Session ${sessionId} status=${state.status}, turns done`);
        break;
      }

      const speaker = state.current_speaker;
      if (speaker === "none") break;

      appendRuntimeLog("INFO", `AUTO_HANDOFF_TURN: ${sessionId} | speaker: ${speaker} | round: ${state.current_round}/${state.max_rounds}`);

      const runResult = await runUntilBlockedCore(sessionId, { maxTurns: 1, includeHistoryEntries: 3 });
      const step = runResult.steps.at(-1) || null;
      if (!runResult.ok || runResult.status === "blocked") {
        appendRuntimeLog("WARN", `AUTO_HANDOFF_TURN_BLOCKED: ${sessionId} | speaker: ${speaker} | ${runResult.block_reason || runResult.error || "unknown"}`);
        break;
      }

      appendRuntimeLog("INFO", `AUTO_HANDOFF_TURN_OK: ${sessionId} | speaker: ${speaker} | ${step?.elapsedMs || 0}ms`);
    }

    // Phase 2: Generate structured synthesis
    appendRuntimeLog("INFO", `AUTO_HANDOFF_SYNTHESIZE: ${sessionId}`);
    let synthResult = await generateAutoSynthesis(sessionId);

    // Phase 3: Call synthesize (reuse existing logic)
    const state = loadSession(sessionId);
    if (!state) return;

    // Fallback: if synthesis generation failed, build a basic structure from the discussion
    if (!synthResult || (!synthResult.summary && !synthResult.actionable_tasks)) {
      appendRuntimeLog("WARN", `AUTO_HANDOFF_SYNTH_FALLBACK: ${sessionId} | Building fallback from discussion log`);
      const turns = state.log || [];
      const fallbackSummary = turns.length > 0
        ? `Deliberation on "${state.topic}" completed with ${turns.length} turns from ${[...new Set(turns.map(t => t.speaker))].join(", ")}.`
        : `Deliberation on "${state.topic}" completed.`;
      synthResult = {
        summary: fallbackSummary,
        decisions: [`Discussed: ${state.topic}`],
        actionable_tasks: [],
        markdown_synthesis: `# Auto-generated synthesis (fallback)\n\n${fallbackSummary}\n\n## Discussion\n${turns.map(t => `**${t.speaker}**: ${typeof t.content === 'string' ? t.content.substring(0, 200) : '(no content)'}${t.content && t.content.length > 200 ? '...' : ''}`).join("\n\n")}`,
      };
    }

    const markdownSynthesis = synthResult?.markdown_synthesis ||
      `# Auto-generated synthesis\n\n${synthResult?.summary || "Deliberation completed."}\n\n## Decisions\n${(synthResult?.decisions || []).map(d => `- ${d}`).join("\n")}\n\n## Tasks\n${(synthResult?.actionable_tasks || []).map(t => `- [${t.priority}] ${t.task}`).join("\n")}`;

    const structured = {
      summary: synthResult.summary || "",
      decisions: synthResult.decisions || [],
      actionable_tasks: synthResult.actionable_tasks || [],
    };

    // Apply synthesis to session
    withSessionLock(sessionId, () => {
      const loaded = loadSession(sessionId);
      if (!loaded) return;
      loaded.synthesis = markdownSynthesis;
      loaded.structured_synthesis = structured;
      loaded.execution_contract = buildExecutionContract({ state: loaded, structured });
      loaded.status = "completed";
      loaded.current_speaker = "none";
      saveSession(loaded);
      archiveState(loaded);
      cleanupSyncMarkdown(loaded);

      const sessionFile = getSessionFile(loaded);
      try { if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile); } catch {}
    });

    closeMonitorTerminal(sessionId, getSessionWindowIds(state));

    appendRuntimeLog("INFO", `AUTO_HANDOFF_SYNTHESIZED: ${sessionId}`);

    // Phase 4: Notify telepty bus with full structured data for dustcraw to consume
    if (state.auto_execute) {
      const envelope = buildTeleptySynthesisEnvelope({
        state,
        synthesis: markdownSynthesis,
        structured,
      });
      await notifyTeleptyBus(envelope).catch(() => {});
      appendRuntimeLog("INFO", `AUTO_HANDOFF_NOTIFIED: ${sessionId} | telepty event sent`);
    }

    appendRuntimeLog("INFO", `AUTO_HANDOFF_COMPLETE: ${sessionId}`);
  } catch (err) {
    appendRuntimeLog("ERROR", `AUTO_HANDOFF_ERROR: ${sessionId} | ${err.message}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────

server.tool(
  "deliberation_cli_auto_turn",
  "Automatically send a turn to a CLI speaker and collect the response.",
  {
    session_id: z.string().optional().describe("Session ID (required if multiple sessions are active)"),
    timeout_sec: z.number().optional().default(120).describe("CLI response wait timeout (seconds)"),
  },
  safeToolHandler("deliberation_cli_auto_turn", async ({ session_id, timeout_sec }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: t("No active deliberation.", "활성 deliberation이 없습니다.", "en") }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state || state.status !== "active") {
      return { content: [{ type: "text", text: t(`Session "${resolved}" is not active.`, `세션 "${resolved}"이 활성 상태가 아닙니다.`, "en") }] };
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

    // Spawn CLI process
    const startTime = Date.now();
    try {
      const response = await new Promise((resolve, reject) => {
        const env = { ...process.env };
        // Unset CLAUDECODE for claude to avoid nested session errors
        if (hint.envPrefix?.includes("CLAUDECODE=")) {
          delete env.CLAUDECODE;
        }

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
            child = spawn("claude", getCliExecArgs("claude"), { env, windowsHide: true });
            child.stdin.write(turnPrompt);
            child.stdin.end();
            break;
          case "codex":
            child = spawn("codex", getCliExecArgs("codex"), { env, windowsHide: true });
            child.stdin.write(turnPrompt);
            child.stdin.end();
            break;
          case "gemini":
            child = spawn("gemini", ["-p", turnPrompt], { env, windowsHide: true });
            break;
          default: {
            // Generic: try command with prompt as argument
            const flags = hint.flags ? hint.flags.split(/\s+/) : [];
            child = spawn(hint.cmd, [...flags, turnPrompt], { env, windowsHide: true });
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

      return {
        content: [{
          type: "text",
          text: `✅ CLI auto-turn complete!\n\n**Speaker:** ${speaker}\n**CLI:** ${hint.cmd}\n**Turn ID:** ${turnId}\n**Response length:** ${response.length} chars\n**Elapsed:** ${elapsedMs}ms\n\n${result.content[0].text}`,
        }],
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
      return { content: [{ type: "text", text: t("No active deliberation.", "활성 deliberation이 없습니다.", "en") }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const initialState = loadSession(resolved);
    if (!initialState || initialState.status !== "active") {
      return { content: [{ type: "text", text: t(`Session "${resolved}" is not active.`, `세션 "${resolved}"이 활성 상태가 아닙니다.`, "en") }] };
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
  },
  safeToolHandler("deliberation_respond", async ({ session_id, speaker, content, content_file, use_clipboard, include_clipboard_image, turn_id }) => {
    // Guard: prevent orchestrator from fabricating responses for CLI/browser speakers
    const resolved = resolveSessionId(session_id);
    if (resolved && resolved !== "MULTIPLE") {
      const state = loadSession(resolved);
      if (state) {
        const { transport } = resolveTransportForSpeaker(state, speaker);
        if (transport === "cli_respond" || transport === "browser_auto") {
          // Check if caller is the same speaker (legitimate self-response) or an impersonator
          const callerSpeaker = detectCallerSpeaker();
          const callerIsSpeaker = callerSpeaker && (speaker === callerSpeaker);
          if (!callerIsSpeaker) {
            return {
              content: [{
                type: "text",
                text: t(
                  `⚠️ **Proxy response blocked**: Speaker "${speaker}" has ${transport} transport.\n\nThe orchestrator is not allowed to write responses on behalf of other speakers.\nUse the following tools instead:\n- CLI speaker → \`deliberation_route_turn\` or \`deliberation_cli_auto_turn\`\n- Browser speaker → \`deliberation_route_turn\` or \`deliberation_browser_auto_turn\`\n\nThese tools run the actual CLI/browser to collect genuine responses.`,
                  `⚠️ **대리 응답 차단**: speaker "${speaker}"는 ${transport} transport입니다.\n\n오케스트레이터가 다른 speaker를 대신하여 응답을 작성하는 것은 허용되지 않습니다.\n대신 다음 도구를 사용하세요:\n- CLI speaker → \`deliberation_route_turn\` 또는 \`deliberation_cli_auto_turn\`\n- 브라우저 speaker → \`deliberation_route_turn\` 또는 \`deliberation_browser_auto_turn\`\n\n이 도구들이 실제 CLI/브라우저를 실행하여 진짜 응답을 수집합니다.`,
                  state?.lang),
              }],
            };
          }
        }
      }
    }

    // Support reading content from file or clipboard to avoid JSON escaping issues
    let finalContent = content;
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
      return { content: [{ type: "text", text: t("❌ Either content, content_file, or include_clipboard_image must be provided.", "❌ content, content_file 또는 include_clipboard_image 중 하나를 제공해야 합니다.", "en") }] };
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
  "deliberation_list_remote_sessions",
  "List all active deliberation sessions on a remote machine (via Tailscale/IP) to find the correct session_id for context injection.",
  {
    remote_url: z.string().describe("The Tailscale IP or Host and port (e.g., '100.100.100.5:3847') of the remote machine."),
  },
  safeToolHandler("deliberation_list_remote_sessions", async ({ remote_url }) => {
    try {
      const baseUrl = remote_url.startsWith("http") ? remote_url : `http://${remote_url}`;
      const cleanBaseUrl = baseUrl.replace(/\/$/, "");
      const response = await fetch(`${cleanBaseUrl}/api/sessions`);
      
      if (!response.ok) {
        return { content: [{ type: "text", text: `❌ Failed to fetch remote sessions (${response.status})` }] };
      }
      
      const sessions = await response.json();
      if (!Array.isArray(sessions) || sessions.length === 0) {
        return { content: [{ type: "text", text: `No active deliberation sessions found on ${remote_url}.` }] };
      }

      let result = `### Active Sessions on ${remote_url}\n\n`;
      for (const s of sessions) {
        result += `- **ID:** \`${s.id}\`\n`;
        result += `  **Topic:** ${s.topic}\n`;
        result += `  **Status:** ${s.status} (Round ${s.current_round}/${s.max_rounds})\n\n`;
      }

      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Error connecting to remote machine at ${remote_url}: ${e.message}` }] };
    }
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
      return { content: [{ type: "text", text: t("No active deliberation.", "활성 deliberation이 없습니다.", "en") }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    return withSessionLock(resolved, () => {
      const state = loadSession(resolved);
      if (!state || state.status !== "active") {
        return { content: [{ type: "text", text: t(`Session "${resolved}" is not active.`, `세션 "${resolved}"이 활성 상태가 아닙니다.`, "en") }] };
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
  "deliberation_copy_last_turn",
  "Copy the last turn's response to the system clipboard.",
  {
    session_id: z.string().optional().describe("Session ID (required if multiple sessions are active)"),
  },
  async ({ session_id }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved || resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: t("No unique active deliberation found.", "고유한 활성 deliberation을 찾을 수 없습니다.", "en") }] };
    }
    const state = loadSession(resolved);
    if (!state || state.log.length === 0) {
      return { content: [{ type: "text", text: t("No responses yet.", "아직 응답이 없습니다.", "en") }] };
    }
    const last = state.log[state.log.length - 1];
    try {
      writeClipboardText(last.content);
      let imgMsg = "";
      if (last.attachments && last.attachments.length > 0) {
        const hasImg = last.attachments.some(a => a.type === "image");
        if (hasImg) imgMsg = "\n\n⚠️ Note: This response included images, but only text was copied to the clipboard.";
      }
      return { content: [{ type: "text", text: `📋 **[${last.speaker}]'s response copied to clipboard.** (Round ${last.round})${imgMsg}\n\nYou can now paste it into other tools using Cmd+V (ㅍ).` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Failed to copy to clipboard: ${e.message}` }] };
    }
  }
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
      return { content: [{ type: "text", text: t("No active deliberation.", "활성 deliberation이 없습니다.", "en") }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state) {
      return { content: [{ type: "text", text: t(`Session "${resolved}" not found.`, `세션 "${resolved}"을 찾을 수 없습니다.`, "en") }] };
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
      return { content: [{ type: "text", text: t("No active deliberation.", "활성 deliberation이 없습니다.", "en") }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    let state = null;
    let archivePath = null;
    const lockedResult = withSessionLock(resolved, () => {
      const loaded = loadSession(resolved);
      if (!loaded) {
        return { content: [{ type: "text", text: t(`Session "${resolved}" not found.`, `세션 "${resolved}"을 찾을 수 없습니다.`, "en") }] };
      }

      loaded.synthesis = synthesis;
      loaded.structured_synthesis = structured || null;
      loaded.execution_contract = buildExecutionContract({ state: loaded, structured: structured || null });
      loaded.status = "completed";
      loaded.current_speaker = "none";
      saveSession(loaded);
      archivePath = archiveState(loaded);
      cleanupSyncMarkdown(loaded);

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
      return { content: [{ type: "text", text: t("No past deliberations.", "과거 deliberation이 없습니다.", "en") }] };
    }

    const files = fs.readdirSync(archiveDir)
      .filter(f => f.startsWith("deliberation-") && f.endsWith(".md"))
      .sort().reverse();

    if (files.length === 0) {
      return { content: [{ type: "text", text: t("No past deliberations.", "과거 deliberation이 없습니다.", "en") }] };
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
          return { content: [{ type: "text", text: t(`Session "${session_id}" not found.`, `세션 "${session_id}"을 찾을 수 없습니다.`, "en") }] };
        }
        const file = getSessionFile(state);
        if (state && state.log.length > 0) {
          archiveState(state);
        }
        if (state) cleanupSyncMarkdown(state);
        toCloseIds = getSessionWindowIds(state);
        fs.unlinkSync(file);
        return { content: [{ type: "text", text: t(`✅ Session "${session_id}" reset complete. 🖥️ Monitor terminal closed.`, `✅ 세션 "${session_id}" 초기화 완료. 🖥️ 모니터 터미널 닫힘.`, "en") }] };
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
      return { content: [{ type: "text", text: t("No sessions to reset.", "초기화할 세션이 없습니다.", "en") }] };
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

// ── Request Review (auto-review) ───────────────────────────────

function invokeCliReviewer(command, prompt, timeoutMs) {
  const hint = CLI_INVOCATION_HINTS[command];
  let args;
  let opts = { encoding: "utf-8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024, windowsHide: true };
  const env = { ...process.env };

  switch (command) {
    case "claude":
      if (hint?.envPrefix?.includes("CLAUDECODE=")) delete env.CLAUDECODE;
      args = ["-p", "--output-format", "text", "--no-input"];
      opts.input = prompt;
      break;
    case "codex":
      args = ["exec", "-"];
      opts.input = prompt;
      break;
    case "gemini":
      args = ["-p", prompt];
      opts.stdio = ["ignore", "pipe", "pipe"];
      break;
    default: {
      const flags = hint?.flags ? hint.flags.split(/\s+/).filter(Boolean) : ["-p"];
      args = [...flags, prompt];
      opts.stdio = ["ignore", "pipe", "pipe"];
      break;
    }
  }

  try {
    const result = execFileSync(command, args, { ...opts, env });
    let cleaned = result;
    if (command === "codex") {
      const lines = result.split("\n");
      const codexLineIdx = lines.findIndex(l => l.trim() === "codex");
      if (codexLineIdx !== -1) {
        cleaned = lines.slice(codexLineIdx + 1)
          .filter(line => !/^(tokens used$|^[0-9,]*$)/.test(line))
          .join("\n");
      }
    }
    return { ok: true, response: cleaned.trim() };
  } catch (error) {
    if (error && error.killed) {
      return { ok: false, error: "timeout" };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: msg };
  }
}

function buildReviewPrompt(context, question, priorReviews) {
  let prompt = `You are a code reviewer. Provide a concise, structured review.\n\n`;
  prompt += `## Context\n${context}\n\n`;
  prompt += `## Review Question\n${question}\n\n`;
  if (priorReviews.length > 0) {
    prompt += `## Prior Reviews\n`;
    for (const r of priorReviews) {
      prompt += `### ${r.reviewer}\n${r.response}\n\n`;
    }
  }
  prompt += `Respond with your review. Be specific about issues, risks, and suggestions.`;
  return prompt;
}

function synthesizeReviews(context, question, reviews) {
  if (reviews.length === 0) return "(No reviews completed)";

  let synthesis = `## Review Synthesis\n\n`;
  synthesis += `**Question:** ${question}\n`;
  synthesis += `**Reviews:** ${reviews.length}\n\n`;

  synthesis += `### Individual Reviews\n\n`;
  for (const r of reviews) {
    synthesis += `#### ${r.reviewer}\n${r.response}\n\n`;
  }

  if (reviews.length > 1) {
    synthesis += `### Summary\n`;
    synthesis += `${reviews.length} reviewer(s) provided feedback on: ${question}\n`;
    synthesis += `Reviewers: ${reviews.map(r => r.reviewer).join(", ")}\n`;
  }

  return synthesis;
}

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

// ── Decision Engine Tools ─────────────────────────────────────

server.tool(
  "decision_start",
  "Start a new decision session. Multiple LLMs provide independent opinions and conflicts are visualized.",
  {
    problem: z.string().describe("Decision problem (e.g., 'JWT vs Session authentication method')"),
    options: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.array(z.string()).optional()
    ).describe("Options list (e.g., ['JWT', 'Session', 'OAuth2'])"),
    criteria: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.array(z.string()).optional()
    ).describe("Evaluation criteria (auto-loaded from template if omitted)"),
    template: z.string().optional().describe("Micro-decision template ID (lib-compare, arch-decision, pr-priority, naming-convention, tradeoff, risk-approval)"),
    speakers: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.array(z.string().trim().min(1).max(64)).min(2).optional()
    ).describe("Participating LLM list (minimum 2, e.g., ['claude', 'codex', 'gemini'])"),
  },
  safeToolHandler("decision_start", async ({ problem, options, criteria, template, speakers }) => {
    // Auto-discover speakers if not provided
    if (!speakers || speakers.length === 0) {
      const candidateSnapshot = await collectSpeakerCandidates({ include_cli: true, include_browser: false });
      speakers = candidateSnapshot.candidates
        .filter(c => c.type === "cli" && checkCliLiveness(c.speaker))
        .map(c => c.speaker)
        .slice(0, 4);
      if (speakers.length < 2) {
        return { content: [{ type: "text", text: t("❌ Decision requires at least 2 speakers. Please specify speakers directly.", "❌ 의사결정에 최소 2명의 speaker가 필요합니다. speakers를 직접 지정하세요.", "en") }] };
      }
    }

    // Template matching
    const templates = loadTemplates();
    let matchedTemplate = null;
    if (template) {
      matchedTemplate = templates.find(t => t.id === template) || null;
    } else {
      matchedTemplate = matchTemplate(problem, templates);
    }

    // Use template criteria if not provided
    if ((!criteria || criteria.length === 0) && matchedTemplate) {
      criteria = matchedTemplate.criteria.map(c => c.name || c);
    }

    // Create session
    const session = createDecisionSession({
      problem,
      options: options || [],
      criteria: criteria || [],
      speakers,
      template: matchedTemplate?.id || null,
      participant_profiles: mapParticipantProfiles(speakers, [], {}),
    });

    // Advance to parallel_opinions immediately (intake is just creation)
    advanceStage(session);

    // Save session
    withSessionLock(session.id, () => {
      saveSession(session);
    });

    appendRuntimeLog("INFO", `DECISION_START: ${session.id} | problem: ${problem.slice(0, 60)} | speakers: ${speakers.join(",")} | criteria: ${(criteria || []).length}`);

    // Build opinion prompt for parallel execution
    const opinionPrompt = buildOpinionPrompt(problem, options || [], criteria || [], matchedTemplate?.id);

    // Run parallel independent opinions using CLI auto-turn pattern
    const opinionResults = {};
    const opinionPromises = speakers.map(async (speaker) => {
      try {
        const hint = CLI_INVOCATION_HINTS[speaker] || CLI_INVOCATION_HINTS["_generic"];
        const cmd = hint?.cmd || speaker;

        // Check liveness
        if (!checkCliLiveness(cmd)) {
          opinionResults[speaker] = { error: `CLI not available: ${cmd}` };
          return;
        }

        // Spawn CLI with opinion prompt
        const result = await new Promise((resolve, reject) => {
          let stdout = "";
          let stderr = "";

          let proc;
          const env = { ...process.env, NO_COLOR: "1" };
          
          if (speaker === "claude") {
            const args = getCliExecArgs("claude");
            proc = spawn("claude", args.includes("--no-input") ? args : [...args, "--no-input"], { env, windowsHide: true });
            proc.stdin.write(opinionPrompt);
            proc.stdin.end();
          } else if (speaker === "codex") {
            proc = spawn("codex", getCliExecArgs("codex"), { env, windowsHide: true });
            proc.stdin.write(opinionPrompt);
            proc.stdin.end();
          } else if (speaker === "gemini") {
            proc = spawn("gemini", ["-p", opinionPrompt], { env, windowsHide: true });
          } else {
            const flags = hint?.flags ? (Array.isArray(hint.flags) ? hint.flags : hint.flags.split(/\s+/)) : [];
            proc = spawn(cmd, [...flags, opinionPrompt], { env, windowsHide: true });
          }

          proc.stdout?.on("data", (d) => { stdout += d.toString(); });
          proc.stderr?.on("data", (d) => { stderr += d.toString(); });

          const timer = setTimeout(() => {
            proc.kill("SIGTERM");
            reject(new Error("timeout"));
          }, 180000);

          proc.on("close", (code) => {
            clearTimeout(timer);
            let cleaned = stdout.trim() || stderr.trim();
            if (speaker === "codex") {
              const lines = cleaned.split("\n");
              const codexLineIdx = lines.findIndex(l => l.trim() === "codex");
              if (codexLineIdx !== -1) {
                cleaned = lines.slice(codexLineIdx + 1)
                  .filter(line => !/^(tokens used$|^[0-9,]*$|^mcp:.*)/.test(line))
                  .join("\n").trim();
              }
            } else if (speaker === "gemini") {
              cleaned = cleaned.split("\n")
                .filter(line => !/^(Loaded cached|Error during discovery|\[MCP error\]| {4}at| {2}errno:| {2}code:| {2}syscall:| {2}path:| {2}spawnargs:|MCP issues detected|Server .* supports tool updates)/.test(line))
                .join("\n").trim();
            }
            resolve(cleaned);
          });

          proc.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        opinionResults[speaker] = result;
      } catch (err) {
        opinionResults[speaker] = { error: err.message };
      }
    });

    // Wait for all opinions in parallel
    await Promise.all(opinionPromises);

    // Parse opinions and update session
    withSessionLock(session.id, () => {
      const latest = loadSession(session.id);
      if (!latest) return;

      for (const [speaker, result] of Object.entries(opinionResults)) {
        if (typeof result === "string") {
          latest.opinions[speaker] = parseOpinionFromResponse(speaker, result, latest.criteria);
          latest.log.push({
            round: 1,
            speaker,
            content: result,
            timestamp: new Date().toISOString(),
            channel_used: "cli_auto",
            event: "opinion",
          });
        } else {
          appendRuntimeLog("WARN", `DECISION_OPINION_FAIL: ${session.id} | ${speaker}: ${result?.error}`);
        }
      }

      // Advance to conflict_map
      latest.stage = "conflict_map";
      latest.metadata.updated = new Date().toISOString();

      // Build conflict map
      latest.conflicts = buildConflictMap(latest.opinions, latest.criteria);

      // Advance to user_probe
      latest.stage = "user_probe";
      latest.metadata.updated = new Date().toISOString();

      saveSession(latest);
    });

    // Load updated session for response
    const updatedSession = loadSession(session.id);
    const conflictText = generateConflictQuestions(updatedSession?.conflicts || []);
    const successCount = Object.keys(updatedSession?.opinions || {}).length;
    const templateInfo = matchedTemplate ? `\n**Template:** ${matchedTemplate.name}` : "";

    appendRuntimeLog("INFO", `DECISION_OPINIONS_COMPLETE: ${session.id} | opinions: ${successCount}/${speakers.length} | conflicts: ${(updatedSession?.conflicts || []).length}`);

    return {
      content: [{
        type: "text",
        text: `✅ **Decision Session Started**\n\n**Session:** ${session.id}\n**Problem:** ${problem}\n**Speakers:** ${speakers.join(", ")}\n**Opinions collected:** ${successCount}/${speakers.length}${templateInfo}\n**Stage:** user_probe (awaiting user input)\n**Conflicts:** ${(updatedSession?.conflicts || []).length}\n\n---\n\n${conflictText}\n\n---\n\nSubmit user responses via \`decision_respond\`.`,
      }],
    };
  })
);

server.tool(
  "decision_status",
  "Query the current status of a decision session.",
  {
    session_id: z.string().optional().describe("Session ID (auto-selects active decision session if omitted)"),
  },
  safeToolHandler("decision_status", async ({ session_id }) => {
    // Find decision sessions
    const active = listActiveSessions().filter(s => {
      const full = loadSession(s.id);
      return full?.type === "decision";
    });

    let resolved = session_id;
    if (!resolved) {
      if (active.length === 0) return { content: [{ type: "text", text: t("No active decision sessions.", "활성 decision 세션이 없습니다.", "en") }] };
      if (active.length === 1) resolved = active[0].id;
      else return { content: [{ type: "text", text: t(`Multiple decision sessions are active. Please specify session_id:\n${active.map(s => `- ${s.id}`).join("\n")}`, `여러 decision 세션이 진행 중입니다. session_id를 지정하세요:\n${active.map(s => `- ${s.id}`).join("\n")}`, "en") }] };
    }

    const state = loadSession(resolved);
    if (!state) return { content: [{ type: "text", text: t(`Session not found: ${resolved}`, `세션을 찾을 수 없습니다: ${resolved}`, "en") }] };

    const opinionCount = Object.keys(state.opinions || {}).length;
    const conflictCount = (state.conflicts || []).length;
    const stageIdx = DECISION_STAGES.indexOf(state.stage);
    const progress = stageIdx >= 0 ? `${stageIdx + 1}/${DECISION_STAGES.length}` : state.stage;

    return {
      content: [{
        type: "text",
        text: `📊 **Decision Session Status**\n\n**Session:** ${state.id}\n**Problem:** ${state.problem}\n**Stage:** ${state.stage} (${progress})\n**Status:** ${state.status}\n**Speakers:** ${(state.speakers || []).join(", ")}\n**Opinions:** ${opinionCount}/${(state.speakers || []).length}\n**Conflicts:** ${conflictCount}\n**Template:** ${state.template || "(none)"}\n**Created:** ${state.metadata?.created || ""}`,
      }],
    };
  })
);

server.tool(
  "decision_respond",
  "Submit user responses to conflict questions in the user_probe stage.",
  {
    session_id: z.string().optional().describe("Session ID"),
    responses: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.array(z.string()).min(1)
    ).describe("Response array for each conflict question (in conflict order)"),
  },
  safeToolHandler("decision_respond", async ({ session_id, responses }) => {
    // Find decision session
    const active = listActiveSessions().filter(s => {
      const full = loadSession(s.id);
      return full?.type === "decision";
    });

    let resolved = session_id;
    if (!resolved) {
      if (active.length === 1) resolved = active[0].id;
      else if (active.length === 0) return { content: [{ type: "text", text: t("No active decision sessions.", "활성 decision 세션이 없습니다.", "en") }] };
      else return { content: [{ type: "text", text: t(`Multiple decision sessions are active. Please specify session_id.`, `여러 decision 세션이 진행 중입니다. session_id를 지정하세요.`, "en") }] };
    }

    let synthesisText = "";
    let actionPlan = null;

    withSessionLock(resolved, () => {
      const state = loadSession(resolved);
      if (!state) return;
      if (state.stage !== "user_probe") {
        synthesisText = t(`❌ Cannot accept responses at current stage (${state.stage}). Only possible during user_probe stage.`, `❌ 현재 단계(${state.stage})에서는 응답을 받을 수 없습니다. user_probe 단계에서만 가능합니다.`, state?.lang);
        return;
      }

      // Store user responses
      state.userProbeResponses = responses;
      state.log.push({
        event: "user_probe_response",
        responses,
        timestamp: new Date().toISOString(),
      });

      // Advance to synthesis
      state.stage = "synthesis";
      state.metadata.updated = new Date().toISOString();

      // Build synthesis
      state.synthesis = buildSynthesis(state);

      // Advance to action_export
      state.stage = "action_export";
      state.metadata.updated = new Date().toISOString();

      // Build action plan
      state.actionPlan = buildActionPlan(state);

      // Advance to done
      state.stage = "done";
      state.status = "completed";
      state.metadata.updated = new Date().toISOString();

      saveSession(state);

      // Archive
      const archivePath = archiveState(state);
      cleanupSyncMarkdown(state);

      synthesisText = state.synthesis;
      actionPlan = state.actionPlan;

      appendRuntimeLog("INFO", `DECISION_COMPLETE: ${resolved} | conflicts_resolved: ${responses.length} | decision: ${(actionPlan?.decision || "").slice(0, 60)}`);
    });

    if (synthesisText.startsWith("❌")) {
      return { content: [{ type: "text", text: synthesisText }] };
    }

    const checklistText = actionPlan?.exportFormats?.checklist || "";
    return {
      content: [{
        type: "text",
        text: `✅ **Decision Complete**\n\n${synthesisText}\n\n---\n\n## Action Plan\n\n${checklistText}`,
      }],
    };
  })
);

server.tool(
  "decision_resume",
  "Resume a paused decision session (re-displays conflict questions from the user_probe stage).",
  {
    session_id: z.string().optional().describe("Session ID"),
  },
  safeToolHandler("decision_resume", async ({ session_id }) => {
    const active = listActiveSessions().filter(s => {
      const full = loadSession(s.id);
      return full?.type === "decision";
    });

    let resolved = session_id;
    if (!resolved) {
      if (active.length === 1) resolved = active[0].id;
      else if (active.length === 0) return { content: [{ type: "text", text: t("No decision sessions to resume.", "재개할 decision 세션이 없습니다.", "en") }] };
      else return { content: [{ type: "text", text: t(`Select from multiple sessions:\n${active.map(s => `- ${s.id}`).join("\n")}`, `여러 세션 중 선택하세요:\n${active.map(s => `- ${s.id}`).join("\n")}`, "en") }] };
    }

    const state = loadSession(resolved);
    if (!state) return { content: [{ type: "text", text: t(`Session not found: ${resolved}`, `세션을 찾을 수 없습니다: ${resolved}`, "en") }] };
    if (state.stage !== "user_probe") {
      return { content: [{ type: "text", text: t(`Session is not at user_probe stage (current: ${state.stage}). Cannot resume.`, `세션이 user_probe 단계가 아닙니다 (현재: ${state.stage}). 재개할 수 없습니다.`, state?.lang) }] };
    }

    const conflictText = generateConflictQuestions(state.conflicts || []);
    return {
      content: [{
        type: "text",
        text: `📋 **Decision Session Resumed**\n\n**Session:** ${state.id}\n**Problem:** ${state.problem}\n**Stage:** user_probe\n\n---\n\n${conflictText}\n\n---\n\nSubmit user responses via \`decision_respond\`.`,
      }],
    };
  })
);

server.tool(
  "decision_history",
  "Query past decision history.",
  {
    session_id: z.string().optional().describe("Specific session ID (shows full list if omitted)"),
  },
  safeToolHandler("decision_history", async ({ session_id }) => {
    if (session_id) {
      const state = loadSession(session_id);
      if (!state) return { content: [{ type: "text", text: t(`Session not found: ${session_id}`, `세션을 찾을 수 없습니다: ${session_id}`, "en") }] };

      const opinionSummary = Object.entries(state.opinions || {})
        .map(([speaker, op]) => `- **${speaker}**: ${op.summary || "(none)"} (confidence: ${Math.round((op.confidence || 0.5) * 100)}%)`)
        .join("\n");

      return {
        content: [{
          type: "text",
          text: `📜 **Decision History: ${state.id}**\n\n**Problem:** ${state.problem}\n**Status:** ${state.status}\n**Stage:** ${state.stage}\n**Template:** ${state.template || "(none)"}\n\n## Opinions\n${opinionSummary || "(none)"}\n\n## Synthesis\n${state.synthesis || "(not yet synthesized)"}\n\n## Action Plan\n${state.actionPlan?.exportFormats?.checklist || "(not yet generated)"}`,
        }],
      };
    }

    // List all decision sessions from archives
    const projectSlug = getProjectSlug();
    const archiveDir = path.join(GLOBAL_STATE_DIR, projectSlug, "archive");
    let decisionArchives = [];
    try {
      const files = fs.readdirSync(archiveDir).filter(f => f.startsWith("decision-"));
      decisionArchives = files.map(f => {
        const match = f.match(/^decision-(.+)\.md$/);
        return match ? match[1] : f;
      });
    } catch { /* no archives */ }

    // Also list active decision sessions
    const activeSessions = listActiveSessions().filter(s => {
      const full = loadSession(s.id);
      return full?.type === "decision";
    });

    const activeList = activeSessions.map(s => `- 🟢 ${s.id} (${s.status})`).join("\n");
    const archiveList = decisionArchives.map(a => `- 📁 ${a}`).join("\n");

    return {
      content: [{
        type: "text",
        text: `📜 **Decision History**\n\n## Active Sessions\n${activeList || "(none)"}\n\n## Archives\n${archiveList || "(none)"}`,
      }],
    };
  })
);

server.tool(
  "decision_templates",
  "Display available Micro-Decision templates.",
  {},
  safeToolHandler("decision_templates", async () => {
    const templates = loadTemplates();
    if (templates.length === 0) {
      return { content: [{ type: "text", text: t("No available templates.", "사용 가능한 템플릿이 없습니다.", "en") }] };
    }

    const list = templates.map(t => {
      const criteriaList = (t.criteria || []).map(c => c.name || c.label || c).join(", ");
      return `### ${t.name} (\`${t.id}\`)\n${t.description}\n- **Criteria:** ${criteriaList}\n- **Example:** ${t.example_problem || "(none)"}`;
    }).join("\n\n");

    return {
      content: [{
        type: "text",
        text: `📋 **Decision Templates**\n\n${list}\n\n---\n\nUse with \`decision_start(problem: "...", template: "lib-compare")\`.`,
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
export { selectNextSpeaker, loadRolePrompt, inferSuggestedRole, parseVotes, ROLE_KEYWORDS, ROLE_HEADING_MARKERS, loadRolePresets, applyRolePreset, detectDegradationLevels, formatDegradationReport, DEGRADATION_TIERS, DECISION_STAGES, STAGE_TRANSITIONS, createDecisionSession, advanceStage, buildConflictMap, parseOpinionFromResponse, buildOpinionPrompt, generateConflictQuestions, buildSynthesis, buildActionPlan, loadTemplates, matchTemplate, hasExplicitBrowserParticipantSelection, resolveIncludeBrowserSpeakers, confirmSpeakerSelectionToken, validateSpeakerSelectionRequest, truncatePromptText, getPromptBudgetForSpeaker, formatRecentLogForPrompt, getCliAutoTurnTimeoutSec, getCliExecArgs, buildCliAutoTurnFailureText, buildClipboardTurnPrompt, getProjectStateDir, loadSession, saveSession, listActiveSessions, multipleSessionsError, findSessionRecord, mapParticipantProfiles, formatSpeakerCandidatesReport, buildTeleptyTurnRequestEnvelope, buildTeleptyTurnCompletedEnvelope, buildTeleptySynthesisEnvelope, validateTeleptyEnvelope, registerPendingTeleptyTurnRequest, handleTeleptyBusMessage, completePendingTeleptySemantic, cleanupPendingTeleptyTurn, getTeleptySessionHealth, TELEPTY_TRANSPORT_TIMEOUT_MS, TELEPTY_SEMANTIC_TIMEOUT_MS };
