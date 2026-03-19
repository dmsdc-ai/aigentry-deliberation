/**
 * Speaker/Candidate Discovery domain — speaker detection, role inference,
 * browser LLM tab scanning, CDP probing, transport routing, and candidate
 * report formatting.
 *
 * Extracted from index.js to keep the main entry point focused on MCP tool
 * registration while this module owns all speaker discovery logic.
 */

import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import {
  TELEPTY_DEFAULT_HOST,
  TELEPTY_TRANSPORT_TIMEOUT_MS,
  TELEPTY_SEMANTIC_TIMEOUT_MS,
  collectTeleptySessions,
  collectTeleptyProcessLocators,
  formatTeleptyHostLabel,
} from "./telepty.js";
import { getModelSelectionForTurn } from "../model-router.js";

// ── Dependency injection ────────────────────────────────────────
// Functions that live in index.js but are needed here.  Injected once
// via `initSpeakerDeps()` so we avoid circular imports.

let _deps = {
  appendRuntimeLog: () => {},
  loadDeliberationConfig: () => ({}),
  getProjectSlug: () => path.basename(process.cwd()),
  readJsonFileSafe: () => null,
  writeJsonFileAtomic: () => {},
  getSpeakerSelectionFile: () => "",
};

export function initSpeakerDeps(deps) {
  Object.assign(_deps, deps);
}

// ── Module-level __dirname for ESM ──────────────────────────────
const __dirnameEsm = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
// selectors live one level up from lib/
const __projectRoot = path.dirname(__dirnameEsm);

// ── Constants ───────────────────────────────────────────────────

export const DEFAULT_SPEAKERS = ["agent-a", "agent-b"];

export const DEFAULT_CLI_CANDIDATES = [
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

export const MAX_AUTO_DISCOVERED_SPEAKERS = 12;

export const DEFAULT_BROWSER_APPS = ["Google Chrome", "Brave Browser", "Arc", "Microsoft Edge", "Safari"];

export const DEFAULT_LLM_DOMAINS = [
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
export const DEFAULT_WEB_SPEAKERS = [
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

export const SPEAKER_SELECTION_FILE = "speaker-selection.json";
export const SPEAKER_SELECTION_TTL_MS = 10 * 60 * 1000;

// CLI-specific invocation flags for non-interactive execution
export const CLI_INVOCATION_HINTS = {
  claude: { cmd: "claude", flags: '-p --output-format text', example: 'CLAUDECODE= claude -p --output-format text "prompt"', envPrefix: 'CLAUDECODE=', modelFlag: '--model', defaultModel: null, provider: 'claude' },
  codex: { cmd: "codex", flags: 'exec -', example: 'echo "prompt" | codex exec -', stdinMode: true, modelFlag: '-m', defaultModel: 'gpt-5.4', provider: 'chatgpt' },
  gemini: { cmd: "gemini", flags: '', example: 'gemini "prompt"', modelFlag: '-m', defaultModel: null, provider: 'gemini' },
  aider: { cmd: "aider", flags: '--message', example: 'aider --message "prompt"', modelFlag: '--model', provider: 'chatgpt' },
  cursor: { cmd: "cursor", flags: '', example: 'cursor "prompt"', modelFlag: null, provider: 'chatgpt' },
};

export const ROLE_KEYWORDS = {
  critic: /문제|위험|실패|약점|리스크|반대|비판|결함|취약/,
  implementer: /구현|코드|방법|설계|빌드|개발|함수|모듈|파일/,
  mediator: /합의|정리|결론|종합|요약|중재|절충|균형/,
  researcher: /사례|데이터|연구|벤치마크|비교|논문|참고/,
};

export const ROLE_HEADING_MARKERS = {
  critic: /^##?\s*(Critic|비판|약점|심각도|위험\s*분석|검증|평가|Review)/m,
  implementer: /^##?\s*(코드\s*스케치|구현|Implementation|제안\s*코드)/m,
  mediator: /^##?\s*(합의|종합|중재|Consensus|Mediation)/m,
  researcher: /^##?\s*(조사\s*결과|비교\s*분석|Research|사례\s*연구|근거|데이터|Data)/m,
};

export const DEGRADATION_TIERS = {
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

export const TRANSPORT_TYPES = {
  cli: "cli_respond",
  telepty: "telepty_bus",
  browser: "clipboard",
  browser_auto: "browser_auto",
  manual: "manual",
};

// ── Module-level caches ─────────────────────────────────────────

let _extensionProviderRegistry = null;
let _rolePresetsCache = null;

// ── Utility functions ───────────────────────────────────────────

export function commandExistsInPath(command) {
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

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// ── Speaker normalization ───────────────────────────────────────

export function normalizeSpeaker(raw) {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === "none") return null;
  return normalized;
}

export function dedupeSpeakers(items = []) {
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

// ── Speaker ordering & roles ────────────────────────────────────

export function selectNextSpeaker(session) {
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

export function loadRolePrompt(role) {
  if (!role || role === "free") return "";
  try {
    const promptPath = path.join(__projectRoot, "selectors", "roles", `${role}.md`);
    return fs.readFileSync(promptPath, "utf-8").trim();
  } catch {
    return "";
  }
}

export function inferSuggestedRole(text) {
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

export function parseVotes(text) {
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

export function loadRolePresets() {
  if (_rolePresetsCache) return _rolePresetsCache;
  try {
    const presetsPath = path.join(__projectRoot, "selectors", "role-presets.json");
    _rolePresetsCache = JSON.parse(fs.readFileSync(presetsPath, "utf-8"));
    return _rolePresetsCache;
  } catch {
    _rolePresetsCache = { presets: {} };
    return _rolePresetsCache;
  }
}

export function applyRolePreset(preset, speakers) {
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

// ── Extension provider registry ─────────────────────────────────

export function loadExtensionProviderRegistry() {
  if (_extensionProviderRegistry) return _extensionProviderRegistry;
  try {
    const registryPath = path.join(__projectRoot, "selectors", "extension-providers.json");
    _extensionProviderRegistry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    return _extensionProviderRegistry;
  } catch (err) {
    console.error("Failed to load extension-providers.json:", err.message);
    _extensionProviderRegistry = { providers: [] };
    return _extensionProviderRegistry;
  }
}

export function isExtensionLlmTab(url = "", title = "") {
  if (!String(url).startsWith("chrome-extension://")) return false;
  const registry = loadExtensionProviderRegistry();
  const lowerTitle = String(title || "").toLowerCase();
  if (!lowerTitle) return false;
  return registry.providers.some(p =>
    p.titlePatterns.some(pattern => lowerTitle.includes(pattern.toLowerCase()))
  );
}

// ── Speaker selection tokens ────────────────────────────────────

export function createSelectionToken() {
  return `sel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function issueSpeakerSelectionToken({ candidates, include_browser }) {
  const selectionState = {
    token: createSelectionToken(),
    phase: "candidates",
    created_at: new Date().toISOString(),
    include_browser: !!include_browser,
    candidate_speakers: dedupeSpeakers((candidates || []).map(c => typeof c === "string" ? c : c?.speaker)),
  };
  _deps.writeJsonFileAtomic(_deps.getSpeakerSelectionFile(), selectionState);
  return selectionState;
}

export function loadSpeakerSelectionToken() {
  return _deps.readJsonFileSafe(_deps.getSpeakerSelectionFile());
}

export function clearSpeakerSelectionToken() {
  try {
    fs.unlinkSync(_deps.getSpeakerSelectionFile());
  } catch {
    // ignore missing file
  }
}

export function validateSpeakerSelectionSnapshot({ selectionState, selection_token, speakers, includeBrowserSpeakers, nowMs = Date.now() }) {
  if (!selection_token) {
    return { ok: false, code: "missing_token" };
  }
  if (!selectionState?.token) {
    return { ok: false, code: "missing_selection_state" };
  }
  if (selectionState.token !== selection_token) {
    return { ok: false, code: "token_mismatch" };
  }

  const createdAtMs = Date.parse(selectionState.created_at || "");
  if (!Number.isFinite(createdAtMs) || (nowMs - createdAtMs) > SPEAKER_SELECTION_TTL_MS) {
    return { ok: false, code: "expired_token" };
  }

  if (!!selectionState.include_browser !== !!includeBrowserSpeakers) {
    return { ok: false, code: "mode_mismatch" };
  }

  const availableSpeakers = new Set(dedupeSpeakers(selectionState.candidate_speakers || []));
  const requestedSpeakers = dedupeSpeakers(speakers || []);
  const missingSpeakers = requestedSpeakers.filter(speaker => !availableSpeakers.has(speaker));
  if (missingSpeakers.length > 0) {
    return { ok: false, code: "speaker_mismatch", missing_speakers: missingSpeakers };
  }

  return { ok: true };
}

export function confirmSpeakerSelectionToken({ selectionState, selection_token, speakers, includeBrowserSpeakers, nowMs = Date.now(), persist = true }) {
  const snapshotValidation = validateSpeakerSelectionSnapshot({
    selectionState,
    selection_token,
    speakers,
    includeBrowserSpeakers,
    nowMs,
  });
  if (!snapshotValidation.ok) {
    return snapshotValidation;
  }

  const confirmedSelection = {
    token: createSelectionToken(),
    phase: "confirmed",
    created_at: new Date(nowMs).toISOString(),
    include_browser: !!includeBrowserSpeakers,
    candidate_speakers: dedupeSpeakers(selectionState.candidate_speakers || []),
    selected_speakers: dedupeSpeakers(speakers || []),
  };
  if (persist) {
    _deps.writeJsonFileAtomic(_deps.getSpeakerSelectionFile(), confirmedSelection);
  }
  return { ok: true, selectionState: confirmedSelection };
}

export function validateSpeakerSelectionRequest({ selectionState, selection_token, speakers, includeBrowserSpeakers, nowMs = Date.now() }) {
  const snapshotValidation = validateSpeakerSelectionSnapshot({
    selectionState,
    selection_token,
    speakers,
    includeBrowserSpeakers,
    nowMs,
  });
  if (!snapshotValidation.ok) {
    return snapshotValidation;
  }

  if (selectionState.phase !== "confirmed" || !Array.isArray(selectionState.selected_speakers)) {
    return { ok: false, code: "selection_not_confirmed" };
  }

  const expectedSpeakers = dedupeSpeakers(selectionState.selected_speakers || []);
  const requestedSpeakers = dedupeSpeakers(speakers || []);
  if (
    expectedSpeakers.length !== requestedSpeakers.length
    || expectedSpeakers.some(speaker => !requestedSpeakers.includes(speaker))
  ) {
    return {
      ok: false,
      code: "selected_speakers_mismatch",
      expected_speakers: expectedSpeakers,
      requested_speakers: requestedSpeakers,
    };
  }

  return { ok: true };
}

// ── Browser participant helpers ─────────────────────────────────

export function hasExplicitBrowserParticipantSelection({ speakers, participant_types } = {}) {
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

export function resolveIncludeBrowserSpeakers({ include_browser_speakers, config, speakers, participant_types } = {}) {
  if (include_browser_speakers !== undefined && include_browser_speakers !== null) {
    return include_browser_speakers;
  }
  if (config?.include_browser_speakers !== undefined && config?.include_browser_speakers !== null) {
    return config.include_browser_speakers;
  }
  return false;
}

// ── CLI discovery ───────────────────────────────────────────────

export function resolveCliCandidates() {
  const fromEnv = (process.env.DELIBERATION_CLI_CANDIDATES || "")
    .split(/[,\s]+/)
    .map(v => v.trim())
    .filter(Boolean);

  // If config has enabled_clis, use that as the primary filter
  const config = _deps.loadDeliberationConfig();
  if (Array.isArray(config.enabled_clis) && config.enabled_clis.length > 0) {
    return dedupeSpeakers([...fromEnv, ...config.enabled_clis]);
  }

  return dedupeSpeakers([...fromEnv, ...DEFAULT_CLI_CANDIDATES]);
}

export function checkCliLiveness(command) {
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

export function discoverLocalCliSpeakers() {
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

export function detectCallerSpeaker() {
  const hinted = normalizeSpeaker(process.env.DELIBERATION_CALLER_SPEAKER);
  if (hinted) return hinted;

  const envKeys = Object.keys(process.env).join(" ");
  const pathHint = process.env.PATH || "";

  // Codex detection
  if (/\bCODEX_[A-Z0-9_]+\b/.test(envKeys) || pathHint.includes("/.codex/")) {
    return "codex";
  }

  // Claude detection
  if (/\bCLAUDE_[A-Z0-9_]+\b/.test(envKeys) || pathHint.includes("/.claude/")) {
    return "claude";
  }

  // Gemini detection
  if (/\bGOOGLE_GENAI_[A-Z0-9_]+\b/.test(envKeys) || /\bGEMINI_[A-Z0-9_]+\b/.test(envKeys) || pathHint.includes("/.gemini/")) {
    return "gemini";
  }

  // Aider detection
  if (/\bAIDER_[A-Z0-9_]+\b/.test(envKeys) || pathHint.includes("/aider/")) {
    return "aider";
  }

  return null;
}

// ── URL / domain helpers ────────────────────────────────────────

export function isLlmUrl(url = "") {
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

export function dedupeBrowserTabs(tabs = []) {
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

export function parseInjectedBrowserTabsFromEnv() {
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

// ── CDP helpers ─────────────────────────────────────────────────

export function normalizeCdpEndpoint(raw) {
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

export function resolveCdpEndpoints() {
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

export async function fetchJson(url, timeoutMs = 900) {
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

export function inferBrowserFromCdpEndpoint(endpoint) {
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

export function summarizeFailures(items = [], max = 3) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const shown = items.slice(0, max);
  const suffix = items.length > max ? ` and ${items.length - max} more` : "";
  return `${shown.join(", ")}${suffix}`;
}

// ── Browser LLM tab collection ──────────────────────────────────

export async function collectBrowserLlmTabsViaCdp() {
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

export async function ensureCdpAvailable() {
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
    const cdpConfig = _deps.loadDeliberationConfig();
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

export function collectBrowserLlmTabsViaAppleScript() {
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

export async function collectBrowserLlmTabs() {
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

// ── LLM provider inference ──────────────────────────────────────

export function inferLlmProvider(url = "", title = "") {
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

// ── Speaker candidate collection ────────────────────────────────

export async function collectSpeakerCandidates({ include_cli = true, include_browser = true } = {}) {
  const candidates = [];
  const seen = new Set();
  let browserNote = null;

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

    const { sessions: teleptySessions, note: teleptyNote } = await collectTeleptySessions();
    const locators = collectTeleptyProcessLocators(teleptySessions);
    for (const session of teleptySessions) {
      const locator = locators.get(session.id) || {};
      add({
        speaker: session.id,
        type: "telepty",
        label: session.id,
        telepty_session_id: session.id,
        telepty_host: session.host || TELEPTY_DEFAULT_HOST,
        command: session.command || "wrapped",
        cwd: session.cwd || null,
        active_clients: session.active_clients ?? null,
        runtime_pid: locator.pid ?? null,
        runtime_tty: locator.tty ?? null,
      });
    }
    if (teleptyNote) {
      browserNote = browserNote ? `${browserNote} | ${teleptyNote}` : teleptyNote;
    }
  }

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

// ── Speaker candidate report ────────────────────────────────────

export function formatSpeakerCandidatesReport({ candidates, browserNote }) {
  const cli = candidates.filter(c => c.type === "cli");
  const telepty = candidates.filter(c => c.type === "telepty");
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

  out += "### Telepty Sessions\n";
  if (telepty.length === 0) {
    out += "- (No active telepty sessions)\n\n";
  } else {
    out += `${telepty.map(c => {
      const parts = [
        `command: ${c.command || "wrapped"}`,
        c.telepty_host ? `host: ${formatTeleptyHostLabel(c.telepty_host)}` : null,
        Number.isFinite(c.runtime_pid) ? `pid: ${c.runtime_pid}` : null,
        c.runtime_tty ? `tty: ${c.runtime_tty}` : null,
      ].filter(Boolean).join(", ");
      const cwdLine = c.cwd ? `\n  cwd: ${c.cwd}` : "";
      return `- \`${c.speaker}\` (${parts})${cwdLine}`;
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

// ── Participant profile mapping ─────────────────────────────────

export function mapParticipantProfiles(speakers, candidates, typeOverrides) {
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

    if (candidate.type === "telepty") {
      profiles.push({
        speaker,
        type: "telepty",
        command: candidate.command || null,
        telepty_session_id: candidate.telepty_session_id || speaker,
        telepty_host: candidate.telepty_host || null,
        runtime_pid: Number.isFinite(candidate.runtime_pid) ? candidate.runtime_pid : null,
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

// ── Speaker ordering ────────────────────────────────────────────

export function buildSpeakerOrder(speakers, fallbackSpeaker = DEFAULT_SPEAKERS[0], fallbackPlacement = "front") {
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

export function normalizeSessionActors(state) {
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

// ── Transport routing ───────────────────────────────────────────

export function resolveTransportForSpeaker(state, speaker) {
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

export function formatTransportGuidance(transport, state, speaker) {
  const sid = state.id;
  const profile = (state.participant_profiles || []).find(
    p => normalizeSpeaker(p.speaker) === normalizeSpeaker(speaker)
  ) || null;
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
    case "telepty_bus":
      return `Telepty session speaker. This turn will be published on the telepty bus as a structured \`turn_request\` envelope for the target session to consume.\n\n` +
             `📡 **Bus delivery**: deliberation publishes a typed envelope instead of relying on raw PTY inject.\n` +
             `⏱️ **Timeouts**: transport ack waits ${TELEPTY_TRANSPORT_TIMEOUT_MS / 1000}s, semantic self-submit waits ${TELEPTY_SEMANTIC_TIMEOUT_MS / 1000}s.\n` +
             `⛔ **No proxy response**: the remote telepty session must answer for itself via \`deliberation_respond(...)\`.`;
    case "manual":
    default:
      if (profile?.type === "telepty" && profile.telepty_session_id) {
        const hostSuffix = profile.telepty_host && !["127.0.0.1", "localhost"].includes(profile.telepty_host)
          ? `@${profile.telepty_host}`
          : "";
        const pidNote = Number.isFinite(profile.runtime_pid) ? ` (pid ${profile.runtime_pid})` : "";
        return `Telepty-managed session speaker${pidNote}. Send the [turn_prompt] below to \`telepty inject ${profile.telepty_session_id}${hostSuffix} "<prompt>"\`, then have that remote session self-submit via \`deliberation_respond(session_id: "${sid}", speaker: "${speaker}", content: "...")\`.\n\n` +
               `📋 **Recommended path**: inject the prompt into the telepty session and let the remote session answer for itself.\n` +
               `⛔ **No proxy response**: Do not answer on behalf of this speaker from the orchestrator.`;
      }
      return `Manual speaker. Get a response from the LLM's **web UI or CLI tool** and submit via \`deliberation_respond(session_id: "${sid}", speaker: "${speaker}", content: "...")\`.\n\n` +
             `📋 **Copy the [turn_prompt] section below** to the web UI.\n` +
             `🖼️ **To include an image:** Copy the image to your clipboard and use \`include_clipboard_image: true\` in \`deliberation_respond\`.\n\n` +
             `⛔ **Absolutely no API calls**: Calling LLM APIs directly via REST API, HTTP requests (urllib, requests, fetch, etc.) is forbidden. Only use web browser UI or CLI tools. Direct API key calls will result in deliberation participation being rejected.`;
  }
}

// ── Degradation detection ───────────────────────────────────────

export async function detectDegradationLevels() {
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

export function formatDegradationReport(levels) {
  const lines = [];
  for (const [feature, info] of Object.entries(levels)) {
    const tierNum = parseInt(info.tier.replace("tier", ""));
    const indicator = tierNum === 1 ? "🟢" : tierNum === 2 ? "🟡" : "🔴";
    lines.push(`  ${indicator} **${feature}**: ${info.name} — ${info.description}`);
  }
  return lines.join("\n");
}
