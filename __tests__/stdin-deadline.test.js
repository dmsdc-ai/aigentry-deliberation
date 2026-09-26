// ─────────────────────────────────────────────────────────────────────────────
// task 1172 / lc1172dj-v1 — A STDIN FAILURE MUST NOT MOVE THE ORIGINAL DEADLINE
//
// Regression for the timing defect confirmed by the independent lt1172dd probe:
// `failOnStdinError` retired the original turn/synthesis deadline and armed a
// FRESH 5000+2000 ms cleanup budget, so a first stdin error arriving 1 ms before
// the deadline made the call settle 6999 ms AFTER it.
//
// The corrected contract asserted here:
//   1. every cleanup stage is clipped to the time left before the ORIGINAL
//      absolute deadline, so total elapsed never exceeds it for ANY arrival time
//      of the first stdin error;
//   2. at that deadline the outcome is still the FIRST stdin error (verbatim
//      message + `cause`) with the provider's termination stated as UNOBSERVED —
//      never a generic `CLI timeout (Ns)` / `Synthesis generation timeout`;
//   3. a stage the deadline cut short did not run, so its signal is neither
//      issued nor claimed: an attempted signal is not a delivered one;
//   4. the early-failure 5000+2000 behaviour, the single-signal discipline and
//      the timer hygiene are unchanged.
//
// These drive the REAL runCliAutoTurnCore / generateAutoSynthesis imported from
// lib/transport.js against owned in-process fake children and fake timers. No
// real provider, no spawn, no OS process, no network, no MCP bus — nothing here
// to reap or account for. The deadlines are MEASURED from the product's own
// armed timer, never computed from a re-implementation.
//
// NOTE on the frozen lt1172dd reproducer: its M1/C2 arms record the OVERRUN as
// the measured behaviour. Those expectations are deliberately NOT carried over
// here — this file asserts the corrected instant instead.
//
// ── SECOND DEFECT, SECOND CONTRACT (ct1172dt, carried into this file) ─────────
// The clipping above was first written against `deadlineAt - Date.now()`: a WALL
// clock remainder used to bound a deadline that `setTimeout` enforces on a
// MONOTONIC one. ct1172dt measured what that costs when the two clocks move
// independently — 8 unchanged-clock controls passed while 6 stepped arms failed:
// a backward step of 60 s restored the full 6999 ms overrun and the false
// `SIGTERM+SIGKILL within 7000ms` claim, a 3 s step restored 3000 ms of it, and a
// forward step skipped the escalation entirely so a wedged provider was never
// SIGKILLed. Those six arms are carried here as shipped regressions (§4–§6
// below), each beside its unchanged-clock twin on the same measurement machinery.
//
// The corrected contract they assert:
//   5. every quantity that bounds the cleanup — the deadline origin, each stage's
//      remainder, and the elapsed window the failure reports — comes from the
//      clock that enforces the deadline, so a system-clock step of either sign
//      changes NOTHING about where the call settles or which signals it names.
//
// Measurement discipline for those arms: settlement instants are read from a
// SCHEDULER-elapsed accumulator (`sched.t`, §3), never from `Date.now()`, because
// `Date.now()` is the perturbed quantity and would absorb the jump it is meant to
// expose. The deadlines themselves are re-measured here by sweeping the product's
// own armed timer in scheduler time. No product code is re-implemented.
// ─────────────────────────────────────────────────────────────────────────────
import { afterEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {
  runCliAutoTurnCore,
  generateAutoSynthesis,
  initTransportDeps,
} from '../lib/transport.js';

const KILL_GRACE_MS = 5000;    // STDIN_FAIL_KILL_GRACE_MS
const CLOSE_CONFIRM_MS = 2000; // STDIN_FAIL_CLOSE_CONFIRM_MS
const BUDGET_MS = KILL_GRACE_MS + CLOSE_CONFIRM_MS;

const hooks = vi.hoisted(() => ({
  spawn: null, loadSession: null, submitTurn: null, liveness: null, transportFor: null,
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
  };
});

// ── owned fixtures ───────────────────────────────────────────────────────────

function sessionState(overrides = {}) {
  return {
    id: 's1', project: 'proj', topic: 'Topic.', status: 'active',
    current_round: 1, max_rounds: 2, current_speaker: 'codex',
    speakers: ['codex', 'claude'], speaker_roles: {},
    pending_turn_id: 'turn-1', log: [], ...overrides,
  };
}

// Fake ChildProcess. Records every signal and whether it was aimed at a child
// already observed to close, so "one signal for the failure" stays
// distinguishable from "a signal aimed at a child that already exited".
function makeFakeChild({ stdin, killReturns = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = stdin ?? new PassThrough();
  child.killSignals = [];
  child.closed = false;
  child.killsAfterClose = [];
  child.kill = (sig) => {
    child.killSignals.push(sig);
    if (child.closed) child.killsAfterClose.push(sig);
    return killReturns;
  };
  return child;
}

function observeClose(child, code = 143) {
  child.closed = true;
  child.emit('close', code);
}

// stdin that accepts the write and emits 'error' only when told to. This is what
// makes a LATE first error expressible: the prompt write succeeds, the deadline
// is armed, and the EPIPE is raised at a chosen virtual instant.
function controllableStdin() {
  const s = new Writable({ write(_c, _e, cb) { cb(); } });
  s.raise = (code = 'EPIPE') => { const e = new Error(`write ${code}`); e.code = code; s.emit('error', e); };
  return s;
}

// stdin whose write throws SYNCHRONOUSLY out of .write() itself.
function syncThrowingStdin(code = 'ERR_STREAM_DESTROYED') {
  const s = new Writable({ write(_c, _e, cb) { cb(); } });
  s.write = () => { const e = new Error(`write ${code}`); e.code = code; throw e; };
  return s;
}

function completeChild(child, stdout, code = 0) {
  child.stdout.once('end', () => { child.closed = true; child.emit('close', code); });
  child.stdout.end(stdout);
  child.stderr.end();
}

function activeSession(state = sessionState()) {
  const submitted = [];
  hooks.loadSession = () => state;
  hooks.submitTurn = (p) => { submitted.push(p); return { ok: true }; };
  hooks.liveness = () => true;
  hooks.transportFor = () => ({ transport: 'cli_respond' });
  return submitted;
}

// generateAutoSynthesis takes a SESSION ID: passing a state object makes it bail
// at `if (!state)` and return null for the wrong reason. Every synthesis arm
// therefore asserts the AUTO_SYNTHESIS_FAILED record as well as the null.
function synthesisSession() {
  hooks.loadSession = () => sessionState({ log: [{ speaker: 'codex', round: 1, content: 'prior turn' }] });
  hooks.liveness = () => true;
  const logs = [];
  initTransportDeps({ appendRuntimeLog: (lvl, msg) => logs.push(`${lvl} ${msg}`) });
  return logs;
}

// ── the clocks this harness installs, named explicitly ───────────────────────
//
// The product reads TWO kinds of clock: a wall clock (`Date.now()`, for reported
// elapsed fields) and a monotonic one (`performance.now()`, which is where its
// deadline bound is now measured). Vitest fakes the globals it is told to fake,
// and its default set is deliberately NOT relied on here: if the harness faked
// the scheduler while the product kept reading an unfaked monotonic clock, every
// virtual advance below would leave the product believing no time had passed, the
// clipping would never engage, and the bound would look absent when it is not.
// So every clock the product can read is named, and `probe: clock separation`
// asserts the three properties every arm in this file depends on — a harness
// failure is then reported as a harness failure instead of as a product defect.
const FAKED_CLOCKS = [
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'Date', 'performance',
];

// Scheduler-elapsed accumulator: the sum of the advances performed since the
// clocks were installed. Never read from any clock, so a wall-clock step cannot
// hide inside it. Used by the stepped arms (§4-§6); the unchanged-clock arms above
// measure in `Date.now()`, which is equivalent there precisely because nothing
// steps it.
const sched = { t: 0 };

function installClocks() {
  vi.useFakeTimers({ toFake: FAKED_CLOCKS });
  sched.t = 0;
}

// The only motion that runs timers: advances the scheduler (and, coupled by
// default, the wall clock) by `ms`. `sched.t` is incremented BEFORE the advance so
// a settle callback running during the step reads the instant at its END; with the
// 1 ms sweep used for every measured instant that is exact.
async function adv(ms) {
  sched.t += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

// THE PERTURBATION: moves the wall clock by a signed delta and nothing else. The
// scheduler is not advanced, and the arm re-proves the decoupling at every use
// rather than trusting the probe: the monotonic clock and the pending timer count
// are both asserted unchanged across the step.
function jumpWallClock(deltaMs) {
  const timersBefore = vi.getTimerCount();
  const wallBefore = Date.now();
  const monoBefore = performance.now();
  vi.setSystemTime(new Date(wallBefore + deltaMs));
  expect(Date.now() - wallBefore).toBe(deltaMs);        // the wall clock moved...
  expect(performance.now()).toBe(monoBefore);           // ...the monotonic one did not
  expect(vi.getTimerCount()).toBe(timersBefore);        // nothing fired, nothing advanced
  return deltaMs;
}

// Records the SCHEDULER instant a call settles, for the arms where `Date.now()` is
// the perturbed quantity.
function trackSched(p) {
  const st = { settled: false, at: null, value: undefined };
  p.then((v) => { st.settled = true; st.at = sched.t; st.value = v; },
         (e) => { st.settled = true; st.at = sched.t; st.value = e; });
  return st;
}

// Discovers a settlement instant by 1 ms scheduler steps. Never assumes one.
async function sweepUntilSettled(st, maxMs) {
  let steps = 0;
  while (!st.settled && steps < maxMs) { await adv(1); steps += 1; }
  expect(st.settled, `not settled within ${maxMs}ms of scheduler time`).toBe(true);
  return st.at;
}

// Coarse sweep, used only to LOCATE the product's own armed deadline.
async function sweepCoarse(st, stepMs, maxMs) {
  let steps = 0;
  while (!st.settled && steps < maxMs) { await adv(stepMs); steps += stepMs; }
  expect(st.settled).toBe(true);
  return steps;
}

// Records the exact virtual instant a call settles, so "settled no later than the
// original deadline" is a measurement and not an inference.
function track(p, t0) {
  const st = { settled: false, at: null, value: undefined };
  p.then((v) => { st.settled = true; st.at = Date.now() - t0; st.value = v; },
         (e) => { st.settled = true; st.at = Date.now() - t0; st.value = e; });
  return st;
}
const flush = () => vi.advanceTimersByTimeAsync(0);

// Drives one late-failure arm: spawn, run to `errorAtMs`, raise the first EPIPE.
// Returns the tracker and the child so each arm asserts only its own difference.
function startTurnWithLateError(errorAtMs, stdin, child) {
  const t0 = Date.now();
  const st = track(runCliAutoTurnCore('s1', 'codex', 120), t0);
  return { t0, st, advanceToError: async () => {
    await flush();
    await vi.advanceTimersByTimeAsync(errorAtMs);
    expect(st.settled).toBe(false);
    stdin.raise('EPIPE');
    await flush();
    expect(child.killSignals).toEqual(['SIGTERM']);
  } };
}

afterEach(() => {
  for (const k of Object.keys(hooks)) hooks[k] = null;
  initTransportDeps({ appendRuntimeLog: () => {} });
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// The product's own deadlines, measured — not assumed.
// ─────────────────────────────────────────────────────────────────────────────
let TURN_DEADLINE_MS = null;
let SYNTH_DEADLINE_MS = null;

describe('measured deadlines (no stdin failure)', () => {
  it('turn: the armed deadline and the seconds the product REPORTS agree', async () => {
    activeSession();
    const child = makeFakeChild({ stdin: controllableStdin() });
    hooks.spawn = () => child;
    installClocks();

    const t0 = Date.now();
    const st = track(runCliAutoTurnCore('s1', 'codex', 120), t0);
    await flush();
    expect(vi.getTimerCount()).toBe(1); // exactly the turn deadline

    let stepsMs = 0;
    while (!st.settled && stepsMs < 900_000) {
      await vi.advanceTimersByTimeAsync(1000);
      stepsMs += 1000;
    }
    expect(st.settled).toBe(true);

    const msg = st.value?.error ?? String(st.value);
    const m = /CLI timeout \((\d+)s\)/.exec(msg);
    expect(m, `expected a CLI timeout rejection, got: ${msg}`).toBeTruthy();
    expect(Number(m[1]) * 1000).toBe(stepsMs);
    expect(st.at).toBe(stepsMs);

    TURN_DEADLINE_MS = stepsMs;
    expect(TURN_DEADLINE_MS).toBeGreaterThan(BUDGET_MS);
  });

  it('synthesis: the armed deadline is located the same way', async () => {
    const logs = synthesisSession();
    const child = makeFakeChild({ stdin: controllableStdin() });
    hooks.spawn = () => child;
    installClocks();

    const t0 = Date.now();
    const st = track(generateAutoSynthesis('s1'), t0);
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    let stepsMs = 0;
    while (!st.settled && stepsMs < 900_000) {
      await vi.advanceTimersByTimeAsync(1000);
      stepsMs += 1000;
    }
    expect(st.settled).toBe(true);
    expect(st.value).toBeNull();
    const failed = logs.filter((l) => l.includes('AUTO_SYNTHESIS_FAILED'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('Synthesis generation timeout');
    expect(st.at).toBe(stepsMs);

    SYNTH_DEADLINE_MS = stepsMs;
    expect(SYNTH_DEADLINE_MS).toBeGreaterThan(BUDGET_MS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TURN PATH
// ─────────────────────────────────────────────────────────────────────────────
describe('runCliAutoTurnCore: stdin cleanup is bounded by the original deadline', () => {
  it('initial failure: the full 5000+2000 budget still applies and settles far inside the deadline', async () => {
    const D = TURN_DEADLINE_MS;
    const submitted = activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const t0 = Date.now();
    const st = track(runCliAutoTurnCore('s1', 'codex', 120), t0);
    await flush();

    stdin.raise('EPIPE');                              // t = 0
    await flush();
    expect(child.killSignals).toEqual(['SIGTERM']);
    expect(st.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']); // room for the escalation
    await vi.advanceTimersByTimeAsync(CLOSE_CONFIRM_MS - 1);
    expect(st.settled).toBe(false);                    // still bounded, not yet

    await vi.advanceTimersByTimeAsync(1);
    expect(st.settled).toBe(true);
    expect(st.at).toBe(BUDGET_MS);                     // unchanged early behaviour
    expect(st.at).toBeLessThan(D);
    expect(st.value.error).toContain('write EPIPE');
    expect(st.value.error).toContain('UNOBSERVED');
    expect(st.value.error).toContain('SIGTERM+SIGKILL');
    expect(st.value.error).toContain(String(BUDGET_MS)); // the window that really ran
    expect({ timers: vi.getTimerCount(), subs: submitted.length }).toEqual({ timers: 0, subs: 0 });
  });

  it('deadline-1: settles AT the original deadline with the first error, and claims no SIGKILL', async () => {
    const D = TURN_DEADLINE_MS;
    const submitted = activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const arm = startTurnWithLateError(D - 1, stdin, child);
    await arm.advanceToError();
    const { st } = arm;
    expect(vi.getTimerCount()).toBe(1);   // the deadline handle replaced by a 1ms stage

    await vi.advanceTimersByTimeAsync(1); // the ORIGINAL deadline instant
    expect(st.settled).toBe(true);
    expect(st.at).toBe(D);                // NOT D - 1 + 7000: this is the regression
    expect(st.at).toBeLessThanOrEqual(D);

    // The first stdin error is still the outcome, verbatim and as `cause`...
    expect(st.value.ok).toBe(false);
    expect(st.value.error).toContain('write EPIPE');
    expect(st.value.error).toContain('UNOBSERVED');
    // ...and not a generic timeout.
    expect(st.value.error).not.toContain('CLI timeout');
    // The grace was cut short by the deadline, so the escalation never ran: the
    // signal is neither issued nor claimed.
    expect(child.killSignals).toEqual(['SIGTERM']);
    expect(st.value.error).not.toContain('SIGKILL');
    expect({ timers: vi.getTimerCount(), subs: submitted.length }).toEqual({ timers: 0, subs: 0 });
  });

  it('stage boundary: a failure exactly one full budget before the deadline fits exactly, using both stages', async () => {
    const D = TURN_DEADLINE_MS;
    activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const arm = startTurnWithLateError(D - BUDGET_MS, stdin, child);
    await arm.advanceToError();
    const { st } = arm;

    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']); // the full grace fit
    expect(st.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(CLOSE_CONFIRM_MS);
    expect(st.settled).toBe(true);
    expect(st.at).toBe(D);                                     // exactly on the bound
    expect(st.value.error).toContain('write EPIPE');
    expect(st.value.error).toContain('SIGTERM+SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stage boundary: one ms later, the confirm window is clipped and settlement is still AT the deadline', async () => {
    const D = TURN_DEADLINE_MS;
    activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const arm = startTurnWithLateError(D - BUDGET_MS + 1, stdin, child);
    await arm.advanceToError();
    const { st } = arm;

    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(st.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(CLOSE_CONFIRM_MS - 1); // clipped stage, 1ms short
    expect(st.settled).toBe(true);
    expect(st.at).toBe(D);
    expect(st.value.error).toContain('write EPIPE');
    expect(st.value.error).toContain('UNOBSERVED');
    expect(st.value.error).toContain(String(BUDGET_MS - 1)); // the window that ran
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close observed BEFORE the deadline: settles on that close with the first error untouched', async () => {
    const D = TURN_DEADLINE_MS;
    const submitted = activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const arm = startTurnWithLateError(D - 4000, stdin, child);
    await arm.advanceToError();
    const { st } = arm;

    await vi.advanceTimersByTimeAsync(2500);   // inside the (clipped) grace
    expect(st.settled).toBe(false);
    observeClose(child, 143);
    await flush();

    expect(st.settled).toBe(true);
    expect(st.at).toBe(D - 4000 + 2500);
    expect(st.at).toBeLessThan(D);
    expect(st.value.error).toContain('write EPIPE');
    expect(st.value.error).not.toContain('UNOBSERVED'); // the close WAS observed
    expect(child.killSignals).toEqual(['SIGTERM']);     // close cancelled the escalation
    expect({
      killsAfterClose: child.killsAfterClose, timers: vi.getTimerCount(), subs: submitted.length,
    }).toEqual({ killsAfterClose: [], timers: 0, subs: 0 });
  });

  it('close observed AFTER the deadline: the deadline already settled it, and the late close changes nothing', async () => {
    const D = TURN_DEADLINE_MS;
    activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const arm = startTurnWithLateError(D - 2500, stdin, child);
    await arm.advanceToError();
    const { st } = arm;

    await vi.advanceTimersByTimeAsync(2500);
    expect(st.settled).toBe(true);
    expect(st.at).toBe(D);
    const errorAtDeadline = st.value.error;
    expect(errorAtDeadline).toContain('write EPIPE');
    expect(errorAtDeadline).toContain('UNOBSERVED');

    observeClose(child, 143);                  // 2499ms too late to be observed
    await vi.advanceTimersByTimeAsync(BUDGET_MS);

    expect(st.value.error).toBe(errorAtDeadline); // the claim that landed first stands
    expect(child.killsAfterClose).toEqual([]);
    expect(child.killSignals).toEqual(['SIGTERM']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('duplicate and late errors inside a clipped stage are absorbed: no extra signal, timer or outcome', async () => {
    const D = TURN_DEADLINE_MS;
    activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const arm = startTurnWithLateError(D - 3000, stdin, child);
    await arm.advanceToError();
    const { st } = arm;
    const afterFirst = { kills: [...child.killSignals], timers: vi.getTimerCount() };

    stdin.raise('ECONNRESET');
    stdin.raise('ECONNRESET');
    await flush();
    expect({ kills: child.killSignals, timers: vi.getTimerCount() }).toEqual(afterFirst);

    await vi.advanceTimersByTimeAsync(3000);
    expect(st.settled).toBe(true);
    expect(st.at).toBe(D);
    expect(st.value.error).toContain('EPIPE');
    expect(st.value.error).not.toContain('ECONNRESET'); // first error preserved
    expect(vi.getTimerCount()).toBe(0);
  });

  it('synchronous throw: no deadline handle is armed, one clipped cleanup stage is', async () => {
    const submitted = activeSession();
    const child = makeFakeChild({ stdin: syncThrowingStdin('ERR_STREAM_DESTROYED') });
    hooks.spawn = () => child;
    installClocks();

    const t0 = Date.now();
    const st = track(runCliAutoTurnCore('s1', 'codex', 120), t0);
    await flush();

    // One handle only: the deadline instant is held as a value, not a timer, so a
    // doomed turn cannot have two racing handles.
    expect(child.killSignals).toEqual(['SIGTERM']);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(st.settled).toBe(true);
    expect(st.at).toBe(BUDGET_MS);
    expect(st.at).toBeLessThan(TURN_DEADLINE_MS);
    expect(st.value.error).toContain('write ERR_STREAM_DESTROYED');
    expect(st.value.error).not.toContain('CLI timeout');
    expect({ timers: vi.getTimerCount(), subs: submitted.length }).toEqual({ timers: 0, subs: 0 });
  });

  it('post-settled deadline: a stdin error after the timeout settles nothing and signals nothing', async () => {
    const D = TURN_DEADLINE_MS;
    const submitted = activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const t0 = Date.now();
    const st = track(runCliAutoTurnCore('s1', 'codex', 120), t0);
    await flush();

    await vi.advanceTimersByTimeAsync(D);
    expect(st.settled).toBe(true);
    expect(st.at).toBe(D);
    expect(st.value.error).toContain('CLI timeout'); // pure-timeout path untouched
    const killsAtTimeout = [...child.killSignals];
    const errorAtTimeout = st.value.error;

    expect(() => stdin.raise('EPIPE')).not.toThrow();
    await vi.advanceTimersByTimeAsync(BUDGET_MS);

    expect({
      kills: child.killSignals, error: st.value.error, timers: vi.getTimerCount(), subs: submitted.length,
    }).toEqual({ kills: killsAtTimeout, error: errorAtTimeout, timers: 0, subs: 0 });
  });

  it('the success path is untouched: one submission, no signal, no stranded timer', async () => {
    const submitted = activeSession();
    const child = makeFakeChild();
    hooks.spawn = () => child;

    const p = runCliAutoTurnCore('s1', 'codex', 120);
    await Promise.resolve();
    completeChild(child, 'the answer', 0);
    const res = await p;

    expect(res.ok).toBe(true);
    expect(res.response).toBe('the answer');
    expect(typeof res.elapsedMs).toBe('number');
    expect(submitted).toHaveLength(1);
    expect(child.killSignals).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNTHESIS PATH (the twin implementation)
// ─────────────────────────────────────────────────────────────────────────────
describe('generateAutoSynthesis: the same bound applies', () => {
  it('initial failure: the full budget still applies, well inside the synthesis deadline', async () => {
    const logs = synthesisSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const t0 = Date.now();
    const st = track(generateAutoSynthesis('s1'), t0);
    await flush();

    stdin.raise('EPIPE');
    await flush();
    expect(child.killSignals).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    await vi.advanceTimersByTimeAsync(CLOSE_CONFIRM_MS);

    expect(st.settled).toBe(true);
    expect(st.at).toBe(BUDGET_MS);
    expect(st.value).toBeNull();
    const failed = logs.filter((l) => l.includes('AUTO_SYNTHESIS_FAILED'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('write EPIPE');
    expect(failed[0]).toContain('UNOBSERVED');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deadline-1: settles AT the synthesis deadline with the EPIPE-derived failure, no SIGKILL claimed', async () => {
    const D = SYNTH_DEADLINE_MS;
    const logs = synthesisSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const t0 = Date.now();
    const st = track(generateAutoSynthesis('s1'), t0);
    await flush();

    await vi.advanceTimersByTimeAsync(D - 1);
    stdin.raise('EPIPE');
    await flush();
    expect(child.killSignals).toEqual(['SIGTERM']);
    expect(st.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(st.settled).toBe(true);
    expect(st.at).toBe(D);                 // NOT D - 1 + 7000
    expect(st.value).toBeNull();

    const failed = logs.filter((l) => l.includes('AUTO_SYNTHESIS_FAILED'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('write EPIPE');
    expect(failed[0]).toContain('UNOBSERVED');
    expect(failed[0]).not.toContain('Synthesis generation timeout');
    expect(failed[0]).not.toContain('SIGKILL');
    expect(child.killSignals).toEqual(['SIGTERM']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close observed after the synthesis deadline changes nothing', async () => {
    const D = SYNTH_DEADLINE_MS;
    const logs = synthesisSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const t0 = Date.now();
    const st = track(generateAutoSynthesis('s1'), t0);
    await flush();

    await vi.advanceTimersByTimeAsync(D - 2500);
    stdin.raise('EPIPE');
    await flush();
    await vi.advanceTimersByTimeAsync(2500);

    expect(st.settled).toBe(true);
    expect(st.at).toBe(D);
    observeClose(child, 143);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);

    const failed = logs.filter((l) => l.includes('AUTO_SYNTHESIS_FAILED'));
    expect(failed).toHaveLength(1);       // no second outcome recorded
    expect(failed[0]).toContain('UNOBSERVED');
    expect(child.killsAfterClose).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3. THE HARNESS PROBE — the clock primitive every arm below depends on.
//
// Asserted before any product conclusion is drawn from a stepped clock: if this
// arm fails, the harness is wrong and nothing in §4-§6 may be read as a product
// property. No product call is made here.
// ─────────────────────────────────────────────────────────────────────────────
describe('probe: clock separation', () => {
  it('advancing timers moves the scheduler, the monotonic clock and the wall clock together', async () => {
    installClocks();
    const wall0 = Date.now();
    const mono0 = performance.now();
    let firedAt = null;
    setTimeout(() => { firedAt = performance.now() - mono0; }, 1000);

    await adv(1000);
    expect(firedAt).toBe(1000);                 // the timer ran on its own duration
    expect(performance.now() - mono0).toBe(1000);
    expect(Date.now() - wall0).toBe(1000);
    expect(sched.t).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a system-clock step moves the WALL clock only: monotonic clock, timer queue and pending timers untouched', async () => {
    installClocks();
    const mono0 = performance.now();
    let fired = false;
    setTimeout(() => { fired = true; }, 1000);
    expect(vi.getTimerCount()).toBe(1);

    jumpWallClock(+600_000);                    // forward 10 min
    jumpWallClock(-900_000);                    // and backward past its own origin
    expect(fired).toBe(false);                  // nothing ran
    expect(performance.now()).toBe(mono0);      // the monotonic clock never moved
    expect(sched.t).toBe(0);

    await adv(1000);                            // only a scheduler advance runs it
    expect(fired).toBe(true);
    expect(performance.now() - mono0).toBe(1000);
  });

  it('a timer armed AFTER a step still fires on its scheduler duration, not on the wall delta', async () => {
    installClocks();
    jumpWallClock(-50_000);
    let fired = false;
    setTimeout(() => { fired = true; }, 100);
    await adv(99);
    expect(fired).toBe(false);
    await adv(1);
    expect(fired).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4. The product's own deadlines in SCHEDULER time, and the proof that a
//     wall-clock step does not move them. Re-measured here rather than reused
//     from the Date-based measurement above, so the stepped arms rest on a
//     reference instant established with their own machinery.
// ─────────────────────────────────────────────────────────────────────────────
let TURN_DEADLINE_SCHED_MS = null;
let SYNTH_DEADLINE_SCHED_MS = null;

describe('measured deadlines in scheduler time', () => {
  it('M0: the turn deadline located by sweeping the PRODUCT\'s armed timer', async () => {
    activeSession();
    const child = makeFakeChild({ stdin: controllableStdin() });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    const d = await sweepCoarse(st, 1000, 900_000);
    const msg = st.value?.error ?? String(st.value);
    const m = /CLI timeout \((\d+)s\)/.exec(msg);
    expect(m, `expected a CLI timeout rejection, got: ${msg}`).toBeTruthy();
    expect(Number(m[1]) * 1000).toBe(d);        // the seconds the product reports agree
    expect(st.at).toBe(d);

    TURN_DEADLINE_SCHED_MS = d;
    expect(TURN_DEADLINE_SCHED_MS).toBeGreaterThan(BUDGET_MS);
  });

  it('S0: the synthesis deadline located the same way', async () => {
    const logs = synthesisSession();
    const child = makeFakeChild({ stdin: controllableStdin() });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(generateAutoSynthesis('s1'));
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    const d = await sweepCoarse(st, 1000, 900_000);
    expect(st.value).toBeNull();
    const failed = logs.filter((l) => l.includes('AUTO_SYNTHESIS_FAILED'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('Synthesis generation timeout');

    SYNTH_DEADLINE_SCHED_MS = d;
    expect(SYNTH_DEADLINE_SCHED_MS).toBeGreaterThan(BUDGET_MS);
  });

  it('M-MONO: two wall-clock steps mid-flight do not move the deadline the product enforces', async () => {
    const D = TURN_DEADLINE_SCHED_MS;
    activeSession();
    const child = makeFakeChild({ stdin: controllableStdin() });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    await adv(1000);

    jumpWallClock(-600_000);           // 10 min backward...
    expect(st.settled).toBe(false);
    jumpWallClock(+900_000);           // ...and 15 min forward of that
    expect(st.settled).toBe(false);    // neither step fired the deadline early

    await adv(D - 1000 - 1);
    expect(st.settled).toBe(false);    // nor late
    await adv(1);
    expect(st.settled).toBe(true);
    expect(st.at).toBe(D);             // exactly the original scheduler deadline
    expect(st.value.error).toContain(`CLI timeout (${D / 1000}s)`);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5. TURN PATH — a stepped wall clock changes nothing. Each arm is paired with
//     the unchanged-clock control that isolates the step as the only difference.
// ─────────────────────────────────────────────────────────────────────────────
describe('runCliAutoTurnCore: a system-clock step does not move the bound', () => {
  it('T-CTRL-early (control): a t=0 failure uses the full 5000+2000 budget', async () => {
    const submitted = activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    stdin.raise('EPIPE');
    await flush();
    expect(child.killSignals).toEqual(['SIGTERM']);

    const at = await sweepUntilSettled(st, 20_000);
    expect({ settledAtSched: at, signals: child.killSignals })
      .toEqual({ settledAtSched: BUDGET_MS, signals: ['SIGTERM', 'SIGKILL'] });
    expect(at).toBeLessThan(TURN_DEADLINE_SCHED_MS);
    expect(st.value.error).toContain('write EPIPE');
    expect(st.value.error).toContain(`within ${BUDGET_MS}ms`);
    expect({ timers: vi.getTimerCount(), subs: submitted.length }).toEqual({ timers: 0, subs: 0 });
  });

  it('T-CTRL-late (control): a deadline-1 failure settles AT the deadline, no SIGKILL claimed', async () => {
    const D = TURN_DEADLINE_SCHED_MS;
    const submitted = activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    await adv(D - 1);
    expect(st.settled).toBe(false);
    stdin.raise('EPIPE');
    await flush();

    const at = await sweepUntilSettled(st, 30_000);
    expect({ settledAtSched: at, overrun: at - D, signals: child.killSignals })
      .toEqual({ settledAtSched: D, overrun: 0, signals: ['SIGTERM'] });
    expect(st.value.error).toContain('write EPIPE');
    expect(st.value.error).toContain('UNOBSERVED');
    expect(st.value.error).toContain('within 1ms');   // the stage that really ran
    expect(st.value.error).not.toContain('CLI timeout');
    expect(st.value.error).not.toContain('SIGKILL');
    expect({ timers: vi.getTimerCount(), subs: submitted.length }).toEqual({ timers: 0, subs: 0 });
  });

  it('T-BACK-60s: the wall clock steps back 60 s just before a deadline-1 failure', async () => {
    const D = TURN_DEADLINE_SCHED_MS;
    const submitted = activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    await adv(D - 1);                 // 1 ms of scheduler time left
    expect(st.settled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    jumpWallClock(-60_000);           // the only perturbation
    stdin.raise('EPIPE');             // first and only cause
    await flush();
    expect(child.killSignals).toEqual(['SIGTERM']);

    const at = await sweepUntilSettled(st, 30_000);
    // Measured, and printed beside the requirement either way. The pre-fix
    // behaviour under this step was settledAtSched D+6999 with SIGTERM+SIGKILL.
    expect({ settledAtSched: at, originalDeadline: D, overrun: at - D, signals: child.killSignals })
      .toEqual({ settledAtSched: D, originalDeadline: D, overrun: 0, signals: ['SIGTERM'] });
    expect(st.value.error).toContain('write EPIPE');
    expect(st.value.error).toContain('within 1ms');   // not the 7000 ms constant
    expect(st.value.error).not.toContain('SIGKILL');
    expect(st.value.error).not.toContain('CLI timeout');
    expect({ timers: vi.getTimerCount(), subs: submitted.length }).toEqual({ timers: 0, subs: 0 });
  });

  it('T-BACK-3s: a smaller backward step — no overrun, and none that scales with the step', async () => {
    const D = TURN_DEADLINE_SCHED_MS;
    activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    await adv(D - 1);
    jumpWallClock(-3000);
    stdin.raise('EPIPE');
    await flush();

    const at = await sweepUntilSettled(st, 30_000);
    // Pre-fix under this step: D+3000, i.e. the overrun tracked the step exactly.
    expect({ settledAtSched: at, overrun: at - D, signals: child.killSignals })
      .toEqual({ settledAtSched: D, overrun: 0, signals: ['SIGTERM'] });
    expect(st.value.error).toContain('within 1ms');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('T-FWD-early: the wall clock steps a full deadline FORWARD before a t=0 failure', async () => {
    const D = TURN_DEADLINE_SCHED_MS;
    const submitted = activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    jumpWallClock(+D);                // a wall clock now past the deadline instant
    stdin.raise('EPIPE');
    await flush();

    const at = await sweepUntilSettled(st, 20_000);
    // Identical to T-CTRL-early, which isolates the step as the only difference.
    // Pre-fix: settled at 0 with SIGTERM only — the escalation was skipped, so a
    // wedged provider was never SIGKILLed.
    expect({ settledAtSched: at, signals: child.killSignals })
      .toEqual({ settledAtSched: BUDGET_MS, signals: ['SIGTERM', 'SIGKILL'] });
    expect(st.value.error).toContain('write EPIPE');
    expect(st.value.error).toContain(`within ${BUDGET_MS}ms`);
    expect({ timers: vi.getTimerCount(), subs: submitted.length }).toEqual({ timers: 0, subs: 0 });
  });

  it('T-FWD-mid: the wall clock steps forward DURING the grace, before the confirm window is sized', async () => {
    const D = TURN_DEADLINE_SCHED_MS;
    activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    stdin.raise('EPIPE');             // t=0: the full grace is armed normally
    await flush();
    await adv(2000);                  // mid-grace
    jumpWallClock(+D);
    expect(st.settled).toBe(false);

    const at = await sweepUntilSettled(st, 20_000);
    // Pre-fix: the confirm stage was sized against the stepped wall clock, came
    // out at 0, and settled at 5000 with no SIGKILL.
    expect({ settledAtSched: at, signals: child.killSignals })
      .toEqual({ settledAtSched: BUDGET_MS, signals: ['SIGTERM', 'SIGKILL'] });
    expect(st.value.error).toContain(`within ${BUDGET_MS}ms`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('T-CTRL-close (control): an observed close still cancels the escalation', async () => {
    const D = TURN_DEADLINE_SCHED_MS;
    const submitted = activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    await adv(D - 4000);
    stdin.raise('EPIPE');
    await flush();
    await adv(2500);
    expect(st.settled).toBe(false);
    observeClose(child, 143);
    await flush();

    expect(st.settled).toBe(true);
    expect(st.at).toBe(D - 1500);
    expect(st.value.error).toContain('write EPIPE');
    expect(st.value.error).not.toContain('UNOBSERVED');   // the close WAS observed
    expect(child.killSignals).toEqual(['SIGTERM']);
    expect({
      killsAfterClose: child.killsAfterClose, timers: vi.getTimerCount(), subs: submitted.length,
    }).toEqual({ killsAfterClose: [], timers: 0, subs: 0 });
  });

  it('T-CTRL-success (control): a completed call submits once, signals nothing, strands no timer', async () => {
    const submitted = activeSession();
    const child = makeFakeChild({ stdin: controllableStdin() });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    await adv(1000);
    completeChild(child, 'the provider answer');
    await flush();

    expect(st.settled).toBe(true);
    expect(st.value.ok).toBe(true);
    expect(child.killSignals).toEqual([]);
    expect({ timers: vi.getTimerCount(), subs: submitted.length }).toEqual({ timers: 0, subs: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6. SYNTHESIS PATH — the same steps at the second callsite.
// ─────────────────────────────────────────────────────────────────────────────
describe('generateAutoSynthesis: a system-clock step does not move the bound either', () => {
  it('S-CTRL-late (control): a deadline-1 failure settles AT the synthesis deadline', async () => {
    const D = SYNTH_DEADLINE_SCHED_MS;
    const logs = synthesisSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(generateAutoSynthesis('s1'));
    await flush();
    await adv(D - 1);
    expect(st.settled).toBe(false);
    stdin.raise('EPIPE');
    await flush();
    expect(child.killSignals).toEqual(['SIGTERM']);

    const at = await sweepUntilSettled(st, 30_000);
    expect({ settledAtSched: at, overrun: at - D }).toEqual({ settledAtSched: D, overrun: 0 });
    expect(st.value).toBeNull();
    const failed = logs.filter((l) => l.includes('AUTO_SYNTHESIS_FAILED'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('write EPIPE');
    expect(failed[0]).toContain('within 1ms');
    expect(failed[0]).not.toContain('Synthesis generation timeout');
    expect(failed[0]).not.toContain('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('S-BACK-60s: the wall clock steps back 60 s just before a deadline-1 synthesis failure', async () => {
    const D = SYNTH_DEADLINE_SCHED_MS;
    const logs = synthesisSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(generateAutoSynthesis('s1'));
    await flush();
    await adv(D - 1);
    expect(vi.getTimerCount()).toBe(1);

    jumpWallClock(-60_000);
    stdin.raise('EPIPE');
    await flush();
    expect(child.killSignals).toEqual(['SIGTERM']);

    const at = await sweepUntilSettled(st, 30_000);
    // Pre-fix under this step: D+6999 with SIGTERM+SIGKILL and `within 7000ms`.
    expect({ settledAtSched: at, originalDeadline: D, overrun: at - D, signals: child.killSignals })
      .toEqual({ settledAtSched: D, originalDeadline: D, overrun: 0, signals: ['SIGTERM'] });

    const failed = logs.filter((l) => l.includes('AUTO_SYNTHESIS_FAILED'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('write EPIPE');
    expect(failed[0]).toContain('within 1ms');
    expect(failed[0]).not.toContain('SIGKILL');
    expect(failed[0]).not.toContain('Synthesis generation timeout');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('S-FWD-early: the wall clock steps a full synthesis deadline forward before a t=0 failure', async () => {
    const D = SYNTH_DEADLINE_SCHED_MS;
    const logs = synthesisSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installClocks();

    const st = trackSched(generateAutoSynthesis('s1'));
    await flush();
    jumpWallClock(+D);
    stdin.raise('EPIPE');
    await flush();

    const at = await sweepUntilSettled(st, 20_000);
    // Pre-fix: settled at 0, SIGTERM only — the escalation was skipped.
    expect({ settledAtSched: at, signals: child.killSignals })
      .toEqual({ settledAtSched: BUDGET_MS, signals: ['SIGTERM', 'SIGKILL'] });
    const failed = logs.filter((l) => l.includes('AUTO_SYNTHESIS_FAILED'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(`within ${BUDGET_MS}ms`);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §7. THIRD DEFECT, THIRD CONTRACT (mc1172er) — THE REPORTED CLEANUP WINDOW IS
//     MEASURED, NOT SUMMED.
//
// The clipping above reads the monotonic clock correctly. The window the failure
// REPORTS did not: it was accumulated from each stage's SCHEDULED length
// (`+= graceMs`, `+= confirmMs`). Those lengths are what a stage asked for;
// `setTimeout` guarantees a floor and never a ceiling, so a blocked event loop
// serves each stage late and the sum then states less time than really elapsed.
// Measured on the synthesis callsite by an independent run: a healthy control
// reported `within 7000ms` for 7000 ms of monotonic progress, while the same
// harness with 4000 ms of loop lag still reported `within 7000ms` for 11000 ms —
// the diagnostic under-reported by exactly the lag, which is the one quantity it
// exists to expose.
//
// The corrected contract asserted here:
//   6. the reported window is the real monotonic duration from the FIRST stdin
//      error to settlement, at both callsites: it tracks event-loop lag, it is
//      not restarted by a later error, it is not clamped to the 7000 ms budget
//      or to the original deadline when the loop overshoots them, and it is
//      always a nonnegative whole number of milliseconds.
//
// What these arms deliberately do NOT assert: that settlement itself stays at or
// before the deadline under lag. It does not, and cannot — clipping later waits
// bounds the scheduled wait, not the scheduler. L3 pins the overshoot being
// REPORTED rather than hidden.
//
// The lag control below moves the MONOTONIC clock only — no timer is delivered
// and `sched.t` does not move — which is exactly what the product sees when the
// loop is wedged. It wraps the already-faked `performance.now` global that
// `monotonicNowMs` reads, so it is an in-process clock control on a declared
// dependency: no host clock, no process control, no real provider.
// ─────────────────────────────────────────────────────────────────────────────
const lag = { ms: 0, restore: null };

function installLaggableClocks() {
  installClocks();
  const perf = globalThis.performance;
  const faked = perf.now.bind(perf);
  const wrapper = () => faked() + lag.ms;
  lag.ms = 0;
  perf.now = wrapper;
  // Identity-guarded: if `vi.useRealTimers()` already put the real `now` back,
  // this must not push the fake one on top of it again.
  lag.restore = () => { if (perf.now === wrapper) perf.now = faked; lag.restore = null; };
}

// THE PERTURBATION for this section: monotonic time passes, the scheduler does
// not run. Re-proved at every use rather than trusted, exactly as jumpWallClock
// does for its own step.
function injectLoopLag(ms) {
  const monoBefore = performance.now();
  const schedBefore = sched.t;
  const timersBefore = vi.getTimerCount();
  lag.ms += ms;
  expect(performance.now() - monoBefore).toBe(ms);   // the monotonic clock moved...
  expect(sched.t).toBe(schedBefore);                 // ...the scheduler did not
  expect(vi.getTimerCount()).toBe(timersBefore);     // nothing fired
  return ms;
}

// Reads the window out of the product's own message instead of matching a
// constant, so the arms can compare it against a duration the harness measured.
function reportedWindowMs(message) {
  const m = / within (\d+)ms\)/.exec(message ?? '');
  expect(m, `expected a reported cleanup window, got: ${message}`).toBeTruthy();
  return Number(m[1]);
}

describe('the reported cleanup window is measured monotonic elapsed, not the sum of scheduled stages', () => {
  afterEach(() => { if (lag.restore) lag.restore(); lag.ms = 0; });

  it('L1 (control, turn): with no lag the window is the full budget and equals measured elapsed', async () => {
    const submitted = activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installLaggableClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    stdin.raise('EPIPE');
    const monoAtFailure = performance.now();
    await flush();
    expect(child.killSignals).toEqual(['SIGTERM']);

    await adv(KILL_GRACE_MS);
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    await adv(CLOSE_CONFIRM_MS);
    expect(st.settled).toBe(true);

    const observedMono = performance.now() - monoAtFailure;
    expect({ settledAtSched: st.at, observedMono }).toEqual({ settledAtSched: BUDGET_MS, observedMono: BUDGET_MS });
    expect(reportedWindowMs(st.value.error)).toBe(observedMono);
    expect(st.value.error).toContain(`within ${BUDGET_MS}ms`);
    expect({ timers: vi.getTimerCount(), subs: submitted.length }).toEqual({ timers: 0, subs: 0 });
  });

  it('L2 (turn): 4000ms of loop lag inside the grace is REPORTED, not summed away', async () => {
    activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installLaggableClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    stdin.raise('EPIPE');
    const monoAtFailure = performance.now();
    await flush();

    await adv(2000);                  // part of the grace served normally
    injectLoopLag(4000);              // ...then the loop is wedged for 4 s
    await adv(KILL_GRACE_MS - 2000);  // the grace timer is delivered at sched 5000
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(st.settled).toBe(false);

    await adv(CLOSE_CONFIRM_MS);
    expect(st.settled).toBe(true);

    const observedMono = performance.now() - monoAtFailure;
    expect({ settledAtSched: st.at, observedMono })
      .toEqual({ settledAtSched: BUDGET_MS, observedMono: BUDGET_MS + 4000 });
    // THE REGRESSION: pre-fix this said `within 7000ms` — the scheduled sum —
    // for 11000 ms of real cleanup.
    expect(reportedWindowMs(st.value.error)).toBe(11000);
    expect(st.value.error).toContain('within 11000ms');
    expect(st.value.error).not.toContain(`within ${BUDGET_MS}ms`);
    expect(st.value.error).toContain('write EPIPE');
    expect(st.value.error).toContain('UNOBSERVED');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('L3 (turn): lag past the deadline skips the confirm stage, and the overshoot is reported, not clamped', async () => {
    const D = TURN_DEADLINE_SCHED_MS;
    activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installLaggableClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    stdin.raise('EPIPE');             // t=0: the full grace is armed
    const monoAtFailure = performance.now();
    await flush();

    injectLoopLag(D + 500);           // the loop is wedged past the whole deadline
    await adv(KILL_GRACE_MS);         // the grace timer is finally delivered
    expect(st.settled).toBe(true);

    const observedMono = performance.now() - monoAtFailure;
    expect(observedMono).toBe(KILL_GRACE_MS + D + 500);
    // The clipping still sees the lag: no room for the confirm stage, so it is
    // not entered and its SIGKILL is neither issued nor claimed.
    expect({ settledAtSched: st.at, signals: child.killSignals })
      .toEqual({ settledAtSched: KILL_GRACE_MS, signals: ['SIGTERM'] });
    expect(st.value.error).not.toContain('SIGKILL');
    // ...and the window states the real elapsed time even though it is longer
    // than the budget AND longer than the original deadline. Clamping either way
    // would imply a scheduler bound the clipping does not provide.
    expect(reportedWindowMs(st.value.error)).toBe(observedMono);
    expect(reportedWindowMs(st.value.error)).toBeGreaterThan(BUDGET_MS);
    expect(reportedWindowMs(st.value.error)).toBeGreaterThan(D);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('L4 (turn): a fractional monotonic elapsed is still formatted as a nonnegative whole ms', async () => {
    activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installLaggableClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    stdin.raise('EPIPE');
    const monoAtFailure = performance.now();
    await flush();

    injectLoopLag(0.75);
    await adv(BUDGET_MS);
    expect(st.settled).toBe(true);

    const observedMono = performance.now() - monoAtFailure;
    expect(observedMono).toBe(BUDGET_MS + 0.75);
    const reported = reportedWindowMs(st.value.error);
    expect(Number.isInteger(reported)).toBe(true);
    expect(reported).toBeGreaterThanOrEqual(0);
    expect(reported).toBe(Math.round(observedMono));   // 7001, nearest whole ms
  });

  it('L5 (turn): a later error does not restart the window — it starts at the FIRST cause', async () => {
    activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installLaggableClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    stdin.raise('EPIPE');
    const monoAtFailure = performance.now();
    await flush();

    await adv(2000);
    injectLoopLag(3000);
    stdin.raise('ECONNRESET');        // absorbed: no re-signal, no re-arm...
    stdin.raise('ECONNRESET');
    await flush();
    expect(child.killSignals).toEqual(['SIGTERM']);

    await adv(KILL_GRACE_MS - 2000);
    await adv(CLOSE_CONFIRM_MS);
    expect(st.settled).toBe(true);

    const observedMono = performance.now() - monoAtFailure;
    expect(observedMono).toBe(BUDGET_MS + 3000);
    // ...and no re-stamped origin either: restarting at the second error would
    // have reported 5000 ms of a 10000 ms cleanup.
    expect(reportedWindowMs(st.value.error)).toBe(10000);
    expect(st.value.error).toContain('EPIPE');
    expect(st.value.error).not.toContain('ECONNRESET');
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('L6 (turn): an observed close under lag still reports no window at all', async () => {
    const submitted = activeSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installLaggableClocks();

    const st = trackSched(runCliAutoTurnCore('s1', 'codex', 120));
    await flush();
    stdin.raise('EPIPE');
    await flush();

    await adv(2500);
    injectLoopLag(3000);              // lag inside the grace...
    observeClose(child, 143);         // ...and then the child IS observed to close
    await flush();

    expect(st.settled).toBe(true);
    // The first error is handed back untouched: no UNOBSERVED claim, so no
    // window is reported and none is invented for the observed path.
    expect(st.value.error).toBe('write EPIPE');
    expect(st.value.error).not.toContain('UNOBSERVED');
    expect(st.value.error).not.toContain('within');
    expect({
      killsAfterClose: child.killsAfterClose, signals: child.killSignals,
      timers: vi.getTimerCount(), subs: submitted.length,
    }).toEqual({ killsAfterClose: [], signals: ['SIGTERM'], timers: 0, subs: 0 });
  });

  it('L7 (control, synthesis): with no lag the synthesis window equals measured elapsed', async () => {
    const logs = synthesisSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installLaggableClocks();

    const st = trackSched(generateAutoSynthesis('s1'));
    await flush();
    stdin.raise('EPIPE');
    const monoAtFailure = performance.now();
    await flush();

    await adv(BUDGET_MS);
    expect(st.settled).toBe(true);
    expect(st.value).toBeNull();

    const observedMono = performance.now() - monoAtFailure;
    expect({ settledAtSched: st.at, observedMono }).toEqual({ settledAtSched: BUDGET_MS, observedMono: BUDGET_MS });
    const failed = logs.filter((l) => l.includes('AUTO_SYNTHESIS_FAILED'));
    expect(failed).toHaveLength(1);
    expect(reportedWindowMs(failed[0])).toBe(observedMono);
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('L8 (synthesis): the measured counterexample — 4000ms of lag reports 11000ms, not 7000ms', async () => {
    const logs = synthesisSession();
    const stdin = controllableStdin();
    const child = makeFakeChild({ stdin });
    hooks.spawn = () => child;
    installLaggableClocks();

    const st = trackSched(generateAutoSynthesis('s1'));
    await flush();
    stdin.raise('EPIPE');
    const monoAtFailure = performance.now();
    await flush();

    await adv(2000);
    injectLoopLag(4000);
    await adv(KILL_GRACE_MS - 2000);
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(st.settled).toBe(false);
    await adv(CLOSE_CONFIRM_MS);
    expect(st.settled).toBe(true);

    const observedMono = performance.now() - monoAtFailure;
    expect({ settledAtSched: st.at, observedMono })
      .toEqual({ settledAtSched: BUDGET_MS, observedMono: BUDGET_MS + 4000 });
    const failed = logs.filter((l) => l.includes('AUTO_SYNTHESIS_FAILED'));
    expect(failed).toHaveLength(1);
    // The exact frozen measurement this section exists for.
    expect(reportedWindowMs(failed[0])).toBe(11000);
    expect(failed[0]).toContain('within 11000ms');
    expect(failed[0]).not.toContain(`within ${BUDGET_MS}ms`);
    expect(failed[0]).toContain('write EPIPE');
    expect(failed[0]).toContain('UNOBSERVED');
    expect(vi.getTimerCount()).toBe(0);
  });
});
