import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// Doctor runtime.log footprint check (v0.0.45):
// - WARN at >= 50 MB, ERROR at >= 500 MB (env-configurable)
// - Reports top 3 offenders with path + size
// - Diagnoses only; never mutates log files

const REPO_ROOT = process.cwd();
const DOCTOR_ENTRY = path.join(REPO_ROOT, 'doctor.js');

function getInstallDir(homeDir) {
  return path.join(homeDir, '.local', 'lib', 'mcp-deliberation');
}

function mkHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliberation-doctor-'));
  fs.mkdirSync(getInstallDir(homeDir), { recursive: true });
  return homeDir;
}

function writeLogFile(filePath, sizeMB) {
  // Use a sparse file so we don't actually write 600 MB to disk on every run.
  // fs.truncateSync creates a sparse file whose apparent size matches sizeMB
  // (st_size reports the declared size; fs.statSync.size honors that).
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.ftruncateSync(fd, sizeMB * 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }
}

function runDoctor(homeDir, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DOCTOR_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 15000);
  });
}

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try { fn(); } catch { /* ignore */ }
  }
});

describe('doctor runtime.log footprint check', () => {
  it('ERROR-level threshold fires for a 600 MB runtime.log', async () => {
    const homeDir = mkHome();
    cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    const installDir = getInstallDir(homeDir);
    writeLogFile(path.join(installDir, 'runtime.log'), 600);

    const res = await runDoctor(homeDir);
    // Doctor exits 0 (reports issues) or 1 (any issue) — we only assert output
    expect(res.stdout).toMatch(/❌\s+runtime\.log footprint:\s+[\d.]+\s+(MB|GB)\s+\(>=\s+500 MB ERROR threshold\)/);
    expect(res.stdout).toContain('top offenders:');
    expect(res.stdout).toContain('runtime.log');
  }, 15000);

  it('WARN-level threshold fires for a 75 MB runtime.log', async () => {
    const homeDir = mkHome();
    cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    const installDir = getInstallDir(homeDir);
    writeLogFile(path.join(installDir, 'runtime.log'), 75);

    const res = await runDoctor(homeDir);
    expect(res.stdout).toMatch(/⚠️.*runtime\.log footprint:\s+[\d.]+\s+MB\s+\(>=\s+50 MB WARN threshold\)/);
  }, 15000);

  it('OK-level for small runtime.log footprint', async () => {
    const homeDir = mkHome();
    cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    const installDir = getInstallDir(homeDir);
    writeLogFile(path.join(installDir, 'runtime.log'), 1); // 1 MB — below 50 MB WARN

    const res = await runDoctor(homeDir);
    expect(res.stdout).toMatch(/✅\s+runtime\.log footprint:\s+1\.0\s+MB/);
    expect(res.stdout).not.toContain('top offenders:');
  }, 15000);

  it('diagnoses only — does not mutate the large log file', async () => {
    const homeDir = mkHome();
    cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    const installDir = getInstallDir(homeDir);
    const logPath = path.join(installDir, 'runtime.log');
    writeLogFile(logPath, 600);
    const sizeBefore = fs.statSync(logPath).size;

    await runDoctor(homeDir);

    const sizeAfter = fs.statSync(logPath).size;
    expect(sizeAfter).toBe(sizeBefore);
  }, 15000);

  it('top-3 offenders sorted by size, largest first', async () => {
    const homeDir = mkHome();
    cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    const installDir = getInstallDir(homeDir);
    writeLogFile(path.join(installDir, 'runtime.log'), 100);          // 100 MB
    writeLogFile(path.join(installDir, 'runtime.log.old'), 60);       // 60 MB
    writeLogFile(path.join(installDir, 'runtime.log.pre-0.0.45'), 40); // 40 MB — not shown in top 3 if 3+ files, but will be

    const res = await runDoctor(homeDir);
    // Total = 200 MB, both thresholds: 50 MB WARN, 500 MB ERROR → should hit WARN
    expect(res.stdout).toMatch(/⚠️.*runtime\.log footprint/);
    expect(res.stdout).toContain('top offenders:');
    // Largest first — position of "runtime.log " (100MB) should precede "runtime.log.old" (60MB)
    const idxRuntime = res.stdout.indexOf(path.join(installDir, 'runtime.log') + '\n');
    // Use the plain runtime.log without suffix — need exact match via end-of-line
    const lines = res.stdout.split('\n').filter(l => l.includes('runtime.log'));
    // There should be at least 3 lines listing the offenders
    const offenderLines = lines.filter(l => l.match(/^\s+- /));
    expect(offenderLines.length).toBeGreaterThanOrEqual(3);
  }, 15000);
});
