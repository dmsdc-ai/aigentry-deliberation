// ADR-264 §2.3 — Spawn Isolation (BUG-008)
// Covers merge-blocker metric M6: 5 malicious paths each mapped to specific error code.
// Also covers §2.3 step 5 (session_id sanitize via safeId) and step 6 (session-unique subdir creation).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateSpawnCwd, sanitizeSessionDirName, ensureSessionSubdir } from '../index.js';

describe('ADR-264 §2.3 — validateSpawnCwd (M6 security matrix)', () => {
  let tmpRoot;
  let symlinkOutside;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adr264-spawn-'));
    // Symlink pointing to "/" (outside any allowed prefix) to exercise symlink escape.
    symlinkOutside = path.join(tmpRoot, 'escape-link');
    try { fs.symlinkSync('/', symlinkOutside); } catch { /* best effort */ }
  });

  afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it('rejects relative path with E_CWD_NOT_ABSOLUTE', () => {
    const result = validateSpawnCwd('../foo', { allowedPrefixes: [tmpRoot] });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_CWD_NOT_ABSOLUTE');
  });

  it('rejects nonexistent absolute path with E_CWD_NOT_FOUND', () => {
    const ghost = path.join(tmpRoot, 'does-not-exist-xyz');
    const result = validateSpawnCwd(ghost, { allowedPrefixes: [tmpRoot] });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_CWD_NOT_FOUND');
  });

  it('rejects path outside allowedPrefixes with E_CWD_NOT_ALLOWED', () => {
    // "/etc" exists on Darwin/Linux but is outside the configured prefixes.
    const result = validateSpawnCwd('/etc', { allowedPrefixes: [tmpRoot] });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_CWD_NOT_ALLOWED');
  });

  it('rejects symlink that escapes allowedPrefixes with E_CWD_SYMLINK_ESCAPE', () => {
    // Our symlink points to "/", which resolves outside tmpRoot.
    const result = validateSpawnCwd(symlinkOutside, { allowedPrefixes: [tmpRoot] });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_CWD_SYMLINK_ESCAPE');
  });

  it('accepts an allowed absolute path with no symlink and returns resolved path', () => {
    const result = validateSpawnCwd(tmpRoot, { allowedPrefixes: [tmpRoot] });
    expect(result.ok).toBe(true);
    expect(result.resolved).toBeTruthy();
    // fs.realpathSync resolves symlinks in the prefix too (e.g. /tmp → /private/tmp on macOS).
    expect(result.input).toBe(tmpRoot);
  });

  it('defaults allowedPrefixes to $HOME + $TMPDIR when not supplied', () => {
    const result = validateSpawnCwd(tmpRoot);
    expect(result.ok).toBe(true);
  });
});

describe('ADR-264 §2.3 step 5 — sanitizeSessionDirName (safeId reuse)', () => {
  it('passes safe ascii + korean + dot + dash + underscore unchanged', () => {
    expect(sanitizeSessionDirName('session_2026-04-19.bench_한글.1')).toBe(
      'session_2026-04-19.bench_한글.1',
    );
  });

  it('replaces slashes with underscore (dots stay, matching withSessionLock safeId regex)', () => {
    // ADR-264 §2.3 step 5 uses the same regex as withSessionLock: `.` survives.
    expect(sanitizeSessionDirName('../escape/me')).toBe('.._escape_me');
  });

  it('replaces null bytes and slashes', () => {
    expect(sanitizeSessionDirName('a/b\u0000c')).toBe('a_b_c');
  });
});

describe('ADR-264 §2.3 step 6 — ensureSessionSubdir', () => {
  let tmpRoot;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adr264-subdir-'));
  });

  afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it('creates a session-unique subdirectory under the resolved cwd', () => {
    const out = ensureSessionSubdir(tmpRoot, 'bench-orch-001');
    expect(fs.existsSync(out)).toBe(true);
    expect(path.basename(out)).toBe('bench-orch-001');
  });

  it('is idempotent when caller has already pointed at the session subdir', () => {
    const explicit = path.join(tmpRoot, 'bench-orch-002');
    fs.mkdirSync(explicit, { recursive: true });
    const out = ensureSessionSubdir(explicit, 'bench-orch-002');
    // When basename matches sanitized session_id, no nested duplicate.
    expect(out).toBe(explicit);
  });

  it('sanitizes malicious session_id and keeps the subdir under the resolved cwd', () => {
    const out = ensureSessionSubdir(tmpRoot, '../../etc');
    expect(out.startsWith(tmpRoot)).toBe(true);
    // Slashes replaced with underscore; dots survive per ADR-264 §2.3 step 5.
    expect(path.basename(out)).toBe('.._.._etc');
  });

  it('refuses to resolve to a parent directory when session_id is literally "."', () => {
    // Defensive: bare `.` or `..` survive the regex. ensureSessionSubdir must
    // still not climb above the caller's cwd.
    const out = ensureSessionSubdir(tmpRoot, '..');
    expect(out.startsWith(tmpRoot)).toBe(true);
    expect(path.basename(out)).not.toBe('..');
  });
});
