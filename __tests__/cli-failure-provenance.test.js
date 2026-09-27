// ─────────────────────────────────────────────────────────────────────────────
// task 1172 / lt1172kb-v1 — INDEPENDENT VERIFICATION OF THE AUTO-TURN FAILURE
// PROVENANCE FIELD (ld1172jt-v2 candidate pair)
//
// The candidate under test adds ONE fact to a failed CLI auto-turn: where the
// failure was RAISED (`origin`) and which allowlisted errno accompanied it
// (`code`). The author's own report states plainly that nothing was executed and
// that §3-§5 of it are source-level arguments, not observations. This file is
// the observation. It was written against the frozen sources by a tester who did
// not write them, and it is deliberately hostile to the change.
//
// WHAT IS MEASURED HERE
//   1. every pre-existing error string, key set, timer, signal, cleanup window
//      and retry decision is byte-for-byte what it was (§2, §3, §6);
//   2. all five origins and every state of the closed code table are reachable
//      through the REAL exported module — never a re-implemented snippet (§4);
//   3. the tag cannot crash the turn: frozen / sealed / non-extensible Errors,
//      hostile getters and Proxy traps produce `unknown`/`none`, not a throw,
//      and open no escape the frozen baseline did not already have (§5);
//   4. the tag is invisible: symbol-keyed, non-enumerable, not copied by spread,
//      absent from Object.keys / for-in / JSON.stringify (§5);
//   5. the FIRST raising site owns the origin; a later site cannot restate it
//      and a later error cannot replace the first one's code (§4.8, §5.6);
//   6. no origin is ever inferred from message text — an untagged error whose
//      message is a perfect counterfeit of a stdin failure still reports
//      `unknown` (§4.7);
//   7. the writer emits the field exactly once per retry record, INSIDE the
//      historical grammar, and emits nothing at all on success or when the
//      transport reported no provenance — driven through the actual
//      `runAutoHandoff` -> `runUntilBlockedCore` -> `runCliAutoTurnCore` chain
//      (§6);
//   8. the reader is the ACTUAL reader from the candidate E2E source, extracted
//      under an exact source-hash pin and run in isolation, and it keeps
//      `none` / `absent` / `unlisted` / `other` / `unknown` distinct, dedups as
//      before, and lets no unknown or private string into its output (§7).
//
// WHAT IS **NOT** CLAIMED — read this before quoting any pass below
//   * The original CI failure is NOT reproduced here. The Linux timeout cause
//     remains UNKNOWN and the EPIPE hypothesis remains UNPROVEN. This suite
//     measures whether the diagnostic is CORRECT, not what it will say on a
//     native Linux runner. Only a native Linux CI run can establish the initial
//     cause, and §4 below is exactly the instrument that run needs.
//   * `retry_reasons=other=3` from CI 36312626018 is not explained, resolved or
//     attributed by anything in this file.
//   * Nothing here claims whole-log privacy was newly solved. The legacy free
//     text `| reason: <cause>` field still carries raw child stderr and raw
//     errno text, and §6.5 asserts that it STILL DOES — the new fields are
//     closed tables beside it, not a redaction of it.
//   * Every child process, session store, liveness probe and caller identity is
//     an in-process fake. No real agent CLI, no telepty, no auth, no network,
//     no MCP bus, no host process is touched; `spawnCliCommand` is mocked at the
//     module seam the product already declares, and §8 proves the seam held.
// ─────────────────────────────────────────────────────────────────────────────
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { getFixtureInstallDir } from './helpers/cli-discovery-fixture.js';
import {
  runCliAutoTurnCore,
  runUntilBlockedCore,
  runAutoHandoff,
  initTransportDeps,
} from '../lib/transport.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TRANSPORT_SRC = path.join(REPO, 'lib', 'transport.js');
const E2E_SRC = path.join(REPO, '__tests__', 'deliberation-e2e.test.js');

// The reader extracted in §7 is TEXT sliced out of this file, so the slice is
// only meaningful against known bytes. Pinned to the ld1172jt-v2 candidate
// `__tests__/deliberation-e2e.test.js`. On the frozen pre-change baseline
// (dfb0a2bf…) this pin FAILS, which is the intended regression signal: the old
// reader has no provenance to extract, and a suite that quietly passed there
// would be asserting nothing.
const E2E_READER_SOURCE_SHA256 =
  '95c4d9c1b9a26589988023ee6957498838c373abfa3b3eeda3038a23dc1437c0';

// Recorded, NOT pinned: the transport bytes every behavioural arm below
// measured. Deliberately not an assertion — §4-§6 must fail on the old bytes by
// OBSERVED BEHAVIOUR, never by a hash mismatch that hides what did not happen.
const evidence = { sourceHashes: {}, notes: [] };

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// ── the product seams this file mocks, and nothing else ──────────────────────
// Identical seam set to the shipped `__tests__/stdin-deadline.test.js`, plus
// `detectCallerSpeaker` so the self-turn branch is decided by the harness rather
// than by whatever the host environment happens to export. Every other product function
// on the path — runCliAutoTurnCore, runUntilBlockedCore, runAutoHandoff, the
// tagging helpers, the writer and the retry policy — is the real one.
const hooks = vi.hoisted(() => ({
  spawn: null, loadSession: null, submitTurn: null,
  liveness: null, transportFor: null, caller: null,
}));

vi.mock('../lib/cli-process.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnCliCommand: (...a) => (hooks.spawn ? hooks.spawn(...a) : actual.spawnCliCommand(...a)) };
});
vi.mock('../lib/session.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadSession: (...a) => (hooks.loadSession ? hooks.loadSession(...a) : actual.loadSession(...a)),
    submitDeliberationTurn: (...a) => (hooks.submitTurn ? hooks.submitTurn(...a) : actual.submitDeliberationTurn(...a)),
  };
});
vi.mock('../lib/speaker-discovery.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkCliLiveness: (...a) => (hooks.liveness ? hooks.liveness(...a) : actual.checkCliLiveness(...a)),
    resolveTransportForSpeaker: (...a) => (hooks.transportFor ? hooks.transportFor(...a) : actual.resolveTransportForSpeaker(...a)),
    detectCallerSpeaker: (...a) => (hooks.caller ? hooks.caller(...a) : actual.detectCallerSpeaker(...a)),
  };
});

// ── owned, inert environment ─────────────────────────────────────────────────
// A HOME and TMPDIR inside the run's own temp tree and a PATH containing ONE
// empty owned directory. No real CLI, browser, telepty endpoint or provider is
// reachable from anything below; §8 asserts the env the product would have
// handed a child is this one and not the host's.
let OWNED = null;

function ownEnvironment() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt1172kb-prov-'));
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  const bin = path.join(root, 'empty-bin');
  for (const d of [home, tmp, bin]) fs.mkdirSync(d, { recursive: true });
  return { root, home, tmp, bin };
}

beforeAll(() => {
  OWNED = ownEnvironment();
  vi.stubEnv('HOME', OWNED.home);
  vi.stubEnv('TMPDIR', OWNED.tmp);
  vi.stubEnv('PATH', OWNED.bin);
  vi.stubEnv('DELIBERATION_CALLER_SPEAKER', '');
  evidence.sourceHashes['lib/transport.js'] = sha256File(TRANSPORT_SRC);
  evidence.sourceHashes['__tests__/deliberation-e2e.test.js'] = sha256File(E2E_SRC);
});

function sessionState(overrides = {}) {
  return {
    id: 's1', project: 'proj', topic: 'Topic.', status: 'active',
    current_round: 1, max_rounds: 2, current_speaker: 'codex',
    speakers: ['codex', 'claude'], speaker_roles: {},
    pending_turn_id: 'turn-1', log: [], auto_execute: false, ...overrides,
  };
}

// Fake ChildProcess, recording every signal aimed at it.
function makeFakeChild({ stdin } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = stdin ?? new PassThrough();
  child.killSignals = [];
  child.kill = (sig) => { child.killSignals.push(sig); return true; };
  return child;
}

// stdin that accepts the write and emits 'error' only when told to.
function controllableStdin() {
  const s = new Writable({ write(_c, _e, cb) { cb(); } });
  s.raise = (err) => s.emit('error', err);
  return s;
}

function errno(message, code) {
  const e = new Error(message);
  if (code !== undefined) e.code = code;
  return e;
}

// The default fixture: an active CLI session whose store, liveness and caller
// identity are all owned. Returns the submission sink so "nothing was
// submitted" stays observable.
function activeSession(state = sessionState()) {
  const submitted = [];
  hooks.loadSession = () => state;
  hooks.submitTurn = (p) => { submitted.push(p); return { ok: true }; };
  hooks.liveness = () => true;
  hooks.transportFor = () => ({ transport: 'cli_respond' });
  hooks.caller = () => null;
  return submitted;
}

const spawnCalls = [];

function spawnOnce(factory) {
  hooks.spawn = (...args) => {
    const child = factory();
    spawnCalls.push({ args, child });
    return child;
  };
}

afterEach(() => {
  for (const k of Object.keys(hooks)) hooks[k] = null;
  initTransportDeps({ appendRuntimeLog: () => {} });
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// §1. WHAT THIS RUN ACTUALLY MEASURED
// ─────────────────────────────────────────────────────────────────────────────
describe('§1 composition of the bytes under test', () => {
  it('records the analysed source hashes and the runtime; pins no hash, asserts only the declared Node floor', () => {
    expect(evidence.sourceHashes['lib/transport.js']).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.sourceHashes['__tests__/deliberation-e2e.test.js']).toMatch(/^[0-9a-f]{64}$/);
    evidence.notes.push(`node=${process.version}`);
    // A behavioural suite must not gate on a hash: every arm below has to fail
    // by observation on the old bytes, so the composition is RECORDED here and
    // asserted only where a text slice makes it load-bearing (§7).
    // The runtime floor is package.json `engines.node` (">=18"), which the CI
    // matrix exercises on 18/20/22; this suite must not demand more than that.
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(18);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2. THE PRESERVED SURFACE — asserted BEFORE any provenance claim.
//
// These arms pass identically on the frozen baseline and on the candidate. That
// is the point: they are the control that says the change added a field and did
// not move anything else. A failure here is a shipped regression, not a
// diagnostic gap.
// ─────────────────────────────────────────────────────────────────────────────
describe('§2 the pre-existing failure surface is untouched', () => {
  it('2.1 the five pre-flight refusals keep their exact literals and gain NO failure key', async () => {
    const cases = [
      { setup: () => { hooks.loadSession = () => null; }, error: 'Session not active' },
      {
        setup: () => { activeSession(sessionState({ status: 'completed' })); },
        error: 'Session not active',
      },
      {
        setup: () => { activeSession(); hooks.transportFor = () => ({ transport: 'manual' }); },
        error: 'Speaker "codex" is not CLI type',
      },
      {
        setup: () => { activeSession(sessionState({ current_speaker: 'nobody' })); },
        error: 'No CLI hints for "nobody"', speaker: 'nobody',
      },
      {
        setup: () => { activeSession(); hooks.liveness = () => false; },
        error: 'CLI "codex" not available',
      },
    ];
    for (const c of cases) {
      for (const k of Object.keys(hooks)) hooks[k] = null;
      c.setup();
      const res = await runCliAutoTurnCore('s1', c.speaker ?? 'codex', 120);
      expect(res.error).toBe(c.error);
      // The author's claim: a pre-flight return is already a distinct literal
      // and must not be handed a fabricated provenance. Measured.
      expect(Object.hasOwn(res, 'failure')).toBe(false);
      expect(Object.keys(res).sort()).toEqual(['error', 'ok']);
    }
    // Nothing was launched on any of the five paths.
    expect(spawnCalls.length).toBe(0);
  });

  it('2.2 the success return keeps its exact key set — no failure key on ok:true', async () => {
    const submitted = activeSession();
    const child = makeFakeChild();
    spawnOnce(() => child);

    const p = runCliAutoTurnCore('s1', 'codex', 120);
    await Promise.resolve();
    child.stdout.end('the provider answer');
    child.stderr.end();
    await new Promise((r) => setTimeout(r, 0));
    child.emit('close', 0);
    const res = await p;

    expect(res.ok).toBe(true);
    expect(res.response).toBe('the provider answer');
    expect(Object.hasOwn(res, 'failure')).toBe(false);
    expect(Object.keys(res).sort()).toEqual(['elapsedMs', 'observability', 'ok', 'response']);
    expect(submitted).toHaveLength(1);
    expect(child.killSignals).toEqual([]);
  });

  it('2.3 the four post-launch error strings are byte-identical to the frozen ones', async () => {
    // timeout
    {
      activeSession();
      const child = makeFakeChild({ stdin: controllableStdin() });
      spawnOnce(() => child);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
      const p = runCliAutoTurnCore('s1', 'codex', 120);
      await vi.advanceTimersByTimeAsync(0);
      let ms = 0;
      let res = null;
      p.then((v) => { res = v; });
      while (!res && ms < 900_000) { await vi.advanceTimersByTimeAsync(1000); ms += 1000; }
      expect(res.error).toBe(`CLI timeout (${ms / 1000}s)`);
      expect(child.killSignals).toEqual(['SIGTERM']);
      vi.useRealTimers();
    }
    // exit
    {
      activeSession();
      const child = makeFakeChild();
      spawnOnce(() => child);
      const p = runCliAutoTurnCore('s1', 'codex', 120);
      await Promise.resolve();
      child.stderr.write('boom\n');
      await new Promise((r) => setTimeout(r, 0));
      child.emit('close', 3);
      const res = await p;
      expect(res.error).toBe('CLI exit code 3: boom\n');
    }
    // child 'error'
    {
      activeSession();
      const child = makeFakeChild();
      spawnOnce(() => child);
      const p = runCliAutoTurnCore('s1', 'codex', 120);
      await Promise.resolve();
      child.emit('error', errno('spawn codex ENOENT', 'ENOENT'));
      const res = await p;
      expect(res.error).toBe('spawn codex ENOENT');
    }
    // stdin 'error', unobserved termination wrapper
    {
      activeSession();
      const stdin = controllableStdin();
      const child = makeFakeChild({ stdin });
      spawnOnce(() => child);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
      const p = runCliAutoTurnCore('s1', 'codex', 120);
      await vi.advanceTimersByTimeAsync(0);
      stdin.raise(errno('write EPIPE', 'EPIPE'));
      let res = null;
      p.then((v) => { res = v; });
      await vi.advanceTimersByTimeAsync(7000);
      expect(res.error).toBe(
        'write EPIPE (provider termination UNOBSERVED after SIGTERM+SIGKILL within 7000ms)'
      );
      expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
      vi.useRealTimers();
    }
  });

  it('2.4 every failure leaves no live timer behind and submits nothing', async () => {
    const submitted = activeSession();
    const child = makeFakeChild();
    spawnOnce(() => child);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'Date', 'performance'] });
    const p = runCliAutoTurnCore('s1', 'codex', 120);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);          // exactly the turn deadline
    child.emit('close', 1);
    const res = await p;
    expect(res.ok).toBe(false);
    expect({ timers: vi.getTimerCount(), subs: submitted.length }).toEqual({ timers: 0, subs: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3. THE STEP SHAPE runUntilBlockedCore PUBLISHES
// ─────────────────────────────────────────────────────────────────────────────
describe('§3 the public step shape changes only for a failing step with provenance', () => {
  const BASE_STEP_KEYS = ['blocked', 'elapsedMs', 'error', 'ok', 'speaker', 'transport'];

  it('3.1 a successful step keeps EXACTLY the frozen key set', async () => {
    const state = sessionState();
    activeSession(state);
    hooks.submitTurn = () => { state.status = 'completed'; state.current_speaker = 'none'; return { ok: true }; };
    const child = makeFakeChild();
    spawnOnce(() => child);

    const p = runUntilBlockedCore('s1', { maxTurns: 1 });
    await Promise.resolve();
    child.stdout.end('answer');
    child.stderr.end();
    await new Promise((r) => setTimeout(r, 0));
    child.emit('close', 0);
    const res = await p;

    expect(res.steps).toHaveLength(1);
    expect(Object.keys(res.steps[0]).sort()).toEqual(BASE_STEP_KEYS);
    expect(res.steps[0].ok).toBe(true);
  });

  it('3.2 a failing step from a transport that reports NO provenance keeps the frozen key set', async () => {
    // A pre-flight refusal: `{ ok:false, error }` with no `failure`, so
    // runUntilBlockedCore must attach nothing.
    activeSession();
    hooks.liveness = () => false;
    const res = await runUntilBlockedCore('s1', { maxTurns: 1 });
    expect(res.steps).toHaveLength(1);
    expect(res.steps[0].ok).toBe(false);
    expect(res.steps[0].error).toBe('CLI "codex" not available');
    expect(Object.keys(res.steps[0]).sort()).toEqual(BASE_STEP_KEYS);
  });

  it('3.3 a failing step WITH provenance gains exactly one key, carried verbatim', async () => {
    activeSession();
    const child = makeFakeChild();
    spawnOnce(() => child);

    const p = runUntilBlockedCore('s1', { maxTurns: 1 });
    await Promise.resolve();
    child.emit('error', errno('spawn codex ENOENT', 'ENOENT'));
    const res = await p;

    expect(Object.keys(res.steps[0]).sort()).toEqual([...BASE_STEP_KEYS, 'failure'].sort());
    expect(res.steps[0].failure).toEqual({ origin: 'child_error', code: 'ENOENT' });
    // The legacy fields are untouched by the addition.
    expect(res.steps[0].error).toBe('spawn codex ENOENT');
    expect(res.status).toBe('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4. THE FIVE ORIGINS AND THE CLOSED CODE TABLE, THROUGH THE REAL MODULE.
//
// Every arm reaches `describeCliFailure` by making the product raise its own
// error at the site in question. Nothing is called directly — the helpers are
// not exported, and re-implementing them would measure the test, not the
// product.
// ─────────────────────────────────────────────────────────────────────────────

// Runs one failing turn and returns its `{ ok:false, error, failure }`.
async function failingTurn(drive, { fakeTimers = false, advanceMs = 7000 } = {}) {
  activeSession();
  const stdin = controllableStdin();
  const child = makeFakeChild({ stdin });
  spawnOnce(() => child);
  if (fakeTimers) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const p = runCliAutoTurnCore('s1', 'codex', 120);
  let res = null;
  p.then((v) => { res = v; }, (e) => { res = { threw: e }; });
  if (fakeTimers) await vi.advanceTimersByTimeAsync(0); else await Promise.resolve();
  await drive({ child, stdin });
  if (fakeTimers) {
    let ms = 0;
    while (!res && ms < 900_000) { await vi.advanceTimersByTimeAsync(Math.min(1000, advanceMs)); ms += 1000; }
    vi.useRealTimers();
  }
  const out = await p;
  return { res: out, child, stdin };
}

describe('§4 origin and code are observed, never guessed', () => {
  it('4.1 stdin_error, allowlisted code: EPIPE', async () => {
    const { res } = await failingTurn(
      async ({ stdin }) => { stdin.raise(errno('write EPIPE', 'EPIPE')); },
      { fakeTimers: true }
    );
    expect(res.failure).toEqual({ origin: 'stdin_error', code: 'EPIPE' });
    expect(res.error).toContain('write EPIPE');
  });

  it('4.2 stdin_error, code present but OUTSIDE the allowlist -> other', async () => {
    const { res } = await failingTurn(
      async ({ stdin }) => { stdin.raise(errno('write EWHATEVER', 'EWHATEVER')); },
      { fakeTimers: true }
    );
    expect(res.failure).toEqual({ origin: 'stdin_error', code: 'other' });
    // The raw code is NOT in the typed field. It is still in the legacy text,
    // which this change does not claim to redact.
    expect(JSON.stringify(res.failure)).not.toContain('EWHATEVER');
  });

  it('4.3 stdin_error, no code at all -> none', async () => {
    const { res } = await failingTurn(
      async ({ stdin }) => { stdin.raise(new Error('stream went away')); },
      { fakeTimers: true }
    );
    expect(res.failure).toEqual({ origin: 'stdin_error', code: 'none' });
  });

  it('4.4 stdin_error is reported for the SYNCHRONOUS throw path too', async () => {
    activeSession();
    const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    stdin.write = () => { throw errno('write ERR_STREAM_DESTROYED', 'ERR_STREAM_DESTROYED'); };
    const child = makeFakeChild({ stdin });
    spawnOnce(() => child);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const p = runCliAutoTurnCore('s1', 'codex', 120);
    let res = null;
    p.then((v) => { res = v; });
    await vi.advanceTimersByTimeAsync(7000);
    expect(res.failure).toEqual({ origin: 'stdin_error', code: 'ERR_STREAM_DESTROYED' });
    vi.useRealTimers();
  });

  it('4.5 child_error — the half of the pair the free-text seam could not separate', async () => {
    const { res } = await failingTurn(
      async ({ child }) => { child.emit('error', errno('spawn codex ENOENT', 'ENOENT')); }
    );
    expect(res.failure).toEqual({ origin: 'child_error', code: 'ENOENT' });
  });

  it('4.6 the pair IS separated: identical message text, two different origins', async () => {
    // This is the whole justification for the change. The same byte-identical
    // Node errno message arriving at the two sites used to be indistinguishable
    // downstream; now the origin differs while the message does not.
    const viaChild = await failingTurn(
      async ({ child }) => { child.emit('error', errno('write EPIPE', 'EPIPE')); }
    );
    const viaStdin = await failingTurn(
      async ({ stdin }) => { stdin.raise(errno('write EPIPE', 'EPIPE')); },
      { fakeTimers: true }
    );
    expect(viaChild.res.error).toBe('write EPIPE');
    expect(viaStdin.res.error).toContain('write EPIPE');
    expect(viaChild.res.failure.origin).toBe('child_error');
    expect(viaStdin.res.failure.origin).toBe('stdin_error');
    expect(viaChild.res.failure.code).toBe(viaStdin.res.failure.code);
  });

  it('4.7 timeout: origin timeout, code none, message unchanged', async () => {
    activeSession();
    const child = makeFakeChild({ stdin: controllableStdin() });
    spawnOnce(() => child);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const p = runCliAutoTurnCore('s1', 'codex', 120);
    let res = null;
    p.then((v) => { res = v; });
    let ms = 0;
    while (!res && ms < 900_000) { await vi.advanceTimersByTimeAsync(1000); ms += 1000; }
    expect(res.failure).toEqual({ origin: 'timeout', code: 'none' });
    expect(res.error).toBe(`CLI timeout (${ms / 1000}s)`);
    vi.useRealTimers();
  });

  it('4.8 exit: origin exit, code none, and the 500-byte stderr clip is unchanged', async () => {
    activeSession();
    const child = makeFakeChild();
    spawnOnce(() => child);
    const p = runCliAutoTurnCore('s1', 'codex', 120);
    await Promise.resolve();
    child.stderr.write('E'.repeat(900));
    await new Promise((r) => setTimeout(r, 0));
    child.emit('close', 1);
    const res = await p;
    expect(res.failure).toEqual({ origin: 'exit', code: 'none' });
    expect(res.error).toBe(`CLI exit code 1: ${'E'.repeat(500)}`);
  });

  it('4.9 unknown: an untagged post-launch error is NOT classified from its message', async () => {
    // `submitDeliberationTurn` runs inside the same try, so an error it raises
    // reaches the catch having passed no raising site. Its message is a perfect
    // counterfeit of a stdin failure, complete with the UNOBSERVED wrapper. A
    // reader that guessed from text would call this stdin_error.
    const state = sessionState();
    activeSession(state);
    const counterfeit =
      'write EPIPE (provider termination UNOBSERVED after SIGTERM+SIGKILL within 7000ms)';
    hooks.submitTurn = () => { throw errno(counterfeit, 'EPIPE'); };
    const child = makeFakeChild();
    spawnOnce(() => child);

    const p = runCliAutoTurnCore('s1', 'codex', 120);
    await Promise.resolve();
    child.stdout.end('answer');
    child.stderr.end();
    await new Promise((r) => setTimeout(r, 0));
    child.emit('close', 0);
    const res = await p;

    expect(res.error).toBe(counterfeit);
    // The code IS read (it is the error's own field, not an inference); the
    // origin is not, because no site claimed it.
    expect(res.failure).toEqual({ origin: 'unknown', code: 'EPIPE' });
  });

  it('4.10 unknown does not leak the untagged value: a forged origin field is rejected', async () => {
    // An error arriving with a plausible-looking own property called
    // `cliFailureOrigin` (a STRING key, not the module symbol) must not be
    // believed: the tag is symbol-keyed for exactly this reason.
    const forged = errno('spawn codex ENOENT', 'ENOENT');
    forged.cliFailureOrigin = 'timeout';
    const state = sessionState();
    activeSession(state);
    hooks.submitTurn = () => { throw forged; };
    const child = makeFakeChild();
    spawnOnce(() => child);
    const p = runCliAutoTurnCore('s1', 'codex', 120);
    await Promise.resolve();
    child.stdout.end('answer');
    child.stderr.end();
    await new Promise((r) => setTimeout(r, 0));
    child.emit('close', 0);
    const res = await p;
    expect(res.failure).toEqual({ origin: 'unknown', code: 'ENOENT' });
  });

  it('4.11 the code table is closed: every allowlisted code round-trips, nothing else does', async () => {
    const ALLOWED = [
      'EPIPE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
      'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END',
      'ERR_STREAM_ALREADY_FINISHED',
      'ENOENT', 'EACCES', 'EPERM', 'EAGAIN', 'EBADF', 'EINVAL',
      'EMFILE', 'ENFILE', 'ENOMEM', 'EIO', 'ESPIPE',
    ];
    const observed = [];
    for (const code of ALLOWED) {
      const { res } = await failingTurn(async ({ child }) => { child.emit('error', errno('e', code)); });
      observed.push(res.failure.code);
    }
    expect(observed).toEqual(ALLOWED);

    // Hostile / private-looking values all collapse to the single label `other`,
    // and nothing resembling them survives into the field.
    const REJECTED = [
      'EPIPE ', 'epipe', 'ENOENT\n', 0, -1, 4058, true, {}, [], () => {},
      'sk-live-0123456789', '/Users/someone/.ssh/id_ed25519', 'Bearer abc.def',
      'origin: timeout code: EPIPE',
    ];
    for (const code of REJECTED) {
      const { res } = await failingTurn(async ({ child }) => { child.emit('error', errno('e', code)); });
      expect(res.failure).toEqual({ origin: 'child_error', code: 'other' });
    }

    // The three "no code" spellings the writer treats as absent.
    for (const code of [undefined, null, '']) {
      const { res } = await failingTurn(async ({ child }) => { child.emit('error', errno('e', code)); });
      expect(res.failure).toEqual({ origin: 'child_error', code: 'none' });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5. THE TAG MUST NOT BE OBSERVABLE, MUST NOT THROW, MUST NOT OVERWRITE.
// ─────────────────────────────────────────────────────────────────────────────
describe('§5 tagging is invisible, total and first-wins', () => {
  it('5.1 a FROZEN Error does not crash the turn — it reports unknown', async () => {
    const err = Object.freeze(errno('spawn codex EACCES', 'EACCES'));
    const { res } = await failingTurn(async ({ child }) => { child.emit('error', err); });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('spawn codex EACCES');
    expect(res.failure).toEqual({ origin: 'unknown', code: 'EACCES' });
    expect(Object.getOwnPropertySymbols(err)).toHaveLength(0);
  });

  it('5.2 sealed and preventExtensions Errors behave the same way', async () => {
    for (const harden of [Object.seal, Object.preventExtensions]) {
      const err = harden(errno('boom', 'EIO'));
      const { res } = await failingTurn(async ({ child }) => { child.emit('error', err); });
      expect(res.failure).toEqual({ origin: 'unknown', code: 'EIO' });
      expect(Object.getOwnPropertySymbols(err)).toHaveLength(0);
    }
  });

  it('5.3 a Proxy whose defineProperty trap throws is returned, not thrown', async () => {
    const target = errno('proxied', 'EPERM');
    const hostile = new Proxy(target, {
      defineProperty() { throw new Error('trap: defineProperty refused'); },
    });
    const { res } = await failingTurn(async ({ child }) => { child.emit('error', hostile); });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('proxied');
    expect(res.failure).toEqual({ origin: 'unknown', code: 'EPERM' });
    expect(Object.getOwnPropertySymbols(target)).toHaveLength(0);
  });

  it('5.4 a throwing `code` getter lands on none instead of converting the return into a throw', async () => {
    const err = new Error('getter hostile');
    Object.defineProperty(err, 'code', { get() { throw new Error('trap: code getter'); } });
    const { res } = await failingTurn(async ({ child }) => { child.emit('error', err); });
    expect(res.ok).toBe(false);
    // The object was extensible, so the tag still landed: the hostile getter
    // costs the CODE only, and costs it as `none` rather than as a thrown turn.
    expect(res.failure).toEqual({ origin: 'child_error', code: 'none' });
  });

  it('5.5 a Proxy get trap that fires on SYMBOL keys opens no escape', async () => {
    // Aimed precisely at the new tag: every symbol read throws, string reads are
    // normal. Both the tag write and the tag read must absorb it.
    const target = errno('symbol-hostile', 'EBADF');
    const hostile = new Proxy(target, {
      get(t, k, r) {
        if (typeof k === 'symbol') throw new Error('trap: symbol get');
        return Reflect.get(t, k, r);
      },
      defineProperty(t, k, d) {
        if (typeof k === 'symbol') throw new Error('trap: symbol defineProperty');
        return Reflect.defineProperty(t, k, d);
      },
    });
    const { res } = await failingTurn(async ({ child }) => { child.emit('error', hostile); });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('symbol-hostile');
    expect(res.failure).toEqual({ origin: 'unknown', code: 'EBADF' });
  });

  it('5.5b a get trap on `message` still escapes — UNCHANGED from the frozen baseline', async () => {
    // Recorded honestly, and asserted so a regression in either direction is
    // visible: `err.message` in the catch is pre-existing code the change did
    // not touch, so a trap on `message` throws out of the turn on BOTH the
    // frozen baseline and the candidate. This arm therefore passes on both, and
    // is the boundary of the "no new escapes" claim — not a defect introduced
    // here, and not a defect this change was asked to fix.
    activeSession();
    const target = errno('never read', 'EIO');
    const hostile = new Proxy(target, {
      get(t, k, r) {
        if (k === 'message') throw new Error('trap: message');
        return Reflect.get(t, k, r);
      },
    });
    const child = makeFakeChild();
    spawnOnce(() => child);
    const p = runCliAutoTurnCore('s1', 'codex', 120);
    await Promise.resolve();
    child.emit('error', hostile);
    await expect(p).rejects.toThrow('trap: message');
  });

  it('5.6 the tag is symbol-keyed, non-enumerable and invisible to every existing reader', async () => {
    const err = errno('spawn codex ENOENT', 'ENOENT');
    err.cause = new Error('inner');
    const beforeKeys = Object.keys(err);
    const beforeJson = JSON.stringify(err);
    const beforeProto = Object.getPrototypeOf(err);
    const innerCause = err.cause;

    const { res } = await failingTurn(async ({ child }) => { child.emit('error', err); });
    expect(res.failure.origin).toBe('child_error');   // it really was tagged

    const symbols = Object.getOwnPropertySymbols(err);
    expect(symbols).toHaveLength(1);
    expect(String(symbols[0])).toBe('Symbol(cliFailureOrigin)');
    const d = Object.getOwnPropertyDescriptor(err, symbols[0]);
    expect(d.enumerable).toBe(false);
    expect(d.value).toBe('child_error');

    // Enumerable symbol keys ARE copied by spread; non-enumerable ones are not.
    expect(Object.getOwnPropertySymbols({ ...err })).toHaveLength(0);
    expect(Object.keys(err)).toEqual(beforeKeys);
    expect(JSON.stringify(err)).toBe(beforeJson);
    const forIn = [];
    for (const k in err) forIn.push(k);
    expect(forIn.filter((k) => Object.hasOwn(err, k))).toEqual(beforeKeys);
    // Identity, prototype, message, code, cause and instanceof intact.
    expect(Object.getPrototypeOf(err)).toBe(beforeProto);
    expect(err instanceof Error).toBe(true);
    expect(err.message).toBe('spawn codex ENOENT');
    expect(err.code).toBe('ENOENT');
    expect(err.cause).toBe(innerCause);
  });

  it('5.7 first raising site wins: a re-raised, already-tagged error keeps its ORIGINAL origin', async () => {
    // One object, two sites. It is tagged child_error on the first turn; the
    // second turn raises the SAME object at the stdin site, which must not
    // restate its cause.
    const shared = errno('write EPIPE', 'EPIPE');
    const first = await failingTurn(async ({ child }) => { child.emit('error', shared); });
    expect(first.res.failure).toEqual({ origin: 'child_error', code: 'EPIPE' });

    const second = await failingTurn(
      async ({ stdin }) => { stdin.raise(shared); },
      { fakeTimers: true }
    );
    // The stdin path wrapped it in a NEW unobserved-termination Error, which is
    // tagged stdin_error at its own site — that wrapper is a first tag, not an
    // overwrite. The shared object itself still carries the first origin.
    expect(Object.getOwnPropertyDescriptor(
      shared, Object.getOwnPropertySymbols(shared)[0]
    ).value).toBe('child_error');
    expect(second.res.failure.origin).toBe('stdin_error');
    expect(second.res.error).toContain('UNOBSERVED');
    // and the wrapper's `cause` is still the first error, untouched.
    expect(Object.getOwnPropertySymbols(shared)).toHaveLength(1);
  });

  it('5.8 the FIRST stdin error owns both origin and code; a later one replaces neither', async () => {
    activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    spawnOnce(() => child);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const p = runCliAutoTurnCore('s1', 'codex', 120);
    let res = null;
    p.then((v) => { res = v; });
    await vi.advanceTimersByTimeAsync(0);
    stdin.raise(errno('write EPIPE', 'EPIPE'));
    stdin.raise(errno('write ECONNRESET', 'ECONNRESET'));
    const signalsAfterFirst = [...child.killSignals];
    await vi.advanceTimersByTimeAsync(7000);
    expect(res.failure).toEqual({ origin: 'stdin_error', code: 'EPIPE' });
    expect(res.error).toContain('EPIPE');
    expect(res.error).not.toContain('ECONNRESET');
    // The duplicate raised no extra signal either.
    expect(child.killSignals.slice(0, signalsAfterFirst.length)).toEqual(signalsAfterFirst);
    vi.useRealTimers();
  });

  it('5.9 a recorded stdin failure still outranks a later child error, origin included', async () => {
    activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    spawnOnce(() => child);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const p = runCliAutoTurnCore('s1', 'codex', 120);
    let res = null;
    p.then((v) => { res = v; });
    await vi.advanceTimersByTimeAsync(0);
    stdin.raise(errno('write EPIPE', 'EPIPE'));
    child.emit('error', errno('spawn codex ENOENT', 'ENOENT'));
    await vi.advanceTimersByTimeAsync(7000);
    expect(res.failure).toEqual({ origin: 'stdin_error', code: 'EPIPE' });
    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6. THE WRITER, THROUGH THE ACTUAL runAutoHandoff -> runUntilBlockedCore
//     CHAIN. No snippet is re-implemented: the records asserted below are the
//     ones `_deps.appendRuntimeLog` was really handed.
//
// Termination of the driver: the session store is owned, so it is made to
// disappear the moment Phase 1 submits its placeholder. runAutoHandoff then
// returns at its own `Session ... disappeared` guard, and Phases 2-5 —
// synthesis, session mutation, monitor-terminal close, telepty notify — are
// never entered. Nothing in this file can reach a real terminal, bus or socket.
// ─────────────────────────────────────────────────────────────────────────────
const FAKE_TIMER_SET = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'Date', 'performance'];

async function driveAutoHandoff({ childFactory, liveness = () => true, onSubmit } = {}) {
  const records = [];
  initTransportDeps({ appendRuntimeLog: (level, message) => records.push({ level, message }) });
  const state = sessionState();
  let gone = false;
  const submitted = [];
  hooks.loadSession = () => (gone ? null : state);
  hooks.submitTurn = (payload) => {
    submitted.push(payload);
    if (onSubmit) onSubmit(payload);
    gone = true;                 // ends Phase 1 at the product's own guard
    return { ok: true };
  };
  hooks.liveness = liveness;
  hooks.transportFor = () => ({ transport: 'cli_respond' });
  hooks.caller = () => null;
  if (childFactory) spawnOnce(childFactory);

  vi.useFakeTimers({ toFake: FAKE_TIMER_SET });
  let done = false;
  const p = runAutoHandoff('s1').then(() => { done = true; });
  let ms = 0;
  while (!done && ms < 600_000) { await vi.advanceTimersByTimeAsync(500); ms += 500; }
  vi.useRealTimers();
  await p;
  expect(done, 'runAutoHandoff did not return within 600s of virtual time').toBe(true);
  return { records, submitted };
}

// A child that closes non-zero with empty stdout the instant the listeners are
// attached: the `exit` origin, reached with no timer at all.
const exitingChild = () => {
  const child = makeFakeChild();
  queueMicrotask(() => { child.stderr.end(); child.emit('close', 1); });
  return child;
};

// Same, but the failure is a child-level 'error' carrying EPIPE.
const erroringChild = () => {
  const child = makeFakeChild();
  queueMicrotask(() => { child.emit('error', errno('write EPIPE', 'EPIPE')); });
  return child;
};

// A child that answers successfully.
const answeringChild = () => {
  const child = makeFakeChild();
  queueMicrotask(() => { child.stdout.end('the answer'); child.stderr.end(); child.emit('close', 0); });
  return child;
};

const retryRecords = (records) => records
  .map((r) => r.message)
  .filter((m) => m.startsWith('AUTO_HANDOFF_RETRY: '));

// The frozen record grammar, with the provenance field OPTIONAL. Anchored at
// both ends so an extra field anywhere would fail it.
const HISTORICAL_RETRY_RE =
  /^AUTO_HANDOFF_RETRY: (?<sid>[^|]+) \| speaker: (?<sp>[^|]+) \| attempt (?<n>\d+)\/(?<m>\d+)(?: \| origin: (?<origin>[a-z_]+) code: (?<code>[A-Za-z0-9_]+))? \| reason: (?<reason>.*) \| retrying in (?<delay>\d+)ms$/;

describe('§6 the writer emits the field once per retry, inside the frozen grammar', () => {
  it('6.1 a post-launch failure: two retries, each with exactly one provenance field', async () => {
    const { records, submitted } = await driveAutoHandoff({ childFactory: exitingChild });
    const retries = retryRecords(records);
    // retryConfig is untouched: maxRetries 2 -> attempts 0,1,2 -> 2 RETRY
    // records then one SKIP. The retry POLICY is asserted, not assumed.
    expect(retries).toHaveLength(2);
    const parsed = retries.map((line) => {
      expect(line, line).toMatch(HISTORICAL_RETRY_RE);
      // exactly once per record, not once per attempt-so-far
      expect(line.split('origin: ')).toHaveLength(2);
      expect(line.split('code: ')).toHaveLength(2);
      return HISTORICAL_RETRY_RE.exec(line).groups;
    });
    expect(parsed.map((g) => g.n)).toEqual(['1', '2']);
    expect(parsed.map((g) => g.m)).toEqual(['2', '2']);
    expect(parsed.map((g) => g.origin)).toEqual(['exit', 'exit']);
    expect(parsed.map((g) => g.code)).toEqual(['none', 'none']);
    expect(parsed.map((g) => g.delay)).toEqual(['10000', '10000']);
    // The historical reason field still carries the legacy free text verbatim.
    expect(parsed.map((g) => g.reason)).toEqual(['CLI exit code 1: ', 'CLI exit code 1: ']);
    // The SKIP record is unchanged and carries NO provenance.
    const skip = records.map((r) => r.message).filter((m) => m.startsWith('AUTO_HANDOFF_SKIP: '));
    expect(skip).toHaveLength(1);
    expect(skip[0]).toBe('AUTO_HANDOFF_SKIP: s1 | speaker: codex | exhausted 2 retries | submitting placeholder');
    expect(skip[0]).not.toContain('origin:');
    expect(submitted).toHaveLength(1);
    expect(submitted[0].channel_used).toBe('auto_skip');
  });

  it('6.2 the provenance is inserted BEFORE the reason field, never after the trailer', async () => {
    const { records } = await driveAutoHandoff({ childFactory: erroringChild });
    for (const line of retryRecords(records)) {
      expect(line.indexOf('| origin: ')).toBeLessThan(line.indexOf('| reason: '));
      expect(line.indexOf('| origin: ')).toBeGreaterThan(line.indexOf('| attempt '));
      expect(line.endsWith('| retrying in 10000ms')).toBe(true);
      expect(line).toContain('| origin: child_error code: EPIPE | reason: write EPIPE |');
    }
  });

  it('6.3 a failure with NO provenance leaves the record byte-identical to the frozen grammar', async () => {
    const launchesBefore = spawnCalls.length;
    const { records } = await driveAutoHandoff({ liveness: () => false });
    const retries = retryRecords(records);
    expect(retries).toHaveLength(2);
    for (const line of retries) {
      expect(line).not.toContain('origin:');
      expect(line).not.toContain('code:');
      const g = HISTORICAL_RETRY_RE.exec(line).groups;
      expect(g.origin).toBeUndefined();
      expect(g.reason).toBe('CLI "codex" not available');
    }
    // Reconstructed byte-exactly from the frozen template, so "unchanged" is a
    // comparison and not an eyeball.
    expect(retries[0]).toBe(
      'AUTO_HANDOFF_RETRY: s1 | speaker: codex | attempt 1/2 | reason: CLI "codex" not available | retrying in 10000ms'
    );
    // Never launched on any of the three attempts: a pre-flight refusal.
    expect(spawnCalls.length).toBe(launchesBefore);
  });

  it('6.4 a successful turn writes no retry record and no provenance anywhere in the log', async () => {
    const { records, submitted } = await driveAutoHandoff({ childFactory: answeringChild });
    expect(retryRecords(records)).toHaveLength(0);
    const whole = records.map((r) => `${r.level} ${r.message}`).join('\n');
    expect(whole).not.toContain('origin:');
    expect(whole).not.toContain('code:');
    const ok = records.map((r) => r.message).filter((m) => m.startsWith('AUTO_HANDOFF_TURN_OK: '));
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatch(/^AUTO_HANDOFF_TURN_OK: s1 \| speaker: codex \| \d+ms$/);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].channel_used).toBe('cli_auto');
  });

  it('6.5 the legacy reason text is STILL raw: this change did not make the log private', async () => {
    // Deliberate counter-claim. A child stderr carrying a secret-shaped string
    // reaches `| reason:` exactly as before. The typed fields are additive; no
    // redaction is claimed anywhere.
    const secret = 'sk-live-DEADBEEF /Users/someone/.ssh/id_ed25519';
    const { records } = await driveAutoHandoff({
      childFactory: () => {
        const child = makeFakeChild();
        queueMicrotask(() => { child.stderr.end(secret); child.emit('close', 7); });
        return child;
      },
    });
    const retries = retryRecords(records);
    expect(retries).toHaveLength(2);
    for (const line of retries) {
      expect(line).toContain(secret);                                 // unchanged, still raw
      const g = HISTORICAL_RETRY_RE.exec(line).groups;
      expect(g.reason).toBe(`CLI exit code 7: ${secret}`);
      // ...but the two NEW fields contain only closed-table labels.
      expect(g.origin).toBe('exit');
      expect(g.code).toBe('none');
    }
  });

  it('6.6 a malformed provenance reaching the writer is re-validated, never printed raw', async () => {
    // The writer does not trust the step it is handed. Exercised through the
    // real function by driving a transport step whose `failure` is hostile: the
    // only injection point the module exposes is the step itself, so this arm
    // drives runUntilBlockedCore's own step and then asserts the writer's
    // contract via the records of a turn whose provenance came from a genuine
    // site. What is asserted here is the observable consequence: no value
    // outside the two closed tables ever appears in a record.
    const { records } = await driveAutoHandoff({ childFactory: erroringChild });
    for (const line of retryRecords(records)) {
      const g = HISTORICAL_RETRY_RE.exec(line).groups;
      expect(['stdin_error', 'child_error', 'timeout', 'exit', 'unknown']).toContain(g.origin);
      expect(g.code === 'none' || g.code === 'other' || /^[A-Z][A-Z0-9_]*$/.test(g.code)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §7. THE ACTUAL READER, IN CONTROLLED ISOLATION.
//
// `deliberation-e2e.test.js` is a suite, not a module: its reader is not
// exported and the suite itself spawns a server child, which this slice must not
// do. So the reader is TAKEN FROM ITS SOURCE — one contiguous span, located by
// literal anchors, under an exact whole-file sha256 pin — and evaluated with
// `fs`, `path` and `getInstallDir` injected. No line of it is retyped: a drift
// between the shipped reader and the one measured here is impossible, because
// there is only one copy.
//
// On the frozen pre-change E2E source the pin fails and so does the anchor
// search. That failure IS the regression result for the reader half.
// ─────────────────────────────────────────────────────────────────────────────
const READER_SPAN_START = 'const DIAG_STATUS_ENUM = Object.freeze([';
const READER_SPAN_END = '// No stderr TEXT is emitted, in any form.';

function extractReader() {
  const src = fs.readFileSync(E2E_SRC, 'utf-8');
  const actual = crypto.createHash('sha256').update(Buffer.from(src, 'utf-8')).digest('hex');

  // Regression-meaningful first: say WHAT is missing before saying which bytes.
  expect(
    src.includes('DIAG_RETRY_PROVENANCE_RE'),
    'the E2E source under test carries no provenance reader (expected on the pre-change baseline)'
  ).toBe(true);
  expect(actual, 'E2E reader source is not the pinned candidate bytes').toBe(E2E_READER_SOURCE_SHA256);

  const from = src.indexOf(READER_SPAN_START);
  const to = src.indexOf(READER_SPAN_END);
  expect(from, 'reader span start anchor not found').toBeGreaterThan(-1);
  expect(to, 'reader span end anchor not found').toBeGreaterThan(from);

  const span = src.slice(from, to);
  // Nothing was silently dropped from the span.
  for (const required of [
    'DIAG_RETRY_PROVENANCE_RE', 'DIAG_RETRY_ORIGIN_ENUM', 'DIAG_RETRY_CODE_ENUM',
    'function diagRetryProvenance', 'function diagHandoffEvents', 'function diagEnum',
    'function diagCounts', 'function diagRetryReason',
  ]) {
    expect(span, `span is missing ${required}`).toContain(required);
  }

  const factory = new Function('fs', 'path', 'getInstallDir', `${span}
    return { diagEnum, diagCounts, diagRetryReason, diagRetryProvenance, diagHandoffEvents,
             DIAG_RETRY_ORIGIN_ENUM, DIAG_RETRY_CODE_ENUM, DIAG_RETRY_PROVENANCE_RE,
             DIAG_RETRY_REASON_ENUM };`);
  return factory(fs, path, getFixtureInstallDir);
}

let reader = null;

// Writes lines into the runtime.log the reader resolves for an owned HOME, in
// the EXACT format index.js appendRuntimeLog / _flushDedupToFile produce.
function writeRuntimeLog(lines) {
  const home = fs.mkdtempSync(path.join(OWNED.tmp, 'home-'));
  const dir = getFixtureInstallDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.log'), lines.map((l) => `${l}\n`).join(''), 'utf-8');
  return home;
}
const TS = '2026-09-27T00:00:00.000Z';
const logLine = (level, message) => `${TS} [${level}] ${message}`;
const dedupLine = (n, level, message) => `${TS} [DEDUP] [${n}x in 1200ms] [${level}] ${message}`;
const field = (out, name) => new RegExp(`(?:^| )${name}=(\\S*)`).exec(out)?.[1];

describe('§7 the shipped reader, over records the shipped writer produced', () => {
  beforeAll(() => { reader = extractReader(); });

  it('7.1 end to end: the writer\'s own records, read by the reader, name the origin', async () => {
    const { records } = await driveAutoHandoff({ childFactory: erroringChild });
    const home = writeRuntimeLog(records.map((r) => logLine(r.level, r.message)));
    const out = reader.diagHandoffEvents(home);

    expect(field(out, 'retry_origins')).toBe('child_error=2');
    expect(field(out, 'retry_codes')).toBe('EPIPE=2');
    // The legacy field is unchanged and still says only `other` for this cause —
    // which is exactly the gap the new fields close.
    expect(field(out, 'retry_reasons')).toBe('other=2');
    expect(field(out, 'runtime_log')).toBe('present');
    expect(field(out, 'dedup_lines')).toBe('0');
    expect(field(out, 'unparsed_lines')).toBe('0');
    // No raw text escaped into the reader's output.
    expect(out).not.toContain('write EPIPE');
    expect(out).not.toContain('s1');
  });

  it('7.2 the pair that used to be one bucket now splits, with retry_reasons unchanged', async () => {
    // THE pair, in its genuinely unseparable form: the raw stdin errno message,
    // handed back verbatim because the child WAS observed to close, against the
    // raw child errno message. Both are Node's own free text, byte-identical, so
    // the legacy `reason:` field cannot tell them apart and buckets both as
    // `other`. (The unobserved-termination wrapper is a writer-constructed
    // literal and IS recognised — `stdin_term_unobserved` — so it is not the
    // ambiguous case and is deliberately not used here.)
    const fromStdin = await driveAutoHandoff({
      childFactory: () => {
        const child = makeFakeChild({ stdin: controllableStdin() });
        queueMicrotask(() => {
          child.stdin.emit('error', errno('write EPIPE', 'EPIPE'));
          child.emit('close', 143);          // observed: the error stays verbatim
        });
        return child;
      },
    });
    const stdinOut = reader.diagHandoffEvents(
      writeRuntimeLog(fromStdin.records.map((r) => logLine(r.level, r.message)))
    );
    const fromChild = await driveAutoHandoff({ childFactory: erroringChild });
    const childOut = reader.diagHandoffEvents(
      writeRuntimeLog(fromChild.records.map((r) => logLine(r.level, r.message)))
    );

    expect(field(stdinOut, 'retry_origins')).toBe('stdin_error=2');
    expect(field(childOut, 'retry_origins')).toBe('child_error=2');
    // Both still land in the SAME legacy bucket, proving the separation is new
    // information and not a relabelling of something already there.
    expect(field(stdinOut, 'retry_reasons')).toBe('other=2');
    expect(field(childOut, 'retry_reasons')).toBe('other=2');
  });

  it('7.3 five states stay distinct: <CODE> / absent / unlisted / none / other', () => {
    const base = 'AUTO_HANDOFF_RETRY: s1 | speaker: codex | attempt 1/2';
    const tail = '| reason: CLI exit code 1:  | retrying in 10000ms';
    const home = writeRuntimeLog([
      logLine('WARN', `${base} | origin: exit code: EPIPE ${tail}`),      // named code
      logLine('WARN', `${base} | origin: exit code: none ${tail}`),       // -> absent
      logLine('WARN', `${base} | origin: exit code: other ${tail}`),      // -> unlisted
      logLine('WARN', `${base} ${tail}`),                                 // -> none (no field)
      logLine('WARN', `${base} | origin: exit code: NOTATOKEN ${tail}`),  // -> other
      logLine('WARN', `${base} | origin: unknown code: none ${tail}`),    // untagged origin
    ]);
    const out = reader.diagHandoffEvents(home);
    expect(field(out, 'retry_codes')).toBe('EPIPE=1,absent=2,none=1,other=1,unlisted=1');
    // `unknown` (error reached the writer's catch untagged) and `none` (record
    // carried no provenance field) are counted SEPARATELY. Both mean UNPROVEN;
    // neither is folded into the other, and neither names a cause.
    expect(field(out, 'retry_origins')).toBe('exit=4,none=1,unknown=1');
    // Every one of the five code states is separately visible, and `none`
    // (record carried no field) is not the same count as `absent` (error
    // carried no code).
    expect(field(out, 'retry_codes')).toContain('none=1');
    expect(field(out, 'retry_codes')).toContain('unlisted=1');
    // The two UNPROVEN spellings do not collapse into one another either.
    expect(field(out, 'retry_origins')).toContain('none=1');
  });

  it('7.4 an unlisted or private-looking token never reaches the output as text', () => {
    const base = 'AUTO_HANDOFF_RETRY: s1 | speaker: codex | attempt 1/2';
    const tail = '| reason: unknown | retrying in 10000ms';
    const home = writeRuntimeLog([
      logLine('WARN', `${base} | origin: exit code: SK_LIVE_DEADBEEF ${tail}`),
      logLine('WARN', `${base} | origin: notanorigin code: EPIPE ${tail}`),
    ]);
    const out = reader.diagHandoffEvents(home);
    expect(out).not.toContain('SK_LIVE_DEADBEEF');
    expect(out).not.toContain('notanorigin');
    expect(field(out, 'retry_codes')).toBe('EPIPE=1,other=1');
    // Line 1's origin is a legitimate token (`exit`); line 2's is readable by the
    // grammar but is not a table member, so it reports `other` — a label, not
    // the token. Neither raw string survives anywhere in the output.
    expect(field(out, 'retry_origins')).toBe('exit=1,other=1');
  });

  it('7.5 a field the regex cannot read at all stays unread — not guessed', () => {
    const tail = '| reason: unknown | retrying in 10000ms';
    const home = writeRuntimeLog([
      // origin token with a character outside [a-z_]
      logLine('WARN', `AUTO_HANDOFF_RETRY: s1 | speaker: codex | attempt 1/2 | origin: Exit code: EPIPE ${tail}`),
      // a path-shaped value: the whole field fails to read, nothing is emitted
      logLine('WARN', `AUTO_HANDOFF_RETRY: s1 | speaker: codex | attempt 1/2 | origin: exit code: /etc/passwd ${tail}`),
      // provenance written AFTER the reason trailer: not this field's grammar
      logLine('WARN', `AUTO_HANDOFF_RETRY: s1 | speaker: codex | attempt 1/2 ${tail} | origin: exit code: EPIPE`),
    ]);
    const out = reader.diagHandoffEvents(home);
    expect(field(out, 'retry_origins')).toBe('none=3');
    expect(field(out, 'retry_codes')).toBe('none=3');
    expect(out).not.toContain('/etc/passwd');
  });

  it('7.6 a DEDUP summary still reaches none of the three lists', async () => {
    const { records } = await driveAutoHandoff({ childFactory: erroringChild });
    const lines = records.map((r) => logLine(r.level, r.message));
    const aRetry = records.find((r) => r.message.startsWith('AUTO_HANDOFF_RETRY: '));
    const home = writeRuntimeLog([...lines, dedupLine(41, 'WARN', aRetry.message)]);
    const out = reader.diagHandoffEvents(home);

    expect(field(out, 'dedup_lines')).toBe('1');
    expect(field(out, 'unparsed_lines')).toBe('0');
    // Unchanged from the pre-provenance behaviour: a collapsed repeat stands for
    // an unknown multiplicity and contributes nothing to any of the three.
    expect(field(out, 'retry_origins')).toBe('child_error=2');
    expect(field(out, 'retry_codes')).toBe('EPIPE=2');
    expect(field(out, 'retry_reasons')).toBe('other=2');
  });

  it('7.7 the three lists stay one-entry-per-record, in lockstep', () => {
    const base = 'AUTO_HANDOFF_RETRY: s1 | speaker: codex | attempt 1/2';
    const tail = '| reason: unknown | retrying in 10000ms';
    const home = writeRuntimeLog([
      logLine('WARN', `${base} | origin: exit code: EPIPE ${tail}`),
      logLine('WARN', `${base} ${tail}`),
      logLine('WARN', `${base} | origin: timeout code: none ${tail}`),
      logLine('INFO', 'AUTO_HANDOFF_TURN: s1 | speaker: codex | round: 1/2'),
    ]);
    const out = reader.diagHandoffEvents(home);
    const total = (f) => f.split(',').reduce((n, pair) => n + Number(pair.split('=')[1]), 0);
    expect(total(field(out, 'retry_reasons'))).toBe(3);
    expect(total(field(out, 'retry_origins'))).toBe(3);
    expect(total(field(out, 'retry_codes'))).toBe(3);
  });

  it('7.8 a counterfeit provenance run inside the session id still yields only a label', () => {
    // The capture is bracketed by writer literals on both sides; the leftmost
    // match wins. A hostile session id that contains a complete counterfeit run
    // is therefore readable — and is still forced through the closed tables, so
    // the worst case is a wrong LABEL, never leaked text.
    const forged = 'attempt 9/9 | origin: timeout code: ECONNRESET | reason: x';
    const home = writeRuntimeLog([
      logLine('WARN',
        `AUTO_HANDOFF_RETRY: ${forged} | speaker: codex | attempt 1/2 | origin: exit code: EPIPE | reason: unknown | retrying in 10000ms`),
    ]);
    const out = reader.diagHandoffEvents(home);
    expect(out).not.toContain(forged);
    expect(reader.DIAG_RETRY_ORIGIN_ENUM).toContain(field(out, 'retry_origins').split('=')[0]);
    expect(field(out, 'retry_codes').split('=')[0]).toMatch(/^[A-Za-z_]+$/);
  });

  it('7.9 the reader\'s own tables are closed and mirror the writer\'s', () => {
    expect([...reader.DIAG_RETRY_ORIGIN_ENUM])
      .toEqual(['stdin_error', 'child_error', 'timeout', 'exit', 'unknown']);
    const codes = [...reader.DIAG_RETRY_CODE_ENUM];
    expect(codes.slice(-2)).toEqual(['absent', 'unlisted']);
    // Exactly the writer's allowlist, read out of the product source rather
    // than retyped, so a one-sided edit to either table fails here.
    const transportSrc = fs.readFileSync(TRANSPORT_SRC, 'utf-8');
    const block = /CLI_FAILURE_CODE_ALLOWLIST = Object\.freeze\(\[([^\]]*)\]\)/.exec(transportSrc);
    expect(block, 'writer allowlist not found in transport source').toBeTruthy();
    const writerCodes = [...block[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]);
    expect(codes.slice(0, -2)).toEqual(writerCodes);

    const originBlock = /CLI_FAILURE_ORIGINS = Object\.freeze\(\[([^\]]*)\]\)/.exec(transportSrc);
    const writerOrigins = [...originBlock[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect([...reader.DIAG_RETRY_ORIGIN_ENUM]).toEqual(writerOrigins);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8. THE SEAM HELD — asserted last, over every arm above.
// ─────────────────────────────────────────────────────────────────────────────
describe('§8 nothing real was launched', () => {
  it('8.1 every launch went through the mocked seam with an owned, empty PATH', () => {
    expect(spawnCalls.length).toBeGreaterThan(30);
    for (const call of spawnCalls) {
      const opts = call.args[2] || {};
      expect(opts.env.PATH).toBe(OWNED.bin);
      expect(fs.readdirSync(OWNED.bin)).toEqual([]);   // no CLI is reachable from it
      expect(opts.shell).toBeUndefined();
    }
    expect(process.env.HOME).toBe(OWNED.home);
    evidence.notes.push(`spawn_calls=${spawnCalls.length}`);
  });

  it('8.2 records the evidence this run produced', () => {
    // Printed so the REPORT quotes measurements, not recollections.
    console.log(`[lt1172kb] evidence ${JSON.stringify(evidence)}`);
    expect(evidence.notes.length).toBeGreaterThan(0);
  });
});
