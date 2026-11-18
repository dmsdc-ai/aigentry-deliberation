// Regression guard for the silent MCP-server death behind the red CI on
// ubuntu/windows (`deliberation-e2e` self_turn cases timing out at
// "timeout waiting for archive").
//
// runCliAutoTurnCore / generateAutoSynthesis feed the turn prompt to a spawned
// CLI over a pipe. A CLI that never reads stdin — or that exits before draining
// it — closes the read end, so the write fails with EPIPE. `child.stdin` is a
// stream, so an EPIPE with no `error` listener is promoted to a process-level
// uncaughtException, and the broken-stdio guard in index.js matches ANY
// EPIPE-shaped error and answers with `process.exit(0)`. The MCP server then
// disappears mid-deliberation: no synthesis, no archive, exit status 0, nothing
// on stderr.
//
// These cases pin the invariant that makes that impossible: the write is always
// guarded, and a broken pipe on a child's stdin is absorbed instead of being
// turned into a process-level fault.

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { writeCliStdin } from '../lib/transport.js';

// A CLI that writes its answer and exits without ever reading stdin. This is
// exactly the shape of the CI stub in deliberation-e2e.test.js (writeStubCli),
// and of any real CLI that ignores stdin or dies early.
function spawnStubIgnoringStdin() {
  return spawn(process.execPath, ['-e', "process.stdout.write('[STUB] ok [AGREE]')"], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function onceExited(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}

describe('writeCliStdin — broken pipe on a spawned CLI must not become a process fault', () => {
  it('attaches an error listener before writing, so an EPIPE is never promoted to uncaughtException', async () => {
    const child = spawnStubIgnoringStdin();
    try {
      writeCliStdin(child, 'turn prompt');

      // Without a listener, EventEmitter.emit('error', ...) throws synchronously
      // and Node reports it as an uncaughtException. That is the precise step
      // that killed the server, so assert the listener is in place.
      expect(child.stdin.listenerCount('error')).toBeGreaterThan(0);

      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      expect(() => child.stdin.emit('error', epipe)).not.toThrow();

      // Non-broken-pipe stdin errors must also stay contained (they are logged).
      const other = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      expect(() => child.stdin.emit('error', other)).not.toThrow();
    } finally {
      await onceExited(child);
    }
  });

  it('survives a real write to an already-closed child stdin and still yields the child stdout', async () => {
    const child = spawnStubIgnoringStdin();
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });

    const closed = new Promise((resolve) => child.once('close', resolve));

    // Wait for the CLI to exit first, so the pipe is provably dead before the
    // write. This removes the scheduling race that made the CI failure look
    // intermittent (dash on Ubuntu exits sooner than bash on macOS).
    await onceExited(child);
    expect(() => writeCliStdin(child, 'x'.repeat(256 * 1024))).not.toThrow();

    // Give the failed write a turn of the loop to surface its error event.
    await new Promise((r) => setTimeout(r, 50));
    await closed;

    // The contract the call sites rely on: the child's exit code and stdout
    // decide the turn, and a broken stdin pipe does not take the process down.
    expect(child.exitCode).toBe(0);
    expect(stdout).toContain('[STUB] ok');
  });

  it('is a no-op when the child has no stdin pipe', () => {
    expect(() => writeCliStdin({}, 'prompt')).not.toThrow();
    expect(() => writeCliStdin(null, 'prompt')).not.toThrow();
  });
});
