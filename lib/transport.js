/**
 * Transport/Terminal domain — tmux terminal management, browser port singleton,
 * CLI/browser/telepty auto-turn execution, review helpers, and auto-handoff
 * orchestration.
 *
 * Extracted from index.js to keep the main entry point focused on MCP tool
 * registration while this module owns all transport execution logic.
 */

import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

// ── Direct imports from sibling modules ──────────────────────────
import {
  dispatchTeleptyTurnRequest,
  buildTeleptySynthesisEnvelope,
  notifyTeleptyBus,
  notifyTeleptySessionInject,
  callBrainIngest,
  buildExecutionContract,
  ensureTeleptyBusSubscriber,
  TELEPTY_TRANSPORT_TIMEOUT_MS,
  TELEPTY_SEMANTIC_TIMEOUT_MS,
} from "./telepty.js";
import {
  resolveTransportForSpeaker,
  normalizeSpeaker,
  checkCliLiveness,
  CLI_INVOCATION_HINTS,
  collectSpeakerCandidates,
  mapParticipantProfiles,
  buildSpeakerOrder,
  commandExistsInPath,
  shellQuote,
  detectCallerSpeaker,
} from "./speaker-discovery.js";
import {
  loadSession,
  saveSession,
  resolveSessionId,
  submitDeliberationTurn,
  buildClipboardTurnPrompt,
  archiveState,
  cleanupSyncMarkdown,
  ensureDirs,
  generateTurnId,
  formatRecentLogForPrompt,
  truncatePromptText,
  getPromptBudgetForSpeaker,
} from "./session.js";
import { OrchestratedBrowserPort } from "../browser-control-port.js";
import { getModelSelectionForTurn } from "../model-router.js";
import { t } from "../i18n.js";

// ── Dependency injection ────────────────────────────────────────
// Functions that live in index.js but are needed here.  Injected once
// via `initTransportDeps()` so we avoid circular imports.

let _deps = {
  appendRuntimeLog: () => {},
  getProjectSlug: () => path.basename(process.cwd()),
  getSessionFile: () => "",
  withSessionLock: (ref, fn) => fn(),
  loadDeliberationConfig: () => ({}),
  resolveCdpEndpoints: () => [],
};

export function initTransportDeps(deps) {
  Object.assign(_deps, deps);
}

// ── Constants ───────────────────────────────────────────────────

const HOME = os.homedir();
const IS_WIN = process.platform === "win32";
const INSTALL_DIR = IS_WIN
  ? path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "mcp-deliberation")
  : path.join(HOME, ".local", "lib", "mcp-deliberation");

export const TMUX_SESSION = "deliberation";
export const MONITOR_SCRIPT = path.join(INSTALL_DIR, "session-monitor.sh");
export const MONITOR_SCRIPT_WIN = path.join(INSTALL_DIR, "session-monitor-win.js");

// ── Terminal management (tmux, AppleScript terminal) ────────────

export function tmuxWindowName(sessionId) {
  return sessionId.replace(/[^a-zA-Z0-9가-힣-]/g, "").slice(0, 25);
}

export function appleScriptQuote(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function tryExecFile(command, args = []) {
  try {
    execFileSync(command, args, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function resolveMonitorShell() {
  if (commandExistsInPath("bash")) return "bash";
  if (commandExistsInPath("sh")) return "sh";
  return null;
}

export function buildMonitorCommand(sessionId, project) {
  const shell = resolveMonitorShell();
  if (!shell) return null;
  return `${shell} ${shellQuote(MONITOR_SCRIPT)} ${shellQuote(sessionId)} ${shellQuote(project)}`;
}

export function buildMonitorCommandWindows(sessionId, project) {
  return `node "${MONITOR_SCRIPT_WIN}" "${sessionId}" "${project}"`;
}

export function hasTmuxSession(name) {
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function hasTmuxWindow(sessionName, windowName) {
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

export function tmuxHasAttachedClients(sessionName) {
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

export function isTmuxWindowViewed(sessionName, windowName) {
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

export function tmuxWindowCount(name) {
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

export function buildTmuxAttachCommand(sessionId) {
  const winName = tmuxWindowName(sessionId);
  // Use grouped session (new-session -t) so each terminal has independent active window.
  // This prevents window-switching conflicts when multiple deliberations run concurrently.
  return `tmux new-session -t ${shellQuote(TMUX_SESSION)} \\; select-window -t ${shellQuote(`${TMUX_SESSION}:${winName}`)}`;
}

export function listPhysicalTerminalWindowIds() {
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

export function openPhysicalTerminal(sessionId) {
  const winName = tmuxWindowName(sessionId);
  // Use grouped session (new-session -t) for independent active window per client
  const attachCmd = `tmux new-session -t "${TMUX_SESSION}" \\; select-window -t "${TMUX_SESSION}:${winName}"`;

  // Prevent duplicate windows for the SAME session:
  // If a client is already viewing this specific window, just activate Terminal.app
  if (isTmuxWindowViewed(TMUX_SESSION, winName)) {
    _deps.appendRuntimeLog("INFO", `TMUX_WINDOW_ALREADY_VIEWED: ${winName}. Activating existing Terminal.`);
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

export function spawnMonitorTerminal(sessionId) {
  // Windows: use Windows Terminal or PowerShell directly (no tmux needed)
  if (process.platform === "win32") {
    const project = _deps.getProjectSlug();
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

  const project = _deps.getProjectSlug();
  const winName = tmuxWindowName(sessionId);
  const cmd = buildMonitorCommand(sessionId, project);
  if (!cmd) {
    return false;
  }

  try {
    if (hasTmuxSession(TMUX_SESSION)) {
      // Skip if a window with the same name already exists (prevents duplicates)
      if (hasTmuxWindow(TMUX_SESSION, winName)) {
        _deps.appendRuntimeLog("INFO", `TMUX_WINDOW_EXISTS: ${winName} in ${TMUX_SESSION}`);
        return true;
      }
      execFileSync("tmux", ["new-window", "-t", TMUX_SESSION, "-n", winName, cmd], {
        stdio: "ignore",
        windowsHide: true,
      });
      _deps.appendRuntimeLog("INFO", `TMUX_WINDOW_CREATED: ${winName} in existing ${TMUX_SESSION}`);
    } else {
      execFileSync("tmux", ["new-session", "-d", "-s", TMUX_SESSION, "-n", winName, cmd], {
        stdio: "ignore",
        windowsHide: true,
      });
      _deps.appendRuntimeLog("INFO", `TMUX_SESSION_CREATED: ${TMUX_SESSION} with window ${winName}`);
    }
    return true;
  } catch {
    return false;
  }
}

export function closePhysicalTerminal(windowId) {
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

export function closeMonitorTerminal(sessionId, terminalWindowIds = []) {
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

export function getSessionWindowIds(state) {
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

export function closeAllMonitorTerminals() {
  try {
    execFileSync("tmux", ["kill-session", "-t", TMUX_SESSION], { stdio: "ignore", windowsHide: true });
  } catch { /* ignore */ }
}

// ── BrowserControlPort singleton ────────────────────────────────

let _browserPort = null;
export function getBrowserPort() {
  if (!_browserPort) {
    const cdpEndpoints = _deps.resolveCdpEndpoints();
    _browserPort = new OrchestratedBrowserPort({ cdpEndpoints });
  }
  return _browserPort;
}

// ── CLI auto-turn helpers ───────────────────────────────────────

export function getCliAutoTurnTimeoutSec({ speaker, requestedTimeoutSec, promptLength, priorTurns }) {
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

export function getCliExecArgs(speaker, model) {
  const hint = CLI_INVOCATION_HINTS[speaker];
  switch (speaker) {
    case "claude": {
      const args = ["-p", "--output-format", "text"];
      // claude uses its own config for model selection; model flag not appended
      return args;
    }
    case "codex": {
      const args = [
        "exec",
        "--ephemeral",
        "-c", 'approval_policy="never"',
        "-c", 'sandbox_mode="read-only"',
        "-c", 'model_reasoning_effort="low"',
        "-",
      ];
      if (model && hint?.modelFlag) {
        // Insert model flag before the trailing "-" stdin marker
        args.splice(args.length - 1, 0, hint.modelFlag, model);
      }
      return args;
    }
    case "gemini":
      return null;
    default:
      return null;
  }
}

export function buildCliAutoTurnFailureText({ state, speaker, hint, err, effectiveTimeout, promptLength, priorTurns }) {
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

// ── Auto-turn execution core ────────────────────────────────────

/**
 * Run a single CLI auto-turn for the given session and speaker.
 * Returns { ok: true, response, elapsedMs } or { ok: false, error }.
 */
export async function runCliAutoTurnCore(sessionId, speaker, timeoutSec = 120) {
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

      const speakerHint = CLI_INVOCATION_HINTS[speaker];
      const speakerModel = speakerHint?.defaultModel ?? null;

      switch (speaker) {
        case "claude":
          child = spawn("claude", getCliExecArgs("claude", null), { env, windowsHide: true });
          child.stdin.write(turnPrompt);
          child.stdin.end();
          break;
        case "codex":
          child = spawn("codex", getCliExecArgs("codex", speakerModel), { env, windowsHide: true });
          child.stdin.write(turnPrompt);
          child.stdin.end();
          break;
        case "gemini": {
          const geminiArgs = speakerModel && speakerHint?.modelFlag
            ? [speakerHint.modelFlag, speakerModel, "-p", turnPrompt]
            : ["-p", turnPrompt];
          child = spawn("gemini", geminiArgs, { env, windowsHide: true });
          break;
        }
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

export async function runBrowserAutoTurnCore(sessionId, speaker, timeoutSec = 45) {
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

export async function runTeleptyBusAutoTurnCore(sessionId, speaker, includeHistoryEntries = 4) {
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

export async function runUntilBlockedCore(sessionId, {
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
      // Count how many remaining speakers can be auto-dispatched after the orchestrator responds
      const remainingAutoSpeakers = (state.speakers || []).filter(s => {
        if (normalizeSpeaker(s) === normalizeSpeaker(callerSpeaker)) return false;
        const { transport: t } = resolveTransportForSpeaker(state, s);
        return t === "cli_respond" || t === "browser_auto" || t === "telepty_bus";
      }).length;

      return {
        ok: true,
        status: "blocked",
        block_reason: "self_turn",
        speaker,
        transport,
        turn_prompt: buildClipboardTurnPrompt(state, speaker, null, includeHistoryEntries),
        remaining_auto_speakers: remainingAutoSpeakers,
        hint: remainingAutoSpeakers > 0
          ? "Respond with deliberation_respond, then call run_until_blocked again to auto-progress remaining speakers."
          : undefined,
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
export async function generateAutoSynthesis(sessionId) {
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

      const synthModel = hint?.defaultModel ?? null;

      switch (speaker) {
        case "claude":
          child = spawn("claude", getCliExecArgs("claude", null), { env, windowsHide: true });
          child.stdin.write(synthesisPrompt);
          child.stdin.end();
          break;
        case "codex":
          child = spawn("codex", getCliExecArgs("codex", synthModel), { env, windowsHide: true });
          child.stdin.write(synthesisPrompt);
          child.stdin.end();
          break;
        case "gemini": {
          const geminiArgs = synthModel && hint?.modelFlag
            ? [hint.modelFlag, synthModel, "-p", synthesisPrompt]
            : ["-p", synthesisPrompt];
          child = spawn("gemini", geminiArgs, { env, windowsHide: true });
          break;
        }
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
    _deps.appendRuntimeLog("ERROR", `AUTO_SYNTHESIS_FAILED: ${sessionId} | ${err.message}`);
    return null;
  }
}

/**
 * Orchestrate full auto-handoff: run all turns -> synthesize -> inbox -> telepty.
 * Called as fire-and-forget from deliberation_start when auto_execute or auto_synthesize is true.
 */
export async function runAutoHandoff(sessionId) {
  _deps.appendRuntimeLog("INFO", `AUTO_HANDOFF_START: ${sessionId}`);

  const retryConfig = { maxRetries: 2, retryDelayMs: 10000 };

  try {
    // Pre-flight: if every speaker matches the orchestrator's CLI identity, there is
    // no one to auto-dispatch. Halt Phase 1 and skip Phase 2 synthesis so the session
    // remains `active` and the orchestrator can provide turns manually.
    {
      const initialState = loadSession(sessionId);
      const callerId = detectCallerSpeaker();
      if (initialState && callerId && Array.isArray(initialState.speakers) && initialState.speakers.length > 0) {
        const normalizedCaller = normalizeSpeaker(callerId);
        const allSelf = initialState.speakers.every(s => normalizeSpeaker(s) === normalizedCaller);
        if (allSelf) {
          _deps.appendRuntimeLog("WARN", `AUTO_HANDOFF_ALL_SELF_TURN: ${sessionId} | all speakers match caller identity "${normalizedCaller}" | halting auto-dispatch; orchestrator must proceed manually`);
          return;
        }
      }
    }

    // Phase 1: Run all deliberation turns
    let maxIterations = 100; // safety limit
    while (maxIterations-- > 0) {
      const state = loadSession(sessionId);
      if (!state) {
        _deps.appendRuntimeLog("ERROR", `AUTO_HANDOFF: Session ${sessionId} disappeared`);
        return;
      }
      if (state.status !== "active") {
        _deps.appendRuntimeLog("INFO", `AUTO_HANDOFF: Session ${sessionId} status=${state.status}, turns done`);
        break;
      }

      const speaker = state.current_speaker;
      if (speaker === "none") break;

      _deps.appendRuntimeLog("INFO", `AUTO_HANDOFF_TURN: ${sessionId} | speaker: ${speaker} | round: ${state.current_round}/${state.max_rounds}`);

      let turnSucceeded = false;
      for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
        const runResult = await runUntilBlockedCore(sessionId, { maxTurns: 1, includeHistoryEntries: 3 });
        const step = runResult.steps.at(-1) || null;

        if (runResult.ok && runResult.status !== "blocked") {
          _deps.appendRuntimeLog("INFO", `AUTO_HANDOFF_TURN_OK: ${sessionId} | speaker: ${speaker} | ${step?.elapsedMs || 0}ms`);
          turnSucceeded = true;
          break;
        }

        // self_turn: orchestrator is the speaker. The defensive guard at runUntilBlockedCore
        // prevented a recursive CLI spawn; here we submit a visible placeholder so the session
        // can advance to the next speaker rather than aborting Phase 1 entirely.
        if (runResult.block_reason === "self_turn") {
          _deps.appendRuntimeLog("WARN", `AUTO_HANDOFF_SELF_TURN_SKIP: ${sessionId} | speaker: ${speaker} | submitting placeholder and advancing`);
          submitDeliberationTurn({
            session_id: sessionId,
            speaker,
            content: `[SELF_TURN_SKIP] Speaker ${speaker} matches the orchestrator identity; auto-dispatch skipped to avoid recursive self-spawn. The orchestrator may contribute this speaker's input manually via deliberation_respond before synthesis.`,
            channel_used: "self_turn_skip",
            fallback_reason: "caller_identity_match",
          });
          turnSucceeded = true; // placeholder submitted, advance to next speaker
          break;
        }

        if (attempt < retryConfig.maxRetries) {
          _deps.appendRuntimeLog("WARN", `AUTO_HANDOFF_RETRY: ${sessionId} | speaker: ${speaker} | attempt ${attempt + 1}/${retryConfig.maxRetries} | reason: ${runResult.block_reason || runResult.error || "unknown"} | retrying in ${retryConfig.retryDelayMs}ms`);
          await new Promise(r => setTimeout(r, retryConfig.retryDelayMs));
        } else {
          _deps.appendRuntimeLog("WARN", `AUTO_HANDOFF_SKIP: ${sessionId} | speaker: ${speaker} | exhausted ${retryConfig.maxRetries} retries | submitting placeholder`);
          // Submit a placeholder turn so the session can advance to the next speaker
          submitDeliberationTurn({
            session_id: sessionId,
            speaker,
            content: `[AUTO_SKIP] Speaker ${speaker} did not respond after ${retryConfig.maxRetries} retries.`,
            channel_used: "auto_skip",
          });
          turnSucceeded = true; // placeholder submitted, continue with next speaker
        }
      }

      if (!turnSucceeded) break;
    }

    // Phase 2: Generate structured synthesis
    _deps.appendRuntimeLog("INFO", `AUTO_HANDOFF_SYNTHESIZE: ${sessionId}`);
    let synthResult = await generateAutoSynthesis(sessionId);

    // Phase 3: Call synthesize (reuse existing logic)
    const state = loadSession(sessionId);
    if (!state) return;

    // Fallback: if synthesis generation failed, build a basic structure from the discussion
    if (!synthResult || (!synthResult.summary && !synthResult.actionable_tasks)) {
      _deps.appendRuntimeLog("WARN", `AUTO_HANDOFF_SYNTH_FALLBACK: ${sessionId} | Building fallback from discussion log`);
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
    _deps.withSessionLock(sessionId, () => {
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

      const sessionFile = _deps.getSessionFile(loaded);
      try { if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile); } catch {}
    });

    closeMonitorTerminal(sessionId, getSessionWindowIds(state));

    _deps.appendRuntimeLog("INFO", `AUTO_HANDOFF_SYNTHESIZED: ${sessionId}`);

    // Phase 4: Notify telepty bus with full structured data for dustcraw to consume
    if (state.auto_execute) {
      const envelope = buildTeleptySynthesisEnvelope({
        state,
        synthesis: markdownSynthesis,
        structured,
      });
      await notifyTeleptyBus(envelope).catch(() => {});
      _deps.appendRuntimeLog("INFO", `AUTO_HANDOFF_NOTIFIED: ${sessionId} | telepty event sent`);
    }

    // Phase 5: Report final results to orchestrator
    const orchestratorSessionId = state.orchestrator_session_id;
    if (orchestratorSessionId) {
      const taskCount = structured.actionable_tasks?.length || 0;
      const decisionCount = structured.decisions?.length || 0;
      const reportText = `[deliberation_auto_complete] session: ${sessionId} | topic: ${state.topic} | decisions: ${decisionCount} | tasks: ${taskCount} | status: completed`;
      notifyTeleptySessionInject({
        targetSessionId: orchestratorSessionId,
        prompt: reportText,
        fromSessionId: `deliberation:${sessionId}`,
      }).catch(() => {});
      _deps.appendRuntimeLog("INFO", `AUTO_HANDOFF_REPORTED: ${sessionId} | orchestrator: ${orchestratorSessionId}`);
    }

    _deps.appendRuntimeLog("INFO", `AUTO_HANDOFF_COMPLETE: ${sessionId}`);
  } catch (err) {
    _deps.appendRuntimeLog("ERROR", `AUTO_HANDOFF_ERROR: ${sessionId} | ${err.message}`);
  }
}

// ── Review helpers ──────────────────────────────────────────────

export function invokeCliReviewer(command, prompt, timeoutMs) {
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

export function buildReviewPrompt(context, question, priorReviews) {
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

export function synthesizeReviews(context, question, reviews) {
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
