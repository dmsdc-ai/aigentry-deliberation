/**
 * CLI process domain — the single launch path for provider CLI commands
 * (claude / codex / gemini and configured equivalents).
 *
 * Why this module exists: those CLIs are installed on Windows as `<name>.cmd`
 * shims. `child_process.spawn`/`execFileSync` do not apply PATHEXT and cannot
 * execute a `.cmd` without a shell, so every bare-name launch fails on win32
 * with an asynchronous ENOENT and no pid. `cross-spawn` performs the PATH +
 * PATHEXT resolution and the cmd.exe quoting itself, per argument, so no
 * untrusted prompt/model/flag value is ever concatenated into a shell string.
 *
 * Scope: provider CLI invocation only. tmux, osascript, Chrome and terminal
 * management calls keep using `child_process` directly.
 */

import crossSpawn from "cross-spawn";
import { spawnSync } from "node:child_process";
import { getSystemErrorMap } from "node:util";

/**
 * libuv's numeric error number for ENOENT on THIS platform, read out of Node's
 * own system error table: -2 on POSIX, -4058 on win32. Node stamps exactly this
 * value onto a real spawn ENOENT, so it is the only correct value to use when
 * restoring the native error shape below.
 *
 * Deliberately NOT `os.constants.errno.ENOENT` — that is the plain C errno (2 on
 * both platforms), not the libuv number Node reports — and deliberately not a
 * hard-coded per-platform literal. `util.getSystemErrorMap()` is the supported
 * primitive that already ships with the runtime; nothing new is added to the
 * dependency set, and no permission, API or provider choice changes.
 *
 * Reading the table is a pure lookup: no process is started and nothing is
 * resolved at import time. If the table ever lacks the entry, the shape cannot
 * be established at all and the unresolved-command case below REFUSES with an
 * explicit error rather than guessing an errno or leaving a string one in place.
 */
const UV_ENOENT = (() => {
  for (const [errno, [name]] of getSystemErrorMap()) {
    if (name === "ENOENT") return errno;
  }
  return undefined;
})();

/**
 * The human-approved fixed calibration operand, verbatim. `|` is not a legal
 * Windows filename character and no such path exists, so `GetFileAttributesW`
 * fails, libuv reports UV_ENOENT and `CreateProcessW` is never reached.
 *
 * It is a CONSTANT: never derived from a caller's command, argument, cwd, env or
 * PATH, so nothing a caller supplies is ever re-executed or replayed here.
 *
 * Measured, not assumed: native CI 36311416695 at 3ab75ab ran this literal and a
 * verified-absent absolute path inside an owned temp directory through the same
 * `spawnSync` on both pinned runtimes (job 108597954452 / Node 20.20.0, job
 * 108597954349 / Node 22.23.2) and the two operands produced IDENTICAL shapes in
 * every field on each runtime — `verdict=calibrated failures=0`. On this
 * platform the literal therefore behaves exactly as a genuinely unresolvable
 * command, which is what makes it a valid yardstick for one.
 */
const CALIBRATION_TARGET = "C:\\aigentry-cli-process-calibration|target";

/**
 * The bounded options that native probe validated, and only those: no arguments,
 * an empty env (so no PATH is consulted), no inherited or captured stdio, no
 * shell, no console window, and a hard 1s deadline. No temp file, no binary
 * install, no network.
 */
const CALIBRATION_OPTIONS = Object.freeze({
  env: {},
  stdio: "ignore",
  shell: false,
  windowsHide: true,
  timeout: 1000,
});

/** Distinct, greppable code for the refusal below. Never a generic ENOENT. */
const CALIBRATION_UNAVAILABLE_CODE = "ERR_CLI_PROCESS_ENOENT_CALIBRATION_UNAVAILABLE";

/**
 * Per-process memo of the ONE probe: `{ ok: true, ...shape }` on success,
 * `{ ok: false, reason }` on refusal. Both verdicts are cached, so a repeated
 * miss never re-probes and a failed calibration never retries.
 */
let calibration = null;

/** A bounded token for a diagnostic. Never a message, path, stream or env value. */
function reasonToken(error) {
  const code = error && error.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "other";
}

function isNullOrUndefined(value) {
  return value === null || value === undefined;
}

/**
 * Ask THIS runtime what its own unresolvable-command `spawnSync` result looks
 * like, by running the approved fixed literal once.
 *
 * WHY A MEASUREMENT AND NOT A CONSTANT: Node derives a failed spawn's
 * `stdout`/`stderr` from its null `output` in shipped `internal/child_process`,
 * and changed the derivation — `result.output && result.output[1]` on 20.20.0
 * versus `result.output?.[1]` on 22.23.2 — so both fields are `null` up to Node
 * 20 and `undefined` from Node 22, while `output` itself stays `null` and every
 * other field of the shape is unchanged. A literal (either one) is a runtime
 * constant masquerading as a contract, and a Node-version switch just encodes
 * the 20->22 boundary as one release's accident. The running runtime is the only
 * sound authority for its own derivation, so it is asked directly.
 *
 * Every load-bearing field is validated before the shape is accepted, and each
 * rejection is a separate bounded token. A throw, a timeout, a malformed result,
 * an unexpected field or a missing UV_ENOENT all end in refusal: no platform
 * literal, no version switch, no silent default, no fallback shape.
 */
function measureUnresolvedShape() {
  // Without the runtime's numeric ENOENT there is nothing to validate the probe
  // against and nothing correct to stamp onto the error. Refuse; never guess.
  if (UV_ENOENT === undefined) return { ok: false, reason: "enoent-errno-unresolved" };

  let result;
  try {
    result = spawnSync(CALIBRATION_TARGET, [], CALIBRATION_OPTIONS);
  } catch (probeError) {
    return { ok: false, reason: `probe-threw(${reasonToken(probeError)})` };
  }
  if (result === null || typeof result !== "object") return { ok: false, reason: "probe-result-not-object" };

  const err = result.error;
  // An unresolvable command must fail as one: a present ENOENT error carrying
  // this runtime's NUMERIC errno. A timeout, or any other error, lands here.
  if (!err) return { ok: false, reason: "probe-error-absent" };
  if (err.code !== "ENOENT") return { ok: false, reason: "probe-error-code-not-enoent" };
  if (typeof err.errno !== "number") return { ok: false, reason: "probe-errno-not-number" };
  if (err.errno !== UV_ENOENT) return { ok: false, reason: "probe-errno-not-runtime-enoent" };
  // The runtime-invariant fields of the shape, asserted rather than assumed.
  if (result.status !== null) return { ok: false, reason: "probe-status-not-null" };
  if (result.signal !== null) return { ok: false, reason: "probe-signal-not-null" };
  if (result.output !== null) return { ok: false, reason: "probe-output-not-null" };
  // pid 0 is what proves the probe created no process, i.e. that this really is
  // the unresolved path and not a command that ran and failed.
  if (result.pid !== 0) return { ok: false, reason: "probe-pid-not-zero" };
  // The one pair that moves between runtimes. Exactly two variants are accepted;
  // a Buffer, a string or anything else means the derivation is not the one this
  // correction was measured against.
  if (!isNullOrUndefined(result.stdout)) return { ok: false, reason: "probe-stdout-not-null-or-undefined" };
  if (!isNullOrUndefined(result.stderr)) return { ok: false, reason: "probe-stderr-not-null-or-undefined" };

  return {
    ok: true,
    status: result.status,
    signal: result.signal,
    output: result.output,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** The one probe, memoized in both directions. */
function calibratedUnresolvedShape() {
  if (calibration === null) calibration = measureUnresolvedShape();
  return calibration;
}

/**
 * The refusal. Distinct from the ENOENT it replaces, so a caller cannot mistake
 * an uncalibrated runtime for a missing CLI, and the original cross-spawn
 * resolution error is preserved verbatim as `cause` so nothing is lost. The
 * message carries only the bounded reason token: no command, argument, path,
 * stream byte or env value is logged or attached.
 */
function calibrationUnavailableError(reason, resolutionError) {
  const error = new Error(
    "provider CLI command could not be resolved, and this runtime's native " +
      `unresolved-command shape could not be calibrated (reason: ${reason})`,
    { cause: resolutionError },
  );
  error.code = CALIBRATION_UNAVAILABLE_CODE;
  error.calibrationReason = reason;
  return error;
}

/**
 * Restore Node's native `spawnSync` failure shape for a command cross-spawn
 * could not resolve at all.
 *
 * MEASURED DIVERGENCE (native win32, CI 36215641444 / WindowsNode20 job
 * 108330955350): on win32 cross-spawn routes the command through
 * `cmd.exe /d /s /c`. When the name resolves to nothing, cmd.exe itself still
 * starts, prints its own localized "is not recognized as an internal or external
 * command" line and exits 1 — so the raw `spawnSync` result reads exactly like a
 * genuine failed command: `status: 1`, a non-empty `stderr`, a 3-element
 * `output`. cross-spawn recognises the case in `lib/enoent.js verifyENOENTSync`,
 * which fires only when `status === 1` AND `parsed.file` is falsy, i.e. only when
 * its own `resolveCommand` found nothing on PATH/PATHEXT, and attaches its
 * `notFoundError`. That error carries `errno: "ENOENT"` as a STRING and leaves
 * the misleading status/stream fields in place.
 *
 * Node's real `spawnSync` for an unresolvable command reports `status: null`,
 * `signal: null`, `output: null`, a NUMERIC errno, and `stdout`/`stderr` derived
 * from that null `output` — `null` up to Node 20, `undefined` from Node 22 (see
 * `measureUnresolvedShape`); `execFileSync` then copies those fields onto the
 * error it throws. A caller that branches on `err.status`, reads `err.stderr`, or
 * compares `err.errno` numerically therefore behaves differently on Windows than
 * on POSIX unless the result is normalized here.
 *
 * The stream pair is taken from the running runtime's own measurement rather than
 * written as a literal, because a literal is only ever correct for the runtimes
 * that shipped that derivation: the earlier `null` hard-coding was accurate on
 * Node 20 and OVER-corrected from Node 22 on, replacing one divergence with
 * another. Nothing here switches on a Node version or a platform errno literal.
 *
 * Narrowness, deliberately:
 *   - The trigger is cross-spawn's own resolution verdict, surfaced as a STRING
 *     `errno` on a `code: "ENOENT"` error, on win32. Node never produces a string
 *     errno, so this cannot capture a real spawn error; and a non-zero exit from a
 *     command that DID resolve never reaches here at all, because cross-spawn
 *     requires `!parsed.file` before it synthesizes anything. No arbitrary
 *     command failure is swallowed.
 *   - `verifyENOENTSync` only synthesizes on win32, and POSIX needs no correction
 *     because Node's own shape is already what it reports, so the whole
 *     calibration path is unreachable there: no POSIX call ever probes.
 *   - The probe runs at most ONCE per process, lazily, on the first actual miss.
 *     A successful command, and an import, do no process work whatsoever.
 *   - cmd.exe's message is never read, parsed or matched. The discriminator is
 *     the error object's own fields, so behaviour does not depend on the
 *     runner's console codepage or UI language.
 *   - The caller's command, arguments and options are never re-resolved,
 *     re-executed or replayed: the probe's operand and options are fixed
 *     constants. No command or argument quoting is performed here. `message`,
 *     `code`, `syscall`, `path` and `spawnargs` are cross-spawn's own and already
 *     match Node's.
 *   - If the shape cannot be established, the case REFUSES (see
 *     `calibrationUnavailableError`) instead of half-correcting.
 *
 * Residual, reported rather than hidden: on win32 a cmd.exe process genuinely
 * ran, so `result.pid` is that real (already-exited) pid, whereas Node starts
 * nothing and the probe accordingly measures `pid: 0`. That measured `0` is
 * deliberately NOT copied over: it would assert that no process was created,
 * which is false here. Suppressing the pid for real would mean resolving the
 * command ourselves before launching — a second lookup and hand-rolled quoting,
 * both excluded.
 */
function normalizeUnresolvedCommand(result) {
  const err = result.error;
  if (!err || err.code !== "ENOENT" || typeof err.errno !== "string") {
    return result;
  }
  if (process.platform !== "win32") {
    return result;
  }
  const shape = calibratedUnresolvedShape();
  if (!shape.ok) {
    throw calibrationUnavailableError(shape.reason, err);
  }
  err.errno = UV_ENOENT;
  result.status = shape.status;
  result.signal = shape.signal;
  result.stdout = shape.stdout;
  result.stderr = shape.stderr;
  result.output = shape.output;
  return result;
}

/**
 * Asynchronous provider CLI launch. Drop-in for `child_process.spawn`:
 * returns the live ChildProcess with the caller's stdio handles intact.
 *
 * ENOENT contract: on win32 cross-spawn re-emits an unresolvable command as an
 * `'error'` event carrying `code: "ENOENT"` instead of the `'exit'` event, so
 * callers that reject on `'error'` keep behaving as they do today; `'close'`
 * still fires afterwards and remains safe for `settled`-guarded handlers. The
 * `code` every caller in this product branches on is the same on both
 * platforms. `errno` on that async error is still cross-spawn's string, and is
 * left alone: no caller reads it, there is no status/stream field to correct on
 * an event that replaces `'exit'`, and rewriting it would be a change nothing
 * measured asked for. Nothing on this path calibrates or probes.
 */
export function spawnCliCommand(command, args = [], options = {}) {
  return crossSpawn(command, args, options);
}

/**
 * Mirrors Node's `checkExecSyncError` (lib/child_process.js) so the thrown
 * error is indistinguishable from the one `execFileSync` raises: the spawn
 * error itself when there is one, otherwise a `Command failed:` error, in both
 * cases carrying the spawnSync result fields (status, signal, pid, output,
 * stdout, stderr).
 */
function checkExecSyncError(result, command, args) {
  if (result.error) {
    return Object.assign(result.error, result);
  }
  if (result.status !== 0) {
    let msg = `Command failed: ${[command, ...args].join(" ")}`;
    if (result.stderr && result.stderr.length > 0) {
      msg += `\n${result.stderr.toString()}`;
    }
    return Object.assign(new Error(msg), result);
  }
  return null;
}

/**
 * Synchronous provider CLI invocation. Drop-in for `child_process.execFileSync`:
 * returns stdout on success (Buffer, or a string when `encoding` is set) and
 * throws on a spawn error, a signal death or a non-zero status, with the same
 * error shape. Like `execFileSync` it writes the child's stderr through to the
 * parent's stderr when the caller did not pass `stdio`. Caller `input`, `env`,
 * `cwd`, `timeout`, `maxBuffer`, `encoding` and `stdio` are passed through
 * untouched; no error is swallowed and no invocation is retried.
 *
 * The one unresolvable-command case is normalized back to Node's shape first —
 * before the stderr pass-through, so that cmd.exe's own localized "not
 * recognized" line is not printed to the parent for a command Node would have
 * failed silently, and before `checkExecSyncError`, so the fields copied onto
 * the thrown error are the native ones. If that runtime's shape cannot be
 * calibrated, the normalization throws its own explicit error from here, with
 * cross-spawn's resolution error as `cause`, instead of reporting a shape it did
 * not measure. See `normalizeUnresolvedCommand`.
 */
export function execFileSyncCliCommand(command, args = [], options = {}) {
  const inheritStderr = !options.stdio;
  const result = normalizeUnresolvedCommand(crossSpawn.sync(command, args, options));
  if (inheritStderr && result.stderr) {
    process.stderr.write(result.stderr);
  }
  const error = checkExecSyncError(result, command, args);
  if (error) throw error;
  return result.stdout;
}
