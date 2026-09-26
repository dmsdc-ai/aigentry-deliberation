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

/**
 * Asynchronous provider CLI launch. Drop-in for `child_process.spawn`:
 * returns the live ChildProcess with the caller's stdio handles intact.
 *
 * ENOENT contract: on win32 cross-spawn re-emits an unresolvable command as an
 * `'error'` event carrying `code: "ENOENT"` instead of the `'exit'` event, so
 * callers that reject on `'error'` keep behaving as they do today; `'close'`
 * still fires afterwards and remains safe for `settled`-guarded handlers.
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
 */
export function execFileSyncCliCommand(command, args = [], options = {}) {
  const inheritStderr = !options.stdio;
  const result = crossSpawn.sync(command, args, options);
  if (inheritStderr && result.stderr) {
    process.stderr.write(result.stderr);
  }
  const error = checkExecSyncError(result, command, args);
  if (error) throw error;
  return result.stdout;
}
