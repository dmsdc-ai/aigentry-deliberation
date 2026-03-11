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
  npx @dmsdc-ai/aigentry-deliberation install     Install (register MCP server)
  npx @dmsdc-ai/aigentry-deliberation uninstall    Uninstall
  npx @dmsdc-ai/aigentry-deliberation              Run MCP server (stdio)

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
import { readClipboardText, writeClipboardText, hasClipboardImage, captureClipboardImage } from "./clipboard.js";
import {
  DECISION_STAGES, STAGE_TRANSITIONS,
  createDecisionSession, advanceStage, buildConflictMap,
  parseOpinionFromResponse, buildOpinionPrompt,
  generateConflictQuestions, buildSynthesis, buildActionPlan,
  loadTemplates, matchTemplate,
} from "./decision-engine.js";
import { detectLang, t } from "./i18n.js";

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
const DEFAULT_SPEAKERS = ["agent-a", "agent-b"];
const DEFAULT_CLI_CANDIDATES = [
  "claude",
  "codex",
  "gemini",
  "qwen",
  "chatgpt",
  "aider",
  "llm",
  "opencode",
  "cursor-agent",
  "cursor",
  "continue",
];
const MAX_AUTO_DISCOVERED_SPEAKERS = 12;

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

const DEFAULT_BROWSER_APPS = ["Google Chrome", "Brave Browser", "Arc", "Microsoft Edge", "Safari"];
const DEFAULT_LLM_DOMAINS = [
  "chatgpt.com",
  "openai.com",
  "claude.ai",
  "anthropic.com",
  "gemini.google.com",
  "copilot.microsoft.com",
  "poe.com",
  "perplexity.ai",
  "mistral.ai",
  "huggingface.co/chat",
  "deepseek.com",
  "qwen.ai",
  "notebooklm.google.com",
];

// Well-known web LLMs — always available as speaker candidates regardless of browser detection.
// When a matching browser tab is detected, transport upgrades to browser_auto (CDP) or clipboard.
// When no tab is detected, transport falls back to clipboard (manual paste).
const DEFAULT_WEB_SPEAKERS = [
  { speaker: "web-chatgpt", provider: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com" },
  { speaker: "web-claude", provider: "claude", name: "Claude", url: "https://claude.ai" },
  { speaker: "web-gemini", provider: "gemini", name: "Gemini", url: "https://gemini.google.com" },
  { speaker: "web-copilot", provider: "copilot", name: "Copilot", url: "https://copilot.microsoft.com" },
  { speaker: "web-perplexity", provider: "perplexity", name: "Perplexity", url: "https://perplexity.ai" },
  { speaker: "web-deepseek", provider: "deepseek", name: "DeepSeek", url: "https://chat.deepseek.com" },
  { speaker: "web-mistral", provider: "mistral", name: "Mistral", url: "https://mistral.ai" },
  { speaker: "web-poe", provider: "poe", name: "Poe", url: "https://poe.com" },
  { speaker: "web-grok", provider: "grok", name: "Grok", url: "https://grok.com" },
  { speaker: "web-qwen", provider: "qwen", name: "Qwen", url: "https://chat.qwen.ai" },
  { speaker: "web-huggingchat", provider: "huggingchat", name: "HuggingChat", url: "https://huggingface.co/chat" },
];

let _extensionProviderRegistry = null;
const __dirnameEsm = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
function loadExtensionProviderRegistry() {
  if (_extensionProviderRegistry) return _extensionProviderRegistry;
  try {
    const registryPath = path.join(__dirnameEsm, "selectors", "extension-providers.json");
    _extensionProviderRegistry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    return _extensionProviderRegistry;
  } catch (err) {
    console.error("Failed to load extension-providers.json:", err.message);
    _extensionProviderRegistry = { providers: [] };
    return _extensionProviderRegistry;
  }
}

function isExtensionLlmTab(url = "", title = "") {
  if (!String(url).startsWith("chrome-extension://")) return false;
  const registry = loadExtensionProviderRegistry();
  const lowerTitle = String(title || "").toLowerCase();
  if (!lowerTitle) return false;
  return registry.providers.some(p =>
    p.titlePatterns.some(pattern => lowerTitle.includes(pattern.toLowerCase()))
  );
}

// ── Sprint 1: Smart Speaker Ordering + Persona Roles ────────────

function selectNextSpeaker(session) {
  const { speakers, current_speaker, log, ordering_strategy } = session;
  switch (ordering_strategy || "cyclic") {
    case "random":
      return speakers[Math.floor(Math.random() * speakers.length)];
    case "weighted-random": {
      const window = log.slice(-(speakers.length * 2));
      const counts = new Map(speakers.map(s => [s, 0]));
      for (const entry of window) {
        if (counts.has(entry.speaker)) counts.set(entry.speaker, counts.get(entry.speaker) + 1);
      }
      const maxCount = Math.max(...counts.values(), 1);
      const weights = speakers.map(s => maxCount + 1 - counts.get(s));
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      for (let i = 0; i < speakers.length; i++) {
        r -= weights[i];
        if (r <= 0) return speakers[i];
      }
      return speakers[speakers.length - 1];
    }
    case "cyclic":
    default: {
      const idx = speakers.indexOf(current_speaker);
      return speakers[(idx + 1) % speakers.length];
    }
  }
}

function loadRolePrompt(role) {
  if (!role || role === "free") return "";
  try {
    const promptPath = path.join(__dirnameEsm, "selectors", "roles", `${role}.md`);
    return fs.readFileSync(promptPath, "utf-8").trim();
  } catch {
    return "";
  }
}

const ROLE_KEYWORDS = {
  critic: /문제|위험|실패|약점|리스크|반대|비판|결함|취약/,
  implementer: /구현|코드|방법|설계|빌드|개발|함수|모듈|파일/,
  mediator: /합의|정리|결론|종합|요약|중재|절충|균형/,
  researcher: /사례|데이터|연구|벤치마크|비교|논문|참고/,
};

const ROLE_HEADING_MARKERS = {
  critic: /^##?\s*(Critic|비판|약점|심각도|위험\s*분석|검증|평가|Review)/m,
  implementer: /^##?\s*(코드\s*스케치|구현|Implementation|제안\s*코드)/m,
  mediator: /^##?\s*(합의|종합|중재|Consensus|Mediation)/m,
  researcher: /^##?\s*(조사\s*결과|비교\s*분석|Research|사례\s*연구|근거|데이터|Data)/m,
};

function inferSuggestedRole(text) {
  const scores = {};
  for (const [role, pattern] of Object.entries(ROLE_KEYWORDS)) {
    const matches = (text.match(new RegExp(pattern, "g")) || []).length;
    if (matches > 0) scores[role] = matches;
  }
  // Structural heading markers get extra weight (equivalent to 5 keyword matches)
  for (const [role, pattern] of Object.entries(ROLE_HEADING_MARKERS)) {
    if (pattern.test(text)) {
      scores[role] = (scores[role] || 0) + 8;
    }
  }
  if (Object.keys(scores).length === 0) return "free";
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

function parseVotes(text) {
  const votes = [];
  for (const line of text.split("\n")) {
    const agree = line.match(/\[AGREE\]/i);
    const disagree = line.match(/\[DISAGREE\]/i);
    const conditional = line.match(/\[CONDITIONAL:\s*(.+?)\]/i);
    if (agree) votes.push({ line: line.trim(), vote: "agree" });
    else if (disagree) votes.push({ line: line.trim(), vote: "disagree" });
    else if (conditional) votes.push({ line: line.trim(), vote: "conditional", condition: conditional[1].trim() });
  }
  return votes;
}

let _rolePresetsCache = null;
function loadRolePresets() {
  if (_rolePresetsCache) return _rolePresetsCache;
  try {
    const presetsPath = path.join(__dirnameEsm, "selectors", "role-presets.json");
    _rolePresetsCache = JSON.parse(fs.readFileSync(presetsPath, "utf-8"));
    return _rolePresetsCache;
  } catch {
    _rolePresetsCache = { presets: {} };
    return _rolePresetsCache;
  }
}

function applyRolePreset(preset, speakers) {
  const presets = loadRolePresets();
  const presetDef = presets.presets[preset];
  if (!presetDef) return {};

  const roles = presetDef.roles;
  const result = {};
  for (let i = 0; i < speakers.length; i++) {
    result[speakers[i]] = roles[i % roles.length];
  }
  return result;
}

// ── Graceful Degradation Matrix ──────────────────────────────────

const DEGRADATION_TIERS = {
  monitoring: {
    tier1: { name: "tmux", description: "tmux real-time monitoring window", check: () => commandExistsInPath("tmux") },
    tier2: { name: "logfile", description: "Log file tail monitoring", check: () => true },
    tier3: { name: "silent", description: "No monitoring (log only)", check: () => true },
  },
  browser: {
    tier1: { name: "cdp_auto", description: "CDP auto send/collect", check: async () => { try { const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(2000) }); return res.ok; } catch { return false; } } },
    tier2: { name: "clipboard", description: "Clipboard-based manual transfer", check: () => true },
    tier3: { name: "manual", description: "Fully manual copy/paste", check: () => true },
  },
  terminal: {
    tier1: { name: "auto_open", description: "Auto-open terminal app", check: () => process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" },
    tier2: { name: "none", description: "Cannot auto-open terminal", check: () => true },
    tier3: { name: "none", description: "Cannot auto-open terminal", check: () => true },
  },
};

async function detectDegradationLevels() {
  const levels = {};
  for (const [feature, tiers] of Object.entries(DEGRADATION_TIERS)) {
    for (const tierKey of ["tier1", "tier2", "tier3"]) {
      const tier = tiers[tierKey];
      const available = await Promise.resolve(tier.check());
      if (available) {
        levels[feature] = { tier: tierKey, name: tier.name, description: tier.description };
        break;
      }
    }
  }
  return levels;
}

function formatDegradationReport(levels) {
  const lines = [];
  for (const [feature, info] of Object.entries(levels)) {
    const tierNum = parseInt(info.tier.replace("tier", ""));
    const indicator = tierNum === 1 ? "🟢" : tierNum === 2 ? "🟡" : "🔴";
    lines.push(`  ${indicator} **${feature}**: ${info.name} — ${info.description}`);
  }
  return lines.join("\n");
}

const PRODUCT_DISCLAIMER = "ℹ️ This tool does not permanently modify external websites. It reads browser context in read-only mode to route speakers.";
const LOCKS_SUBDIR = ".locks";
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 8000;
const LOCK_STALE_MS = 60000;

function getProjectSlug() {
  return path.basename(process.cwd());
}

function getProjectStateDir() {
  return path.join(GLOBAL_STATE_DIR, getProjectSlug());
}

function getSessionsDir() {
  return path.join(getProjectStateDir(), "sessions");
}

function getSessionFile(sessionId) {
  return path.join(getSessionsDir(), `${sessionId}.json`);
}

function getArchiveDir() {
  const obsidianDir = path.join(OBSIDIAN_PROJECTS, getProjectSlug(), "deliberations");
  if (fs.existsSync(path.join(OBSIDIAN_PROJECTS, getProjectSlug()))) {
    return obsidianDir;
  }
  return path.join(getProjectStateDir(), "archive");
}

function getLocksDir() {
  return path.join(getProjectStateDir(), LOCKS_SUBDIR);
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

function withProjectLock(fn, options) {
  return withFileLock(path.join(getLocksDir(), "_project.lock"), fn, options);
}

function withSessionLock(sessionId, fn, options) {
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9가-힣._-]/g, "_");
  return withFileLock(path.join(getLocksDir(), `${safeId}.lock`), fn, options);
}

function normalizeSpeaker(raw) {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === "none") return null;
  return normalized;
}

function dedupeSpeakers(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const normalized = normalizeSpeaker(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function hasExplicitBrowserParticipantSelection({ speakers, participant_types } = {}) {
  const manualSpeakers = Array.isArray(speakers) ? speakers : [];
  const hasBrowserSpeaker = manualSpeakers.some(speaker => {
    const normalized = normalizeSpeaker(speaker);
    return normalized?.startsWith("web-");
  });
  if (hasBrowserSpeaker) return true;

  const overrides = participant_types && typeof participant_types === "object"
    ? Object.entries(participant_types)
    : [];

  return overrides.some(([speaker, type]) => {
    const normalized = normalizeSpeaker(speaker);
    return normalized?.startsWith("web-") || type === "browser" || type === "browser_auto";
  });
}

function resolveIncludeBrowserSpeakers({ include_browser_speakers, config, speakers, participant_types } = {}) {
  if (include_browser_speakers !== undefined && include_browser_speakers !== null) {
    return include_browser_speakers;
  }
  if (config?.include_browser_speakers !== undefined && config?.include_browser_speakers !== null) {
    return config.include_browser_speakers;
  }
  return false;
}

function resolveCliCandidates() {
  const fromEnv = (process.env.DELIBERATION_CLI_CANDIDATES || "")
    .split(/[,\s]+/)
    .map(v => v.trim())
    .filter(Boolean);

  // If config has enabled_clis, use that as the primary filter
  const config = loadDeliberationConfig();
  if (Array.isArray(config.enabled_clis) && config.enabled_clis.length > 0) {
    return dedupeSpeakers([...fromEnv, ...config.enabled_clis]);
  }

  return dedupeSpeakers([...fromEnv, ...DEFAULT_CLI_CANDIDATES]);
}

function commandExistsInPath(command) {
  if (!command || !/^[a-zA-Z0-9._-]+$/.test(command)) {
    return false;
  }

  if (process.platform === "win32") {
    try {
      execFileSync("where", [command], { stdio: "ignore" });
      return true;
    } catch {
      // keep PATH scan fallback for shells where "where" is unavailable
    }
  }

  const pathVar = process.env.PATH || "";
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  if (dirs.length === 0) return false;

  const extensions = process.platform === "win32"
    ? ["", ".exe", ".cmd", ".bat", ".ps1"]
    : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, `${command}${ext}`);
      try {
        fs.accessSync(fullPath, fs.constants.X_OK);
        return true;
      } catch {
        // ignore and continue
      }
    }
  }
  return false;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function checkCliLiveness(command) {
  const hint = CLI_INVOCATION_HINTS[command];
  const env = { ...process.env };
  // Unset CLAUDECODE to avoid nested session errors
  if (hint?.envPrefix?.includes("CLAUDECODE=")) {
    delete env.CLAUDECODE;
  }
  try {
    execFileSync(command, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5000,
      env,
    });
    return true;
  } catch {
    // --version failed, try --help as fallback
    try {
      execFileSync(command, ["--help"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
        env,
      });
      return true;
    } catch {
      return false;
    }
  }
}

function discoverLocalCliSpeakers() {
  const found = [];
  for (const candidate of resolveCliCandidates()) {
    if (commandExistsInPath(candidate)) {
      found.push(candidate);
    }
    if (found.length >= MAX_AUTO_DISCOVERED_SPEAKERS) {
      break;
    }
  }
  return found;
}

function detectCallerSpeaker() {
  const hinted = normalizeSpeaker(process.env.DELIBERATION_CALLER_SPEAKER);
  if (hinted) return hinted;

  const pathHint = process.env.PATH || "";
  if (/\bCODEX_[A-Z0-9_]+\b/.test(Object.keys(process.env).join(" "))) {
    return "codex";
  }
  if (pathHint.includes("/.codex/")) {
    return "codex";
  }

  if (/\bCLAUDE_[A-Z0-9_]+\b/.test(Object.keys(process.env).join(" "))) {
    return "claude";
  }
  if (pathHint.includes("/.claude/")) {
    return "claude";
  }

  return null;
}

function isLlmUrl(url = "") {
  const value = String(url || "").trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return DEFAULT_LLM_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch {
    const lowered = value.toLowerCase();
    return DEFAULT_LLM_DOMAINS.some(domain => lowered.includes(domain));
  }
}

function dedupeBrowserTabs(tabs = []) {
  const out = [];
  const seen = new Set();
  for (const tab of tabs) {
    const browser = String(tab?.browser || "").trim();
    const title = String(tab?.title || "").trim();
    const url = String(tab?.url || "").trim();
    if (!url || (!isLlmUrl(url) && !isExtensionLlmTab(url, title))) continue;
    // Dedup by title+url (ignore browser name) so that the same tab detected
    // via both AppleScript and CDP is not duplicated. The first occurrence wins,
    // so callers should add preferred sources first (e.g., CDP before AppleScript).
    const key = `${title}\t${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      browser: browser || "Browser",
      title: title || "(untitled)",
      url,
    });
  }
  return out;
}

function parseInjectedBrowserTabsFromEnv() {
  const raw = process.env.DELIBERATION_BROWSER_TABS_JSON;
  if (!raw) {
    return { tabs: [], note: null };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { tabs: [], note: "DELIBERATION_BROWSER_TABS_JSON format error: must be a JSON array." };
    }

    const tabs = dedupeBrowserTabs(parsed.map(item => ({
      browser: item?.browser || "External Bridge",
      title: item?.title || "(untitled)",
      url: item?.url || "",
    })));
    return {
      tabs,
      note: tabs.length > 0 ? `Environment variable tab injection: ${tabs.length} tabs` : "No valid LLM URLs found in DELIBERATION_BROWSER_TABS_JSON.",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return { tabs: [], note: `Failed to parse DELIBERATION_BROWSER_TABS_JSON: ${reason}` };
  }
}

function normalizeCdpEndpoint(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;

  const withProto = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(withProto);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/json/list";
    }
    return url.toString();
  } catch {
    return null;
  }
}

function resolveCdpEndpoints() {
  const fromEnv = (process.env.DELIBERATION_BROWSER_CDP_ENDPOINTS || "")
    .split(/[,\s]+/)
    .map(v => normalizeCdpEndpoint(v))
    .filter(Boolean);
  if (fromEnv.length > 0) {
    return [...new Set(fromEnv)];
  }

  const ports = (process.env.DELIBERATION_BROWSER_CDP_PORTS || "9222,9223,9333")
    .split(/[,\s]+/)
    .map(v => Number.parseInt(v, 10))
    .filter(v => Number.isInteger(v) && v > 0 && v < 65536);

  const endpoints = [];
  for (const port of ports) {
    endpoints.push(`http://127.0.0.1:${port}/json/list`);
    endpoints.push(`http://localhost:${port}/json/list`);
  }
  return [...new Set(endpoints)];
}

async function fetchJson(url, timeoutMs = 900) {
  if (typeof fetch !== "function") {
    throw new Error("fetch API unavailable in current Node runtime");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "accept": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function inferBrowserFromCdpEndpoint(endpoint) {
  try {
    const parsed = new URL(endpoint);
    const port = Number.parseInt(parsed.port, 10);
    if (port === 9222) return "Google Chrome (CDP)";
    if (port === 9223) return "Microsoft Edge (CDP)";
    if (port === 9333) return "Brave Browser (CDP)";
    return `Browser (CDP:${parsed.host})`;
  } catch {
    return "Browser (CDP)";
  }
}

function summarizeFailures(items = [], max = 3) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const shown = items.slice(0, max);
  const suffix = items.length > max ? ` and ${items.length - max} more` : "";
  return `${shown.join(", ")}${suffix}`;
}

async function collectBrowserLlmTabsViaCdp() {
  const endpoints = resolveCdpEndpoints();
  const tabs = [];
  const failures = [];

  for (const endpoint of endpoints) {
    try {
      const payload = await fetchJson(endpoint);
      if (!Array.isArray(payload)) {
        throw new Error("unexpected payload");
      }

      const browser = inferBrowserFromCdpEndpoint(endpoint);
      for (const item of payload) {
        if (!item || String(item.type) !== "page") continue;
        const url = String(item.url || "").trim();
        const title = String(item.title || "").trim();
        if (!isLlmUrl(url) && !isExtensionLlmTab(url, title)) continue;
        tabs.push({
          browser,
          title: title || "(untitled)",
          url,
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      failures.push(`${endpoint} (${reason})`);
    }
  }

  const uniqTabs = dedupeBrowserTabs(tabs);
  if (uniqTabs.length > 0) {
    const failSummary = summarizeFailures(failures);
    return {
      tabs: uniqTabs,
      note: failSummary ? `Some CDP endpoint access failed: ${failSummary}` : null,
    };
  }

  const failSummary = summarizeFailures(failures);
  return {
    tabs: [],
    note: `No LLM tabs found via CDP. Run browser with --remote-debugging-port=9222 or inject tab list via DELIBERATION_BROWSER_TABS_JSON.${failSummary ? ` (failed: ${failSummary})` : ""}`,
  };
}

async function ensureCdpAvailable() {
  const endpoints = resolveCdpEndpoints();

  // First attempt: try existing CDP endpoints
  for (const endpoint of endpoints) {
    try {
      const payload = await fetchJson(endpoint, 1500);
      if (Array.isArray(payload)) {
        return { available: true, endpoint };
      }
    } catch { /* not reachable */ }
  }

  // Auto-launch Chrome with CDP on macOS, Linux, and Windows
  {
    let chromeBin, chromeUserDataDir;

    if (process.platform === "darwin") {
      chromeBin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      chromeUserDataDir = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
    } else if (process.platform === "linux") {
      const chromeCandidates = ["google-chrome", "google-chrome-stable", "google-chrome-beta", "chromium-browser", "chromium"];
      chromeBin = chromeCandidates.find(c => commandExistsInPath(c)) || null;
      if (!chromeBin) {
        return {
          available: false,
          reason: "Chrome/Chromium not found. Install google-chrome or chromium and run with --remote-debugging-port=9222.",
        };
      }
      const googleDir = path.join(os.homedir(), ".config", "google-chrome");
      const chromiumDir = path.join(os.homedir(), ".config", "chromium");
      chromeUserDataDir = fs.existsSync(googleDir) ? googleDir : fs.existsSync(chromiumDir) ? chromiumDir : null;
    } else if (process.platform === "win32") {
      const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
      const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
      const winCandidates = [
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      ];
      chromeBin = winCandidates.find(p => fs.existsSync(p)) || null;
      if (!chromeBin) {
        return {
          available: false,
          reason: "Chrome/Edge not found. Install Chrome or run with --remote-debugging-port=9222.",
        };
      }
      const chromeDir = path.join(localAppData, "Google", "Chrome", "User Data");
      const edgeDir = path.join(localAppData, "Microsoft", "Edge", "User Data");
      chromeUserDataDir = fs.existsSync(chromeDir) ? chromeDir : fs.existsSync(edgeDir) ? edgeDir : null;
    } else {
      return {
        available: false,
        reason: "Cannot activate Chrome CDP. Run Chrome with --remote-debugging-port=9222.",
      };
    }

    // Chrome 145+ requires --user-data-dir for CDP to work.
    // The default data dir is rejected, so we copy the profile to ~/.chrome-cdp.
    // Profile can be set via env DELIBERATION_CHROME_PROFILE or config.chrome_profile (e.g., "Profile 1").
    const cdpDataDir = path.join(os.homedir(), ".chrome-cdp");
    const cdpConfig = loadDeliberationConfig();
    const profileDir = process.env.DELIBERATION_CHROME_PROFILE || cdpConfig.chrome_profile || "Default";

    try {
      if (chromeUserDataDir) {
        const srcProfile = path.join(chromeUserDataDir, profileDir);
        const dstProfile = path.join(cdpDataDir, profileDir);
        // Track which profile was copied; re-copy if profile changed
        const profileMarker = path.join(cdpDataDir, ".cdp-profile");
        const lastProfile = fs.existsSync(profileMarker) ? fs.readFileSync(profileMarker, "utf8").trim() : null;
        const needsCopy = !fs.existsSync(dstProfile) || (lastProfile && lastProfile !== profileDir);
        if (needsCopy && fs.existsSync(srcProfile)) {
          // Clean old profile if switching
          if (lastProfile && lastProfile !== profileDir) {
            const oldDst = path.join(cdpDataDir, lastProfile);
            if (fs.existsSync(oldDst)) fs.rmSync(oldDst, { recursive: true, force: true });
          }
          fs.mkdirSync(cdpDataDir, { recursive: true });
          execFileSync("cp", ["-R", srcProfile, dstProfile], { timeout: 30000, stdio: "ignore" });
          fs.writeFileSync(profileMarker, profileDir);
          // Create minimal Local State with single profile to avoid profile picker
          const localStateSrc = path.join(chromeUserDataDir, "Local State");
          if (fs.existsSync(localStateSrc)) {
            const state = JSON.parse(fs.readFileSync(localStateSrc, "utf8"));
            state.profile.profiles_created = 1;
            state.profile.last_used = profileDir;
            if (state.profile.info_cache) {
              const kept = {};
              if (state.profile.info_cache[profileDir]) kept[profileDir] = state.profile.info_cache[profileDir];
              state.profile.info_cache = kept;
            }
            fs.writeFileSync(path.join(cdpDataDir, "Local State"), JSON.stringify(state));
          }
        }
      }
    } catch { /* proceed with launch attempt anyway */ }

    const launchArgs = [
      "--remote-debugging-port=9222",
      "--remote-allow-origins=http://127.0.0.1:9222",
      `--user-data-dir=${cdpDataDir}`,
      `--profile-directory=${profileDir}`,
      "--no-first-run",
    ];

    try {
      const child = spawn(chromeBin, launchArgs, { stdio: "ignore", detached: true });
      child.unref();
    } catch {
      return {
        available: false,
        reason: `Failed to auto-launch Chrome. Manually run Chrome with --remote-debugging-port=9222 --user-data-dir=~/.chrome-cdp.`,
      };
    }

    // Wait for Chrome to initialize CDP
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Retry CDP connection after launch
    for (const endpoint of endpoints) {
      try {
        const payload = await fetchJson(endpoint, 2000);
        if (Array.isArray(payload)) {
          return { available: true, endpoint, launched: true };
        }
      } catch { /* still not reachable */ }
    }

    return {
      available: false,
      reason: "Chrome launched but cannot connect to CDP. Fully close Chrome and try again. (Restart required if Chrome was started without CDP)",
    };
  }

  // Unreachable (all platforms handled above), but keep as safety net
  return {
    available: false,
    reason: "Cannot activate Chrome CDP. Run Chrome with --remote-debugging-port=9222.",
  };
}

function collectBrowserLlmTabsViaAppleScript() {
  if (process.platform !== "darwin") {
    return { tabs: [], note: "AppleScript tab scanning is only supported on macOS." };
  }

  const escapedDomains = DEFAULT_LLM_DOMAINS.map(d => d.replace(/"/g, '\\"'));
  const escapedApps = DEFAULT_BROWSER_APPS.map(a => a.replace(/"/g, '\\"'));
  const domainList = `{${escapedDomains.map(d => `"${d}"`).join(", ")}}`;
  const appList = `{${escapedApps.map(a => `"${a}"`).join(", ")}}`;

  // NOTE: Use stdin pipe (`osascript -`) instead of multiple `-e` flags
  // because osascript's `-e` mode silently breaks with nested try/on error blocks.
  // Also wrap dynamic `tell application` with `using terms from` so that
  // Chrome-specific properties like `tabs` resolve via the scripting dictionary.
  // Use ASCII character 9 for tab delimiter because `using terms from`
  // shadows the built-in `tab` constant, turning it into the literal string "tab".
  const scriptText = `set llmDomains to ${domainList}
set browserApps to ${appList}
set outText to ""
set tabChar to ASCII character 9
tell application "System Events"
set runningApps to name of every application process
end tell
repeat with appName in browserApps
if runningApps contains (appName as string) then
try
if (appName as string) is "Safari" then
using terms from application "Safari"
tell application (appName as string)
repeat with w in windows
try
repeat with t in tabs of w
set u to URL of t as string
set matched to false
repeat with d in llmDomains
if u contains (d as string) then set matched to true
end repeat
if matched then set outText to outText & (appName as string) & tabChar & (name of t as string) & tabChar & u & linefeed
end repeat
end try
end repeat
end tell
end using terms from
else
using terms from application "Google Chrome"
tell application (appName as string)
repeat with w in windows
try
repeat with t in tabs of w
set u to URL of t as string
set matched to false
repeat with d in llmDomains
if u contains (d as string) then set matched to true
end repeat
if matched then set outText to outText & (appName as string) & tabChar & (title of t as string) & tabChar & u & linefeed
end repeat
end try
end repeat
end tell
end using terms from
end if
on error errMsg
set outText to outText & (appName as string) & tabChar & "ERROR" & tabChar & errMsg & linefeed
end try
end if
end repeat
return outText`;

  try {
    const raw = execFileSync("osascript", ["-"], {
      input: scriptText,
      encoding: "utf-8",
      timeout: 8000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const rows = String(raw)
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [browser = "", title = "", url = ""] = line.split("\t");
        return { browser, title, url };
      });
    const tabs = rows.filter(r => r.title !== "ERROR");
    const errors = rows.filter(r => r.title === "ERROR");
    return {
      tabs,
      note: errors.length > 0
        ? `Some browser access failed: ${errors.map(e => `${e.browser} (${e.url})`).join(", ")}`
        : null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return {
      tabs: [],
      note: `Browser tab scan failed: ${reason}. Check macOS automation permissions (Terminal -> Browser control).`,
    };
  }
}

async function collectBrowserLlmTabs() {
  const mode = (process.env.DELIBERATION_BROWSER_SCAN_MODE || "auto").trim().toLowerCase();
  const tabs = [];
  const notes = [];

  const injected = parseInjectedBrowserTabsFromEnv();
  tabs.push(...injected.tabs);
  if (injected.note) notes.push(injected.note);

  if (mode === "off") {
    return {
      tabs: dedupeBrowserTabs(tabs),
      note: notes.length > 0 ? notes.join(" | ") : "Browser tab auto-scanning is disabled.",
    };
  }

  // CDP first: CDP-detected tabs are preferred over AppleScript-detected ones
  // because they carry CDP metadata (tab ID, WebSocket URL) for browser_auto transport.
  // Since dedupeBrowserTabs keeps the first occurrence, CDP entries win the dedup.
  const shouldUseCdp = mode === "auto" || mode === "cdp";
  if (shouldUseCdp) {
    const cdp = await collectBrowserLlmTabsViaCdp();
    tabs.push(...cdp.tabs);
    if (cdp.note) notes.push(cdp.note);
  }

  const shouldUseAppleScript = mode === "auto" || mode === "applescript";
  if (shouldUseAppleScript && process.platform === "darwin") {
    const mac = collectBrowserLlmTabsViaAppleScript();
    tabs.push(...mac.tabs);
    if (mac.note) notes.push(mac.note);
  } else if (mode === "applescript" && process.platform !== "darwin") {
    notes.push("AppleScript scanning is macOS only. Switch to CDP scanning.");
  }

  const uniqTabs = dedupeBrowserTabs(tabs);
  return {
    tabs: uniqTabs,
    note: notes.length > 0 ? notes.join(" | ") : null,
  };
}

function inferLlmProvider(url = "", title = "") {
  const value = String(url).toLowerCase();
  // Extension side panel: infer from title via registry
  if (value.startsWith("chrome-extension://") && title) {
    const registry = loadExtensionProviderRegistry();
    const lowerTitle = String(title).toLowerCase();
    for (const entry of registry.providers) {
      if (entry.titlePatterns.some(p => lowerTitle.includes(p.toLowerCase()))) {
        return entry.provider;
      }
    }
    return "extension-llm";
  }
  if (value.includes("claude.ai") || value.includes("anthropic.com")) return "claude";
  if (value.includes("chatgpt.com") || value.includes("openai.com")) return "chatgpt";
  if (value.includes("gemini.google.com") || value.includes("notebooklm.google.com")) return "gemini";
  if (value.includes("copilot.microsoft.com")) return "copilot";
  if (value.includes("perplexity.ai")) return "perplexity";
  if (value.includes("poe.com")) return "poe";
  if (value.includes("mistral.ai")) return "mistral";
  if (value.includes("huggingface.co/chat")) return "huggingchat";
  if (value.includes("deepseek.com")) return "deepseek";
  if (value.includes("qwen.ai")) return "qwen";
  if (value.includes("grok.com")) return "grok";
  return "web-llm";
}

async function collectSpeakerCandidates({ include_cli = true, include_browser = true } = {}) {
  const candidates = [];
  const seen = new Set();

  const add = (candidate) => {
    const speaker = normalizeSpeaker(candidate?.speaker);
    if (!speaker || seen.has(speaker)) return;
    seen.add(speaker);
    candidates.push({ ...candidate, speaker });
  };

  if (include_cli) {
    for (const cli of discoverLocalCliSpeakers()) {
      const live = checkCliLiveness(cli);
      add({
        speaker: cli,
        type: "cli",
        label: cli,
        command: cli,
        live,
      });
    }
  }

  let browserNote = null;
  if (include_browser) {
    // Ensure CDP is available before probing browser tabs
    const cdpStatus = await ensureCdpAvailable();
    if (cdpStatus.launched) {
      browserNote = "Chrome CDP auto-launched (--remote-debugging-port=9222)";
    }

    const { tabs, note } = await collectBrowserLlmTabs();
    browserNote = browserNote ? `${browserNote} | ${note || ""}`.replace(/ \| $/, "") : (note || null);
    const providerCounts = new Map();
    for (const tab of tabs) {
      const provider = inferLlmProvider(tab.url, tab.title);
      const count = (providerCounts.get(provider) || 0) + 1;
      providerCounts.set(provider, count);
      add({
        speaker: `web-${provider}-${count}`,
        type: "browser",
        provider,
        browser: tab.browser || "",
        title: tab.title || "",
        url: tab.url || "",
      });
    }

    // CDP auto-detection: probe endpoints for matching tabs
    const cdpEndpoints = resolveCdpEndpoints();
    const cdpTabsMap = new Map(); // dedupe by tab ID (multiple endpoints may return same tabs)
    for (const endpoint of cdpEndpoints) {
      try {
        const tabs = await fetchJson(endpoint, 2000);
        if (Array.isArray(tabs)) {
          for (const t of tabs) {
            if (t.type === "page" && t.url && t.id && !cdpTabsMap.has(t.id)) {
              cdpTabsMap.set(t.id, t);
            }
          }
        }
      } catch { /* endpoint not reachable */ }
    }
    const cdpTabs = [...cdpTabsMap.values()];

    // Match CDP tabs with discovered browser candidates
    for (const candidate of candidates) {
      if (candidate.type !== "browser") continue;
      // For extension candidates, match by title instead of hostname
      const candidateUrl = String(candidate.url || "");
      if (candidateUrl.startsWith("chrome-extension://")) {
        const candidateTitle = String(candidate.title || "").toLowerCase();
        if (candidateTitle) {
          const matches = cdpTabs.filter(t =>
            String(t.url || "").startsWith("chrome-extension://") &&
            String(t.title || "").toLowerCase().includes(candidateTitle)
          );
          if (matches.length >= 1) {
            candidate.cdp_available = true;
            candidate.cdp_tab_id = matches[0].id;
            candidate.cdp_ws_url = matches[0].webSocketDebuggerUrl;
          }
        }
        continue;
      }
      let candidateHost = "";
      try {
        candidateHost = new URL(candidate.url).hostname.toLowerCase();
      } catch { continue; }
      if (!candidateHost) continue;
      const matches = cdpTabs.filter(t => {
        try {
          return new URL(t.url).hostname.toLowerCase() === candidateHost;
        } catch { return false; }
      });
      if (matches.length >= 1) {
        candidate.cdp_available = true;
        candidate.cdp_tab_id = matches[0].id;
        candidate.cdp_ws_url = matches[0].webSocketDebuggerUrl;
      }
    }

    // Auto-register well-known web LLMs that weren't already detected via browser scanning.
    // This ensures web speakers are ALWAYS available regardless of browser detection success.
    // If a browser tab for the same provider was already detected, skip auto-registration
    // to avoid duplicates (e.g., detected "web-chatgpt-1" vs auto-registered "web-chatgpt").
    const detectedProviders = new Set(
      candidates.filter(c => c.type === "browser" && !c.auto_registered).map(c => c.provider)
    );
    // CDP is reachable if we got any tabs from the endpoints (attach() handles auto-tab-creation)
    const cdpReachable = cdpTabs.length > 0 || cdpStatus.available;
    for (const ws of DEFAULT_WEB_SPEAKERS) {
      if (detectedProviders.has(ws.provider)) continue;
      add({
        speaker: ws.speaker,
        type: "browser",
        provider: ws.provider,
        browser: "auto-registered",
        title: ws.name,
        url: ws.url,
        auto_registered: true,
        cdp_available: cdpReachable,
      });
    }

    // Second pass: match auto-registered speakers to individual CDP tabs
    // (they were added after the first matching pass and only got the global cdpReachable flag)
    if (cdpTabs.length > 0) {
      for (const candidate of candidates) {
        if (!candidate.auto_registered || candidate.cdp_tab_id) continue;
        let candidateHost = "";
        try {
          candidateHost = new URL(candidate.url).hostname.toLowerCase();
        } catch { continue; }
        if (!candidateHost) continue;
        const matches = cdpTabs.filter(t => {
          try {
            const tabHost = new URL(t.url).hostname.toLowerCase();
            // Exact match or subdomain match (e.g., chat.deepseek.com matches deepseek.com)
            return tabHost === candidateHost || tabHost.endsWith("." + candidateHost);
          } catch { return false; }
        });
        if (matches.length >= 1) {
          candidate.cdp_available = true;
          candidate.cdp_tab_id = matches[0].id;
          candidate.cdp_ws_url = matches[0].webSocketDebuggerUrl;
        }
      }
    }

    // Third pass: upgrade browser-detected candidates that missed the first hostname match.
    // When CDP is reachable, AppleScript-detected speakers should also get browser_auto
    // transport. The OrchestratedBrowserPort will create/navigate tabs on demand if needed.
    if (cdpReachable) {
      for (const candidate of candidates) {
        if (candidate.type !== "browser" || candidate.auto_registered) continue;
        if (candidate.cdp_available) continue; // already matched
        candidate.cdp_available = true;
      }
    }
  }

  return { candidates, browserNote };
}

function formatSpeakerCandidatesReport({ candidates, browserNote }) {
  const cli = candidates.filter(c => c.type === "cli");
  const detected = candidates.filter(c => c.type === "browser" && !c.auto_registered);
  const autoReg = candidates.filter(c => c.type === "browser" && c.auto_registered);

  let out = "## Selectable Speakers\n\n";
  out += "### CLI\n";
  if (cli.length === 0) {
    out += "- (No local CLI detected)\n\n";
  } else {
    out += `${cli.map(c => {
      const status = c.live === false ? " ❌ not executable" : c.live === true ? " ✅ executable" : "";
      return `- \`${c.speaker}\` (command: ${c.command})${status}`;
    }).join("\n")}\n\n`;
  }

  out += "### Browser LLM (detected)\n";
  if (detected.length === 0) {
    out += "- (No LLM tabs detected in browser)\n";
  } else {
    out += `${detected.map(c => {
      const icon = c.cdp_available ? "⚡auto" : "📋clipboard";
      const extTag = String(c.url || "").startsWith("chrome-extension://") ? " [Extension]" : "";
      return `- \`${c.speaker}\` [${icon}]${extTag} [${c.browser}] ${c.title}\n  ${c.url}`;
    }).join("\n")}\n`;
  }

  out += "\n### Web LLM (auto-registered)\n";
  out += `${autoReg.map(c => {
    const icon = c.cdp_available ? "⚡auto" : "📋clipboard";
    return `- \`${c.speaker}\` [${icon}] — ${c.title} (${c.url})`;
  }).join("\n")}\n`;

  if (browserNote) {
    out += `\n\nℹ️ ${browserNote}`;
  }
  return out;
}

function mapParticipantProfiles(speakers, candidates, typeOverrides) {
  const bySpeaker = new Map();
  for (const c of candidates || []) {
    const key = normalizeSpeaker(c.speaker);
    if (key) bySpeaker.set(key, c);
  }

  const overrides = typeOverrides || {};

  const profiles = [];
  for (const raw of speakers || []) {
    const speaker = normalizeSpeaker(raw);
    if (!speaker) continue;

    // Check for explicit type override
    const overrideType = overrides[speaker] || overrides[raw];
    if (overrideType) {
      const candidate = bySpeaker.get(speaker);
      profiles.push({
        speaker,
        type: overrideType,
        ...(overrideType === "browser_auto" || overrideType === "browser" ? {
          provider: candidate?.provider || null,
          browser: candidate?.browser || null,
          title: candidate?.title || null,
          url: candidate?.url || null,
        } : {}),
      });
      continue;
    }

    const candidate = bySpeaker.get(speaker);
    if (!candidate) {
      // Force CLI type if the speaker is available as a CLI command in PATH
      if (commandExistsInPath(speaker)) {
        profiles.push({
          speaker,
          type: "cli",
          command: speaker,
        });
      } else {
        profiles.push({
          speaker,
          type: "manual",
        });
      }
      continue;
    }

    if (candidate.type === "cli") {
      profiles.push({
        speaker,
        type: "cli",
        command: candidate.command || speaker,
      });
      continue;
    }

    const effectiveType = candidate.cdp_available ? "browser_auto" : "browser";
    profiles.push({
      speaker,
      type: effectiveType,
      provider: candidate.provider || null,
      browser: candidate.browser || null,
      title: candidate.title || null,
      url: candidate.url || null,
    });
  }
  return profiles;
}

// ── Transport routing ─────────────────────────────────────────

const TRANSPORT_TYPES = {
  cli: "cli_respond",
  browser: "clipboard",
  browser_auto: "browser_auto",
  manual: "manual",
};

// BrowserControlPort singleton — initialized lazily on first use
let _browserPort = null;
function getBrowserPort() {
  if (!_browserPort) {
    const cdpEndpoints = resolveCdpEndpoints();
    _browserPort = new OrchestratedBrowserPort({ cdpEndpoints });
  }
  return _browserPort;
}

function resolveTransportForSpeaker(state, speaker) {
  const normalizedSpeaker = normalizeSpeaker(speaker);
  if (!normalizedSpeaker || !state?.participant_profiles) {
    return { transport: "manual", reason: "no_profile" };
  }
  const profile = state.participant_profiles.find(
    p => normalizeSpeaker(p.speaker) === normalizedSpeaker
  );
  if (!profile) {
    return { transport: "manual", reason: "speaker_not_in_profiles" };
  }
  const transport = TRANSPORT_TYPES[profile.type] || "manual";
  return { transport, profile, reason: null };
}

// CLI-specific invocation flags for non-interactive execution
const CLI_INVOCATION_HINTS = {
  claude: { cmd: "claude", flags: '-p --output-format text', example: 'CLAUDECODE= claude -p --output-format text "prompt"', envPrefix: 'CLAUDECODE=', modelFlag: '--model', provider: 'claude' },
  codex: { cmd: "codex", flags: 'exec -', example: 'echo "prompt" | codex exec -', stdinMode: true, modelFlag: '--model', defaultModel: 'default', provider: 'chatgpt' },
  gemini: { cmd: "gemini", flags: '', example: 'gemini "prompt"', modelFlag: '--model', provider: 'gemini' },
  aider: { cmd: "aider", flags: '--message', example: 'aider --message "prompt"', modelFlag: '--model', provider: 'chatgpt' },
  cursor: { cmd: "cursor", flags: '', example: 'cursor "prompt"', modelFlag: null, provider: 'chatgpt' },
};

function formatTransportGuidance(transport, state, speaker) {
  const sid = state.id;
  switch (transport) {
    case "cli_respond": {
      const hint = CLI_INVOCATION_HINTS[speaker] || null;
      let invocationGuide = "";
      let modelGuide = "";
      if (hint) {
        const prefix = hint.envPrefix || '';
        invocationGuide = `\n\n**CLI invocation:** \`${hint.example}\`\n(flags: \`${prefix}${hint.cmd} ${hint.flags}\`)`;
        if (hint.modelFlag && hint.provider) {
          const cliModel = getModelSelectionForTurn(state, speaker, hint.provider);
          if (cliModel.model !== 'default') {
            modelGuide = `\n**Recommended model:** ${cliModel.model} (${cliModel.reason})\n**Model flag:** \`${hint.modelFlag} ${cliModel.model}\``;
          }
        }
      }
      return `CLI speaker. Respond directly via \`deliberation_respond(session_id: "${sid}", speaker: "${speaker}", content: "...")\`.${invocationGuide}${modelGuide}\n\n⛔ **No API calls**: Do not call LLM APIs directly via REST API, HTTP requests, urllib, requests, etc. Only use the CLI tools above.`;
    }
    case "clipboard":
      return `Browser LLM speaker. Copy the prompt below and paste it into the browser LLM using **Cmd+V (ㅍ)**, then submit the response via \`deliberation_respond(session_id: "${sid}", speaker: "${speaker}", use_clipboard: true)\` after copying the LLM's response with **Cmd+C (ㅊ)**.\n\n` +
             `📋 **Prompt has been copied to your clipboard.** (If not, copy the [turn_prompt] section below manually).\n` +
             `🖼️ **To include an image:** Copy the image to your clipboard and use \`include_clipboard_image: true\` in \`deliberation_respond\`.\n\n` +
             `⛔ **No API calls**: This speaker responds only via web browser. Do not call LLMs via REST API or HTTP requests.`;
    case "browser_auto":
      return `Auto browser speaker. Proceed automatically with \`deliberation_browser_auto_turn(session_id: "${sid}")\`. Inputs directly to browser LLM via CDP and reads responses.\n\n⛔ **No API calls**: Proceeds only via CDP automation. No REST API or HTTP requests.`;
    case "manual":
    default:
      return `Manual speaker. Get a response from the LLM's **web UI or CLI tool** and submit via \`deliberation_respond(session_id: "${sid}", speaker: "${speaker}", content: "...")\`.\n\n` +
             `📋 **Copy the [turn_prompt] section below** to the web UI.\n` +
             `🖼️ **To include an image:** Copy the image to your clipboard and use \`include_clipboard_image: true\` in \`deliberation_respond\`.\n\n` +
             `⛔ **Absolutely no API calls**: Calling LLM APIs directly via REST API, HTTP requests (urllib, requests, fetch, etc.) is forbidden. Only use web browser UI or CLI tools. Direct API key calls will result in deliberation participation being rejected.`;
  }
}

function buildSpeakerOrder(speakers, fallbackSpeaker = DEFAULT_SPEAKERS[0], fallbackPlacement = "front") {
  const ordered = [];
  const seen = new Set();

  const add = (candidate) => {
    const speaker = normalizeSpeaker(candidate);
    if (!speaker || seen.has(speaker)) return;
    seen.add(speaker);
    ordered.push(speaker);
  };

  if (fallbackPlacement === "front") {
    add(fallbackSpeaker);
  }

  if (Array.isArray(speakers)) {
    for (const speaker of speakers) {
      add(speaker);
    }
  }

  if (fallbackPlacement !== "front") {
    add(fallbackSpeaker);
  }

  if (ordered.length === 0) {
    for (const speaker of DEFAULT_SPEAKERS) {
      add(speaker);
    }
  }

  return ordered;
}

function normalizeSessionActors(state) {
  if (!state || typeof state !== "object") return state;

  const fallbackSpeaker = normalizeSpeaker(state.current_speaker)
    || normalizeSpeaker(state.log?.[0]?.speaker)
    || DEFAULT_SPEAKERS[0];
  const speakers = buildSpeakerOrder(state.speakers, fallbackSpeaker, "end");
  state.speakers = speakers;

  const normalizedCurrent = normalizeSpeaker(state.current_speaker);
  if (state.status === "active") {
    state.current_speaker = (normalizedCurrent && speakers.includes(normalizedCurrent))
      ? normalizedCurrent
      : speakers[0];
  } else if (normalizedCurrent) {
    state.current_speaker = normalizedCurrent;
  }

  return state;
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

function ensureDirs() {
  fs.mkdirSync(getSessionsDir(), { recursive: true });
  fs.mkdirSync(getArchiveDir(), { recursive: true });
  fs.mkdirSync(getLocksDir(), { recursive: true });
}

function loadSession(sessionId) {
  const file = getSessionFile(sessionId);
  if (!fs.existsSync(file)) return null;
  return normalizeSessionActors(JSON.parse(fs.readFileSync(file, "utf-8")));
}

function saveSession(state) {
  ensureDirs();
  state.updated = new Date().toISOString();
  writeTextAtomic(getSessionFile(state.id), JSON.stringify(state, null, 2));
  syncMarkdown(state);
}

function listActiveSessions() {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        return data;
      } catch { return null; }
    })
    .filter(s => s && (s.status === "active" || s.status === "awaiting_synthesis"));
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
  // Write to state dir instead of CWD to avoid polluting project root
  const mdPath = path.join(getProjectStateDir(), filename);
  try {
    writeTextAtomic(mdPath, stateToMarkdown(state));
  } catch { /* ignore sync failures */ }
}

function cleanupSyncMarkdown(state) {
  const filename = `deliberation-${state.id}.md`;
  // Remove from state dir
  const statePath = path.join(getProjectStateDir(), filename);
  try { fs.unlinkSync(statePath); } catch { /* ignore */ }
  // Also clean up legacy files in CWD (from older versions)
  const cwdPath = path.join(process.cwd(), filename);
  try { fs.unlinkSync(cwdPath); } catch { /* ignore */ }
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

  md += `## Debate Log\n\n`;
  for (const entry of s.log) {
    md += `### ${entry.speaker} — Round ${entry.round}\n\n`;
    if (entry.channel_used || entry.fallback_reason) {
      const parts = [];
      if (entry.channel_used) parts.push(`channel: ${entry.channel_used}`);
      if (entry.fallback_reason) parts.push(`fallback: ${entry.fallback_reason}`);
      md += `> _${parts.join(" | ")}_\n\n`;
    }
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
  ensureDirs();
  const slug = state.topic
    .replace(/[^a-zA-Z0-9가-힣\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 30);
  const ts = new Date().toISOString().slice(0, 16).replace(/:/g, "");
  const filename = `deliberation-${ts}-${slug}.md`;
  const dest = path.join(getArchiveDir(), filename);
  writeTextAtomic(dest, stateToMarkdown(state));
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
  const list = active.map(s => `- **${s.id}**: "${s.topic}" (Round ${s.current_round}/${s.max_rounds}, next: ${s.current_speaker})`).join("\n");
  return t(`Multiple active sessions found. Please specify session_id:\n\n${list}`, `여러 활성 세션이 있습니다. session_id를 지정하세요:\n\n${list}`, "en");
}

function formatRecentLogForPrompt(state, maxEntries = 4) {
  const entries = Array.isArray(state.log) ? state.log.slice(-Math.max(0, maxEntries)) : [];
  if (entries.length === 0) {
    return "(No previous responses yet)";
  }
  return entries.map(e => {
    const content = String(e.content || "").trim();
    return `- ${e.speaker} (Round ${e.round})\n${content}`;
  }).join("\n\n");
}

function buildClipboardTurnPrompt(state, speaker, prompt, includeHistoryEntries = 4) {
  const recent = formatRecentLogForPrompt(state, includeHistoryEntries);
  const extraPrompt = prompt ? `\n[Additional instructions]\n${prompt}\n` : "";

  // Role prompt injection
  const speakerRole = (state.speaker_roles || {})[speaker] || "free";
  const rolePromptText = loadRolePrompt(speakerRole);
  const roleSection = rolePromptText
    ? `\n[role]\nrole: ${speakerRole}\n${rolePromptText}\n[/role]\n`
    : "";

  return `[deliberation_turn_request]
session_id: ${state.id}
project: ${state.project}
topic: ${state.topic}
round: ${state.current_round}/${state.max_rounds}
target_speaker: ${speaker}
required_turn: ${state.current_speaker}${roleSection}

[recent_log]
${recent}
[/recent_log]${extraPrompt}

[response_rule]
- Write only ${speaker}'s response for this turn reflecting the discussion context above
- Output markdown body only (no unnecessary headers/footers)${speakerRole !== "free" ? `\n- Analyze and respond from the perspective of assigned role (${speakerRole})` : ""}
- Must include one of [AGREE], [DISAGREE], or [CONDITIONAL: reason] at the end of response
[/response_rule]
[/deliberation_turn_request]
`;
}

function submitDeliberationTurn({ session_id, speaker, content, turn_id, channel_used, fallback_reason, attachments }) {
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
    state.log.push({
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
    });
    appendRuntimeLog("INFO", `TURN: ${state.id} | R${state.current_round} | speaker: ${normalizedSpeaker} | votes: ${votes.length > 0 ? votes.map(v => v.vote).join(",") : "none"} | channel: ${channel_used || "respond"} | attachments: ${attachments ? attachments.length : 0}`);

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

    saveSession(state);
    return {
      content: [{
        type: "text",
        text: t(`✅ [${state.id}] ${normalizedSpeaker} Round ${state.log[state.log.length - 1].round} complete. Forum updated (${state.log.length} responses accumulated).\n\n**Next:** ${state.current_speaker} (Round ${state.current_round})`, `✅ [${state.id}] ${normalizedSpeaker} Round ${state.log[state.log.length - 1].round} 완료. Forum 업데이트됨 (${state.log.length}건 응답 축적).\n\n**다음:** ${state.current_speaker} (Round ${state.current_round})`, state?.lang),
      }],
    };
  });
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
    ).describe("If true, speakers must be explicitly specified to start (defaults to config setting)"),
    auto_discover_speakers: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" : v),
      z.boolean().optional()
    ).describe("Whether to auto-discover speakers when omitted (defaults to config setting)"),
    include_browser_speakers: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" : v),
      z.boolean().optional()
    ).describe("Whether browser speakers are allowed to participate. Defaults to false unless explicitly enabled."),
    participant_types: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.record(z.string(), z.enum(["cli", "browser", "browser_auto", "manual"])).optional()
    ).describe("Per-speaker type override (e.g., {\"chatgpt\": \"browser_auto\"})"),
    ordering_strategy: z.enum(["auto", "cyclic", "random", "weighted-random"]).optional()
      .describe("Ordering strategy: auto (automatic based on speaker count), cyclic (sequential), random (random each turn), weighted-random (less spoken speakers first)"),
    speaker_roles: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.record(z.string(), z.enum(["critic", "implementer", "mediator", "researcher", "free"])).optional()
    ).describe("Per-speaker role assignment (e.g., {\"claude\": \"critic\", \"codex\": \"implementer\"})"),
    role_preset: z.enum(["balanced", "debate", "research", "brainstorm", "review", "consensus"]).optional()
    .describe("Role preset (balanced/debate/research/brainstorm/review/consensus). Ignored if speaker_roles is specified"),
    },
    safeToolHandler("deliberation_start", async ({ topic, session_id, rounds, first_speaker, speakers, speaker_instructions, require_manual_speakers, auto_discover_speakers, include_browser_speakers, participant_types, ordering_strategy, speaker_roles, role_preset }) => {
    // ── First-time onboarding guard ──
    const config = loadDeliberationConfig();
    if (!config.setup_complete) {
      const candidateSnapshot = await collectSpeakerCandidates({ include_cli: true, include_browser: true });
      const candidateText = formatSpeakerCandidatesReport(candidateSnapshot);
      return {
        content: [{
          type: "text",
          text: `🎉 **Welcome to Deliberation!**\n\nPlease configure basic settings before starting.\n\n**Currently detected speakers:**\n${candidateText}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nYou can set all options at once:\n\n\`\`\`\ndeliberation_cli_config(\n  require_speaker_selection: true/false,\n  include_browser_speakers: false,\n  default_rounds: 3,\n  default_ordering: "auto"\n)\n\`\`\`\n\n**1. Speaker participation mode** (\`require_speaker_selection\`)\n   - \`true\` — Select participating speakers each time\n   - \`false\` — Auto-join detected speakers\n\n**2. Browser speakers** (\`include_browser_speakers\`)\n   - \`false\` — CLI only (recommended)\n   - \`true\` — Include browser LLM speakers too\n\n**3. Default rounds** (\`default_rounds\`)\n   - \`1\` — Quick consensus\n   - \`3\` — Default (recommended)\n   - \`5\` — Deep discussion\n\n**4. Ordering strategy** (\`default_ordering\`)\n   - \`"auto"\` — cyclic for 2 speakers, weighted-random for 3+ (recommended)\n   - \`"cyclic"\` — Fixed order\n   - \`"random"\` — Random each turn\n   - \`"weighted-random"\` — Less spoken speakers first`,
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
    const effectiveRequireManual = require_manual_speakers ?? config.require_speaker_selection ?? true;
    const effectiveAutoDiscover = auto_discover_speakers ?? !effectiveRequireManual;
    rounds = rounds ?? config.default_rounds ?? 3;
    const rawOrdering = ordering_strategy ?? config.default_ordering ?? "auto";
    // Resolve "auto": 2 speakers → cyclic, 3+ → weighted-random
    ordering_strategy = rawOrdering === "auto" ? undefined : rawOrdering; // resolved after speakers are known

    // When require_speaker_selection is explicitly true in config,
    // ignore LLM-provided speakers UNLESS require_manual_speakers: true is explicitly passed
    // (which signals the user has confirmed the speaker selection)
    const configRequiresSelection = config.require_speaker_selection === true;
    const llmExplicitlyConfirmed = require_manual_speakers === true;
    const hasManualSpeakers = Array.isArray(speakers) && speakers.length > 0
      && (!configRequiresSelection || llmExplicitlyConfirmed);

    if (!hasManualSpeakers && effectiveRequireManual) {
      const candidateText = formatSpeakerCandidatesReport(candidateSnapshot);
      const llmSuggested = Array.isArray(speakers) && speakers.length > 0
        ? `\n\n💡 **LLM suggested speakers:** ${speakers.join(", ")}\nTo use this suggestion, pass speakers again with \`require_manual_speakers: true\`.`
        : "";
      const configNote = configRequiresSelection
        ? "\n\n⚙️ `require_speaker_selection: true` setting requires you to manually select speakers."
        : "";
      return {
        content: [{
          type: "text",
          text: `Speakers must be manually selected to start a deliberation.${configNote}${llmSuggested}\n\n${candidateText}\n\nExample:\n\ndeliberation_start(\n  topic: "${topic.replace(/"/g, '\\"')}",\n  rounds: ${rounds},\n  speakers: ["claude", "codex", "gemini"],\n  require_manual_speakers: true,\n  first_speaker: "codex"\n)\n\nFirst call deliberation_speaker_candidates to check currently available speakers.`,
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
    const speakerOrder = buildSpeakerOrder(selectedSpeakers, normalizedFirstSpeaker, "front");

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
      ? "manually specified"
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
  "Query available speaker candidates (local CLI + browser LLM tabs).",
  {
    include_cli: z.boolean().default(true).describe("Include local CLI candidates"),
    include_browser: z.boolean().default(true).describe("Include browser LLM tab candidates"),
  },
  async ({ include_cli, include_browser }) => {
    const snapshot = await collectSpeakerCandidates({ include_cli, include_browser });
    const text = formatSpeakerCandidatesReport(snapshot);
    return { content: [{ type: "text", text: `${text}\n\n${PRODUCT_DISCLAIMER}` }] };
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

    // Dynamic timeout: first turn gets extra time for cold-start
    const speakerPriorTurns = state.log.filter(e => e.speaker === speaker).length;
    const effectiveTimeout = speakerPriorTurns === 0 ? Math.max(timeout_sec, 180) : timeout_sec;

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

        // Different invocation patterns per CLI
        switch (speaker) {
          case "claude":
            child = spawn("claude", ["-p", "--output-format", "text"], { env, windowsHide: true });
            child.stdin.write(turnPrompt);
            child.stdin.end();
            break;
          case "codex":
            child = spawn("codex", ["exec", "-"], { env, windowsHide: true });
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
          child.kill("SIGTERM");
          reject(new Error(`CLI timeout (${effectiveTimeout}s)`));
        }, effectiveTimeout * 1000);

        child.stdout.on("data", (data) => { stdout += data.toString(); });
        child.stderr.on("data", (data) => { stderr += data.toString(); });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0 && !stdout.trim()) {
            reject(new Error(`CLI exit code ${code}: ${stderr.slice(0, 500)}`));
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
                  .filter(line => !/^(tokens used$|^[0-9,]*$)/.test(line))
                  .join("\n");
              } else {
                // Fallback regex cleaning
                cleaned = stdout.split("\n")
                  .filter(line => !/^(OpenAI Codex|--------|workdir:|model:|provider:|approval:|sandbox:|reasoning|session id:|user$|mcp:|thinking$|tokens used$|^[0-9,]*$)/.test(line))
                  .join("\n");
              }
            } else if (speaker === "gemini") {
              cleaned = stdout.split("\n")
                .filter(line => !/^(Loaded cached|Error during discovery|\[MCP error\]| {4}at| {2}errno:| {2}code:| {2}syscall:| {2}path:| {2}spawnargs:|MCP issues detected|Server .* supports tool updates)/.test(line))
                .join("\n");
            }
            resolve(cleaned.trim());
          }
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
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
          text: `❌ CLI auto-turn failed: ${err.message}\n\n**Speaker:** ${speaker}\n**CLI:** ${hint.cmd}\n\nYou can submit a manual response via deliberation_respond(speaker: "${speaker}", content: "...").`,
        }],
      };
    }
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
  "End the deliberation and submit a synthesis report.",
  {
    session_id: z.string().optional().describe("Session ID (required if multiple sessions are active)"),
    synthesis: z.string().describe("Synthesis report (markdown)"),
  },
  safeToolHandler("deliberation_synthesize", async ({ session_id, synthesis }) => {
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
      loaded.status = "completed";
      loaded.current_speaker = "none";
      saveSession(loaded);
      archivePath = archiveState(loaded);
      cleanupSyncMarkdown(loaded);
      // Clean up the active session JSON file upon completion
      const sessionFile = getSessionFile(loaded.id);
      try { if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile); } catch { /* ignore */ }
      state = loaded;
      return null;
    });
    if (lockedResult) {
      return lockedResult;
    }

    appendRuntimeLog("INFO", `SYNTHESIZED: ${resolved} | turns: ${state.log.length} | rounds: ${state.max_rounds}`);

    // Immediately force-close monitor terminal (including physical Terminal) on deliberation end
    closeMonitorTerminal(state.id, getSessionWindowIds(state));

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
        const file = getSessionFile(session_id);
        if (!fs.existsSync(file)) {
          return { content: [{ type: "text", text: t(`Session "${session_id}" not found.`, `세션 "${session_id}"을 찾을 수 없습니다.`, "en") }] };
        }
        const state = loadSession(session_id);
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
    ).describe("true: user selects speakers before each start, false: all detected speakers auto-join"),
    include_browser_speakers: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" : v),
      z.boolean().optional()
    ).describe("true: browser LLM speakers may join when requested or auto-discovered, false: CLI-only mode"),
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
      config.require_speaker_selection = require_speaker_selection;
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
          text: `## Deliberation CLI Settings\n\n**Mode:** ${mode}\n**Speaker selection:** ${config.require_speaker_selection === false ? "auto (detected speakers join)" : "manual (user selects)"}\n**Browser speakers:** ${config.include_browser_speakers === true ? "enabled" : "disabled (CLI-only default)"}\n**Default rounds:** ${config.default_rounds || 3}\n**Ordering:** ${config.default_ordering || "auto"}\n**Chrome profile:** ${config.chrome_profile || "Default"} (env: DELIBERATION_CHROME_PROFILE)\n**Configured CLIs:** ${configured.length > 0 ? configured.join(", ") : "(none — full auto-detection)"}\n**Currently detected CLIs:** ${detected.join(", ") || "(none)"}\n**All supported CLIs:** ${DEFAULT_CLI_CANDIDATES.join(", ")}\n\nTo change:\n\`deliberation_cli_config(require_speaker_selection: false, include_browser_speakers: false, default_rounds: 3, default_ordering: "auto")\`\n\nTo enable browser speakers:\n\`deliberation_cli_config(include_browser_speakers: true)\`\n\nTo set Chrome profile for CDP:\n\`deliberation_cli_config(chrome_profile: "Profile 1")\`\n\nTo revert to full auto-detection:\n\`deliberation_cli_config(enabled_clis: [])\``,
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
            proc = spawn("claude", ["-p", "--output-format", "text", "--no-input"], { env, windowsHide: true });
            proc.stdin.write(opinionPrompt);
            proc.stdin.end();
          } else if (speaker === "codex") {
            proc = spawn("codex", ["exec", "-"], { env, windowsHide: true });
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
                  .filter(line => !/^(tokens used$|^[0-9,]*$)/.test(line))
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
export { selectNextSpeaker, loadRolePrompt, inferSuggestedRole, parseVotes, ROLE_KEYWORDS, ROLE_HEADING_MARKERS, loadRolePresets, applyRolePreset, detectDegradationLevels, formatDegradationReport, DEGRADATION_TIERS, DECISION_STAGES, STAGE_TRANSITIONS, createDecisionSession, advanceStage, buildConflictMap, parseOpinionFromResponse, buildOpinionPrompt, generateConflictQuestions, buildSynthesis, buildActionPlan, loadTemplates, matchTemplate, hasExplicitBrowserParticipantSelection, resolveIncludeBrowserSpeakers };
