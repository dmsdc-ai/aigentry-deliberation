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
 * If the table ever lacks the entry the errno is left exactly as cross-spawn set
 * it rather than guessed at.
 */
const UV_ENOENT = (() => {
  for (const [errno, [name]] of getSystemErrorMap()) {
    if (name === "ENOENT") return errno;
  }
  return undefined;
})();

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
 * `signal: null`, `stdout: null`, `stderr: null`, `output: null` and a NUMERIC
 * errno; `execFileSync` then copies those fields onto the error it throws. A
 * caller that branches on `err.status`, reads `err.stderr`, or compares
 * `err.errno` numerically therefore behaves differently on Windows than on
 * POSIX unless the result is normalized here.
 *
 * Narrowness, deliberately:
 *   - The trigger is cross-spawn's own resolution verdict, surfaced as a STRING
 *     `errno` on a `code: "ENOENT"` error. Node never produces a string errno,
 *     so this cannot capture a real spawn error; and a non-zero exit from a
 *     command that DID resolve never reaches here at all, because cross-spawn
 *     requires `!parsed.file` before it synthesizes anything. No arbitrary
 *     command failure is swallowed.
 *   - cmd.exe's message is never read, parsed or matched. The discriminator is
 *     the error object's own fields, so behaviour does not depend on the
 *     runner's console codepage or UI language.
 *   - Nothing is re-executed, nothing is resolved a second time, and no command
 *     or argument quoting is performed here. `message`, `code`, `syscall`,
 *     `path` and `spawnargs` are cross-spawn's own and already match Node's.
 *
 * Residual, reported rather than hidden: on win32 a cmd.exe process genuinely
 * ran, so `result.pid` is that real (already-exited) pid, whereas Node starts
 * nothing. Suppressing it would mean resolving the command ourselves before
 * launching — a second lookup and hand-rolled quoting, both excluded.
 */
function normalizeUnresolvedCommand(result) {
  const err = result.error;
  if (!err || err.code !== "ENOENT" || typeof err.errno !== "string") {
    return result;
  }
  if (UV_ENOENT !== undefined) err.errno = UV_ENOENT;
  result.status = null;
  result.signal = null;
  result.stdout = null;
  result.stderr = null;
  result.output = null;
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
 * measured asked for.
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
 * the thrown error are the native ones. See `normalizeUnresolvedCommand`.
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
