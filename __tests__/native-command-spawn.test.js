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
// WHAT CHANGED IN v3 (native CI 36215641444, WindowsNode20 job 108330955350)
// v2 was a raw reproduction only: it spawned the bare name through
// `child_process.spawn` and asserted that it WORKS, so on win32 it went red by
// design and the red was the evidence. The reproduction has now served its
// purpose — the win32 ENOENT is measured, not inferred — and a permanently red
// file cannot gate the fix. So this file now carries TWO bare-name arms:
//
//   `bare-name`          raw `child_process.spawn`, unchanged signature. Its
//                        outcome is asserted EXACTLY per platform in a
//                        separately named regression control: on win32 an
//                        asynchronous ENOENT that started nothing, on POSIX a
//                        clean run. Not skipped, not softened, not a blanket
//                        "expected failure" — the win32 shape is pinned field by
//                        field, so a regression that changed it would fail here.
//   `bare-name-adapter`  the SAME bare name and the SAME fixed args through the
//                        actual product adapter, `spawnCliCommand` from
//                        `lib/cli-process.js`. Asserted to succeed on EVERY
//                        platform with no gating. This is the acceptance the
//                        raw reproduction never was.
//
// So this file DOES now import product code: exactly one module,
// `lib/cli-process.js`, because "the product adapter fixes the launch this file
// reproduced" is not provable without executing the product adapter. It still
// does NOT import `lib/transport.js`, run a deliberation, read a config or touch
// any other product module.
//
// It does NOT implement or endorse `shell: true`, never looks up a host CLI,
// never authenticates and never opens a network connection. The only executables
// it may name are the fixture it just wrote inside its own root, plus
// `process.execPath` for the positive control.
//
// DECLARED LIMITS
// 1. The raw arm's win32 red is a measured platform fact, now recorded as a
//    documented control rather than as the file's verdict. No arm is ever
//    skipped or conditionally passed, and the summary assertions at the bottom
//    read EVERY arm, so a green run cannot omit a product-side failure: if the
//    adapter arm fails, this file fails.
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
import { getSystemErrorMap } from 'util';

// The one product module this file loads, and only for the adapter arm. Import
// is side-effect free: it starts nothing at module load.
import { spawnCliCommand } from '../lib/cli-process.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * libuv's numeric ENOENT for THIS platform (-2 on POSIX, -4058 on win32), read
 * out of Node's own system error table rather than hard-coded, so the raw-arm
 * regression control below pins the exact native value without carrying a magic
 * per-platform literal. `null` only if the runtime's table somehow lacks it, in
 * which case the control falls back to "numeric and non-zero".
 */
const UV_ENOENT = (() => {
  for (const [errno, [name]] of getSystemErrorMap()) {
    if (name === 'ENOENT') return errno;
  }
  return null;
})();

/**
 * The two launchers under comparison. Same call signature, so the arm records
 * differ in the launcher and nothing else.
 */
const LAUNCHERS = Object.freeze({
  raw: Object.freeze({ id: 'raw', label: 'child_process.spawn', fn: spawn }),
  adapter: Object.freeze({
    id: 'adapter',
    label: 'lib/cli-process.js spawnCliCommand',
    fn: spawnCliCommand,
  }),
});

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
let adapterArm = null;
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
function observeArm({ arm, command, argv, commandKind, ownedHandleRel, writesStdin, launcher }) {
  const env = sealedEnv(arm);
  const rec = {
    arm,
    launcher: launcher.label,
    launcherId: launcher.id,
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
    // The adapter arm passes the identical (command, argv, options) triple; only
    // the function differs, which is the single variable this file isolates.
    child = launcher.fn(command, argv, { env, windowsHide: true });
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
          launcher: LAUNCHERS.raw,
        });

        bareArm = await observeArm({
          arm: 'bare-name',
          command: SPEAKER,                  // bare name, exactly as transport.js
          argv: [...FIXED_ARGS],
          commandKind: 'bare-name',
          ownedHandleRel: path.relative(ownedRoot, fixturePath),
          writesStdin: true,
          launcher: LAUNCHERS.raw,
        });

        // The same owned command, the same fixed args, the same sealed env and
        // the same owned cwd — through the product adapter instead of raw Node.
        adapterArm = await observeArm({
          arm: 'bare-name-adapter',
          command: SPEAKER,
          argv: [...FIXED_ARGS],
          commandKind: 'bare-name',
          ownedHandleRel: path.relative(ownedRoot, fixturePath),
          writesStdin: true,
          launcher: LAUNCHERS.adapter,
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
        adapterUnderTest: 'lib/cli-process.js spawnCliCommand (same command, args, env and cwd)',
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
        arms: {
          'positive-control': controlArm,
          'bare-name': bareArm,
          'bare-name-adapter': adapterArm,
        },
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

  it('persists all three arms, with bounded fields and no raw host paths', () => {
    expect(setupError).toBe(null);
    expect(fs.existsSync(evidencePath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    expect(Object.keys(onDisk.arms).sort()).toEqual(['bare-name', 'bare-name-adapter', 'positive-control']);
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

  it('keeps every captured stream inside the retention cap', () => {
    for (const rec of [controlArm, bareArm, adapterArm]) {
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
    // `shellOption` reports the option THIS FILE passed, and it is absent in all
    // three arms. On win32 cross-spawn does route the adapter arm through
    // `cmd.exe /d /s /c` internally, with per-argument escaping — that is the
    // fix under test, and it is not the same thing as handing Node `shell: true`
    // and a concatenated command string. Nothing here passes `shell`.
    for (const rec of [controlArm, bareArm, adapterArm]) {
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

  // ---- raw `child_process.spawn`: the documented regression control ---------
  // This is the reproduction, kept as a control and named as one. It asserts the
  // EXACT platform outcome of the unfixed launch path, on every platform, with
  // no skip, no `it.fails`, and no blanket "expected failure" wrapper:
  //
  //   win32   raw spawn cannot apply PATHEXT and cannot execute a `.cmd`, so the
  //           launch fails ASYNCHRONOUSLY with ENOENT having started nothing.
  //           Measured natively at CI 36215641444 / WindowsNode20 job
  //           108330955350; pinned field by field below, so a Node or libuv
  //           change to that shape fails HERE, where it is documented, instead
  //           of silently changing what the product's fix is worth.
  //   POSIX   the same bare name executes normally. Nothing was ever broken
  //           here, and this arm proves the harness itself is sound.
  //
  // What this control does NOT claim: that the product works. `spawn` is not the
  // product's launch path any more. The acceptance for that is the next test,
  // and it is ungated on every platform — so a green run cannot be produced by
  // this control alone.
  it('regression control: raw child_process.spawn reproduces the exact native platform outcome', () => {
    const b = bareArm;
    const why = JSON.stringify(deepSanitize(b));
    expect(b.launcherId).toBe('raw');
    expect(b.ownedHandleRel).toBe(path.join('bin', fixtureFileName(SPEAKER)));
    expect(b.commandShown).toBe(SPEAKER);
    expect(b.argv).toEqual([...FIXED_ARGS]);
    // Never a synchronous throw on either platform: `spawn` reports through the
    // event, which is precisely why the product could not detect this by
    // try/catch around the launch.
    expect(b.syncThrow, `raw spawn threw synchronously: ${why}`).toBe(null);
    expect(b.timedOut, `raw spawn hit the ${CHILD_BOUND_MS}ms bound: ${why}`).toBe(false);

    if (IS_WINDOWS) {
      expect(b.errorPhase, `raw spawn error phase: ${why}`).toBe('async');
      expect(b.errors.length, `raw spawn error count: ${why}`).toBe(1);
      const e = b.errors[0];
      expect(e.code, `raw spawn error code: ${why}`).toBe('ENOENT');
      expect(e.syscall).toBe(`spawn ${SPEAKER}`);
      expect(e.path).toBe(SPEAKER);
      expect(e.messageHead).toBe(`spawn ${SPEAKER} ENOENT`);
      // Node's own numeric libuv errno, not a synthesized string. This is the
      // native value the product wrapper has to reproduce on the sync side.
      expect(typeof e.errno, `raw spawn errno type: ${why}`).toBe('number');
      if (UV_ENOENT !== null) expect(e.errno).toBe(UV_ENOENT);
      else expect(e.errno).not.toBe(0);
      // Nothing started: no 'spawn' event, no pid, no output, no exit status.
      expect(b.spawnEventSeen, `raw spawn unexpectedly started a process: ${why}`).toBe(false);
      expect(b.pidPresent, `raw spawn unexpectedly produced a pid: ${why}`).toBe(false);
      expect(b.exit, `raw spawn exit: ${why}`).toBe(null);
      expect(b.stdout, `raw spawn stdout: ${why}`).toBe('');
      expect(b.stdoutBytes).toBe(0);
      // 'close' still fires, carrying the spawn error rather than an exit code —
      // the ordering the product's `settled`-guarded handlers depend on.
      expect(b.eventOrder, `raw spawn event order: ${why}`).toEqual(['error', 'close']);
      expect(b.eventCounts.error).toBe(1);
      expect(b.eventCounts.close).toBe(1);
      expect(b.close, `raw spawn close: ${why}`).toEqual({ code: e.errno, signal: null });
    } else {
      expect(b.errorPhase, `raw spawn error phase: ${why}`).toBe('none');
      expect(b.errors, `raw spawn emitted error events: ${why}`).toEqual([]);
      expect(b.spawnEventSeen, `raw spawn never started: ${why}`).toBe(true);
      expect(b.pidPresent, `raw spawn produced no pid: ${why}`).toBe(true);
      expect(b.eventCounts.close, `raw spawn close count (must be exactly one run): ${why}`).toBe(1);
      expect(b.exit, `raw spawn exit: ${why}`).toEqual({ code: 0, signal: null });
      expect(b.close, `raw spawn close: ${why}`).toEqual({ code: 0, signal: null });
      expect(b.stdout.trim(), `raw spawn stdout: ${why}`).toBe(SENTINEL);
    }
  });

  // ---- the product adapter: acceptance, ungated on every platform -----------
  // Same bare name, same fixed args, same sealed env, same owned cwd, same owned
  // `.cmd`/shim on disk — through `spawnCliCommand` instead of raw `spawn`. The
  // launcher is the only variable, so a green here is attributable to the
  // adapter and to nothing else. No platform branch: this must hold everywhere,
  // and if it does not, this file fails and the product side of the run cannot
  // be omitted from the summary.
  it('product adapter: the same owned bare-name command launches and returns the fixed output', () => {
    const a = adapterArm;
    const why = JSON.stringify(deepSanitize(a));
    expect(a.launcherId).toBe('adapter');
    expect(a.ownedHandleRel).toBe(path.join('bin', fixtureFileName(SPEAKER)));
    expect(a.commandShown).toBe(SPEAKER);
    expect(a.commandKind).toBe('bare-name');
    expect(a.argv).toEqual([...FIXED_ARGS]);
    // `shell` is never passed by this file. On win32 the adapter routes through
    // cmd.exe internally with per-argument escaping — that IS the fix, and it is
    // not the same thing as handing Node `shell: true` and a joined string.
    expect(a.shellOption).toBe('absent');
    expect(a.syncThrow, `adapter threw synchronously: ${why}`).toBe(null);
    expect(a.errorPhase, `adapter error phase: ${why}`).toBe('none');
    expect(a.errors, `adapter emitted error events: ${why}`).toEqual([]);
    expect(a.timedOut, `adapter hit the ${CHILD_BOUND_MS}ms bound: ${why}`).toBe(false);
    expect(a.spawnEventSeen, `adapter never started a process: ${why}`).toBe(true);
    expect(a.pidPresent, `adapter produced no pid: ${why}`).toBe(true);
    expect(a.eventCounts.close, `adapter close count (must be exactly one run): ${why}`).toBe(1);
    expect(a.exit, `adapter exit: ${why}`).toEqual({ code: 0, signal: null });
    expect(a.close, `adapter close: ${why}`).toEqual({ code: 0, signal: null });
    expect(a.stdout.trim(), `adapter stdout: ${why}`).toBe(SENTINEL);
    expect(a.stdinWriteCalled).toBe(true);
    expect(a.stdinEndCalled).toBe(true);
  });

  // The whole point of the three-arm shape: on win32 the raw arm and the adapter
  // arm differ ONLY in the launcher, so the adapter is the cause of the
  // difference in outcome. Asserted as an explicit contrast, not left implicit.
  it('raw and adapter differ only in the launcher, so the outcome difference is attributable', () => {
    expect(bareArm.launcherId).toBe('raw');
    expect(adapterArm.launcherId).toBe('adapter');
    expect(adapterArm.launcher).not.toBe(bareArm.launcher);
    expect(adapterArm.commandShown).toBe(bareArm.commandShown);
    expect(adapterArm.commandKind).toBe(bareArm.commandKind);
    expect(adapterArm.ownedHandleRel).toBe(bareArm.ownedHandleRel);
    expect(adapterArm.argv).toEqual(bareArm.argv);
    expect(adapterArm.envKeys).toEqual(bareArm.envKeys);
    expect(adapterArm.pathEntryCount).toBe(bareArm.pathEntryCount);
    expect(adapterArm.pathextEntries).toEqual(bareArm.pathextEntries);
    expect(adapterArm.cwdIsOwnedAtSpawn).toBe(bareArm.cwdIsOwnedAtSpawn);
    expect(adapterArm.stdinBytes).toBe(bareArm.stdinBytes);
    if (IS_WINDOWS) {
      // The measured contrast: raw fails to start, the adapter runs the fixture.
      expect(bareArm.spawnEventSeen).toBe(false);
      expect(adapterArm.spawnEventSeen).toBe(true);
      expect(bareArm.stdout.trim()).not.toBe(SENTINEL);
      expect(adapterArm.stdout.trim()).toBe(SENTINEL);
    } else {
      // No divergence to attribute on POSIX: both launchers already worked.
      expect(bareArm.stdout.trim()).toBe(SENTINEL);
      expect(adapterArm.stdout.trim()).toBe(SENTINEL);
    }
  });

  it('every arm agrees on args, stdin and runtime, so the only variable is lookup', () => {
    for (const rec of [bareArm, adapterArm]) {
      expect(rec.argv.slice(-FIXED_ARGS.length)).toEqual(controlArm.argv.slice(-FIXED_ARGS.length));
      expect(rec.stdinBytes).toBe(controlArm.stdinBytes);
      expect(rec.stdinBytes).toBe(Buffer.byteLength(FIXED_STDIN));
      expect(rec.envKeys).toEqual(controlArm.envKeys);
      expect(rec.nodeMajor).toBe(controlArm.nodeMajor);
    }
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
    for (const rec of [controlArm, bareArm, adapterArm]) {
      expect(rec.joined, `${rec.arm} was not joined via an observed exit/close`).toBe(true);
      expect(rec.latencyMs, `${rec.arm} exceeded the child bound`).toBeLessThanOrEqual(CHILD_BOUND_MS);
    }
    // Removal is afterAll's job, and only once the join above holds.
    expect(fs.existsSync(ownedRoot)).toBe(true);
    expect(rootRemoval.removed).toBe(false);
  });
});
