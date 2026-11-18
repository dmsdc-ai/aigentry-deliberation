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

// CLI-specific invocation flags for non-interactive execution.
//
// `stdinMode: true` means the prompt travels on the CLI's stdin, never in argv.
// It is the single source of truth for that question: `buildWindowsCliInvocation`
// refuses to put prompt text on a command-interpreter line, and
// `cliDispatchRefusal` (used by `checkCliLiveness`) asks the same question
// before discovery advertises the CLI as live. Every dispatch site feeds
// `claude -p` on stdin (index.js, transport.js runCliAutoTurnCore /
// generateAutoSynthesis, invokeCliReviewer), so the flag has to say so —
// otherwise liveness would refuse a CLI the product dispatches fine.
export const CLI_INVOCATION_HINTS = {
  claude: { cmd: "claude", flags: '-p --output-format text', example: 'CLAUDECODE= claude -p --output-format text "prompt"', envPrefix: 'CLAUDECODE=', stdinMode: true, modelFlag: '--model', defaultModel: null, provider: 'claude' },
  codex: { cmd: "codex", flags: 'exec -', example: 'echo "prompt" | codex exec -', stdinMode: true, modelFlag: '-m', defaultModel: 'gpt-5.4', provider: 'chatgpt' },
  gemini: { cmd: "gemini", flags: '', example: 'gemini "prompt"', modelFlag: '-m', defaultModel: null, provider: 'gemini' },
  grok: { cmd: "grok", flags: '-p', example: 'grok -p "prompt"', modelFlag: '-m', defaultModel: null, provider: 'grok' },
  // Upstream agy (Antigravity) limitation, not our bug: headless --print never flushes stdout
  // here (0 bytes over 180-298s, even with --dangerously-skip-permissions), so cli_auto would
  // hang the whole deliberation. Marked not cli_auto-capable -> runCliAutoTurnCore degrades it to
  // manual. Flip cliAutoCapable back to true once agy fixes headless stdout flushing.
  agy: { cmd: "agy", flags: '-p', example: 'agy -p "prompt"', modelFlag: '--model', defaultModel: null, provider: 'gemini', cliAutoCapable: false },
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

// The only shape this module will ever hand to a process spawn as a command:
// a bare name, no directory separators, no spaces, no shell metacharacters.
// `commandExistsInPath` has always applied it before scanning PATH; since r5
// `checkCliLiveness` applies it too, so a caller-supplied speaker name that is
// really a path (`/usr/bin/true`, `C:\tools\x.exe`) can never become a probe
// target (R4-01).
export const CLI_COMMAND_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function isApprovedCliCommandName(value) {
  return typeof value === "string" && CLI_COMMAND_NAME_PATTERN.test(value);
}

/**
 * The hint for `command`, or undefined — own properties only.
 * `CLI_INVOCATION_HINTS[name]` is a plain-object lookup, so names inherited
 * from Object.prototype (`constructor`, `toString`, …) read as present
 * (R4-06). A speaker name is caller-supplied, so the lookup has to be exact.
 */
export function getCliHint(command) {
  return typeof command === "string"
    && Object.prototype.hasOwnProperty.call(CLI_INVOCATION_HINTS, command)
    ? CLI_INVOCATION_HINTS[command]
    : undefined;
}

/**
 * The command a liveness probe may run for `speaker`, or null if none may.
 *
 * Nothing but the approved command of a KNOWN CLI is ever probed:
 *
 *  - the DISCOVERED candidate for this speaker must itself be `type: "cli"`.
 *    A `participant_types` override only changes how a turn is transported; it
 *    cannot make a telepty session id or a manual participant name executable
 *    (a confirmed session called `true` with its type overridden to `cli`
 *    otherwise became `spawn("true", ["--version"])` — R5-01).
 *  - the command comes from that candidate, never from the speaker id, and it
 *    must be an approved bare command name.
 *  - it must be in the trusted registry: the built-in hint table or the
 *    explicitly enabled candidate list. A speaker with no candidate at all is
 *    never promoted by PATH membership.
 *
 * `trustedCommands` is injectable so the registry can be pinned in a test;
 * production callers pass nothing.
 */
export function resolveCliProbeCommand(speaker, candidates = [], { trustedCommands = null } = {}) {
  const normalized = normalizeSpeaker(speaker);
  if (!normalized) return null;

  const candidate = (Array.isArray(candidates) ? candidates : [])
    .find(entry => normalizeSpeaker(entry?.speaker) === normalized);
  if (!candidate || candidate.type !== "cli") return null;

  const command = typeof candidate.command === "string" && candidate.command
    ? candidate.command
    : normalized;
  if (!isApprovedCliCommandName(command)) return null;

  const trusted = trustedCommands
    ? new Set(trustedCommands)
    : new Set([...Object.keys(CLI_INVOCATION_HINTS), ...resolveCliCandidates()]);
  return trusted.has(command) ? command : null;
}

export function commandExistsInPath(command) {
  if (!isApprovedCliCommandName(command)) {
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

// ── Windows command resolution and process control ──────────────
//
// Windows resolves a bare command name through CreateProcess, which appends
// only `.com` and `.exe`. An npm-installed CLI (claude, codex, gemini …) is a
// `.cmd` shim on PATH, which is not an executable image: only the command
// interpreter can run it. So `spawn("claude", …)` / `execFileSync("claude", …)`
// fails with ENOENT on Windows even though `commandExistsInPath("claude")`
// reports the CLI present (it accepts `.cmd`/`.bat` above). The helpers below
// close that gap for every CLI call site; on other platforms they are
// pass-through and change nothing.
//
// Everything here uses `path.win32` so the construction is a pure function of
// its inputs and can be tested on every platform leg, not only on Windows.

const WIN_IMAGE_EXTENSIONS = [".exe", ".com"];
const WIN_SHIM_EXTENSIONS = [".cmd", ".bat"];
const WIN_RUNNABLE_EXTENSIONS = [...WIN_IMAGE_EXTENSIONS, ...WIN_SHIM_EXTENSIONS];
const WIN_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

// Token delimiters and metacharacters that a caret DOES escape on a cmd.exe
// command line. `%` and `!` are deliberately NOT here: percent expansion runs
// before caret processing and `!` needs `^^!` once delayed expansion is on, so
// a caret does not neutralise either — they are refused outright below.
const CMD_META_CHARS = /([()\[\]^"`<>&|;,= *?])/g;
// A newline ends the interpreter's command line, so nothing after it would be
// passed as an argument.
const CMD_REFUSED_NEWLINE = /[\r\n]/;
// `%` and `!` are expanded by the interpreter itself (see above), and EVERY C0
// control character is refused rather than argued about one at a time: TAB is a
// token delimiter a caret does not reliably escape; NUL terminates the wide
// command-line string the OS receives, so everything after it — including the
// closing quote that `/s` strips — is silently lost below the layer this module
// can see; 0x1A is what cmd.exe treats as end-of-file in batch context, and the
// documentation only covers that rule for *reading* a batch file, not for text
// arriving through a shim's `%*` substitution; 0x0B/0x0C are whitespace that
// CommandLineToArgvW does not treat as a separator but cmd's tokeniser may.
// Refusing the whole class is one character of regex and makes the builder's
// contract — what it does not refuse, it has proved it can quote — finite
// instead of a list of the four characters someone happened to check (R3-10).
// CR and LF are in this class too, but the newline guard above runs first and
// reports them with their own code.
const CMD_REFUSED_META = /[\x00-\x1f%!]/;
// The command line cmd.exe accepts after `/c` is bounded; escaping expands an
// element by up to ~4x, so the bound is reachable from much shorter input.
const CMD_MAX_COMMAND_LINE = 8191;
// A Windows path that needs no current-directory and no current-drive context:
// drive-absolute (`C:\x`) or UNC (`\\host\share\x`). `path.win32.isAbsolute` is
// NOT this test — it is also true for a rooted-but-driveless `\x`, which
// resolves against whatever drive the child's cwd is on.
const WIN_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WIN_UNC_PATH = /^[\\/]{2}[^\\/]/;
// The interpreter is placed on the command line as argv[0] (see the `argv0`
// note in buildWindowsCliInvocation), where cmd.exe strips quotes but does not
// process carets — so a quote in it cannot be escaped, only refused. Same C0
// class as above, plus the quote character.
const CMD_INTERPRETER_REFUSED = /["\x00-\x1f%!]/;

// Every refusal code buildCliInvocation can return. All of them are decided
// before anything is spawned and cannot change between attempts, which is what
// `isPermanentCliFailure` lets the retry loops key off.
export const CLI_INVOCATION_FAILURE_CODES = [
  "E_CLI_NOT_FOUND",
  "E_CLI_NOT_EXECUTABLE",
  "E_CLI_PATH_NOT_ABSOLUTE",
  "E_CLI_INTERPRETER_INVALID",
  "E_CLI_PROMPT_ARGV_REQUIRED",
  "E_CLI_PROMPT_ARGV_SHAPE",
  "E_CLI_ARG_NEWLINE",
  "E_CLI_ARG_META",
  "E_CLI_ARG_TOO_LONG",
];

/**
 * True when a failure text carries one of the pre-spawn refusal codes above.
 * Such a failure is deterministic: retrying it costs the retry delay and
 * produces the identical refusal, so callers must stop at the first one.
 */
export function isPermanentCliFailure(reason) {
  const text = String(reason ?? "");
  return CLI_INVOCATION_FAILURE_CODES.some(code => text.includes(code));
}

export function isWindowsFullyQualifiedPath(value) {
  const text = String(value ?? "");
  return WIN_DRIVE_ABSOLUTE.test(text) || WIN_UNC_PATH.test(text);
}

export function isWindowsDriveAbsolutePath(value) {
  return WIN_DRIVE_ABSOLUTE.test(String(value ?? ""));
}

function escapeCmdMetaChars(value) {
  return value.replace(CMD_META_CHARS, "^$1");
}

function cleanArgList(args) {
  return (Array.isArray(args) ? args : [])
    .filter(arg => arg !== null && arg !== undefined);
}

// Absolute path to a Windows system tool. A bare name must never be spawned:
// libuv searches the child's working directory before PATH on Windows, and that
// directory can be caller-supplied (ADR-264 `spawn_cwd`).
function windowsSystemTool(name, env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", name);
}

// Quote one element of a `cmd.exe /d /s /v:off /c` command line: first the
// documented CommandLineToArgvW backslash/quote rules so the final program
// parses it back as a single argument, then `^`-escaping for cmd.exe's own
// parser. `doubleEscape` adds the second caret level a `.cmd`/`.bat` shim needs
// because forwarding its arguments (`%*`) makes cmd.exe parse them a second
// time, after the first pass has already consumed one caret level.
//
// Two limits of this function, stated so they are not taken for more than they
// are:
//  - the command token keeps the quotes this adds AND has them caret-escaped
//    (see the join in buildWindowsCliInvocation), so locating the shim relies
//    on cmd.exe stripping caret-protected quotes from the command token. That
//    behaviour is observed (CI green on windows-latest, including a shim
//    directory with a space in it), not documented; cross-spawn avoids the
//    question by not quoting the command token at all.
//  - a non-ASCII element is passed through unescaped, which is right for
//    CommandLineToArgvW and for the caret pass, but a `.cmd` shim's `%*`
//    re-parse happens in the active console code page, which can mangle it
//    independently of anything here. No element on the shim path is non-ASCII
//    today (they are all module constants), so this is untested ground.
export function quoteCmdArgument(arg, { doubleEscape = false } = {}) {
  let out = String(arg);
  // Double every run of backslashes that precedes a quote, and escape the quote.
  out = out.replace(/(\\*)"/g, '$1$1\\"');
  // Double a trailing run of backslashes so it cannot escape the closing quote.
  out = out.replace(/(\\*)$/, "$1$1");
  out = escapeCmdMetaChars(`"${out}"`);
  return doubleEscape ? escapeCmdMetaChars(out) : out;
}

// Candidate paths for a bare command name, directory-major and PATHEXT-minor.
// Only extensions this module can actually execute are considered, so a `.ps1`
// sibling cannot shadow the `.cmd` shim npm installs next to it. Pure: no
// filesystem, no process.env.
//
// Two deliberate departures from what Windows itself would try:
//  - a PATH entry that is not fully qualified is dropped. An empty entry means
//    the current directory, and a relative entry ("tools") would be stat'd here
//    against the server's cwd but resolved by the interpreter against the
//    child's cwd — which is caller-supplied (ADR-264 `spawn_cwd`), so the file
//    checked and the file run could be different files.
//  - when PATHEXT is set but lists no extension this module can run, the
//    default runnable list is used anyway (the fix has to work when PATHEXT is
//    unset or restrictive); Windows would run nothing in that case.
export function windowsCommandCandidates(command, pathValue = "", pathExtValue = "") {
  if (!command || !/^[a-zA-Z0-9._-]+$/.test(command)) return [];

  const dirs = String(pathValue)
    .split(path.win32.delimiter)
    .filter(Boolean)
    .filter(isWindowsFullyQualifiedPath);
  let extensions = String(pathExtValue)
    .split(";")
    .map(ext => ext.trim())
    .filter(Boolean)
    .filter(ext => WIN_RUNNABLE_EXTENSIONS.includes(ext.toLowerCase()));
  if (extensions.length === 0) extensions = WIN_DEFAULT_PATHEXT.split(";");

  const givenExt = path.win32.extname(command).toLowerCase();
  const names = givenExt
    ? (WIN_RUNNABLE_EXTENSIONS.includes(givenExt) ? [command] : [])
    : extensions.map(ext => `${command}${ext}`);

  const candidates = [];
  for (const dir of dirs) {
    for (const name of names) candidates.push(path.win32.join(dir, name));
  }
  return candidates;
}

export function resolveWindowsCommandPath(command) {
  if (process.platform !== "win32") return null;
  const candidates = windowsCommandCandidates(
    command,
    process.env.PATH || "",
    process.env.PATHEXT || WIN_DEFAULT_PATHEXT,
  );
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here, keep looking
    }
  }
  return null;
}

// The command interpreter, always as a drive-absolute path. A rooted but
// driveless ComSpec (`\cmd.exe`) is NOT accepted: it resolves against the
// current drive, which comes from the cwd — exactly the dependency an absolute
// path is supposed to remove. Neither is UNC, which would run the interpreter
// itself off a share. buildWindowsCliInvocation re-checks the result, because
// %SystemRoot% can be just as odd as %ComSpec%.
export function resolveCommandInterpreter(env = process.env) {
  const comspec = env.ComSpec || env.COMSPEC;
  if (comspec && isWindowsDriveAbsolutePath(comspec)) return comspec;
  return windowsSystemTool("cmd.exe", env);
}

function cliInvocationFailure(code, reason) {
  return { ok: false, code, reason, stdinPrompt: null, viaInterpreter: false, promptMovedToStdin: false };
}

/**
 * Windows half of buildCliInvocation, separated so the whole construction is a
 * pure function of (command, args, options, resolvedPath, interpreter) and can
 * be unit-tested on every platform leg.
 */
export function buildWindowsCliInvocation(command, args = [], {
  promptArgs = [],
  promptText = null,
  resolvedPath = null,
  interpreter = null,
} = {}) {
  const baseArgs = cleanArgList(args);
  const promptArgv = cleanArgList(promptArgs);

  if (!resolvedPath) {
    return cliInvocationFailure(
      "E_CLI_NOT_FOUND",
      `"${command}" is not on PATH with an extension Windows can execute (.com/.exe/.bat/.cmd)`,
    );
  }

  // A target that is not fully qualified would be resolved against the child's
  // working directory — caller-supplied via ADR-264 `spawn_cwd` — by
  // CreateProcess on the image path and by the interpreter on the shim path,
  // while the stat that found it ran against the server's cwd. Refuse before
  // either can happen.
  if (!isWindowsFullyQualifiedPath(resolvedPath)) {
    return cliInvocationFailure(
      "E_CLI_PATH_NOT_ABSOLUTE",
      `"${command}" resolves to ${resolvedPath}, which is not a drive-absolute or UNC path; it would be resolved against the child's working directory instead of the one that was checked`,
    );
  }

  const ext = path.win32.extname(resolvedPath).toLowerCase();

  if (WIN_IMAGE_EXTENSIONS.includes(ext)) {
    // A real executable image: CreateProcess takes argv as given, no
    // interpreter is involved, so even a multi-line prompt argument survives.
    return {
      ok: true,
      file: resolvedPath,
      args: [...baseArgs, ...promptArgv],
      options: {},
      stdinPrompt: null,
      viaInterpreter: false,
      promptMovedToStdin: false,
    };
  }

  if (!WIN_SHIM_EXTENSIONS.includes(ext)) {
    return cliInvocationFailure(
      "E_CLI_NOT_EXECUTABLE",
      `"${command}" resolves to ${resolvedPath}, which Windows cannot execute directly`,
    );
  }

  // ── `.cmd`/`.bat` shim: the command interpreter runs it ──
  //
  // Prompt text must never reach the interpreter's command line: a newline
  // would end the line, and the rest of the prompt (a topic, other speakers'
  // answers, model output) would be parsed as commands. stdin is the only
  // channel that carries it byte-for-byte, so the prompt may move there only
  // for a CLI documented to read it there (`stdinMode` in
  // CLI_INVOCATION_HINTS). Any other CLI is refused with a named reason —
  // dropping its prompt flags would launch it with no arguments at all, which
  // for an interactive CLI means hanging until the turn times out.
  //
  const stdinCapable = getCliHint(command)?.stdinMode === true;
  const hasPromptText = promptText !== null && promptText !== undefined;
  if (promptArgv.length > 0 && !(stdinCapable && hasPromptText)) {
    return cliInvocationFailure(
      "E_CLI_PROMPT_ARGV_REQUIRED",
      `"${command}" takes its prompt as a command-line argument, and a Windows ${ext} shim runs through the command interpreter, whose command line cannot carry prompt text. Only a CLI that reads its prompt from stdin can be dispatched this way. Use a native .exe build of "${command}", a stdin-capable CLI (claude, codex), or answer this turn with deliberation_respond.`,
    );
  }

  // Only the prompt TEXT moves to stdin. Its flags stay on the line: dropping
  // them is the failure the paragraph above refuses to create for every other
  // CLI — launching a CLI with none of the arguments it was given — and the
  // dispatch sites build flags and text into one array
  // (`promptArgs: [...flags, turnPrompt]`), so the builder is the only place
  // that can tell them apart (R3-06). They are appended to `shellArgs` before
  // the guards below, so they are refused or escaped by exactly the same rules
  // as `args`. Latent today: no call site passes `promptArgs` for a stdinMode
  // CLI (claude and codex take their flags from getCliExecArgs in `args`).
  //
  // The text is identified by POSITION — the documented contract is
  // `promptArgs: [...flags, promptText]` — not by value: a flag that happens to
  // equal the prompt (`promptArgs: ["-p", "-p"]`, `promptText: "-p"`) must keep
  // its flag, and a `promptText` that is NOT the trailing entry means the caller
  // and the builder disagree about which element is prompt text, which would
  // otherwise put that text on the interpreter line. Fail closed instead
  // (R4-03).
  let promptFlags = [];
  if (stdinCapable && hasPromptText && promptArgv.length > 0) {
    const trailing = String(promptArgv[promptArgv.length - 1]);
    if (trailing !== String(promptText)) {
      return cliInvocationFailure(
        "E_CLI_PROMPT_ARGV_SHAPE",
        `"${command}" was given promptArgs whose last element is not promptText, so which element carries the prompt is ambiguous; pass the prompt text as the final entry of promptArgs (the flags before it stay on the command line)`,
      );
    }
    promptFlags = promptArgv.slice(0, -1).map(String);
  }
  const shellArgs = [...baseArgs.map(String), ...promptFlags];
  const lineElements = [resolvedPath, ...shellArgs];
  if (lineElements.some(element => CMD_REFUSED_NEWLINE.test(element))) {
    return cliInvocationFailure(
      "E_CLI_ARG_NEWLINE",
      `"${command}" resolves to the ${ext} shim ${resolvedPath}, and an element containing a newline cannot be placed on a command-interpreter line`,
    );
  }
  if (lineElements.some(element => CMD_REFUSED_META.test(element))) {
    return cliInvocationFailure(
      "E_CLI_ARG_META",
      `"${command}" resolves to the ${ext} shim ${resolvedPath}, and an element containing a control character (including TAB, NUL and 0x1A), "%" or "!" cannot be escaped on a command-interpreter line (percent expansion runs before caret processing, "!" is expanded after it, a NUL truncates the whole line and 0x1A is cmd.exe's batch end-of-file)`,
    );
  }

  // The interpreter is the one element that is NOT escaped: it goes on the line
  // as argv[0] (see `argv0` below), where cmd.exe strips quotes but runs no
  // caret pass. So it must be validated instead — and it is env-derived
  // (%ComSpec%, %SystemRoot%), never caller-derived.
  const interpreterPath = interpreter || resolveCommandInterpreter();
  if (!isWindowsDriveAbsolutePath(interpreterPath) || CMD_INTERPRETER_REFUSED.test(interpreterPath)) {
    return cliInvocationFailure(
      "E_CLI_INTERPRETER_INVALID",
      `the command interpreter resolved to "${interpreterPath}", which is not a drive-absolute path free of quotes, control characters, "%" and "!"; refusing rather than placing it unescaped on its own command line (check %ComSpec% and %SystemRoot%)`,
    );
  }

  const commandLine = [
    quoteCmdArgument(resolvedPath),
    ...shellArgs.map(arg => quoteCmdArgument(arg, { doubleEscape: true })),
  ].join(" ");

  // `windowsVerbatimArguments` hands the joined line to CreateProcess as-is, so
  // the length the OS and cmd.exe see is the whole line, not just the /c string.
  const shellSwitches = ["/d", "/s", "/v:off", "/c"];
  const quotedInterpreter = `"${interpreterPath}"`;
  const fullLineLength =
    quotedInterpreter.length + 1 +
    shellSwitches.join(" ").length + 1 +
    commandLine.length + 2;
  if (fullLineLength > CMD_MAX_COMMAND_LINE) {
    return cliInvocationFailure(
      "E_CLI_ARG_TOO_LONG",
      `"${command}" resolves to the ${ext} shim ${resolvedPath}, and escaping its ${shellArgs.length} argument(s) produces a ${fullLineLength}-character interpreter command line, over cmd.exe's ${CMD_MAX_COMMAND_LINE}-character limit; over the limit the line is truncated and re-parsed with unbalanced quotes`,
    );
  }

  return {
    ok: true,
    // /d suppresses the AutoRun registry command, /s fixes the quote handling
    // of the whole string, /v:off takes delayed `!` expansion out of play
    // whatever the machine default is.
    file: interpreterPath,
    args: [...shellSwitches, `"${commandLine}"`],
    // argv0 is the quoted interpreter path: with windowsVerbatimArguments
    // libuv joins argv verbatim, so an unquoted path containing a space would
    // make cmd.exe mis-tokenise its own switches (CreateProcess still starts
    // the right image — it takes the path from `file` — but cmd parses
    // GetCommandLine()).
    //
    // Weigh this the same way as the quoted command token above: that cmd.exe
    // skips a QUOTED argv[0] when parsing its own line is observed behaviour —
    // it is the form Windows itself uses to launch a shell, and the Windows
    // e2e leg dispatches two shim CLIs through it on every run — not a
    // documented rule. Both quoting decisions rest on the same footing (R3-09).
    options: { windowsVerbatimArguments: true, argv0: quotedInterpreter },
    stdinPrompt: promptArgv.length > 0 ? String(promptText) : null,
    viaInterpreter: true,
    promptMovedToStdin: promptArgv.length > 0,
    shimPath: resolvedPath,
  };
}

/**
 * Build a portable invocation for a CLI known only by its bare command name.
 *
 * Returns `{ ok: true, file, args, options, stdinPrompt, viaInterpreter }` to
 * hand straight to `spawn`/`execFileSync`, or `{ ok: false, code, reason }`
 * when this platform cannot execute the command (the caller reports that
 * instead of an opaque ENOENT).
 *
 * `promptArgs` are the argv entries that carry prompt text, with `promptText`
 * the text itself; `args` are the arguments that always go on the command line.
 * Keep prompt text out of `args`: on the Windows shim path `args` are placed on
 * the interpreter's command line.
 *
 * `viaInterpreter` tells the caller that the spawned process is the interpreter
 * and the CLI is its child, so abandoning the turn has to terminate the tree
 * (see terminateCliProcess).
 */
export function buildCliInvocation(command, args = [], { promptArgs = [], promptText = null } = {}) {
  if (process.platform !== "win32") {
    return {
      ok: true,
      file: command,
      args: [...cleanArgList(args), ...cleanArgList(promptArgs)],
      options: {},
      stdinPrompt: null,
      viaInterpreter: false,
      promptMovedToStdin: false,
    };
  }
  return buildWindowsCliInvocation(command, args, {
    promptArgs,
    promptText,
    resolvedPath: resolveWindowsCommandPath(command),
  });
}

// How long to wait for the tree killer before falling back to killing the one
// process we hold. taskkill normally answers in well under a second.
const TREE_KILL_FALLBACK_MS = 2000;

/**
 * The command that terminates a process tree on Windows, as [file, args].
 * Pure, so the vector — and especially `/t`, which is the entire point — can be
 * asserted on every platform leg instead of only where taskkill exists.
 *
 * `/f` is unconditional: the graceful/forceful distinction `terminateCliProcess`
 * makes on POSIX has no equivalent here, because a console process tree does
 * not reliably act on taskkill's non-forced close request. So on the Windows
 * interpreter path there is no graceful phase, and the 5 s force escalation the
 * call sites arm is a second force kill of an already-dead pid.
 */
export function buildTreeKillCommand(pid, env = process.env) {
  return [windowsSystemTool("taskkill.exe", env), ["/pid", String(pid), "/t", "/f"]];
}

/**
 * Stop a CLI the module started.
 *
 * On the Windows shim path the process we hold is the interpreter and the CLI
 * is its child. Windows has no process groups, and `ChildProcess.kill`
 * terminates a single pid, so killing the interpreter would leave the CLI
 * running — still holding the inherited pipes, still consuming its provider
 * session — every time a turn times out or is abandoned. `taskkill /t`
 * terminates the tree. Argument vector, no shell, absolute path.
 *
 * The tree kill can also start and then fail (access denied, an elevated
 * process in the tree, the pid already reaped) or hang. Any outcome other than
 * "exited 0" falls back to killing the process we hold, so a failed tree kill
 * never ends up killing nothing at all.
 *
 * `platform` and `spawnFn` exist so the Windows branch can be driven on every
 * matrix leg; production callers pass neither.
 */
export function terminateCliProcess(child, {
  viaInterpreter = false,
  force = false,
  platform = process.platform,
  spawnFn = spawn,
} = {}) {
  if (!child) return;
  const signal = force ? "SIGKILL" : "SIGTERM";
  let killedDirect = false;
  const killDirect = () => {
    if (killedDirect) return;
    killedDirect = true;
    try { child.kill(signal); } catch { /* already gone */ }
  };

  if (viaInterpreter && platform === "win32" && typeof child.pid === "number") {
    try {
      const [file, args] = buildTreeKillCommand(child.pid);
      const killer = spawnFn(file, args, { stdio: "ignore", windowsHide: true });
      let fallbackTimer = null;
      const clearFallback = () => {
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
      };
      // taskkill missing (spawn error), refused the tree (non-zero exit) or
      // hung (timer): in every one of those we still have to release the
      // handle we hold.
      killer.on("error", () => { clearFallback(); killDirect(); });
      killer.on("exit", (code) => {
        clearFallback();
        if (code !== 0) killDirect();
      });
      fallbackTimer = setTimeout(killDirect, TREE_KILL_FALLBACK_MS);
      if (typeof fallbackTimer?.unref === "function") fallbackTimer.unref();
      return;
    } catch {
      // spawn itself threw — fall through to the single-process kill.
    }
  }
  killDirect();
}

/**
 * Abandon a CLI at a deadline: close the tree now, and escalate once if the
 * child is still alive when the grace period is up.
 *
 * One function for both async deadlines (the liveness probe and
 * `invokeCliReviewer`), so the thing R2-02 was about — that a deadline closes
 * the TREE and not just the interpreter we hold — is a single named call at each
 * site instead of eight duplicated lines, and is driven directly by tests
 * through the `terminate` seam (R3-08). The escalation cannot be cancelled by
 * the settle path that follows it: on the Windows shim path the first call has
 * already force-killed the tree, so the second is only for the case where the
 * first did not take effect (R3-05).
 *
 * Returns the escalation timer so a caller can clear it if it has a better
 * moment to; `graceMs`, `terminate` and `timerFn` exist for the tests.
 */
export function abandonCliProcess(child, {
  viaInterpreter = false,
  graceMs = TREE_KILL_FALLBACK_MS,
  terminate = terminateCliProcess,
  timerFn = setTimeout,
} = {}) {
  terminate(child, { viaInterpreter });
  const forceTimer = timerFn(() => {
    if (child?.exitCode === null && child?.signalCode === null) {
      terminate(child, { viaInterpreter, force: true });
    }
  }, graceMs);
  if (typeof forceTimer?.unref === "function") forceTimer.unref();
  return forceTimer;
}

/**
 * The non-prompt arguments a dispatch puts on the command line for `speaker`.
 *
 * Moved here from transport.js in r4: it is a pure function of
 * CLI_INVOCATION_HINTS, and `cliDispatchRefusal` has to model exactly what the
 * dispatch will build (R3-01), so both sides must read one definition.
 * transport.js re-exports it, so every existing importer is unaffected.
 */
export function getCliExecArgs(speaker, model) {
  const hint = getCliHint(speaker);
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

/**
 * What a dispatch would place on the interpreter line for `command`, as the
 * dispatch sites build it: `getCliExecArgs` for claude/codex, the model flags
 * for gemini (empty while `defaultModel` is null) and nothing for the CLIs that
 * carry everything in `promptArgs`.
 *
 * `defaultModel` is included because `runCliAutoTurnCore` and
 * `generateAutoSynthesis` pass it (transport.js) — the superset of what
 * `deliberation_cli_auto_turn` passes, so modelling it cannot under-report.
 */
export function cliDispatchArgs(command) {
  const hint = getCliHint(command);
  return getCliExecArgs(command, hint?.defaultModel ?? null) ?? [];
}

// A prompt long enough to be recognisable in a log, short enough not to matter
// for the length bound. Nothing is executed with it: `cliDispatchRefusal` only
// asks the builder whether such a dispatch would be refused.
const CLI_DISPATCH_PROBE_FLAG = "-p";
const CLI_DISPATCH_PROBE_TEXT = "dispatch capability probe";

/**
 * Would dispatching a turn to `command` be refused on this platform, before
 * anything is spawned? Returns `{ code, reason }` if so, else null.
 *
 * Liveness has to ask this, not just "does the CLI answer --version": on
 * Windows a `.cmd`/`.bat` shim runs through the command interpreter, whose
 * command line cannot carry prompt text, so a CLI that takes its prompt in argv
 * can never be dispatched here — while a flags-only `--version` probe through
 * the same shim succeeds. Without this, discovery advertises a speaker whose
 * every turn then fails E_CLI_PROMPT_ARGV_REQUIRED.
 *
 * It asks with the arguments the dispatch will really use (`cliDispatchArgs`),
 * not with an empty list: `E_CLI_ARG_META`, `E_CLI_ARG_NEWLINE` and
 * `E_CLI_ARG_TOO_LONG` are decided from `args` alone, so a probe without them
 * answers for five of the eight refusal codes instead of all eight (R3-01).
 *
 * Pure when `args`, `resolvedPath` and `platform` are supplied, so every branch
 * is testable on every matrix leg.
 */
export function cliDispatchRefusal(command, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return null;
  const resolvedPath = Object.prototype.hasOwnProperty.call(options, "resolvedPath")
    ? options.resolvedPath
    : resolveWindowsCommandPath(command);
  const args = Object.prototype.hasOwnProperty.call(options, "args")
    ? options.args
    : cliDispatchArgs(command);
  // Model the prompt transport the dispatch really uses, per CLI: a stdinMode
  // CLI is dispatched with `args` only and its prompt on stdin, so the probe
  // must not add a synthetic prompt flag — 11 escaped units that the real line
  // does not carry are 11 units of difference at the 8191 boundary, i.e. a
  // refusal of an installation the dispatch would have run (R4-02). For an
  // argv-prompt CLI the question IS "would prompt text in argv be refused", so
  // the pair stays — and that refusal is decided before any length arithmetic.
  const stdinCapable = getCliHint(command)?.stdinMode === true;
  const invocation = buildWindowsCliInvocation(command, args, {
    promptArgs: stdinCapable ? [] : [CLI_DISPATCH_PROBE_FLAG, CLI_DISPATCH_PROBE_TEXT],
    promptText: stdinCapable ? null : CLI_DISPATCH_PROBE_TEXT,
    resolvedPath,
    interpreter: options.interpreter || null,
  });
  return invocation.ok ? null : { code: invocation.code, reason: invocation.reason };
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

  // ADR-264 §2.1 — token_already_consumed precedes TTL/mode checks so the
  // caller can distinguish "was already used" from "expired" or "wrong mode".
  if (selectionState.consumed_at) {
    return { ok: false, code: "token_already_consumed", consumed_at: selectionState.consumed_at };
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

// ADR-264 §2.1 — atomic consume: stamp `consumed_at` onto the confirmed state
// file so cross-process races surface as `token_already_consumed` instead of
// allowing silent double-start. Callers MUST wrap the read+validate+mark
// sequence in `withProjectLock` (index.js) to be cross-process safe.
export function markSelectionTokenConsumed({ selectionState, nowMs = Date.now(), persist = true }) {
  if (!selectionState || typeof selectionState !== "object") {
    return selectionState;
  }
  const consumed = { ...selectionState, consumed_at: new Date(nowMs).toISOString() };
  if (persist) {
    _deps.writeJsonFileAtomic(_deps.getSpeakerSelectionFile(), consumed);
  }
  return consumed;
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

const CLI_LIVENESS_PROBE_TIMEOUT_MS = 5000;

/**
 * Is `command` a CLI this process can actually use for a turn?
 *
 * Two questions, both answered before the result is reported live:
 *  1. would dispatching a turn be refused outright on this platform
 *     (`cliDispatchRefusal`)? A flags-only `--version` probe goes through a
 *     Windows `.cmd` shim quite happily, so probing alone would advertise a
 *     speaker whose every turn then fails deterministically.
 *  2. does the CLI answer `--version` (or `--help`) within the probe timeout?
 *
 * Async because the probe has to be abandonable: on the Windows shim path the
 * process started is the interpreter, and a synchronous timeout kills only that
 * pid, leaving the CLI underneath it running (see terminateCliProcess).
 *
 * `spawnFn`, `probeTimeoutMs` and `abandon` are the seams the deadline and the
 * "nothing was spawned" cases are driven through; production callers pass none.
 */
export async function checkCliLiveness(command, {
  spawnFn = spawn,
  probeTimeoutMs = CLI_LIVENESS_PROBE_TIMEOUT_MS,
  abandon = abandonCliProcess,
} = {}) {
  // Nothing but an approved bare command name is ever spawned. A speaker name
  // is caller-supplied (`deliberation_start`'s `first_speaker`, a telepty
  // session id, a manual participant name), so without this gate a value like
  // `/usr/bin/true` would be handed to `spawn` with `--version` on POSIX
  // (R4-01). Refused before anything is resolved or started.
  if (!isApprovedCliCommandName(command)) {
    _deps.appendRuntimeLog(
      "WARN",
      `CLI_PROBE_REFUSED: ${JSON.stringify(String(command).slice(0, 80))} is not an approved CLI command name; nothing was spawned`,
    );
    return false;
  }

  const hint = getCliHint(command);
  const env = { ...process.env };
  // Unset CLAUDECODE to avoid nested session errors
  if (hint?.envPrefix?.includes("CLAUDECODE=")) {
    delete env.CLAUDECODE;
  }

  // Pre-spawn: a CLI this platform can never dispatch is not live, and the
  // reason is logged so a Windows user can see WHY it is not on offer.
  //
  // "Not on PATH" is a normal condition — every absent candidate CLI, and every
  // non-CLI speaker name this function is also called with, reports it — so it
  // is INFO. WARN is reserved for the refusals that mean "installed, and this
  // platform still cannot dispatch it" (R3-11).
  const refusal = cliDispatchRefusal(command);
  if (refusal) {
    _deps.appendRuntimeLog(
      refusal.code === "E_CLI_NOT_FOUND" ? "INFO" : "WARN",
      `CLI_NOT_DISPATCHABLE: ${command} | ${refusal.code}: ${refusal.reason}`,
    );
    return false;
  }

  // A bare command name cannot reach a Windows `.cmd` shim, so resolve the
  // invocation first (no prompt text is involved here — only fixed flags).
  const probe = (probeArgs) => new Promise((resolve) => {
    const inv = buildCliInvocation(command, probeArgs);
    if (!inv.ok) { resolve(false); return; }

    let child;
    try {
      child = spawnFn(inv.file, inv.args, {
        stdio: "ignore",
        windowsHide: true,
        env,
        ...inv.options,
      });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    let forceTimer = null;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      // On the Windows shim path the process we hold is the interpreter, so the
      // deadline has to close the tree (R2-02) and escalate only if the child
      // survives it (R3-05) — both in abandonCliProcess, which is tested
      // directly (R3-08).
      forceTimer = abandon(child, { viaInterpreter: inv.viaInterpreter === true });
      settle(false);
    }, probeTimeoutMs);

    child.on("error", () => settle(false));
    child.on("close", (code) => settle(code === 0));
  });

  if (await probe(["--version"])) return true;
  // --version failed, try --help as fallback
  return probe(["--help"]);
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
      const live = await checkCliLiveness(cli);
      // When it is not live, say whether the platform refused the dispatch
      // outright (and with which code) rather than leaving a bare ❌.
      const refusal = live ? null : cliDispatchRefusal(cli);
      add({
        speaker: cli,
        type: "cli",
        label: cli,
        command: cli,
        live,
        live_reason: refusal ? refusal.code : null,
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
    // transport. The browser adapter will create/navigate tabs on demand if needed.
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
      // A refusal code (E_CLI_*) means this platform decided before spawning
      // that it can never dispatch a turn to this CLI — see runtime.log for the
      // full reason.
      const reason = c.live === false && c.live_reason ? ` (${c.live_reason})` : "";
      const status = c.live === false ? ` ❌ not executable${reason}` : c.live === true ? " ✅ executable" : "";
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
