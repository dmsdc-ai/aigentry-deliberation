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
  npx @dmsdc-ai/aigentry-deliberation install     설치 (MCP 서버 등록)
  npx @dmsdc-ai/aigentry-deliberation uninstall    제거
  npx @dmsdc-ai/aigentry-deliberation              MCP 서버 실행 (stdio)

설치 후 Claude Code를 재시작하면 자동으로 사용 가능합니다.
`);
  process.exit(0);
}

/**
 * MCP Deliberation Server (Global) — Multi-Session + Transport Routing + Cross-Platform + BrowserControlPort
 *
 * 모든 프로젝트에서 사용 가능한 AI 간 deliberation 서버.
 * 동시에 여러 deliberation을 병렬 진행할 수 있다.
 *
 * 상태 저장: $INSTALL_DIR/state/{project-slug}/sessions/{id}.json
 *   macOS/Linux: ~/.local/lib/mcp-deliberation/
 *   Windows:     %LOCALAPPDATA%/mcp-deliberation/
 *
 * Tools:
 *   deliberation_start        새 토론 시작 → session_id 반환
 *   deliberation_status       세션 상태 조회 (session_id 선택적)
 *   deliberation_list_active  진행 중인 모든 세션 목록
 *   deliberation_context      프로젝트 컨텍스트 로드
 *   deliberation_respond      응답 제출 (session_id 필수)
 *   deliberation_history      토론 기록 조회 (session_id 선택적)
 *   deliberation_synthesize   합성 보고서 생성 (session_id 선택적)
 *   deliberation_list         과거 아카이브 목록
 *   deliberation_reset        세션 초기화 (session_id 선택적, 없으면 전체)
 *   deliberation_speaker_candidates      선택 가능한 스피커 후보(로컬 CLI + 브라우저 LLM 탭) 조회
 *   deliberation_browser_llm_tabs      브라우저 LLM 탭 목록 조회
 *   deliberation_browser_auto_turn      브라우저 LLM에 자동으로 턴을 전송하고 응답을 수집 (CDP 기반)
 *   deliberation_request_review         코드 리뷰 요청 (CLI 리뷰어 자동 호출, sync/async 모드)
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

function inferSuggestedRole(text) {
  const scores = {};
  for (const [role, pattern] of Object.entries(ROLE_KEYWORDS)) {
    const matches = (text.match(new RegExp(pattern, "g")) || []).length;
    if (matches > 0) scores[role] = matches;
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
    tier1: { name: "tmux", description: "tmux 실시간 모니터링 윈도우", check: () => commandExistsInPath("tmux") },
    tier2: { name: "logfile", description: "로그 파일 tail 모니터링", check: () => true },
    tier3: { name: "silent", description: "모니터링 없음 (로그만 기록)", check: () => true },
  },
  browser: {
    tier1: { name: "cdp_auto", description: "CDP 자동 전송/수집", check: async () => { try { const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(2000) }); return res.ok; } catch { return false; } } },
    tier2: { name: "clipboard", description: "클립보드 기반 수동 전달", check: () => true },
    tier3: { name: "manual", description: "완전 수동 복사/붙여넣기", check: () => true },
  },
  terminal: {
    tier1: { name: "auto_open", description: "터미널 앱 자동 오픈", check: () => process.platform === "darwin" || process.platform === "win32" },
    tier2: { name: "none", description: "터미널 자동 오픈 불가", check: () => true },
    tier3: { name: "none", description: "터미널 자동 오픈 불가", check: () => true },
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

const PRODUCT_DISCLAIMER = "ℹ️ 이 도구는 외부 웹사이트를 영구 수정하지 않습니다. 브라우저 문맥을 읽기 전용으로 참조하여 발화자를 라우팅합니다.";
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
      return { content: [{ type: "text", text: `❌ ${toolName} 실패: ${message}` }] };
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

function resolveClipboardReader() {
  if (process.platform === "darwin" && commandExistsInPath("pbpaste")) {
    return { cmd: "pbpaste", args: [] };
  }
  if (process.platform === "win32") {
    const windowsShell = ["powershell.exe", "powershell", "pwsh.exe", "pwsh"]
      .find(cmd => commandExistsInPath(cmd));
    if (windowsShell) {
      return { cmd: windowsShell, args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"] };
    }
  }
  if (commandExistsInPath("wl-paste")) {
    return { cmd: "wl-paste", args: ["-n"] };
  }
  if (commandExistsInPath("xclip")) {
    return { cmd: "xclip", args: ["-selection", "clipboard", "-o"] };
  }
  if (commandExistsInPath("xsel")) {
    return { cmd: "xsel", args: ["--clipboard", "--output"] };
  }
  return null;
}

function resolveClipboardWriter() {
  if (process.platform === "darwin" && commandExistsInPath("pbcopy")) {
    return { cmd: "pbcopy", args: [] };
  }
  if (process.platform === "win32") {
    if (commandExistsInPath("clip.exe") || commandExistsInPath("clip")) {
      return { cmd: "clip", args: [] };
    }
    const windowsShell = ["powershell.exe", "powershell", "pwsh.exe", "pwsh"]
      .find(cmd => commandExistsInPath(cmd));
    if (windowsShell) {
      return { cmd: windowsShell, args: ["-NoProfile", "-Command", "[Console]::In.ReadToEnd() | Set-Clipboard"] };
    }
  }
  if (commandExistsInPath("wl-copy")) {
    return { cmd: "wl-copy", args: [] };
  }
  if (commandExistsInPath("xclip")) {
    return { cmd: "xclip", args: ["-selection", "clipboard"] };
  }
  if (commandExistsInPath("xsel")) {
    return { cmd: "xsel", args: ["--clipboard", "--input"] };
  }
  return null;
}

function readClipboardText() {
  const tool = resolveClipboardReader();
  if (!tool) {
    throw new Error("지원되는 클립보드 읽기 명령이 없습니다 (pbpaste/wl-paste/xclip/xsel 등).");
  }
  return execFileSync(tool.cmd, tool.args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 5 * 1024 * 1024,
  });
}

function writeClipboardText(text) {
  const tool = resolveClipboardWriter();
  if (!tool) {
    throw new Error("지원되는 클립보드 쓰기 명령이 없습니다 (pbcopy/wl-copy/xclip/xsel 등).");
  }
  execFileSync(tool.cmd, tool.args, {
    input: text,
    encoding: "utf-8",
    stdio: ["pipe", "ignore", "pipe"],
    maxBuffer: 5 * 1024 * 1024,
  });
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
    const key = `${browser}\t${title}\t${url}`;
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
      return { tabs: [], note: "DELIBERATION_BROWSER_TABS_JSON 형식 오류: JSON 배열이어야 합니다." };
    }

    const tabs = dedupeBrowserTabs(parsed.map(item => ({
      browser: item?.browser || "External Bridge",
      title: item?.title || "(untitled)",
      url: item?.url || "",
    })));
    return {
      tabs,
      note: tabs.length > 0 ? `환경변수 탭 주입 사용: ${tabs.length}개` : "DELIBERATION_BROWSER_TABS_JSON에 유효한 LLM URL이 없습니다.",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return { tabs: [], note: `DELIBERATION_BROWSER_TABS_JSON 파싱 실패: ${reason}` };
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
  const suffix = items.length > max ? ` 외 ${items.length - max}개` : "";
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
      note: failSummary ? `일부 CDP 엔드포인트 접근 실패: ${failSummary}` : null,
    };
  }

  const failSummary = summarizeFailures(failures);
  return {
    tabs: [],
    note: `CDP에서 LLM 탭을 찾지 못했습니다. 브라우저를 --remote-debugging-port=9222로 실행하거나 DELIBERATION_BROWSER_TABS_JSON으로 탭 목록을 주입하세요.${failSummary ? ` (실패: ${failSummary})` : ""}`,
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

  // If none respond and platform is macOS, try auto-launching Chrome with CDP
  if (process.platform === "darwin") {
    // Chrome 145+ requires --user-data-dir for CDP to work.
    // The default data dir is rejected, so we copy the profile to ~/.chrome-cdp.
    const chromeUserDataDir = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
    const cdpDataDir = path.join(os.homedir(), ".chrome-cdp");
    const profileDir = "Default";

    try {
      const srcProfile = path.join(chromeUserDataDir, profileDir);
      const dstProfile = path.join(cdpDataDir, profileDir);
      if (!fs.existsSync(dstProfile) && fs.existsSync(srcProfile)) {
        fs.mkdirSync(cdpDataDir, { recursive: true });
        execFileSync("cp", ["-R", srcProfile, dstProfile], { timeout: 30000, stdio: "ignore" });
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
    } catch { /* proceed with launch attempt anyway */ }

    const chromeBin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const launchArgs = [
      "--remote-debugging-port=9222",
      "--remote-allow-origins=*",
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
        reason: "Chrome 자동 실행에 실패했습니다. Chrome을 수동으로 --remote-debugging-port=9222 --user-data-dir=~/.chrome-cdp 옵션과 함께 실행해주세요.",
      };
    }

    // Wait for Chrome to initialize CDP
    sleepMs(5000);

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
      reason: "Chrome을 실행했지만 CDP에 연결할 수 없습니다. Chrome을 완전히 종료한 후 다시 시도해주세요. (이미 실행 중인 Chrome이 CDP 없이 시작된 경우 재시작 필요)",
    };
  }

  // Non-macOS: cannot auto-launch
  return {
    available: false,
    reason: "Chrome CDP를 활성화할 수 없습니다. Chrome을 --remote-debugging-port=9222 옵션과 함께 실행해주세요.",
  };
}

function collectBrowserLlmTabsViaAppleScript() {
  if (process.platform !== "darwin") {
    return { tabs: [], note: "AppleScript 탭 스캔은 macOS에서만 지원됩니다." };
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
        ? `일부 브라우저 접근 실패: ${errors.map(e => `${e.browser} (${e.url})`).join(", ")}`
        : null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return {
      tabs: [],
      note: `브라우저 탭 스캔 실패: ${reason}. macOS 자동화 권한(터미널 -> 브라우저 제어)을 확인하세요.`,
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
      note: notes.length > 0 ? notes.join(" | ") : "브라우저 탭 자동 스캔이 비활성화되었습니다.",
    };
  }

  const shouldUseAppleScript = mode === "auto" || mode === "applescript";
  if (shouldUseAppleScript && process.platform === "darwin") {
    const mac = collectBrowserLlmTabsViaAppleScript();
    tabs.push(...mac.tabs);
    if (mac.note) notes.push(mac.note);
  } else if (mode === "applescript" && process.platform !== "darwin") {
    notes.push("AppleScript 스캔은 macOS 전용입니다. CDP 스캔으로 전환하세요.");
  }

  const shouldUseCdp = mode === "auto" || mode === "cdp";
  if (shouldUseCdp) {
    const cdp = await collectBrowserLlmTabsViaCdp();
    tabs.push(...cdp.tabs);
    if (cdp.note) notes.push(cdp.note);
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
      add({
        speaker: cli,
        type: "cli",
        label: cli,
        command: cli,
      });
    }
  }

  let browserNote = null;
  if (include_browser) {
    // Ensure CDP is available before probing browser tabs
    const cdpStatus = await ensureCdpAvailable();
    if (cdpStatus.launched) {
      browserNote = "Chrome CDP 자동 실행됨 (--remote-debugging-port=9222)";
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
    const cdpTabs = [];
    for (const endpoint of cdpEndpoints) {
      try {
        const tabs = await fetchJson(endpoint, 2000);
        if (Array.isArray(tabs)) {
          for (const t of tabs) {
            if (t.type === "page" && t.url) cdpTabs.push(t);
          }
        }
      } catch { /* endpoint not reachable */ }
    }

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
          if (matches.length === 1) {
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
      if (matches.length === 1) {
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
    out += "- (감지된 로컬 CLI 없음)\n\n";
  } else {
    out += `${cli.map(c => `- \`${c.speaker}\` (command: ${c.command})`).join("\n")}\n\n`;
  }

  out += "### Browser LLM (감지됨)\n";
  if (detected.length === 0) {
    out += "- (브라우저에서 감지된 LLM 탭 없음)\n";
  } else {
    out += `${detected.map(c => {
      const icon = c.cdp_available ? "⚡자동" : "📋클립보드";
      const extTag = String(c.url || "").startsWith("chrome-extension://") ? " [Extension]" : "";
      return `- \`${c.speaker}\` [${icon}]${extTag} [${c.browser}] ${c.title}\n  ${c.url}`;
    }).join("\n")}\n`;
  }

  out += "\n### Web LLM (자동 등록)\n";
  out += `${autoReg.map(c => {
    const icon = c.cdp_available ? "⚡자동" : "📋클립보드";
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
      profiles.push({
        speaker,
        type: overrideType,
        ...(overrideType === "browser_auto" ? { provider: "chatgpt" } : {}),
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
  claude: { cmd: "claude", flags: '-p --output-format text', example: 'claude -p --output-format text "프롬프트"', modelFlag: '--model', provider: 'claude' },
  codex: { cmd: "codex", flags: 'exec', example: 'codex exec "프롬프트"', modelFlag: '--model', provider: 'chatgpt' },
  gemini: { cmd: "gemini", flags: '', example: 'gemini "프롬프트"', modelFlag: '--model', provider: 'gemini' },
  aider: { cmd: "aider", flags: '--message', example: 'aider --message "프롬프트"', modelFlag: '--model', provider: 'chatgpt' },
  cursor: { cmd: "cursor", flags: '', example: 'cursor "프롬프트"', modelFlag: null, provider: 'chatgpt' },
};

function formatTransportGuidance(transport, state, speaker) {
  const sid = state.id;
  switch (transport) {
    case "cli_respond": {
      const hint = CLI_INVOCATION_HINTS[speaker] || null;
      let invocationGuide = "";
      let modelGuide = "";
      if (hint) {
        invocationGuide = `\n\n**CLI 호출 방법:** \`${hint.example}\`\n(플래그: \`${hint.cmd} ${hint.flags}\`)`;
        if (hint.modelFlag && hint.provider) {
          const cliModel = getModelSelectionForTurn(state, speaker, hint.provider);
          if (cliModel.model !== 'default') {
            modelGuide = `\n**추천 모델:** ${cliModel.model} (${cliModel.reason})\n**모델 플래그:** \`${hint.modelFlag} ${cliModel.model}\``;
          }
        }
      }
      return `CLI speaker입니다. \`deliberation_respond(session_id: "${sid}", speaker: "${speaker}", content: "...")\`로 직접 응답하세요.${invocationGuide}${modelGuide}\n\n⛔ **API 호출 금지**: REST API, HTTP 요청, urllib, requests 등으로 LLM API를 직접 호출하지 마세요. 반드시 위 CLI 도구만 사용하세요.`;
    }
    case "clipboard":
      return `브라우저 LLM speaker입니다. CDP 자동 연결 시도 중... Chrome이 이미 CDP 없이 실행 중이면 재시작이 필요할 수 있습니다.\n\n⛔ **API 호출 금지**: 이 speaker는 웹 브라우저로만 응답합니다. REST API, HTTP 요청으로 LLM을 호출하지 마세요.`;
    case "browser_auto":
      return `자동 브라우저 speaker입니다. \`deliberation_browser_auto_turn(session_id: "${sid}")\`으로 자동 진행됩니다. CDP를 통해 브라우저 LLM에 직접 입력하고 응답을 읽습니다.\n\n⛔ **API 호출 금지**: CDP 자동화로만 진행합니다. REST API, HTTP 요청 사용 금지.`;
    case "manual":
    default:
      return `수동 speaker입니다. 해당 LLM의 **웹 UI 또는 CLI 도구**를 통해 응답을 받아 \`deliberation_respond(session_id: "${sid}", speaker: "${speaker}", content: "...")\`로 제출하세요.\n\n⛔ **API 호출 절대 금지**: REST API, HTTP 요청(urllib, requests, fetch 등)으로 LLM API를 직접 호출하는 것은 금지됩니다. 반드시 웹 브라우저 UI 또는 CLI 도구만 사용하세요. API 키로 직접 호출하면 deliberation 참여가 거부됩니다.`;
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
  return context || "(컨텍스트 파일을 찾을 수 없습니다)";
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
  // session_id가 주어지면 그대로 사용
  if (sessionId) return sessionId;

  // 없으면 활성 세션이 1개일 때 자동 선택
  const active = listActiveSessions();
  if (active.length === 0) return null;
  if (active.length === 1) return active[0].id;

  // 여러 개면 null (목록 표시 필요)
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
    md += `${entry.content}\n\n---\n\n`;
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
  // tmux 윈도우 이름은 짧게 (마지막 부분 제거하고 20자)
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
  return `tmux attach -t ${shellQuote(TMUX_SESSION)} \\; select-window -t ${shellQuote(`${TMUX_SESSION}:${winName}`)}`;
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
  const attachCmd = `tmux attach -t "${TMUX_SESSION}" \\; select-window -t "${TMUX_SESSION}:${winName}"`;

  // If a terminal is already attached to this tmux session, just switch to the right window
  if (tmuxHasAttachedClients(TMUX_SESSION)) {
    try {
      execFileSync("tmux", ["select-window", "-t", `${TMUX_SESSION}:${winName}`], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch { /* window might not exist yet */ }
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
        return true;
      }
      execFileSync("tmux", ["new-window", "-t", TMUX_SESSION, "-n", winName, cmd], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      execFileSync("tmux", ["new-session", "-d", "-s", TMUX_SESSION, "-n", winName, cmd], {
        stdio: "ignore",
        windowsHide: true,
      });
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
  return `여러 활성 세션이 있습니다. session_id를 지정하세요:\n\n${list}`;
}

function formatRecentLogForPrompt(state, maxEntries = 4) {
  const entries = Array.isArray(state.log) ? state.log.slice(-Math.max(0, maxEntries)) : [];
  if (entries.length === 0) {
    return "(아직 이전 응답 없음)";
  }
  return entries.map(e => {
    const content = String(e.content || "").trim();
    return `- ${e.speaker} (Round ${e.round})\n${content}`;
  }).join("\n\n");
}

function buildClipboardTurnPrompt(state, speaker, prompt, includeHistoryEntries = 4) {
  const recent = formatRecentLogForPrompt(state, includeHistoryEntries);
  const extraPrompt = prompt ? `\n[추가 지시]\n${prompt}\n` : "";

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
- 위 토론 맥락을 반영해 ${speaker}의 이번 턴 응답만 작성
- 마크다운 본문만 출력 (불필요한 머리말/꼬리말 금지)${speakerRole !== "free" ? `\n- 배정된 역할(${speakerRole})의 관점에서 분석하고 응답` : ""}
[/response_rule]
[/deliberation_turn_request]
`;
}

function submitDeliberationTurn({ session_id, speaker, content, turn_id, channel_used, fallback_reason }) {
  const resolved = resolveSessionId(session_id);
  if (!resolved) {
    return { content: [{ type: "text", text: "활성 deliberation이 없습니다." }] };
  }
  if (resolved === "MULTIPLE") {
    return { content: [{ type: "text", text: multipleSessionsError() }] };
  }

  return withSessionLock(resolved, () => {
    const state = loadSession(resolved);
    if (!state || state.status !== "active") {
      return { content: [{ type: "text", text: `세션 "${resolved}"이 활성 상태가 아닙니다.` }] };
    }

    const normalizedSpeaker = normalizeSpeaker(speaker);
    if (!normalizedSpeaker) {
      return { content: [{ type: "text", text: "speaker 값이 비어 있습니다. 응답자 이름을 지정하세요." }] };
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
          text: `[${state.id}] 지금은 **${state.current_speaker}** 차례입니다. ${normalizedSpeaker}는 대기하세요.`,
        }],
      };
    }

    // turn_id 검증 (선택적 — 제공 시 반드시 일치해야 함)
    if (turn_id && state.pending_turn_id && turn_id !== state.pending_turn_id) {
      return {
        content: [{
          type: "text",
          text: `[${state.id}] turn_id 불일치. 예상: "${state.pending_turn_id}", 수신: "${turn_id}". 오래된 요청이거나 중복 제출일 수 있습니다.`,
        }],
      };
    }

    const votes = parseVotes(content);
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
    });

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
            text: `✅ [${state.id}] ${normalizedSpeaker} Round ${state.log[state.log.length - 1].round} 완료.\n\n🏁 **모든 라운드 종료!**\ndeliberation_synthesize(session_id: "${state.id}")로 합성 보고서를 작성하세요.`,
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
        text: `✅ [${state.id}] ${normalizedSpeaker} Round ${state.log[state.log.length - 1].round} 완료.\n\n**다음:** ${state.current_speaker} (Round ${state.current_round})`,
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
  "새 deliberation을 시작합니다. 여러 토론을 동시에 진행할 수 있습니다.",
  {
    topic: z.string().describe("토론 주제"),
    rounds: z.coerce.number().optional().describe("라운드 수 (미지정 시 config 설정 따름, 기본 3)"),
    first_speaker: z.string().trim().min(1).max(64).optional().describe("첫 발언자 이름 (미지정 시 speakers의 첫 항목)"),
    speakers: z.preprocess(
      (v) => {
        const parsed = typeof v === "string" ? JSON.parse(v) : v;
        if (!Array.isArray(parsed)) return parsed;
        // Normalize: accept both string[] and {name, role?, instructions?}[]
        return parsed.map(item => (typeof item === "object" && item !== null && item.name) ? item.name : item);
      },
      z.array(z.string().trim().min(1).max(64)).min(1).optional()
    ).describe("참가자 이름 목록. 문자열 배열 또는 {name, role, instructions} 객체 배열 모두 지원"),
    speaker_instructions: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.record(z.string(), z.string()).optional()
    ).describe("speaker별 추가 지시사항 (예: {\"claude\": \"비판적으로 검토\"})"),
    require_manual_speakers: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" : v),
      z.boolean().optional()
    ).describe("true면 speakers를 반드시 직접 지정해야 시작 (미지정 시 config 설정 따름)"),
    auto_discover_speakers: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" : v),
      z.boolean().optional()
    ).describe("speakers 생략 시 자동 탐색 여부 (미지정 시 config 설정 따름)"),
    participant_types: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.record(z.string(), z.enum(["cli", "browser", "browser_auto", "manual"])).optional()
    ).describe("speaker별 타입 오버라이드 (예: {\"chatgpt\": \"browser_auto\"})"),
    ordering_strategy: z.enum(["auto", "cyclic", "random", "weighted-random"]).optional()
      .describe("발언 순서 전략: auto(스피커 수에 따라 자동), cyclic(순서대로), random(매턴 무작위), weighted-random(덜 말한 사람 우선)"),
    speaker_roles: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.record(z.string(), z.enum(["critic", "implementer", "mediator", "researcher", "free"])).optional()
    ).describe("speaker별 역할 배정 (예: {\"claude\": \"critic\", \"codex\": \"implementer\"})"),
    role_preset: z.enum(["balanced", "debate", "research", "brainstorm", "review", "consensus"]).optional()
      .describe("역할 프리셋 (balanced/debate/research/brainstorm/review/consensus). speaker_roles가 명시되면 무시됨"),
  },
  safeToolHandler("deliberation_start", async ({ topic, rounds, first_speaker, speakers, speaker_instructions, require_manual_speakers, auto_discover_speakers, participant_types, ordering_strategy, speaker_roles, role_preset }) => {
    // ── First-time onboarding guard ──
    const config = loadDeliberationConfig();
    if (!config.setup_complete) {
      const candidateSnapshot = await collectSpeakerCandidates({ include_cli: true, include_browser: true });
      const candidateText = formatSpeakerCandidatesReport(candidateSnapshot);
      return {
        content: [{
          type: "text",
          text: `🎉 **Deliberation 첫 사용을 환영합니다!**\n\n시작 전에 기본 설정을 해주세요.\n\n**현재 감지된 스피커:**\n${candidateText}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n아래 설정을 한 번에 지정할 수 있습니다:\n\n\`\`\`\ndeliberation_cli_config(\n  require_speaker_selection: true/false,\n  default_rounds: 3,\n  default_ordering: "auto"\n)\n\`\`\`\n\n**1. 스피커 참여 모드** (\`require_speaker_selection\`)\n   - \`true\` — 매번 참여할 스피커를 직접 선택\n   - \`false\` — 감지된 CLI + 브라우저 LLM 전부 자동 참여\n\n**2. 기본 라운드 수** (\`default_rounds\`)\n   - \`1\` — 빠른 의견 수렴\n   - \`3\` — 기본 (권장)\n   - \`5\` — 심층 토론\n\n**3. 발언 순서 전략** (\`default_ordering\`)\n   - \`"auto"\` — 2명이면 cyclic, 3명 이상이면 weighted-random (권장)\n   - \`"cyclic"\` — 고정 순서\n   - \`"random"\` — 매턴 무작위\n   - \`"weighted-random"\` — 덜 발언한 사람 우선`,
        }],
      };
    }

    const sessionId = generateSessionId(topic);
    const candidateSnapshot = await collectSpeakerCandidates({ include_cli: true, include_browser: true });

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
        ? `\n\n💡 **LLM이 제안한 스피커:** ${speakers.join(", ")}\n위 제안을 사용하려면 \`require_manual_speakers: true\`와 함께 speakers를 다시 전달하세요.`
        : "";
      const configNote = configRequiresSelection
        ? "\n\n⚙️ `require_speaker_selection: true` 설정에 의해 사용자가 직접 스피커를 선택해야 합니다."
        : "";
      return {
        content: [{
          type: "text",
          text: `스피커를 직접 선택해야 deliberation을 시작할 수 있습니다.${configNote}${llmSuggested}\n\n${candidateText}\n\n예시:\n\ndeliberation_start(\n  topic: "${topic.replace(/"/g, '\\"')}",\n  rounds: ${rounds},\n  speakers: ["codex", "web-claude-1", "web-chatgpt-1"],\n  require_manual_speakers: true,\n  first_speaker: "codex"\n)\n\n먼저 deliberation_speaker_candidates를 호출해 현재 선택 가능한 스피커를 확인하세요.`,
        }],
      };
    }

    let autoDiscoveredSpeakers = [];
    let autoParticipantTypes = {};
    if (!hasManualSpeakers && effectiveAutoDiscover) {
      // Include ALL candidates: CLI + browser
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
      const candidateSnapshot = await collectSpeakerCandidates({ include_cli: true, include_browser: true });
      const candidateText = formatSpeakerCandidatesReport(candidateSnapshot);
      return {
        content: [{
          type: "text",
          text: `⚠️ Deliberation에는 최소 2명의 speaker가 필요합니다. 현재 ${speakerOrder.length}명만 지정됨: ${speakerOrder.join(", ")}\n\n사용 가능한 스피커 후보:\n${candidateText}\n\n예시:\ndeliberation_start(topic: "${topic.slice(0, 50)}...", speakers: ["claude", "codex", "web-gemini-1"])`,
        }],
      };
    }

    const participantMode = hasManualSpeakers
      ? "수동 지정"
      : (autoDiscoveredSpeakers.length > 0 ? "자동 탐색(PATH)" : "기본값");

    const degradationLevels = await detectDegradationLevels();

    const state = {
      id: sessionId,
      project: getProjectSlug(),
      topic,
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
            text: `❌ 브라우저 LLM speaker가 포함되어 있지만 CDP에 연결할 수 없습니다.\n\n${cdpReady.reason}\n\nCDP 연결 후 다시 deliberation_start를 호출하세요.`,
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
        ? `\n⚠️ Windows Terminal을 찾을 수 없어 모니터 터미널 미생성`
        : `\n⚠️ tmux를 찾을 수 없어 모니터 터미널 미생성`
      : physicalOpened
        ? isWin
          ? `\n🖥️ 모니터 터미널 오픈됨 (Windows Terminal)`
          : `\n🖥️ 모니터 터미널 오픈됨: tmux attach -t ${TMUX_SESSION}`
        : isWin
          ? `\n⚠️ 모니터 터미널 자동 오픈 실패`
          : `\n⚠️ tmux 윈도우는 생성됐지만 외부 터미널 자동 오픈 실패. 수동 실행: tmux attach -t ${TMUX_SESSION}`;
    const manualNotDetected = hasManualSpeakers
      ? speakerOrder.filter(s => !candidateSnapshot.candidates.some(c => c.speaker === s))
      : [];
    const detectWarning = manualNotDetected.length > 0
      ? `\n\n⚠️ 현재 환경에서 즉시 검출되지 않은 speaker: ${manualNotDetected.join(", ")}\n(수동 지정으로는 참가 가능)`
      : "";

    const transportSummary = state.participant_profiles.map(p => {
      const { transport } = resolveTransportForSpeaker(state, p.speaker);
      return `  - \`${p.speaker}\`: ${transport} (${p.type})`;
    }).join("\n");

    return {
      content: [{
        type: "text",
        text: `✅ Deliberation 시작!\n\n**세션:** ${sessionId}\n**프로젝트:** ${state.project}\n**주제:** ${topic}\n**라운드:** ${rounds}\n**발언 순서:** ${state.ordering_strategy || "cyclic"}\n**참가자 구성:** ${participantMode}\n**참가자:** ${speakerOrder.join(", ")}\n**첫 발언:** ${state.current_speaker}\n**동시 진행 세션:** ${active.length}개${terminalMsg}${detectWarning}\n\n**역할 배정:**${role_preset ? ` (프리셋: ${role_preset})` : ""}\n${speakerOrder.map(s => `  - \`${s}\`: ${(state.speaker_roles || {})[s] || "free"}`).join("\n")}\n\n**환경 상태:**\n${formatDegradationReport(state.degradation)}\n\n**Transport 라우팅:**\n${transportSummary}\n\n💡 이후 도구 호출 시 session_id: "${sessionId}" 를 사용하세요.`,
      }],
    };
  })
);

server.tool(
  "deliberation_speaker_candidates",
  "사용자가 선택 가능한 스피커 후보(로컬 CLI + 브라우저 LLM 탭)를 조회합니다.",
  {
    include_cli: z.boolean().default(true).describe("로컬 CLI 후보 포함"),
    include_browser: z.boolean().default(true).describe("브라우저 LLM 탭 후보 포함"),
  },
  async ({ include_cli, include_browser }) => {
    const snapshot = await collectSpeakerCandidates({ include_cli, include_browser });
    const text = formatSpeakerCandidatesReport(snapshot);
    return { content: [{ type: "text", text: `${text}\n\n${PRODUCT_DISCLAIMER}` }] };
  }
);

server.tool(
  "deliberation_list_active",
  "현재 프로젝트에서 진행 중인 모든 deliberation 세션 목록을 반환합니다.",
  {},
  async () => {
    const active = listActiveSessions();
    if (active.length === 0) {
      return { content: [{ type: "text", text: "진행 중인 deliberation이 없습니다." }] };
    }

    let list = `## 진행 중인 Deliberation (${getProjectSlug()}) — ${active.length}개\n\n`;
    for (const s of active) {
      list += `### ${s.id}\n- **주제:** ${s.topic}\n- **상태:** ${s.status} | Round ${s.current_round}/${s.max_rounds} | Next: ${s.current_speaker}\n- **응답 수:** ${s.log.length}\n\n`;
    }
    return { content: [{ type: "text", text: list }] };
  }
);

server.tool(
  "deliberation_status",
  "deliberation 상태를 조회합니다. 활성 세션이 1개면 자동 선택, 여러 개면 session_id 필요.",
  {
    session_id: z.string().optional().describe("세션 ID (여러 세션 진행 중이면 필수)"),
  },
  async ({ session_id }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: "활성 deliberation이 없습니다. deliberation_start로 시작하세요." }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state) {
      return { content: [{ type: "text", text: `세션 "${resolved}"을 찾을 수 없습니다.` }] };
    }

    return {
      content: [{
        type: "text",
        text: `**세션:** ${state.id}\n**프로젝트:** ${state.project}\n**주제:** ${state.topic}\n**상태:** ${state.status}\n**라운드:** ${state.current_round}/${state.max_rounds}\n**참가자:** ${state.speakers.join(", ")}\n**현재 차례:** ${state.current_speaker}\n**응답 수:** ${state.log.length}${state.degradation ? `\n\n**환경 상태:**\n${formatDegradationReport(state.degradation)}` : ""}`,
      }],
    };
  }
);

server.tool(
  "deliberation_context",
  "현재 프로젝트의 컨텍스트(md 파일들)를 로드합니다. CWD + Obsidian 자동 감지.",
  {},
  async () => {
    const dirs = detectContextDirs();
    const context = readContextFromDirs(dirs);
    return {
      content: [{
        type: "text",
        text: `## 프로젝트 컨텍스트 (${getProjectSlug()})\n\n**소스:** ${dirs.join(", ")}\n\n${context}`,
      }],
    };
  }
);

server.tool(
  "deliberation_browser_llm_tabs",
  "현재 브라우저에서 열려 있는 LLM 탭(chatgpt/claude/gemini 등)을 조회합니다.",
  {},
  async () => {
    const { tabs, note } = await collectBrowserLlmTabs();
    if (tabs.length === 0) {
      const suffix = note ? `\n\n${note}` : "";
      return { content: [{ type: "text", text: `감지된 LLM 탭이 없습니다.${suffix}` }] };
    }

    const lines = tabs.map((t, i) => `${i + 1}. [${t.browser}] ${t.title}\n   ${t.url}`).join("\n");
    const noteLine = note ? `\n\nℹ️ ${note}` : "";
    return { content: [{ type: "text", text: `## Browser LLM Tabs\n\n${lines}${noteLine}\n\n${PRODUCT_DISCLAIMER}` }] };
  }
);

server.tool(
  "deliberation_route_turn",
  "현재 턴의 speaker에 맞는 transport를 자동 결정하고 안내합니다. CLI speaker는 자동 응답 경로, 브라우저 speaker는 클립보드 경로로 라우팅합니다.",
  {
    session_id: z.string().optional().describe("세션 ID (여러 세션 진행 중이면 필수)"),
    auto_prepare_clipboard: z.boolean().default(true).describe("브라우저 speaker일 때 자동으로 클립보드 prepare 실행"),
    prompt: z.string().optional().describe("브라우저 LLM에 추가로 전달할 지시"),
    include_history_entries: z.number().int().min(0).max(12).default(4).describe("프롬프트에 포함할 최근 로그 개수"),
  },
  safeToolHandler("deliberation_route_turn", async ({ session_id, auto_prepare_clipboard, prompt, include_history_entries }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: "활성 deliberation이 없습니다." }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state || state.status !== "active") {
      return { content: [{ type: "text", text: `세션 "${resolved}"이 활성 상태가 아닙니다.` }] };
    }

    const speaker = state.current_speaker;
    const { transport, profile, reason } = resolveTransportForSpeaker(state, speaker);
    const guidance = formatTransportGuidance(transport, state, speaker);
    const turnId = state.pending_turn_id || null;

    let extra = "";

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
        const turnPrompt = buildClipboardTurnPrompt(state, turnSpeaker, prompt, include_history_entries);

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
          const routeModelInfo = modelSelection.model !== 'default' ? ` | 모델: ${modelSelection.model}` : "";
          extra = `\n\n⚡ 자동 실행 완료! 브라우저 LLM 응답이 자동으로 제출되었습니다. (${waitResult.data.elapsedMs}ms${routeModelInfo})`;
        } else {
          throw new Error(waitResult.error?.message || "no response received");
        }
      } catch (autoErr) {
        const errMsg = autoErr instanceof Error ? autoErr.message : String(autoErr);
        extra = `\n\n⚠️ 자동 실행 실패 (${errMsg}). Chrome을 --remote-debugging-port=9222로 재시작하세요.`;
      }
    }

    const profileInfo = profile
      ? `\n**프로필:** ${profile.type}${profile.url ? ` | ${profile.url}` : ""}${profile.command ? ` | command: ${profile.command}` : ""}`
      : "";

    return {
      content: [{
        type: "text",
        text: `## 턴 라우팅 — ${state.id}\n\n**현재 speaker:** ${speaker}\n**Transport:** ${transport}${reason ? ` (fallback: ${reason})` : ""}${profileInfo}\n**역할:** ${(state.speaker_roles || {})[speaker] || "free"}\n**Turn ID:** ${turnId || "(없음)"}\n**라운드:** ${state.current_round}/${state.max_rounds}\n**발언 순서:** ${state.ordering_strategy || "cyclic"}\n\n${guidance}${extra}\n\n${PRODUCT_DISCLAIMER}`,
      }],
    };
  })
);

server.tool(
  "deliberation_browser_auto_turn",
  "브라우저 LLM에 자동으로 턴을 전송하고 응답을 수집합니다 (CDP 기반).",
  {
    session_id: z.string().optional().describe("세션 ID (여러 세션 진행 중이면 필수)"),
    provider: z.string().optional().default("chatgpt").describe("LLM 프로바이더 (chatgpt, claude, gemini)"),
    timeout_sec: z.number().optional().default(45).describe("응답 대기 타임아웃 (초)"),
  },
  safeToolHandler("deliberation_browser_auto_turn", async ({ session_id, provider, timeout_sec }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: "활성 deliberation이 없습니다." }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state || state.status !== "active") {
      return { content: [{ type: "text", text: `세션 "${resolved}"이 활성 상태가 아닙니다.` }] };
    }

    const speaker = state.current_speaker;
    if (speaker === "none") {
      return { content: [{ type: "text", text: "현재 발언 차례인 speaker가 없습니다." }] };
    }

    const { transport } = resolveTransportForSpeaker(state, speaker);
    if (transport !== "browser_auto" && transport !== "clipboard") {
      return { content: [{ type: "text", text: `speaker "${speaker}"는 브라우저 타입이 아닙니다 (transport: ${transport}). CLI speaker는 deliberation_respond를 사용하세요.` }] };
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
      return { content: [{ type: "text", text: `❌ 브라우저 탭 바인딩 실패: ${attachResult.error.message}\n\n**에러 코드:** ${attachResult.error.code}\n**도메인:** ${attachResult.error.domain}\n\nCDP 디버깅 포트가 활성화된 브라우저가 실행 중인지 확인하세요.\n\`google-chrome --remote-debugging-port=9222\`\n\n${PRODUCT_DISCLAIMER}` }] };
    }

    // Step 1.2: Login detection — check if user is logged in to the web LLM
    const loginCheck = await port.checkLogin(resolved);
    if (loginCheck && !loginCheck.loggedIn) {
      await port.detach(resolved);
      return { content: [{ type: "text", text: `⚠️ **${speaker} 로그인 필요** — 웹 LLM에 로그인되어 있지 않습니다.\n\n**감지된 상태:** ${loginCheck.reason}\n**URL:** ${loginCheck.url || 'N/A'}\n\n이 speaker는 건너뜁니다. 브라우저에서 해당 LLM에 로그인한 후 다시 시도하세요.\n\n⛔ **API 호출로 대체하지 마세요.** 로그인되지 않은 speaker는 건너뛰는 것이 올바른 동작입니다.` }] };
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
        content: `[browser_auto 실패 — fallback] ${sendResult.error.message}`,
        turn_id: turnId,
        channel_used: "browser_auto_fallback",
        fallback_reason: sendResult.error.code,
      });
    }

    // Step 4: Wait for response
    const waitResult = await port.waitTurnResult(resolved, turnId, timeout_sec);
    if (!waitResult.ok) {
      return { content: [{ type: "text", text: `⏱️ 브라우저 LLM 응답 대기 타임아웃 (${timeout_sec}초)\n\n**에러:** ${waitResult.error.message}\n\n자동 실행이 타임아웃되었습니다. Chrome이 --remote-debugging-port=9222로 실행 중인지 확인하세요.\n\n${PRODUCT_DISCLAIMER}` }] };
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
      ? `\n**모델:** ${modelSelection.model} (${modelSelection.reason})\n**분석:** category=${modelSelection.category}, complexity=${modelSelection.complexity}`
      : "";

    return {
      content: [{
        type: "text",
        text: `✅ 브라우저 자동 턴 완료!\n\n**Provider:** ${effectiveProvider}\n**Turn ID:** ${turnId}${modelInfo}\n**응답 길이:** ${response.length}자\n**소요 시간:** ${waitResult.data.elapsedMs}ms${degradationInfo}\n\n${result.content[0].text}`,
      }],
    };
  })
);

server.tool(
  "deliberation_respond",
  "현재 턴의 응답을 제출합니다.",
  {
    session_id: z.string().optional().describe("세션 ID (여러 세션 진행 중이면 필수)"),
    speaker: z.string().trim().min(1).max(64).describe("응답자 이름"),
    content: z.string().optional().describe("응답 내용 (마크다운). content 또는 content_file 중 하나 필수."),
    content_file: z.string().optional().describe("응답 내용이 담긴 파일 경로. JSON 이스케이프 문제 회피용. 파일 내용이 그대로 content로 사용됩니다."),
    turn_id: z.string().optional().describe("턴 검증 ID (deliberation_route_turn에서 받은 값)"),
  },
  safeToolHandler("deliberation_respond", async ({ session_id, speaker, content, content_file, turn_id }) => {
    // Support reading content from file to avoid JSON escaping issues
    let finalContent = content;
    if (content_file && !content) {
      try {
        finalContent = fs.readFileSync(content_file, "utf-8").trim();
      } catch (e) {
        return { content: [{ type: "text", text: `❌ content_file 읽기 실패: ${e.message}` }] };
      }
    }
    if (!finalContent) {
      return { content: [{ type: "text", text: "❌ content 또는 content_file 중 하나를 제공해야 합니다." }] };
    }
    return submitDeliberationTurn({ session_id, speaker, content: finalContent, turn_id, channel_used: "cli_respond" });
  })
);

server.tool(
  "deliberation_history",
  "토론 기록을 반환합니다.",
  {
    session_id: z.string().optional().describe("세션 ID (여러 세션 진행 중이면 필수)"),
  },
  async ({ session_id }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: "활성 deliberation이 없습니다." }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    const state = loadSession(resolved);
    if (!state) {
      return { content: [{ type: "text", text: `세션 "${resolved}"을 찾을 수 없습니다.` }] };
    }

    if (state.log.length === 0) {
      return {
        content: [{
          type: "text",
          text: `**세션:** ${state.id}\n**주제:** ${state.topic}\n\n아직 응답이 없습니다. **${state.current_speaker}**가 먼저 응답하세요.`,
        }],
      };
    }

    let history = `**세션:** ${state.id}\n**주제:** ${state.topic} | **상태:** ${state.status}\n\n`;
    for (const e of state.log) {
      history += `### ${e.speaker} — Round ${e.round}\n\n${e.content}\n\n---\n\n`;
    }
    return { content: [{ type: "text", text: history }] };
  }
);

server.tool(
  "deliberation_synthesize",
  "토론을 종료하고 합성 보고서를 제출합니다.",
  {
    session_id: z.string().optional().describe("세션 ID (여러 세션 진행 중이면 필수)"),
    synthesis: z.string().describe("합성 보고서 (마크다운)"),
  },
  safeToolHandler("deliberation_synthesize", async ({ session_id, synthesis }) => {
    const resolved = resolveSessionId(session_id);
    if (!resolved) {
      return { content: [{ type: "text", text: "활성 deliberation이 없습니다." }] };
    }
    if (resolved === "MULTIPLE") {
      return { content: [{ type: "text", text: multipleSessionsError() }] };
    }

    let state = null;
    let archivePath = null;
    const lockedResult = withSessionLock(resolved, () => {
      const loaded = loadSession(resolved);
      if (!loaded) {
        return { content: [{ type: "text", text: `세션 "${resolved}"을 찾을 수 없습니다.` }] };
      }

      loaded.synthesis = synthesis;
      loaded.status = "completed";
      loaded.current_speaker = "none";
      saveSession(loaded);
      archivePath = archiveState(loaded);
      cleanupSyncMarkdown(loaded);
      state = loaded;
      return null;
    });
    if (lockedResult) {
      return lockedResult;
    }

    // 토론 종료 즉시 모니터 터미널(물리 Terminal 포함) 강제 종료
    closeMonitorTerminal(state.id, getSessionWindowIds(state));

    return {
      content: [{
        type: "text",
        text: `✅ [${state.id}] Deliberation 완료!\n\n**프로젝트:** ${state.project}\n**주제:** ${state.topic}\n**라운드:** ${state.max_rounds}\n**응답:** ${state.log.length}건\n\n📁 ${archivePath}\n🖥️ 모니터 터미널이 즉시 강제 종료되었습니다.`,
      }],
    };
  })
);

server.tool(
  "deliberation_list",
  "과거 deliberation 아카이브 목록을 반환합니다.",
  {},
  async () => {
    ensureDirs();
    const archiveDir = getArchiveDir();
    if (!fs.existsSync(archiveDir)) {
      return { content: [{ type: "text", text: "과거 deliberation이 없습니다." }] };
    }

    const files = fs.readdirSync(archiveDir)
      .filter(f => f.startsWith("deliberation-") && f.endsWith(".md"))
      .sort().reverse();

    if (files.length === 0) {
      return { content: [{ type: "text", text: "과거 deliberation이 없습니다." }] };
    }

    const list = files.map((f, i) => `${i + 1}. ${f.replace(".md", "")}`).join("\n");
    return { content: [{ type: "text", text: `## 과거 Deliberation (${getProjectSlug()})\n\n${list}` }] };
  }
);

server.tool(
  "deliberation_reset",
  "deliberation을 초기화합니다. session_id 지정 시 해당 세션만, 미지정 시 전체 초기화.",
  {
    session_id: z.string().optional().describe("초기화할 세션 ID (미지정 시 전체 초기화)"),
  },
  safeToolHandler("deliberation_reset", async ({ session_id }) => {
    ensureDirs();
    const sessionsDir = getSessionsDir();

    if (session_id) {
      // 특정 세션만 초기화
      let toCloseIds = [];
      const result = withSessionLock(session_id, () => {
        const file = getSessionFile(session_id);
        if (!fs.existsSync(file)) {
          return { content: [{ type: "text", text: `세션 "${session_id}"을 찾을 수 없습니다.` }] };
        }
        const state = loadSession(session_id);
        if (state && state.log.length > 0) {
          archiveState(state);
        }
        if (state) cleanupSyncMarkdown(state);
        toCloseIds = getSessionWindowIds(state);
        fs.unlinkSync(file);
        return { content: [{ type: "text", text: `✅ 세션 "${session_id}" 초기화 완료. 🖥️ 모니터 터미널 닫힘.` }] };
      });
      if (toCloseIds.length > 0) {
        closeMonitorTerminal(session_id, toCloseIds);
      }
      return result;
    }

    // 전체 초기화
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
      return { content: [{ type: "text", text: "초기화할 세션이 없습니다." }] };
    }

    for (const windowId of resetResult.terminalWindowIds) {
      closePhysicalTerminal(windowId);
    }
    closeAllMonitorTerminals();

    return {
      content: [{
        type: "text",
        text: `✅ 전체 초기화 완료. ${resetResult.files.length}개 세션 삭제, ${resetResult.archived}개 아카이브됨. 🖥️ 모든 모니터 터미널 닫힘.`,
      }],
    };
  })
);

server.tool(
  "deliberation_cli_config",
  "딜리버레이션 참가자 CLI 설정을 조회하거나 변경합니다. enabled_clis를 지정하면 저장합니다.",
  {
    enabled_clis: z.array(z.string()).optional().describe("활성화할 CLI 목록 (예: [\"claude\", \"codex\", \"gemini\"]). 미지정 시 현재 설정 조회"),
    require_speaker_selection: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" : v),
      z.boolean().optional()
    ).describe("true: 매번 사용자가 스피커 선택 후 시작, false: 감지된 스피커 전체 자동 참여"),
    default_rounds: z.coerce.number().int().min(1).max(10).optional()
      .describe("기본 라운드 수 (1-10, 기본 3)"),
    default_ordering: z.enum(["auto", "cyclic", "random", "weighted-random"]).optional()
      .describe("기본 발언 순서 전략: auto(스피커 수에 따라 자동), cyclic, random, weighted-random"),
  },
  safeToolHandler("deliberation_cli_config", async ({ enabled_clis, require_speaker_selection, default_rounds, default_ordering }) => {
    const config = loadDeliberationConfig();

    // Handle setup config updates
    let configChanged = false;
    if (require_speaker_selection !== undefined && require_speaker_selection !== null) {
      config.require_speaker_selection = require_speaker_selection;
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
          text: `## Deliberation CLI 설정\n\n**모드:** ${mode}\n**스피커 선택:** ${config.require_speaker_selection === false ? "자동 (감지된 스피커 전체 참여)" : "수동 (사용자가 직접 선택)"}\n**기본 라운드:** ${config.default_rounds || 3}\n**발언 순서:** ${config.default_ordering || "auto"}\n**설정된 CLI:** ${configured.length > 0 ? configured.join(", ") : "(없음 — 전체 자동 감지)"}\n**현재 감지된 CLI:** ${detected.join(", ") || "(없음)"}\n**지원 CLI 전체:** ${DEFAULT_CLI_CANDIDATES.join(", ")}\n\n변경하려면:\n\`deliberation_cli_config(require_speaker_selection: false, default_rounds: 3, default_ordering: "auto")\`\n\n전체 자동 감지로 되돌리려면:\n\`deliberation_cli_config(enabled_clis: [])\``,
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
          text: `✅ CLI 설정 초기화 완료. 전체 자동 감지 모드로 전환되었습니다.\n감지 대상: ${DEFAULT_CLI_CANDIDATES.join(", ")}`,
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

    let result = `✅ CLI 설정 저장 완료!\n\n**활성화된 CLI:** ${valid.join(", ")}`;
    if (installed.length > 0) result += `\n**설치 확인됨:** ${installed.join(", ")}`;
    if (notInstalled.length > 0) result += `\n**⚠️ 미설치:** ${notInstalled.join(", ")} (PATH에서 찾을 수 없음)`;

    return { content: [{ type: "text", text: result }] };
  })
);

// ── Request Review (auto-review) ───────────────────────────────

function invokeCliReviewer(command, prompt, timeoutMs) {
  const args = ["-p", prompt, "--no-input"];
  try {
    const result = execFileSync(command, args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, response: result.trim() };
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
  "코드 리뷰를 요청합니다. 여러 CLI 리뷰어에게 동시에 리뷰를 요청하고 결과를 종합합니다.",
  {
    context: z.string().describe("리뷰할 변경사항 설명 (코드, diff, 설계 등)"),
    question: z.string().describe("리뷰 질문 (예: 'Is this error handling sufficient?')"),
    reviewers: z.array(z.string().trim().min(1).max(64)).min(1).describe("리뷰어 CLI 목록 (예: [\"claude\", \"codex\"])"),
    mode: z.enum(["sync", "async"]).default("sync").describe("sync: 결과 대기 후 반환, async: session_id 즉시 반환"),
    deadline_ms: z.number().int().min(5000).max(600000).default(60000).describe("전체 타임아웃 (밀리초, 기본 60초)"),
    min_reviews: z.number().int().min(1).default(1).describe("최소 필요 리뷰 수 (기본 1)"),
    on_timeout: z.enum(["partial", "fail"]).default("partial").describe("타임아웃 시 동작: partial=부분 결과 반환, fail=에러"),
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
          text: `❌ 유효한 리뷰어가 없습니다. PATH에서 찾을 수 없는 CLI: ${invalidReviewers.join(", ")}\n\n사용 가능한 CLI를 확인하려면 deliberation_speaker_candidates를 호출하세요.`,
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
        ? `\n⚠️ PATH에서 찾을 수 없는 리뷰어 (제외됨): ${invalidReviewers.join(", ")}`
        : "";
      return {
        content: [{
          type: "text",
          text: `✅ 비동기 리뷰 세션 생성됨\n\n**Session ID:** ${sessionId}\n**리뷰어:** ${validReviewers.join(", ")}\n**모드:** async${warn}\n\n진행 상태는 \`deliberation_status(session_id: "${sessionId}")\`로 확인하세요.`,
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
            text: `❌ 리뷰 실패: 최소 ${min_reviews}개 리뷰 필요, ${completedReviews.length}개만 완료\n\n**Session:** ${sessionId}\n**완료:** ${completedReviews.map(r => r.reviewer).join(", ") || "(없음)"}\n**타임아웃:** ${timedOutReviewers.join(", ") || "(없음)"}\n**실패:** ${failedReviewers.map(r => `${r.reviewer}: ${r.error}`).join(", ") || "(없음)"}`,
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
      ? `\n**제외된 리뷰어 (미설치):** ${invalidReviewers.join(", ")}`
      : "";
    const timeoutInfo = timedOutReviewers.length > 0
      ? `\n**타임아웃 리뷰어:** ${timedOutReviewers.join(", ")}`
      : "";
    const failInfo = failedReviewers.length > 0
      ? `\n**실패 리뷰어:** ${failedReviewers.map(r => `${r.reviewer}: ${r.error}`).join(", ")}`
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
        text: `## Review 완료\n\n**Session:** ${sessionId}\n**Coverage:** ${coverage}\n**소요 시간:** ${totalMs}ms\n**완료 리뷰어:** ${completedReviews.map(r => r.reviewer).join(", ") || "(없음)"}${timeoutInfo}${failInfo}${warn}\n\n${synthesis}\n\n---\n\n\`\`\`json\n${JSON.stringify(resultPayload, null, 2)}\n\`\`\``,
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
  await server.connect(transport);
}

// ── Test exports (used by vitest) ──
export { selectNextSpeaker, loadRolePrompt, inferSuggestedRole, parseVotes, ROLE_KEYWORDS, loadRolePresets, applyRolePreset, detectDegradationLevels, formatDegradationReport, DEGRADATION_TIERS };
