import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// These tests exercise the v0.0.45 runtime.log hardening:
// - explicit .old cleanup on rotation (Bug 1)
// - hard-cap in-place truncation on overflow (Bug 1 race protection)
// - dedup of identical messages within window
// - EPIPE reentrance guard and broadened detection (Bug 2)
//
// The runtime log lives at $HOME/.local/lib/mcp-deliberation/runtime.log. Tests
// override HOME to a temp dir so every run is isolated. Logging is driven via a
// small child-process harness that imports index.js (which installs the handlers
// and exposes appendRuntimeLog as a side effect of module init).

const REPO_ROOT = process.cwd();

function getInstallDir(homeDir) {
  return path.join(homeDir, '.local', 'lib', 'mcp-deliberation');
}

function getLogPath(homeDir) {
  return path.join(getInstallDir(homeDir), 'runtime.log');
}

function mkHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliberation-rtlog-'));
  fs.mkdirSync(getInstallDir(homeDir), { recursive: true });
  return homeDir;
}

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try { fn(); } catch { /* ignore */ }
  }
});

// Run a short node script that imports index.js and invokes appendRuntimeLog.
// Returns { stdout, stderr, exitCode } after the child exits.
async function runNodeScript(homeDir, script, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        AIGENTRY_TIER: 'free',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
    // Safety timeout
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 15000);
  });
}

describe('appendRuntimeLog rotation + dedup (Bug 1, Dedup)', () => {
  it('rotates with explicit .old cleanup; total footprint stays bounded across many rotations', async () => {
    const homeDir = mkHome();
    cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    // Produce ~40 KB lines × 1500 writes ≈ 60 MB of raw output.
    // With DELIBERATION_LOG_MAX_SIZE_MB=1 and LOG_HARD_CAP_BYTES=2 MB, total
    // footprint must stay at or below 4 MB (runtime.log + runtime.log.old,
    // each <= 2 MB hard cap).
    const script = `
      const { appendRuntimeLog } = await import('${path.join(REPO_ROOT, 'index.js').replace(/\\/g, '\\\\')}');
      const filler = 'A'.repeat(40 * 1024);
      for (let i = 0; i < 1500; i++) {
        appendRuntimeLog('INFO', \`write-\${i}-\${filler}\`);
      }
    `;
    const res = await runNodeScript(homeDir, script, {
      DELIBERATION_LOG_MAX_SIZE_MB: '1',
      DELIBERATION_LOG_TOTAL_BUDGET_MB: '10',
      DELIBERATION_LOG_DEDUP_MS: '0', // disable dedup to exercise rotation path
    });
    expect(res.exitCode, res.stderr).toBe(0);

    const dir = getInstallDir(homeDir);
    let total = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!/^runtime\.log(\.|$)/.test(name)) continue;
      total += fs.statSync(path.join(dir, name)).size;
    }
    // 2 MB hard cap per file × at most 2 files (runtime.log + runtime.log.old)
    // leaves 4 MB ceiling. Allow some slack for final append post-rotate.
    expect(total).toBeLessThanOrEqual(5 * 1024 * 1024);
  }, 20000);

  it('dedups identical messages within window and emits [Nx in Xms] summary', async () => {
    const homeDir = mkHome();
    cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    const script = `
      const { appendRuntimeLog } = await import('${path.join(REPO_ROOT, 'index.js').replace(/\\/g, '\\\\')}');
      for (let i = 0; i < 1000; i++) appendRuntimeLog('WARN', 'repeated_error: EPIPE stacktrace here');
      // Different message to flush the dedup buffer
      appendRuntimeLog('INFO', 'different message — flushes pending dedup');
    `;
    const res = await runNodeScript(homeDir, script, {
      DELIBERATION_LOG_DEDUP_MS: '10000',
    });
    expect(res.exitCode, res.stderr).toBe(0);

    const content = fs.readFileSync(getLogPath(homeDir), 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    // Expected: 1 line for the first WARN, 1 line for the [DEDUP] summary,
    // 1 line for the INFO flush = 3 lines. Allow up to 4 for timing slack.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(content).toMatch(/\[DEDUP\] \[\d+x in \d+ms\]/);
    expect(content).toContain('repeated_error: EPIPE stacktrace here');
    expect(content).toContain('different message');
  }, 20000);

  it('different messages always write (no cross-key suppression)', async () => {
    const homeDir = mkHome();
    cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    const script = `
      const { appendRuntimeLog } = await import('${path.join(REPO_ROOT, 'index.js').replace(/\\/g, '\\\\')}');
      for (let i = 0; i < 50; i++) appendRuntimeLog('INFO', 'unique-message-' + i);
    `;
    const res = await runNodeScript(homeDir, script);
    expect(res.exitCode, res.stderr).toBe(0);

    const content = fs.readFileSync(getLogPath(homeDir), 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    expect(lines.length).toBe(50);
    expect(content).not.toMatch(/\[DEDUP\]/);
  }, 15000);
});

describe('EPIPE reentrance guard (Bug 2)', () => {
  it('synthetic EPIPE-shaped error triggers single log + process.exit(0)', async () => {
    const homeDir = mkHome();
    cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    // Import index.js to install handlers, then throw a bare EPIPE (no stack-amplification).
    // The handler must catch, log once, and exit(0). If the guard missed, Node's default
    // behavior would exit(1) with the stack printed to stderr.
    const script = `
      await import('${path.join(REPO_ROOT, 'index.js').replace(/\\/g, '\\\\')}');
      // Give the MCP server a tick to finish setup before emitting the error
      setImmediate(() => {
        const err = new Error('write EPIPE');
        err.code = 'EPIPE';
        // Emit via process.emit to bypass Node's async-hook wrapping and hit
        // the registered uncaughtException handler directly.
        process.emit('uncaughtException', err);
      });
    `;
    const res = await runNodeScript(homeDir, script);
    expect(res.exitCode).toBe(0);

    const logPath = getLogPath(homeDir);
    const content = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
    const epipeLines = content.split('\n').filter(l => l.includes('Client disconnected'));
    expect(epipeLines.length).toBe(1);
  }, 15000);

  it('second synthetic fatal error is a no-op (reentrance guard)', async () => {
    const homeDir = mkHome();
    cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    // Fire the fatal handler twice in the same tick. The first call sets the
    // reentrance guard and queues process.exit(0); the second call returns
    // immediately, writing NOTHING extra to the log. After the tick, exit runs.
    const script = `
      await import('${path.join(REPO_ROOT, 'index.js').replace(/\\/g, '\\\\')}');
      setImmediate(() => {
        const err1 = new Error('write EPIPE'); err1.code = 'EPIPE';
        const err2 = new Error('write EPIPE again'); err2.code = 'EPIPE';
        process.emit('uncaughtException', err1);
        process.emit('uncaughtException', err2);
      });
    `;
    const res = await runNodeScript(homeDir, script);
    expect(res.exitCode).toBe(0);

    const content = fs.existsSync(getLogPath(homeDir)) ? fs.readFileSync(getLogPath(homeDir), 'utf-8') : '';
    const epipeLines = content.split('\n').filter(l => l.includes('Client disconnected'));
    // Only ONE line, not two — the guard blocked the second entry
    expect(epipeLines.length).toBe(1);
  }, 15000);

  it('broadened detection: message-only EPIPE (no code property) still triggers the guard', async () => {
    const homeDir = mkHome();
    cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    // Some async stream errors arrive wrapped and lose the .code property.
    // The v0.0.45 handler falls back to regex match on the message.
    const script = `
      await import('${path.join(REPO_ROOT, 'index.js').replace(/\\/g, '\\\\')}');
      setImmediate(() => {
        const err = new Error('Uncaught write EPIPE during downstream send');
        // Deliberately no err.code — forces message-based detection.
        process.emit('uncaughtException', err);
      });
    `;
    const res = await runNodeScript(homeDir, script);
    expect(res.exitCode).toBe(0);
    const content = fs.existsSync(getLogPath(homeDir)) ? fs.readFileSync(getLogPath(homeDir), 'utf-8') : '';
    expect(content).toContain('Client disconnected');
  }, 15000);
});

describe('upgrade safety migration', () => {
  it('renames pre-existing >1 MB runtime.log to runtime.log.pre-0.0.45 on first run', async () => {
    const homeDir = mkHome();
    cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    // Seed a large runtime.log pre-upgrade
    const installDir = getInstallDir(homeDir);
    const logPath = path.join(installDir, 'runtime.log');
    fs.writeFileSync(logPath, 'X'.repeat(2 * 1024 * 1024)); // 2 MB

    const script = `
      const { appendRuntimeLog } = await import('${path.join(REPO_ROOT, 'index.js').replace(/\\/g, '\\\\')}');
      appendRuntimeLog('INFO', 'post-upgrade first write');
    `;
    const res = await runNodeScript(homeDir, script);
    expect(res.exitCode, res.stderr).toBe(0);

    expect(fs.existsSync(path.join(installDir, 'runtime.log.pre-0.0.45'))).toBe(true);
    expect(fs.existsSync(path.join(installDir, '.log-upgrade-v0.0.45'))).toBe(true);
    // The new runtime.log should exist and contain the post-upgrade line
    const newLog = fs.readFileSync(logPath, 'utf-8');
    expect(newLog).toContain('post-upgrade first write');
  }, 15000);
});
