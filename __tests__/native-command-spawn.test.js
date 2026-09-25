// aw1172bs — native bare-name CLI spawn reproduction (task 1172, tester harness)
//
// WHY THIS FILE EXISTS
// The frozen analysis (input/evidence/prior-analysis.md §3 "A-Windows") calls
// the Windows auto-turn failure CONFIRMED from source reading alone:
// `lib/transport.js:798` spawns the bare name `claude` with
// `{ env, windowsHide: true }` and no `shell`, while the discovery fixture
// writes its stub as `<name>.cmd` (`__tests__/helpers/cli-discovery-fixture.js`,
// `stubFileName` / `writeStub`). Nobody has executed that spawn natively. This
// harness executes it, and nothing else, so the claim stops being an inference.
//
// It does NOT implement or endorse `shell: true`, does not import or run product
// code, never looks up a host CLI, never authenticates and never opens a network
// connection. The only executables it may name are the fixture it just wrote
// inside its own root, plus `process.execPath` for the positive control.
//
// DECLARED LIMITS
// 1. A Windows red is the deliverable, not a defect of this file. The ordinary
//    positive contract ("the bare fixture executes once and returns the fixed
//    output") is asserted on EVERY platform. On win32 it is expected to fail,
//    and that failure — carrying the captured error phase and code — IS the
//    evidence. It is never skipped and never conditionally passed.
// 2. `transport.js` builds its child env as `{ ...process.env }`. This harness
//    seals the env instead (owned-only PATH, faked HOME/TMP/XDG, owned cwd) so
//    that executable lookup is the only free variable. The *spawn signature* —
//    `spawn(<bare name>, <fixed args>, { env, windowsHide: true })` followed by
//    a fixed `stdin.write()` / `stdin.end()` — is the product's, unchanged.
//    Because that signature carries no `cwd`, the owned cwd is faked by
//    `process.chdir` around the spawn and restored immediately after.
// 3. Scope is the Windows launch only. This says nothing about the Linux
//    archive stall (prior-analysis §4): those jobs log zero RETRY events, so
//    turns do start, and no conclusion here transfers to them.
// 4. No retry and no deadline is added anywhere. Every child is bounded, and
//    only handles this file created are ever signalled — no PID scan, no
//    process-group kill.
// 5. The owned-only PATH is what keeps a host CLI unreachable, and it works
//    because the CHILD env's PATH is what governs lookup on both platforms:
//    libuv reads `PATH=` out of the supplied env block on win32, and sets
//    `environ` to the supplied env before `execvp` on POSIX. The bare name is
//    therefore the product's literal `claude` with no risk of reaching a real
//    CLI: the only directory searched is the one this file just created.
// 6. The frozen analysis predicted a specific mechanism — "spawn does not apply
//    PATHEXT", i.e. ENOENT. This harness does not assume that. It records the
//    error PHASE separately from the code, so a synchronous refusal (a resolved
//    .cmd that Node declines to launch without `shell`) is distinguishable from
//    an async ENOENT (never resolved at all). Those two point at different
//    product fixes, so the distinction is the point of running this natively.
//
// JOIN AND CLEANUP CONTRACT (v2)
// A child is "joined" only when an actual 'exit' or 'close' listener fired, or
// when `spawn` never produced a pid at all (there is no child to outlive
// anything). `child.exitCode` / `child.signalCode` are NEVER consulted:
// `signalCode` reflects the signal this file *requested*, not observed
// termination, so reading it would let an unjoined child be declared dead.
// Escalation is at most one SIGKILL per owned handle, sent once before the join
// wait — not inside a polling loop. If any owned child is still unjoined when
// the cleanup bound expires, the owned root is PRESERVED and cleanup fails with
// a closed reason; the root is never removed out from under a live child, and a
// removal error is never swallowed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const IS_WINDOWS = process.platform === 'win32';

/** The speaker whose spawn site is under reproduction (transport.js:798). */
const SPEAKER = 'claude';

/**
 * Exactly `getCliExecArgs('claude', null)` from lib/transport.js:669-675.
 * Restated rather than imported: this file must not load product code.
 */
const FIXED_ARGS = Object.freeze(['-p', '--output-format', 'text']);

/** Fixed stand-in for `turnPrompt`. Small enough to fit one pipe buffer, so the
 *  write cannot block even though the fixture never drains stdin. */
const FIXED_STDIN = 'aw1172bs fixed turn prompt\n';

/** The one line an owned fixture is allowed to emit. */
const SENTINEL = 'AW1172BS_FIXTURE_OK';

/** Windows' documented default PATHEXT, used only when the host has none. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

const CHILD_BOUND_MS = 5000;     // hard bound on one observed child
const CLEANUP_BOUND_MS = 2000;   // bound on joining own handles before rm
const ERROR_GRACE_MS = 500;      // a failed spawn may emit 'error' with no 'close'
const JOIN_POLL_MS = 50;         // join-wait tick only; nothing is killed here
const EVENT_LOG_CAP = 16;        // keep the persisted event order bounded
const STREAM_CAP_BYTES = 8192;   // retained bytes per stream, enforced on arrival

/** Closed reason set when an owned child could not be joined in time. */
const E_OWNED_CHILD_UNJOINED = 'E_OWNED_CHILD_UNJOINED';

/**
 * Body of an owned fixture, matching the writer contract in
 * `__tests__/helpers/cli-discovery-fixture.js` (`inertStubBody`): CRLF batch on
 * win32, `#!/bin/sh` elsewhere. Inert — no product, no network, no argv
 * inspection — except that it emits the one fixed sentinel line this harness
 * needs in order to tell "executed" from "not found".
 */
function fixtureBody(name) {
  return IS_WINDOWS
    ? `@echo off\r\nrem aw1172bs owned spawn fixture: ${name}\r\necho ${SENTINEL}\r\nexit /b 0\r\n`
    : `#!/bin/sh\n# aw1172bs owned spawn fixture: ${name}\necho ${SENTINEL}\nexit 0\n`;
}

/** Filename the platform's loader would have to resolve for a bare `name`.
 *  Same rule as `stubFileName` in cli-discovery-fixture.js. */
function fixtureFileName(name) {
  return IS_WINDOWS ? `${name}.cmd` : name;
}

/** Same as `writeStub` in cli-discovery-fixture.js: 0o755, chmod on POSIX. */
function writeFixture(dir, name) {
  const file = path.join(dir, fixtureFileName(name));
  fs.writeFileSync(file, fixtureBody(name), { mode: 0o755 });
  if (!IS_WINDOWS) fs.chmodSync(file, 0o755);
  return file;
}

/** The owned JS the positive control runs through the real `process.execPath`.
 *  Free of `import`/`require`, so it loads the same whether Node reads it as
 *  ESM or CJS. */
const OWNED_CONTROL_JS = [
  '// aw1172bs owned positive-control payload. Prints the same fixed line as the',
  '// shell/batch fixture so the two arms are comparable on output alone.',
  `process.stdout.write(${JSON.stringify(`${SENTINEL}\n`)});`,
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Owned state
// ---------------------------------------------------------------------------

let ownedRoot = null;
let ownedBinDir = null;
let ownedCwd = null;
let fixturePath = null;
let controlJsPath = null;
let evidencePath = null;

/** Every handle this file created, so cleanup touches nothing else. */
const ownedHandles = [];

let bareArm = null;
let controlArm = null;
let cleanup = null;
let setupError = null;
let rootRemoval = { removed: false, reason: 'not-attempted' };

/** A handle counts as joined only on an observed 'exit'/'close', or when spawn
 *  never produced a pid. Deliberately does not read exitCode/signalCode. */
function isJoined(h) {
  return h.exitSeen || h.closeSeen || !h.pidPresent;
}

/** Strip host-specific prefixes from anything that gets persisted or asserted. */
function sanitize(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  const swaps = [
    [ownedRoot, '<OWNED_ROOT>'],
    [path.dirname(process.execPath), '<NODE_DIR>'],
    [os.tmpdir(), '<TMPDIR>'],
    [os.homedir(), '<HOME>'],
  ];
  for (const [needle, label] of swaps) {
    if (!needle) continue;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, IS_WINDOWS ? 'gi' : 'g'), label);
  }
  return out;
}

function deepSanitize(node) {
  if (typeof node === 'string') return sanitize(node);
  if (Array.isArray(node)) return node.map(deepSanitize);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deepSanitize(v)]));
  }
  return node;
}

/**
 * The sealed child environment. Built key by key rather than spread from
 * `process.env`, so no host CLI directory, credential or product switch can
 * reach the child. PATH holds exactly one entry: the owned bin dir.
 */
function sealedEnv(arm) {
  const env = {
    PATH: ownedBinDir,
    HOME: path.join(ownedRoot, 'home'),
    TMPDIR: path.join(ownedRoot, 'tmp'),
    TMP: path.join(ownedRoot, 'tmp'),
    TEMP: path.join(ownedRoot, 'tmp'),
    XDG_CONFIG_HOME: path.join(ownedRoot, 'xdg', 'config'),
    XDG_CACHE_HOME: path.join(ownedRoot, 'xdg', 'cache'),
    XDG_DATA_HOME: path.join(ownedRoot, 'xdg', 'data'),
    XDG_STATE_HOME: path.join(ownedRoot, 'xdg', 'state'),
    XDG_RUNTIME_DIR: path.join(ownedRoot, 'xdg', 'runtime'),
    LANG: 'C',
    LC_ALL: 'C',
    AW1172BS_ARM: arm,
  };
  if (IS_WINDOWS) {
    // PATHEXT is passed exactly as the host has it (falling back to the
    // documented default) so a win32 failure can never be blamed on a PATHEXT
    // that omits .CMD. USERPROFILE mirrors the faked HOME. SystemRoot/windir
    // are the OS locations Windows requires to start any process at all — the
    // positive control cannot be sound without them, and neither is a CLI dir.
    env.PATHEXT = process.env.PATHEXT || DEFAULT_PATHEXT;
    env.USERPROFILE = env.HOME;
    env.LOCALAPPDATA = path.join(env.HOME, 'AppData', 'Local');
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.windir) env.windir = process.env.windir;
  }
  return env;
}

function describeError(err) {
  return {
    name: err?.name ?? null,
    code: err?.code ?? null,
    errno: typeof err?.errno === 'number' ? err.errno : null,
    syscall: err?.syscall ?? null,
    spawnfile: err?.spawnfile ?? null,
    path: err?.path ?? null,
    messageHead: String(err?.message ?? '').slice(0, 200),
  };
}

/**
 * Run one arm and return a bounded, host-path-free observation record.
 *
 * Captures, separately: a synchronous throw from `spawn` itself, versus the
 * async 'spawn'/'error'/'exit'/'close' events, stdout, stderr, and the state of
 * the stdin write/end. Both streams are capped as bytes ARRIVE, so a runaway
 * child cannot grow this process's memory while the arm is still open; the
 * true byte counts and an overflow flag are kept, and overflow fails a test.
 * Nothing here asserts; assertions read the record later.
 */
function observeArm({ arm, command, argv, commandKind, ownedHandleRel, writesStdin }) {
  const env = sealedEnv(arm);
  const rec = {
    arm,
    commandKind,
    commandShown: commandKind === 'bare-name' ? command : path.basename(command),
    ownedHandleRel,
    argv: [...argv],
    stdinBytes: writesStdin ? Buffer.byteLength(FIXED_STDIN) : 0,
    platform: process.platform,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    shellOption: 'absent',
    pathEntryCount: env.PATH.split(path.delimiter).filter(Boolean).length,
    pathextEntries: IS_WINDOWS
      ? env.PATHEXT.split(';').map(e => e.trim().toUpperCase()).filter(Boolean)
      : null,
    cwdIsOwnedAtSpawn: process.cwd() === ownedCwd,
    envKeys: Object.keys(env).sort(),
    errorPhase: 'none',
    syncThrow: null,
    eventOrder: [],
    eventCounts: {},
    errors: [],
    exit: null,
    close: null,
    spawnEventSeen: false,
    pidPresent: false,
    stdout: '',
    stdoutBytes: 0,
    stdoutTruncated: false,
    stderrHead: '',
    stderrBytes: 0,
    stderrTruncated: false,
    streamCapBytes: STREAM_CAP_BYTES,
    stdinWriteCalled: false,
    stdinEndCalled: false,
    stdinFinished: false,
    stdinError: null,
    timedOut: false,
    latencyMs: null,
    latencyBoundMs: CHILD_BOUND_MS,
    joined: false,
  };

  const note = (name) => {
    rec.eventCounts[name] = (rec.eventCounts[name] ?? 0) + 1;
    if (rec.eventOrder.length < EVENT_LOG_CAP) rec.eventOrder.push(name);
  };

  // Retained bytes per stream, enforced on arrival rather than at completion.
  const kept = { stdout: [], stderr: [] };
  const keptBytes = { stdout: 0, stderr: 0 };
  const receive = (which, chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (which === 'stdout') rec.stdoutBytes += buf.length; else rec.stderrBytes += buf.length;
    const room = STREAM_CAP_BYTES - keptBytes[which];
    if (room > 0) {
      const take = buf.subarray(0, Math.min(room, buf.length));
      kept[which].push(take);
      keptBytes[which] += take.length;
    }
    if (buf.length > room) {
      if (which === 'stdout') rec.stdoutTruncated = true; else rec.stderrTruncated = true;
    }
  };

  const startedAt = Date.now();
  let child;
  try {
    // ---- the exact signature under reproduction (lib/transport.js:798) ----
    child = spawn(command, argv, { env, windowsHide: true });
  } catch (err) {
    rec.errorPhase = 'sync';
    rec.syncThrow = describeError(err);
    rec.latencyMs = Date.now() - startedAt;
    rec.joined = true; // nothing ever started, so there is no child to join
    return Promise.resolve(rec);
  }

  const entry = { child, pidPresent: typeof child.pid === 'number', exitSeen: false, closeSeen: false, escalated: false, escalationError: null };
  ownedHandles.push(entry);
  rec.pidPresent = entry.pidPresent;

  return new Promise((resolve) => {
    let settled = false;
    let graceTimer = null;
    const hardTimer = setTimeout(() => {
      rec.timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* own handle only */ }
      finish();
    }, CHILD_BOUND_MS);
    if (typeof hardTimer.unref === 'function') hardTimer.unref();

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      rec.latencyMs = Date.now() - startedAt;
      rec.joined = isJoined(entry);
      resolve(rec);
    }

    child.on('spawn', () => { rec.spawnEventSeen = true; note('spawn'); });

    child.on('error', (err) => {
      rec.errors.push(describeError(err));
      if (rec.errorPhase === 'none') rec.errorPhase = 'async';
      note('error');
      graceTimer = setTimeout(finish, ERROR_GRACE_MS);
      if (typeof graceTimer.unref === 'function') graceTimer.unref();
    });

    // The only two join signals. Registered for the whole life of the handle so
    // cleanup can still observe a late termination after this arm has settled.
    child.on('exit', (code, signal) => {
      entry.exitSeen = true;
      rec.exit = { code, signal };
      note('exit');
    });

    child.on('close', (code, signal) => {
      entry.closeSeen = true;
      rec.close = { code, signal };
      note('close');
      finish();
    });

    if (child.stdout) child.stdout.on('data', (d) => receive('stdout', d));
    if (child.stderr) child.stderr.on('data', (d) => receive('stderr', d));

    if (writesStdin && child.stdin) {
      child.stdin.on('error', (err) => {
        if (!rec.stdinError) rec.stdinError = err?.code ?? err?.name ?? 'unknown';
      });
      child.stdin.on('finish', () => { rec.stdinFinished = true; note('stdin-end'); });
      try {
        child.stdin.write(FIXED_STDIN);
        rec.stdinWriteCalled = true;
        child.stdin.end();
        rec.stdinEndCalled = true;
      } catch (err) {
        if (!rec.stdinError) rec.stdinError = err?.code ?? err?.name ?? 'unknown';
      }
    }
  }).then((r) => {
    r.stdout = Buffer.concat(kept.stdout).toString();
    r.stderrHead = Buffer.concat(kept.stderr).toString().slice(0, 500);
    return r;
  });
}

/**
 * Join every handle this file created, bounded. Own handles only.
 *
 * At most ONE SIGKILL per handle, sent before the wait — never inside the poll
 * loop, which only re-reads the observed 'exit'/'close' flags.
 */
async function settleOwnedHandles() {
  const startedAt = Date.now();

  for (const h of ownedHandles) {
    if (isJoined(h) || h.escalated) continue;
    h.escalated = true;
    try { h.child.kill('SIGKILL'); } catch (err) { h.escalationError = err?.code ?? err?.name ?? 'unknown'; }
  }

  const deadline = startedAt + CLEANUP_BOUND_MS;
  while (!ownedHandles.every(isJoined) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, JOIN_POLL_MS));
  }

  return {
    handles: ownedHandles.length,
    escalated: ownedHandles.filter(h => h.escalated).length,
    escalationErrors: ownedHandles.filter(h => h.escalationError).map(h => h.escalationError),
    unjoined: ownedHandles.filter(h => !isJoined(h)).length,
    allJoined: ownedHandles.every(isJoined),
    waitedMs: Date.now() - startedAt,
    boundMs: CLEANUP_BOUND_MS,
  };
}

// ---------------------------------------------------------------------------
// Both arms run, and both are persisted, before any assertion executes.
// ---------------------------------------------------------------------------

describe('aw1172bs — native bare-name CLI spawn (transport.js:798 reproduction)', () => {
  beforeAll(async () => {
    try {
      if (typeof process.chdir !== 'function') {
        // Faking the child cwd without changing the product's spawn signature
        // requires chdir. Fail loudly rather than silently observe the host cwd.
        throw new Error('aw1172bs harness requires a pool where process.chdir exists');
      }

      // realpath so `process.cwd()` comparisons survive /var -> /private/var.
      ownedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw1172bs-native-spawn-')));
      ownedBinDir = path.join(ownedRoot, 'bin');
      ownedCwd = path.join(ownedRoot, 'cwd');
      for (const dir of [
        ownedBinDir, ownedCwd,
        path.join(ownedRoot, 'home'), path.join(ownedRoot, 'tmp'),
        path.join(ownedRoot, 'xdg', 'config'), path.join(ownedRoot, 'xdg', 'cache'),
        path.join(ownedRoot, 'xdg', 'data'), path.join(ownedRoot, 'xdg', 'state'),
        path.join(ownedRoot, 'xdg', 'runtime'), path.join(ownedRoot, 'control'),
      ]) fs.mkdirSync(dir, { recursive: true });

      fixturePath = writeFixture(ownedBinDir, SPEAKER);
      controlJsPath = path.join(ownedRoot, 'control', 'owned-cli.js');
      fs.writeFileSync(controlJsPath, OWNED_CONTROL_JS, 'utf8');
      evidencePath = path.join(ownedRoot, 'aw1172bs-arms.json');

      const previousCwd = process.cwd();
      try {
        process.chdir(ownedCwd);

        // Positive control first: if the real process.execPath cannot run an
        // owned JS in this sandbox, the bare-name arm proves nothing.
        controlArm = await observeArm({
          arm: 'positive-control',
          command: process.execPath,        // the only allowed real executable
          argv: [controlJsPath, ...FIXED_ARGS],
          commandKind: 'process.execPath',
          ownedHandleRel: path.relative(ownedRoot, controlJsPath),
          writesStdin: true,
        });

        bareArm = await observeArm({
          arm: 'bare-name',
          command: SPEAKER,                  // bare name, exactly as transport.js
          argv: [...FIXED_ARGS],
          commandKind: 'bare-name',
          ownedHandleRel: path.relative(ownedRoot, fixturePath),
          writesStdin: true,
        });
      } finally {
        // Restored before any removal: the owned cwd must not be the live cwd
        // when afterAll removes the root.
        process.chdir(previousCwd);
      }

      cleanup = await settleOwnedHandles();

      const evidence = deepSanitize({
        task: '1172',
        track: 'aw1172bs',
        frozenBase: 'cf1587a3b68779bf9d3a23c37a32842833b84007',
        reproduces: 'lib/transport.js:798 spawn("claude", getCliExecArgs("claude", null), { env, windowsHide: true })',
        fixtureContract: '__tests__/helpers/cli-discovery-fixture.js stubFileName/writeStub',
        fixtureFileName: path.basename(fixturePath),
        bounds: {
          childMs: CHILD_BOUND_MS,
          cleanupMs: CLEANUP_BOUND_MS,
          errorGraceMs: ERROR_GRACE_MS,
          streamCapBytes: STREAM_CAP_BYTES,
          eventLogCap: EVENT_LOG_CAP,
        },
        cleanup,
        arms: { 'positive-control': controlArm, 'bare-name': bareArm },
      });
      fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
      // Also emit to stdout: the owned root is removed in afterAll, so the
      // native CI log is what the controller actually keeps.
      console.log(`AW1172BS_NATIVE_SPAWN_EVIDENCE ${JSON.stringify(evidence)}`);
    } catch (err) {
      // A setup failure goes through the SAME bounded join path, so afterAll
      // makes the same preserve-or-remove decision on the same evidence.
      setupError = describeError(err);
      if (!cleanup) cleanup = await settleOwnedHandles();
      // The root may be removed below, so surface the reason on stdout first.
      console.error(`AW1172BS_NATIVE_SPAWN_SETUP_FAILED ${JSON.stringify(deepSanitize({ setupError, cleanup }))}`);
      throw err;
    }
  }, 30000);

  afterAll(async () => {
    // Runs even when beforeAll threw, so nothing here may assume setup ran.
    if (!ownedRoot) {
      rootRemoval = { removed: false, reason: 'no-owned-root' };
      return;
    }
    const join = cleanup ?? await settleOwnedHandles();
    if (!join.allJoined) {
      // Preserve the root: removing it under a live child is how a harness
      // starts writing into a directory its own orphan still holds open.
      rootRemoval = { removed: false, reason: E_OWNED_CHILD_UNJOINED, unjoined: join.unjoined };
      throw new Error(
        `aw1172bs ${E_OWNED_CHILD_UNJOINED}: ${join.unjoined}/${join.handles} owned child(ren) `
        + `unjoined after the ${join.boundMs}ms cleanup bound; owned root preserved for inspection`,
      );
    }
    // No catch: a cleanup error is a real failure, not something to swallow.
    fs.rmSync(ownedRoot, { recursive: true, force: true });
    rootRemoval = { removed: true, reason: null };
  }, 10000);

  it('persists both arms, with bounded fields and no raw host paths', () => {
    expect(setupError).toBe(null);
    expect(fs.existsSync(evidencePath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    expect(Object.keys(onDisk.arms).sort()).toEqual(['bare-name', 'positive-control']);
    const blob = JSON.stringify(onDisk);
    // Check the JSON-escaped form too: on win32 a raw `C:\...` never appears in
    // JSON output (backslashes are doubled), so a raw-only check is vacuous
    // there and would not actually enforce "no host paths".
    const leaks = (p) => blob.includes(p) || blob.includes(JSON.stringify(p).slice(1, -1));
    expect(leaks(ownedRoot), 'owned root leaked into evidence').toBe(false);
    expect(leaks(process.execPath), 'execPath leaked into evidence').toBe(false);
    expect(leaks(os.homedir()), 'host homedir leaked into evidence').toBe(false);
    for (const rec of Object.values(onDisk.arms)) {
      expect(rec.eventOrder.length).toBeLessThanOrEqual(EVENT_LOG_CAP);
      expect(rec.stderrHead.length).toBeLessThanOrEqual(500);
      expect(rec.latencyMs).toBeLessThanOrEqual(CHILD_BOUND_MS);
    }
  });

  it('keeps both captured streams inside the retention cap', () => {
    for (const rec of [controlArm, bareArm]) {
      const why = JSON.stringify({ arm: rec.arm, stdoutBytes: rec.stdoutBytes, stderrBytes: rec.stderrBytes });
      // Overflow is a failure, not a silently truncated record: an owned
      // fixture that emits more than one sentinel line is not the fixture
      // this harness wrote.
      expect(rec.stdoutTruncated, `${rec.arm} stdout exceeded ${STREAM_CAP_BYTES}B: ${why}`).toBe(false);
      expect(rec.stderrTruncated, `${rec.arm} stderr exceeded ${STREAM_CAP_BYTES}B: ${why}`).toBe(false);
      expect(rec.stdoutBytes).toBeLessThanOrEqual(STREAM_CAP_BYTES);
      expect(rec.stderrBytes).toBeLessThanOrEqual(STREAM_CAP_BYTES);
      expect(Buffer.byteLength(rec.stdout)).toBeLessThanOrEqual(STREAM_CAP_BYTES);
    }
  });

  it('builds the owned fixture on this platform\'s writer contract', () => {
    expect(path.basename(fixturePath)).toBe(IS_WINDOWS ? `${SPEAKER}.cmd` : SPEAKER);
    expect(path.dirname(fixturePath)).toBe(ownedBinDir);
    expect(fs.readFileSync(fixturePath, 'utf8')).toBe(fixtureBody(SPEAKER));
    if (IS_WINDOWS) {
      // The extension the bare name would have to acquire is listed in the
      // PATHEXT the child actually received.
      expect(bareArm.pathextEntries).toContain('.CMD');
    } else {
      expect(fs.statSync(fixturePath).mode & 0o111).not.toBe(0);
    }
  });

  it('isolates the sandbox: one owned PATH entry, owned cwd, no shell option', () => {
    for (const rec of [controlArm, bareArm]) {
      expect(rec.pathEntryCount, `${rec.arm} PATH must hold only the owned bin dir`).toBe(1);
      expect(rec.cwdIsOwnedAtSpawn, `${rec.arm} must spawn from the owned cwd`).toBe(true);
      expect(rec.shellOption).toBe('absent');
      expect(rec.envKeys).toContain('HOME');
      expect(rec.envKeys).toContain('TMPDIR');
      expect(rec.envKeys.some(k => k.startsWith('XDG_'))).toBe(true);
    }
  });

  it('positive control: process.execPath runs the owned JS once and returns the fixed output', () => {
    const c = controlArm;
    const why = JSON.stringify(deepSanitize(c));
    expect(c.syncThrow, `control threw synchronously: ${why}`).toBe(null);
    expect(c.errors, `control emitted error events: ${why}`).toEqual([]);
    expect(c.timedOut).toBe(false);
    expect(c.spawnEventSeen).toBe(true);
    expect(c.eventCounts.close, `control close count: ${why}`).toBe(1);
    expect(c.exit).toEqual({ code: 0, signal: null });
    expect(c.close.code).toBe(0);
    expect(c.stdout.trim()).toBe(SENTINEL);
    expect(c.stdinEndCalled).toBe(true);
    expect(c.ownedHandleRel).toBe(path.join('control', 'owned-cli.js'));
  });

  // ---- the ordinary positive contract -------------------------------------
  // Asserted on every platform. On win32 this is EXPECTED to fail: the record
  // in the failure message (and in the persisted evidence) is the native proof
  // that a bare-name, no-shell spawn cannot reach a `.cmd` on PATH. Not
  // skipped, not gated, not softened.
  it('bare-name spawn resolves the owned fixture from an owned-only PATH and returns the fixed output', () => {
    const b = bareArm;
    const why = JSON.stringify(deepSanitize(b));
    expect(b.ownedHandleRel).toBe(path.join('bin', fixtureFileName(SPEAKER)));
    expect(b.commandShown).toBe(SPEAKER);
    expect(b.argv).toEqual([...FIXED_ARGS]);
    expect(b.syncThrow, `bare-name spawn threw synchronously: ${why}`).toBe(null);
    expect(b.errorPhase, `bare-name spawn error phase: ${why}`).toBe('none');
    expect(b.errors, `bare-name spawn emitted error events: ${why}`).toEqual([]);
    expect(b.timedOut, `bare-name spawn hit the ${CHILD_BOUND_MS}ms bound: ${why}`).toBe(false);
    expect(b.spawnEventSeen, `bare-name spawn never started: ${why}`).toBe(true);
    expect(b.eventCounts.close, `bare-name close count (must be exactly one run): ${why}`).toBe(1);
    expect(b.exit, `bare-name exit: ${why}`).toEqual({ code: 0, signal: null });
    expect(b.stdout.trim(), `bare-name stdout: ${why}`).toBe(SENTINEL);
  });

  it('both arms agree on args, stdin and output, so the only variable is lookup', () => {
    expect(bareArm.argv.slice(-FIXED_ARGS.length)).toEqual(controlArm.argv.slice(-FIXED_ARGS.length));
    expect(bareArm.stdinBytes).toBe(controlArm.stdinBytes);
    expect(bareArm.stdinBytes).toBe(Buffer.byteLength(FIXED_STDIN));
    expect(bareArm.envKeys).toEqual(controlArm.envKeys);
    expect(bareArm.nodeMajor).toBe(controlArm.nodeMajor);
  });

  it('joins every observed child, bounded, before the owned root may be removed', () => {
    const why = JSON.stringify(cleanup);
    expect(cleanup.handles, why).toBeGreaterThanOrEqual(1);
    expect(cleanup.allJoined, `owned handles unjoined at cleanup: ${why}`).toBe(true);
    expect(cleanup.unjoined, why).toBe(0);
    expect(cleanup.waitedMs).toBeLessThanOrEqual(CLEANUP_BOUND_MS);
    // A clean run needs no escalation at all; every child ended on its own.
    expect(cleanup.escalated, `unexpected cleanup escalation: ${why}`).toBe(0);
    expect(cleanup.escalationErrors).toEqual([]);
    for (const rec of [controlArm, bareArm]) {
      expect(rec.joined, `${rec.arm} was not joined via an observed exit/close`).toBe(true);
      expect(rec.latencyMs, `${rec.arm} exceeded the child bound`).toBeLessThanOrEqual(CHILD_BOUND_MS);
    }
    // Removal is afterAll's job, and only once the join above holds.
    expect(fs.existsSync(ownedRoot)).toBe(true);
    expect(rootRemoval.removed).toBe(false);
  });
});
