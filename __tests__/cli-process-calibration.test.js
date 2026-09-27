// nt1172jq — isolated, deterministic tests of the ACTUAL `lib/cli-process.js`
// ENOENT calibration path (task 1172, candidate `wc1172jn`).
//
// ============================================================================
// EVIDENCE CLASS: FIXTURE PROOF. **NOT** NATIVE WINDOWS EVIDENCE.
// ============================================================================
// Every case below fakes `process.platform` — to `win32` for the correction path
// and to an explicit POSIX value for the pass-through path — and substitutes
// `node:child_process.spawnSync` and `cross-spawn` *inside the module graph of
// the module under test*, so what is measured is the candidate's own decision
// logic driven by controlled inputs. It is NOT a measurement of Windows.
//
// PLATFORM IS A FIXTURE, THE HOST IS ONLY RECORDED. No case asserts what machine
// it is running on. Both sides of the module's `process.platform !== "win32"`
// branch are driven by an explicit fake, so all 34 cases produce the same verdicts
// on macOS, Linux and Windows. The host's real platform is written to the evidence
// artifact as the MEASURED HOST of a mocked-platform run — never as a categorical
// claim that the suite only runs on, or only describes, one OS. Nothing is skipped,
// platform-gated or xfailed to achieve that.
//
// In particular this file DOES NOT and CANNOT establish:
//   - that `C:\aigentry-cli-process-calibration|target` produces UV_ENOENT on a
//     real Windows kernel (native CI 36311416695 measured that on both pinned
//     runtimes; it is quoted, not reproduced);
//   - the win32 numeric `UV_ENOENT` (-4058). The probe stubs here use THIS
//     runtime's own value, read from the real `util.getSystemErrorMap()`
//     (-2 on POSIX, -4058 on win32), because that is what the module under test
//     computed at load. What is proven is that the module accepts *its own
//     runtime's* number and rejects any other — the mechanism, not any one
//     platform's constant. On a win32 host that number happens to be the native
//     one, but this file still does not MEASURE Windows;
//   - cmd.exe routing, PATHEXT resolution, or win32 kill propagation.
// Native acceptance remains `__tests__/cli-process.test.js` run ON Windows.
//
// WHAT IS REAL HERE
//   - `../lib/cli-process.js` is imported UNMODIFIED and byte-pinned below. Its
//     real `normalizeUnresolvedCommand`, `measureUnresolvedShape`,
//     `calibratedUnresolvedShape`, `calibrationUnavailableError`, `reasonToken`
//     and memo are the subject. NOTHING is reimplemented or copied here, and the
//     module exports nothing extra for this file's benefit: the whole calibration
//     path is reached only through the shipped `execFileSyncCliCommand`.
//   - `util.getSystemErrorMap()` is the real one everywhere except the single
//     case that must see an ENOENT-less table.
//
// CONTAINMENT — no real command, no real Windows target, no network
//   - `spawnSync` is replaced by a table of PURE stubs that return literal
//     objects. None of them calls through to the real `spawnSync`, and the real
//     one is shadowed out of the mocked namespace entirely, so even an
//     unexpected code path cannot reach it.
//   - Every operand the module under test passes to that stub is recorded and
//     asserted, across the whole file, to be EXACTLY the one fixed calibration
//     literal — never a caller's command, argument, cwd, env or PATH.
//   - `cross-spawn` is replaced too, so no process is ever launched: not the
//     provider CLI, not `cmd.exe`, not an owned fixture.
//   - `process.platform` is faked only inside a `try/finally` around a single
//     synchronous call, and restored unconditionally.
//   - `globalThis.fetch` is guarded and asserted to have zero attempts.
//
// NEGATIVE CONTROL (the suite is not vacuous)
//   Run against the PREVIOUS product bytes
//   (`f29f71b3598ed3fd4cddd33237680d05e1c1bda2eb57176dc0e66ce0b8fb2e78`, which
//   assigned the `null` literal to `stdout`/`stderr` and had no refusal path at
//   all), the cases tagged `@negative-vs-baseline` below FAIL: the Node-22 shape
//   case measures `null` where the runtime reported `undefined`, and every
//   refusal case measures a silent half-correction where a refusal is owed. See
//   `output/REPORT.md` for the recorded baseline run.
//
// BOUNDS: no case starts a process, opens a socket or touches the filesystem
// except to read the pinned module source. Nothing is skipped, platform-gated,
// relaxed or retried.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSystemErrorMap } from "node:util";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUTPUT = path.resolve(REPO, "..");
const MODULE_REL = "lib/cli-process.js";
const MODULE_SPEC = "../lib/cli-process.js";
const MODULE_ABS = path.join(REPO, MODULE_REL);

/** The human-approved fixed calibration operand, verbatim. */
const APPROVED_CALIBRATION_TARGET = "C:\\aigentry-cli-process-calibration|target";

/** The bounded option set the native probe validated, verbatim. */
const APPROVED_CALIBRATION_OPTIONS = {
  env: {},
  stdio: "ignore",
  shell: false,
  windowsHide: true,
  timeout: 1000,
};

const REFUSAL_CODE = "ERR_CLI_PROCESS_ENOENT_CALIBRATION_UNAVAILABLE";

/**
 * THIS runtime's numeric libuv ENOENT, read from the same supported primitive the
 * module under test reads at load. -2 on darwin/linux, -4058 on win32. The stubs
 * below must present this number, because the module validates the probe against
 * its own runtime's value — which is precisely the property under test.
 */
const RUNTIME_UV_ENOENT = (() => {
  for (const [errno, [name]] of getSystemErrorMap()) if (name === "ENOENT") return errno;
  return undefined;
})();

const REAL_PLATFORM = process.platform;
const MODULE_SOURCE = fs.readFileSync(MODULE_ABS, "utf8");
/**
 * The module's EXECUTABLE lines: every line that is not a `//`, `/*` or ` *`
 * comment line. Used only for the "no version branch / no errno literal"
 * assertions, which are claims about code and not about prose — the module's own
 * comments name -4058 and `os.constants.errno.ENOENT` precisely in order to
 * record that neither is used.
 */
const MODULE_CODE_LINES = MODULE_SOURCE.split("\n")
  .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
  .join("\n");
const MODULE_SHA256 = crypto.createHash("sha256").update(fs.readFileSync(MODULE_ABS)).digest("hex");

// ---------------------------------------------------------------------------
// Caller-side sentinels. If any of these ever reaches the probe stub, the module
// replayed something the caller supplied. Values are local tokens, never secrets.
// ---------------------------------------------------------------------------
const CALLER_COMMAND = "nt1172jq-caller-command-must-not-be-replayed";
const CALLER_ARG = "--nt1172jq-caller-arg-must-not-be-replayed";
const CALLER_CWD = "/nt1172jq/caller/cwd/must/not/be/replayed";
const CALLER_ENV_KEY = "NT1172JQ_CALLER_ENV_MUST_NOT_BE_REPLAYED";
const CALLER_ENV_VALUE = "nt1172jq-caller-env-value";
const CALLER_SENTINELS = [CALLER_COMMAND, CALLER_ARG, CALLER_CWD, CALLER_ENV_KEY, CALLER_ENV_VALUE];

// ---------------------------------------------------------------------------
// Owned state
// ---------------------------------------------------------------------------
/** Every (command, args, options) the module under test handed to the stub, file-wide. */
const probeCalls = [];
/** Every reason token the module produced, file-wide, for the boundedness check. */
const observedReasons = [];

const netGuard = {
  attempts: [],
  original: undefined,
  install() {
    this.original = globalThis.fetch;
    globalThis.fetch = (...args) => {
      const target = typeof args[0] === "string" ? args[0] : String(args[0]?.url ?? args[0]);
      this.attempts.push(target);
      throw new Error(`nt1172jq netGuard: outbound fetch blocked -> ${target}`);
    };
  },
  restore() {
    if (this.original !== undefined) globalThis.fetch = this.original;
  },
};

const evidence = {
  track: "nt1172jq",
  task: "1172",
  subject: "lib/cli-process.js ENOENT calibration path, reached through execFileSyncCliCommand",
  evidenceClass: "fixture-proof",
  nativeWindowsEvidence: false,
  // The platform under test is a FIXTURE; `hostPlatform` is only the host that
  // measurement happened to run on. A win32 `hostPlatform` here still means a
  // mocked-platform fixture run, NOT native Windows evidence.
  platformSource: "mocked",
  hostPlatformIsMeasuredNotAsserted: true,
  hostPlatform: REAL_PLATFORM,
  hostArch: process.arch,
  nodeVersion: process.version,
  runtimeUvEnoent: RUNTIME_UV_ENOENT,
  win32UvEnoentNotMeasuredHere: -4058,
  moduleRelative: MODULE_REL,
  moduleSha256: MODULE_SHA256,
  mocked: ["node:child_process spawnSync (module graph of the SUT)", "cross-spawn", "process.platform", "node:util getSystemErrorMap (one case only)"],
  cases: [],
  probeOperands: [],
  networkAttempts: null,
};

function record(name, data) {
  evidence.cases.push(Object.assign({ case: name }, data));
}

// ---------------------------------------------------------------------------
// The synthetic inputs. Pure data; none of them can start anything.
// ---------------------------------------------------------------------------

/**
 * What cross-spawn hands back on win32 for a command whose PATH/PATHEXT lookup
 * found nothing: cmd.exe really ran and exited 1, and `enoent.js
 * verifyENOENTSync` attached `notFoundError` with `errno` as a STRING. This is
 * the ONLY input shape that is supposed to trigger the calibration path.
 */
function crossSpawnSynthesizedEnoent() {
  const error = Object.assign(new Error(`spawn ${CALLER_COMMAND} ENOENT`), {
    code: "ENOENT",
    errno: "ENOENT", // STRING — cross-spawn's own, never Node's
    syscall: `spawn ${CALLER_COMMAND}`,
    path: CALLER_COMMAND,
    spawnargs: [CALLER_ARG],
  });
  return {
    pid: 31337, // a real, already-exited cmd.exe pid
    status: 1,
    signal: null,
    output: [null, Buffer.from(""), Buffer.from("'x' is not recognized as an internal or external command")],
    stdout: Buffer.from(""),
    stderr: Buffer.from("'x' is not recognized as an internal or external command"),
    error,
  };
}

/** The runtime's own unresolved-command shape, up to Node 20: streams are `null`. */
function nativeShapeNode20() {
  return {
    pid: 0,
    status: null,
    signal: null,
    output: null,
    stdout: null,
    stderr: null,
    error: Object.assign(new Error("spawnSync ENOENT"), {
      code: "ENOENT",
      errno: RUNTIME_UV_ENOENT,
      syscall: "spawnSync",
    }),
  };
}

/** The same shape from Node 22 on: `output` still `null`, streams `undefined`. */
function nativeShapeNode22() {
  const shape = nativeShapeNode20();
  shape.stdout = undefined;
  shape.stderr = undefined;
  return shape;
}

// ---------------------------------------------------------------------------
// Loading the module under test with controlled dependencies
// ---------------------------------------------------------------------------

/**
 * Import the REAL module with `spawnSync` and `cross-spawn` substituted.
 *
 * `vi.doMock` (not `vi.mock`) plus `vi.resetModules()`, so each call gets a fresh
 * evaluation of the actual module — which is what makes the per-process
 * `calibration` memo observable: within one load the memo persists, across loads
 * it is reset.
 *
 * @param probeStub  called in place of `spawnSync`. Pure; may throw.
 * @param syncResult what the substituted `crossSpawn.sync` returns.
 * @param errorMapEntries optional replacement for `util.getSystemErrorMap()`.
 */
async function loadSut({ probeStub, syncResult, errorMapEntries }) {
  vi.resetModules();

  const localProbeCalls = [];
  const spawnSyncStub = (command, args, options) => {
    const call = { command, args, options };
    localProbeCalls.push(call);
    probeCalls.push(call);
    evidence.probeOperands.push({ command, args, optionKeys: Object.keys(options || {}).sort() });
    if (!probeStub) {
      throw new Error("nt1172jq: the module probed on a path this case asserts never probes");
    }
    return probeStub(command, args, options);
  };

  // The real `spawnSync` is SHADOWED OUT, not wrapped: there is no passthrough,
  // so no code path in the SUT can reach a real process from this file.
  vi.doMock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, spawnSync: spawnSyncStub };
  });

  const asyncCalls = [];
  const syncCalls = [];
  const asyncReturn = { __nt1172jq: "inert async stand-in; nothing was launched" };
  const crossSpawn = (command, args, options) => {
    asyncCalls.push({ command, args, options });
    return asyncReturn;
  };
  crossSpawn.sync = (command, args, options) => {
    syncCalls.push({ command, args, options });
    if (typeof syncResult === "function") return syncResult(command, args, options);
    return syncResult;
  };
  vi.doMock("cross-spawn", () => ({ default: crossSpawn }));

  if (errorMapEntries !== undefined) {
    vi.doMock("node:util", async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, getSystemErrorMap: () => new Map(errorMapEntries) };
    });
  }

  const sut = await import(MODULE_SPEC);
  return { sut, localProbeCalls, asyncCalls, syncCalls, asyncReturn };
}

/**
 * Run one synchronous call with `process.platform` faked, and restore it
 * unconditionally. The fake is in force for exactly the duration of `fn`.
 */
function onPlatform(platform, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true, enumerable: true, writable: false });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    if (process.platform !== REAL_PLATFORM) {
      throw new Error(`nt1172jq: failed to restore process.platform (${process.platform})`);
    }
  }
}

/** Capture the observable outcome of one `execFileSyncCliCommand` call. */
function outcome(fn) {
  try {
    return { threw: false, returned: fn() };
  } catch (error) {
    return { threw: true, error };
  }
}

/** Drive one win32 miss through the real export, with `stdio` set so no stderr is written. */
function callerOptions(extra = {}) {
  return Object.assign(
    {
      cwd: CALLER_CWD,
      env: { [CALLER_ENV_KEY]: CALLER_ENV_VALUE, PATH: "/nt1172jq/caller/path" },
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 4000,
    },
    extra,
  );
}

function missOnWin32(sut, extra) {
  return onPlatform("win32", () =>
    outcome(() => sut.execFileSyncCliCommand(CALLER_COMMAND, [CALLER_ARG], callerOptions(extra))),
  );
}

/**
 * The POSIX platforms this file drives as EXPLICIT fixtures. These are the two
 * `process.platform` values the product ships on besides win32; the module's
 * POSIX branch is a single `!== "win32"` test, so driving both covers it on any
 * host — including a Windows runner, where the real platform can never supply one.
 */
const POSIX_FIXTURE_PLATFORMS = ["linux", "darwin"];

/** The exact counterpart of `missOnWin32`, with a controlled POSIX platform. */
function missOnPosix(sut, platform, extra) {
  expect(POSIX_FIXTURE_PLATFORMS).toContain(platform);
  return onPlatform(platform, () =>
    outcome(() => sut.execFileSyncCliCommand(CALLER_COMMAND, [CALLER_ARG], callerOptions(extra))),
  );
}

/** The refusal's bounded reason, pulled off the real error the module threw. */
function refusalReason(result) {
  expect(result.threw).toBe(true);
  expect(result.error.code).toBe(REFUSAL_CODE);
  const reason = result.error.calibrationReason;
  observedReasons.push(reason);
  return reason;
}

// ---------------------------------------------------------------------------
beforeAll(() => {
  netGuard.install();
  expect(RUNTIME_UV_ENOENT).toBeTypeOf("number");
});

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("cross-spawn");
  vi.doUnmock("node:util");
  vi.resetModules();
});

afterAll(() => {
  netGuard.restore();
  evidence.networkAttempts = netGuard.attempts;
  evidence.probeCallCount = probeCalls.length;
  evidence.observedReasons = observedReasons;
  const evidenceDir = path.join(OUTPUT, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  // A DISTINCT filename from `cli-process-evidence.json`, so the two suites in
  // one run cannot overwrite each other's artifact.
  fs.writeFileSync(
    path.join(evidenceDir, "cli-process-calibration-evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
});

// ---------------------------------------------------------------------------
// A. The subject is the pinned candidate, and the operand is the approved one
// ---------------------------------------------------------------------------
describe("calibration subject and operand are the reviewed ones", () => {
  it("the module under test is the reviewed candidate bytes", () => {
    expect(MODULE_SHA256).toBe("504997344fd6a8c8739ea57a1f268abe7e54793a8173c345db697d78a9a16a6e");
    record("module-pin", { moduleRelative: MODULE_REL, sha256: MODULE_SHA256 });
  });

  it("the calibration operand is the human-approved literal verbatim, and the options are the bounded set", () => {
    // The constants are module-private and stay that way: the module exports
    // nothing extra for this file. They are read from the pinned source bytes
    // here, and independently CONFIRMED against what the module actually passes
    // to the probe in "the probe operand is exactly the approved fixed literal".
    expect(MODULE_SOURCE).toContain(
      `const CALIBRATION_TARGET = ${JSON.stringify(APPROVED_CALIBRATION_TARGET)};`,
    );
    expect(MODULE_SOURCE).toContain("const CALIBRATION_OPTIONS = Object.freeze({");
    expect(MODULE_SOURCE).toContain(`const CALIBRATION_UNAVAILABLE_CODE = ${JSON.stringify(REFUSAL_CODE)};`);
    // No Node-version branch and no platform errno literal was substituted for
    // the measurement — the whole point of the candidate. Measured over the
    // EXECUTABLE lines only: the module's comments legitimately *name* -4058 and
    // `os.constants.errno.ENOENT` to explain why neither is used, and asserting
    // over the raw bytes would forbid documenting the decision.
    expect(MODULE_CODE_LINES).not.toMatch(/process\.version|NODE_MODULE_VERSION|nodeVersion/);
    expect(MODULE_CODE_LINES).not.toMatch(/4058/);
    expect(MODULE_CODE_LINES).not.toMatch(/\b-2\b/);
    expect(MODULE_CODE_LINES).not.toMatch(/os\.constants|require\("os"\)|from "node:os"/);
    // And the runtime number really is read from the supported primitive.
    expect(MODULE_CODE_LINES).toContain('import { getSystemErrorMap } from "node:util";');
    record("approved-operand-source", {
      operandIsApprovedLiteral: true,
      optionsFrozen: true,
      nodeVersionBranch: false,
      platformErrnoLiteral: false,
    });
  });
});

// ---------------------------------------------------------------------------
// B. Nothing probes except an actual win32 miss
// ---------------------------------------------------------------------------
describe("the probe is reachable from nothing but a win32 unresolved-command miss", () => {
  it("importing the module starts no process", async () => {
    // `probeStub` omitted: the stub throws if it is ever reached.
    const { localProbeCalls } = await loadSut({ probeStub: null, syncResult: { status: 0, pid: 1, stdout: null, stderr: null, output: null, signal: null, error: undefined } });
    expect(localProbeCalls).toEqual([]);
    record("no-probe-at-import", { probeCalls: 0 });
  });

  it("a successful sync command never probes", async () => {
    const success = { pid: 7, status: 0, signal: null, output: [null, "ok", ""], stdout: "ok", stderr: "", error: undefined };
    const { sut, localProbeCalls } = await loadSut({ probeStub: null, syncResult: success });
    const r = onPlatform("win32", () => outcome(() => sut.execFileSyncCliCommand(CALLER_COMMAND, [CALLER_ARG], callerOptions())));
    expect(r.threw).toBe(false);
    expect(r.returned).toBe("ok");
    expect(localProbeCalls).toEqual([]);
    record("no-probe-on-success", { probeCalls: 0, platformFaked: "win32" });
  });

  it("the async export never probes and hands back cross-spawn's own child verbatim", async () => {
    const { sut, localProbeCalls, asyncCalls, asyncReturn } = await loadSut({ probeStub: null, syncResult: undefined });
    const child = onPlatform("win32", () => sut.spawnCliCommand(CALLER_COMMAND, [CALLER_ARG], { cwd: CALLER_CWD }));
    expect(child).toBe(asyncReturn); // drop-in: the same object, not a wrapper
    expect(asyncCalls).toHaveLength(1);
    expect(asyncCalls[0].command).toBe(CALLER_COMMAND);
    expect(localProbeCalls).toEqual([]);
    record("no-probe-on-async", { probeCalls: 0, dropInIdentity: true });
  });

  it("on POSIX the module returns before probing and leaves cross-spawn's string errno in place", async () => {
    // The POSIX side of the module's `process.platform !== "win32"` branch is
    // driven by an EXPLICIT POSIX fixture, exactly as the win32 side is driven by
    // `missOnWin32`. It is NOT inferred from the host: asserting
    // `REAL_PLATFORM !== "win32"` would test the machine rather than the module,
    // and makes the case unrunnable on a Windows runner while proving nothing
    // extra on a POSIX one. Every declared POSIX value is exercised, so the oracle
    // is strictly stronger than the single ambient platform it replaces.
    const measured = [];
    for (const platform of POSIX_FIXTURE_PLATFORMS) {
      const { sut, localProbeCalls } = await loadSut({ probeStub: null, syncResult: () => crossSpawnSynthesizedEnoent() });
      const r = missOnPosix(sut, platform);
      expect(r.threw).toBe(true);
      expect(r.error.code).toBe("ENOENT");
      // Untouched: still cross-spawn's STRING errno and cmd.exe's status/streams.
      expect(r.error.errno).toBe("ENOENT");
      expect(r.error.status).toBe(1);
      expect(Buffer.isBuffer(r.error.stderr)).toBe(true);
      expect(Array.isArray(r.error.output)).toBe(true);
      // `probeStub: null` throws if reached, and this asserts it never was: the
      // whole calibration path is unreachable on a POSIX platform.
      expect(localProbeCalls).toEqual([]);
      measured.push(platform);
    }
    expect(measured).toEqual(POSIX_FIXTURE_PLATFORMS);
    record("no-probe-on-posix", {
      posixFixturePlatforms: measured,
      hostPlatform: REAL_PLATFORM, // the measured host, not an asserted one
      platformSource: "fixture",
      probeCalls: 0,
      errnoLeftAsString: true,
    });
  });
});

// ---------------------------------------------------------------------------
// C. Both native shapes are accepted, and each is applied as measured
// ---------------------------------------------------------------------------
describe("both native unresolved-command shapes are accepted and applied as measured", () => {
  it("the Node-<=20 shape (streams null) is restored exactly as measured", async () => {
    const { sut, localProbeCalls } = await loadSut({
      probeStub: () => nativeShapeNode20(),
      syncResult: () => crossSpawnSynthesizedEnoent(),
    });
    const r = missOnWin32(sut);
    expect(r.threw).toBe(true);
    const e = r.error;
    expect(e.code).toBe("ENOENT");
    expect(e.errno).toBe(RUNTIME_UV_ENOENT); // NUMERIC, this runtime's own
    expect(typeof e.errno).toBe("number");
    expect(e.status).toBe(null);
    expect(e.signal).toBe(null);
    expect(e.output).toBe(null);
    expect(e.stdout).toBe(null);
    expect(e.stderr).toBe(null);
    // The residual the module documents rather than hides: a cmd.exe really ran,
    // so the real pid is DELIBERATELY not replaced by the probe's measured 0.
    expect(e.pid).toBe(31337);
    // cross-spawn's own identifying fields survive verbatim.
    expect(e.syscall).toBe(`spawn ${CALLER_COMMAND}`);
    expect(e.error).toBe(e); // Node's checkExecSyncError self-reference
    expect(localProbeCalls).toHaveLength(1);
    record("shape-node20", { streams: "null", errno: "numeric", pidPreserved: true, probeCalls: 1 });
  });

  it("@negative-vs-baseline the Node->=22 shape (streams undefined) is restored as undefined, not null", async () => {
    const { sut, localProbeCalls } = await loadSut({
      probeStub: () => nativeShapeNode22(),
      syncResult: () => crossSpawnSynthesizedEnoent(),
    });
    const r = missOnWin32(sut);
    expect(r.threw).toBe(true);
    const e = r.error;
    expect(e.code).toBe("ENOENT");
    expect(e.errno).toBe(RUNTIME_UV_ENOENT);
    // The whole point of the candidate: the field is the RUNTIME's value, and
    // the distinction between `undefined` and `null` is load-bearing, so the
    // property must exist AND be undefined — not be missing, and not be null.
    expect(Object.prototype.hasOwnProperty.call(e, "stdout")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(e, "stderr")).toBe(true);
    expect(e.stdout).toBeUndefined();
    expect(e.stderr).toBeUndefined();
    expect(e.stdout).not.toBe(null);
    expect(e.stderr).not.toBe(null);
    // The four runtime-invariant fields are still restored.
    expect(e.status).toBe(null);
    expect(e.signal).toBe(null);
    expect(e.output).toBe(null);
    expect(e.pid).toBe(31337);
    expect(localProbeCalls).toHaveLength(1);
    record("shape-node22", { streams: "undefined", notNull: true, errno: "numeric", probeCalls: 1 });
  });

  it("the restored streams are the probe's OWN values, not a literal: a runtime reporting one null and one undefined is copied field-wise", async () => {
    // A deliberately asymmetric (hypothetical) runtime. It is accepted, because
    // the module validates each stream field independently against
    // null-or-undefined, and it must be copied field-wise rather than collapsed
    // to whichever one the module "expected".
    const asymmetric = () => {
      const shape = nativeShapeNode20();
      shape.stderr = undefined;
      return shape;
    };
    const { sut } = await loadSut({ probeStub: asymmetric, syncResult: () => crossSpawnSynthesizedEnoent() });
    const r = missOnWin32(sut);
    expect(r.threw).toBe(true);
    expect(r.error.stdout).toBe(null);
    expect(r.error.stderr).toBeUndefined();
    record("shape-asymmetric-copied-fieldwise", { stdout: "null", stderr: "undefined" });
  });
});

// ---------------------------------------------------------------------------
// D. Every rejection is its own bounded refusal — no silent half-correction
// ---------------------------------------------------------------------------
describe("an uncalibratable runtime REFUSES, with one bounded reason per cause", () => {
  /** Drive one miss whose probe returns/throws `stub`, and return the reason token. */
  async function reasonFor(stub) {
    const { sut, localProbeCalls } = await loadSut({
      probeStub: stub,
      syncResult: () => crossSpawnSynthesizedEnoent(),
    });
    const r = missOnWin32(sut);
    return { reason: refusalReason(r), error: r.error, probeCalls: localProbeCalls.length };
  }

  /** Mutate the otherwise-valid Node-20 shape in exactly one field. */
  const mutate = (patch) => () => Object.assign(nativeShapeNode20(), patch);

  it("@negative-vs-baseline the probe throwing is refused with the throw's bounded code", async () => {
    const { reason, error } = await reasonFor(() => {
      throw Object.assign(new Error("EACCES on the calibration operand"), { code: "EACCES" });
    });
    expect(reason).toBe("probe-threw(EACCES)");
    // The refusal is DISTINCT from the ENOENT it replaces, so a caller cannot
    // mistake an uncalibrated runtime for a missing CLI.
    expect(error.code).toBe(REFUSAL_CODE);
    expect(error.code).not.toBe("ENOENT");
    record("refuse-probe-threw-coded", { reason });
  });

  it("@negative-vs-baseline a throw with no usable code is refused as `other`, never as the raw message", async () => {
    const { reason, error } = await reasonFor(() => { throw new Error("a message that must not become the token"); });
    expect(reason).toBe("probe-threw(other)");
    expect(error.message).not.toContain("must not become the token");
    // Lowercase / non-token codes are also closed to `other`.
    const lower = await reasonFor(() => { throw Object.assign(new Error("x"), { code: "not-a-token" }); });
    expect(lower.reason).toBe("probe-threw(other)");
    record("refuse-probe-threw-untokenizable", { reasons: [reason, lower.reason] });
  });

  it("@negative-vs-baseline the 1s calibration deadline is refused, not treated as an unresolved command", async () => {
    // Node's `spawnSync` reports a timeout by RETURNING a result whose `error` is
    // ETIMEDOUT. That is not an ENOENT, so it lands on the not-enoent token —
    // a timed-out probe can never be mistaken for a measured shape.
    const timedOut = () => ({
      pid: 0, status: null, signal: "SIGTERM", output: null, stdout: null, stderr: null,
      error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT", errno: -110, syscall: "spawnSync" }),
    });
    const { reason } = await reasonFor(timedOut);
    expect(reason).toBe("probe-error-code-not-enoent");
    record("refuse-probe-timeout", { reason, note: "the 1s CALIBRATION_OPTIONS deadline surfaces here" });
  });

  it("@negative-vs-baseline a malformed probe result is refused", async () => {
    expect((await reasonFor(() => null)).reason).toBe("probe-result-not-object");
    expect((await reasonFor(() => undefined)).reason).toBe("probe-result-not-object");
    expect((await reasonFor(() => "not-an-object")).reason).toBe("probe-result-not-object");
    expect((await reasonFor(() => 0)).reason).toBe("probe-result-not-object");
    record("refuse-result-not-object", { variants: ["null", "undefined", "string", "number"] });
  });

  it("@negative-vs-baseline an absent or wrong probe error is refused", async () => {
    expect((await reasonFor(mutate({ error: undefined }))).reason).toBe("probe-error-absent");
    expect((await reasonFor(mutate({ error: null }))).reason).toBe("probe-error-absent");
    expect(
      (await reasonFor(mutate({ error: Object.assign(new Error("x"), { code: "EPERM", errno: RUNTIME_UV_ENOENT }) }))).reason,
    ).toBe("probe-error-code-not-enoent");
    record("refuse-error-absent-or-wrong", { tokens: ["probe-error-absent", "probe-error-code-not-enoent"] });
  });

  it("@negative-vs-baseline a non-numeric or foreign errno is refused — a string errno can never be accepted as a measurement", async () => {
    const withErrno = (errno) =>
      mutate({ error: Object.assign(new Error("spawnSync ENOENT"), { code: "ENOENT", errno }) });
    expect((await reasonFor(withErrno("ENOENT"))).reason).toBe("probe-errno-not-number");
    expect((await reasonFor(withErrno(undefined))).reason).toBe("probe-errno-not-number");
    expect((await reasonFor(withErrno(String(RUNTIME_UV_ENOENT)))).reason).toBe("probe-errno-not-number");
    // A number, but not THIS runtime's — e.g. the other platform's literal.
    expect((await reasonFor(withErrno(RUNTIME_UV_ENOENT - 1))).reason).toBe("probe-errno-not-runtime-enoent");
    expect((await reasonFor(withErrno(-4058 === RUNTIME_UV_ENOENT ? -2 : -4058))).reason).toBe("probe-errno-not-runtime-enoent");
    record("refuse-errno", { tokens: ["probe-errno-not-number", "probe-errno-not-runtime-enoent"] });
  });

  it("@negative-vs-baseline each runtime-invariant field is asserted, not assumed", async () => {
    expect((await reasonFor(mutate({ status: 1 }))).reason).toBe("probe-status-not-null");
    expect((await reasonFor(mutate({ status: 0 }))).reason).toBe("probe-status-not-null");
    expect((await reasonFor(mutate({ status: undefined }))).reason).toBe("probe-status-not-null");
    expect((await reasonFor(mutate({ signal: "SIGTERM" }))).reason).toBe("probe-signal-not-null");
    expect((await reasonFor(mutate({ signal: undefined }))).reason).toBe("probe-signal-not-null");
    expect((await reasonFor(mutate({ output: [] }))).reason).toBe("probe-output-not-null");
    expect((await reasonFor(mutate({ output: [null, null, null] }))).reason).toBe("probe-output-not-null");
    expect((await reasonFor(mutate({ output: undefined }))).reason).toBe("probe-output-not-null");
    record("refuse-invariant-fields", { tokens: ["probe-status-not-null", "probe-signal-not-null", "probe-output-not-null"] });
  });

  it("@negative-vs-baseline a probe that actually started a process (pid != 0) is refused — it is not the unresolved path", async () => {
    expect((await reasonFor(mutate({ pid: 1234 }))).reason).toBe("probe-pid-not-zero");
    expect((await reasonFor(mutate({ pid: null }))).reason).toBe("probe-pid-not-zero");
    expect((await reasonFor(mutate({ pid: undefined }))).reason).toBe("probe-pid-not-zero");
    record("refuse-pid-not-zero", { note: "pid 0 is what proves the probe created no process" });
  });

  it("@negative-vs-baseline a stream that is neither null nor undefined is refused, per field", async () => {
    expect((await reasonFor(mutate({ stdout: Buffer.from("") }))).reason).toBe("probe-stdout-not-null-or-undefined");
    expect((await reasonFor(mutate({ stdout: "" }))).reason).toBe("probe-stdout-not-null-or-undefined");
    expect((await reasonFor(mutate({ stdout: 0 }))).reason).toBe("probe-stdout-not-null-or-undefined");
    expect((await reasonFor(mutate({ stderr: Buffer.from("boom") }))).reason).toBe("probe-stderr-not-null-or-undefined");
    expect((await reasonFor(mutate({ stderr: "boom" }))).reason).toBe("probe-stderr-not-null-or-undefined");
    record("refuse-stream-shape", { tokens: ["probe-stdout-not-null-or-undefined", "probe-stderr-not-null-or-undefined"] });
  });

  it("@negative-vs-baseline without a runtime ENOENT number the module refuses WITHOUT probing at all", async () => {
    // `util.getSystemErrorMap()` is substituted with a table that has no ENOENT
    // entry — the only case in this file that touches `node:util`. There is then
    // nothing correct to validate against or to stamp, so no probe is attempted.
    const { sut, localProbeCalls } = await loadSut({
      probeStub: null, // would throw if reached
      syncResult: () => crossSpawnSynthesizedEnoent(),
      errorMapEntries: [[-13, ["EACCES", "permission denied"]]],
    });
    const r = missOnWin32(sut);
    expect(refusalReason(r)).toBe("enoent-errno-unresolved");
    expect(localProbeCalls).toEqual([]);
    record("refuse-enoent-errno-unresolved", { probeCalls: 0, note: "refused before any spawnSync" });
  });

  it("every refusal reason observed in this file is a bounded token — no message, path, stream or env value", () => {
    expect(observedReasons.length).toBeGreaterThanOrEqual(12);
    for (const reason of observedReasons) {
      expect(reason).toMatch(/^[a-z][a-z0-9-]*(\((?:[A-Z][A-Z0-9_]*|other)\))?$/);
      expect(reason.length).toBeLessThanOrEqual(40);
      for (const sentinel of CALLER_SENTINELS) expect(reason).not.toContain(sentinel);
    }
    record("bounded-reason-tokens", {
      distinct: [...new Set(observedReasons)].sort(),
      count: observedReasons.length,
    });
  });
});

// ---------------------------------------------------------------------------
// E. The refusal's own shape, and what it must never carry
// ---------------------------------------------------------------------------
describe("the refusal carries the resolution error as cause and nothing else", () => {
  it("@negative-vs-baseline `cause` is cross-spawn's own error and the message carries only the reason token", async () => {
    const synthesized = crossSpawnSynthesizedEnoent();
    const { sut } = await loadSut({ probeStub: () => null, syncResult: () => synthesized });
    const r = missOnWin32(sut);
    expect(r.threw).toBe(true);
    const e = r.error;
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe(REFUSAL_CODE);
    expect(e.calibrationReason).toBe("probe-result-not-object");
    // Nothing is lost.
    expect(e.cause).toBe(synthesized.error);
    expect(e.cause.code).toBe("ENOENT");
    // The message states the bounded reason and nothing else: no command,
    // argument, cwd, env name/value, path or stream byte.
    expect(e.message).toContain("(reason: probe-result-not-object)");
    for (const sentinel of CALLER_SENTINELS) expect(e.message).not.toContain(sentinel);
    expect(e.message).not.toContain("is not recognized");
    expect(e.message).not.toContain(APPROVED_CALIBRATION_TARGET);
    // A refusal is NOT a normalized result: the caller gets no half-corrected
    // fields at all, because the throw happens before any assignment.
    expect(e.status).toBeUndefined();
    expect(e.stdout).toBeUndefined();
    expect(e.stderr).toBeUndefined();
    record("refusal-shape", {
      code: REFUSAL_CODE,
      causeIsResolutionError: true,
      messageCarriesOnlyReason: true,
      noHalfCorrectedFields: true,
    });
  });
});

// ---------------------------------------------------------------------------
// F. Exactly one probe per process, in BOTH verdict directions
// ---------------------------------------------------------------------------
describe("the probe runs at most once per process, and both verdicts are cached", () => {
  it("a successful calibration is cached: three misses, one spawnSync", async () => {
    let probes = 0;
    const { sut, localProbeCalls } = await loadSut({
      probeStub: () => { probes += 1; return nativeShapeNode22(); },
      syncResult: () => crossSpawnSynthesizedEnoent(),
    });
    const results = [missOnWin32(sut), missOnWin32(sut), missOnWin32(sut)];
    expect(probes).toBe(1);
    expect(localProbeCalls).toHaveLength(1);
    for (const r of results) {
      expect(r.threw).toBe(true);
      expect(r.error.code).toBe("ENOENT");
      expect(r.error.errno).toBe(RUNTIME_UV_ENOENT);
      expect(r.error.stdout).toBeUndefined();
      expect(r.error.stderr).toBeUndefined();
      expect(r.error.status).toBe(null);
    }
    record("cache-success", { misses: 3, probes: 1 });
  });

  it("@negative-vs-baseline a FAILED calibration is cached too: three misses, one spawnSync, no retry", async () => {
    let probes = 0;
    const { sut, localProbeCalls } = await loadSut({
      probeStub: () => { probes += 1; return Object.assign(nativeShapeNode20(), { pid: 99 }); },
      syncResult: () => crossSpawnSynthesizedEnoent(),
    });
    const reasons = [missOnWin32(sut), missOnWin32(sut), missOnWin32(sut)].map(refusalReason);
    expect(probes).toBe(1);
    expect(localProbeCalls).toHaveLength(1);
    expect(reasons).toEqual(["probe-pid-not-zero", "probe-pid-not-zero", "probe-pid-not-zero"]);
    record("cache-failure", { misses: 3, probes: 1, retries: 0 });
  });

  it("the memo is per-process: a fresh module evaluation probes again, exactly once", async () => {
    const first = await loadSut({ probeStub: () => nativeShapeNode20(), syncResult: () => crossSpawnSynthesizedEnoent() });
    missOnWin32(first.sut);
    missOnWin32(first.sut);
    expect(first.localProbeCalls).toHaveLength(1);
    const second = await loadSut({ probeStub: () => nativeShapeNode20(), syncResult: () => crossSpawnSynthesizedEnoent() });
    missOnWin32(second.sut);
    expect(second.localProbeCalls).toHaveLength(1);
    record("memo-is-per-process", { firstLoadProbes: 1, secondLoadProbes: 1 });
  });
});

// ---------------------------------------------------------------------------
// G. One fixed operand; no user command is ever replayed
// ---------------------------------------------------------------------------
describe("the probe operand is a fixed constant, never anything the caller supplied", () => {
  it("the probe operand is exactly the approved fixed literal, with the approved bounded options", async () => {
    const { sut, localProbeCalls } = await loadSut({
      probeStub: () => nativeShapeNode22(),
      syncResult: () => crossSpawnSynthesizedEnoent(),
    });
    missOnWin32(sut);
    expect(localProbeCalls).toHaveLength(1);
    const [{ command, args, options }] = localProbeCalls;
    // Confirms, from behaviour rather than from source, that the private constant
    // really is the approved literal.
    expect(command).toBe(APPROVED_CALIBRATION_TARGET);
    expect(args).toEqual([]);
    expect(options).toEqual(APPROVED_CALIBRATION_OPTIONS);
    expect(Object.keys(options).sort()).toEqual(["env", "shell", "stdio", "timeout", "windowsHide"]);
    // No PATH is consulted, no stdio is inherited or captured, no shell, and the
    // deadline is the bounded one.
    expect(options.env).toEqual({});
    expect(options.shell).toBe(false);
    expect(options.stdio).toBe("ignore");
    expect(options.windowsHide).toBe(true);
    expect(options.timeout).toBe(1000);
    expect(Object.isFrozen(options)).toBe(true);
    record("fixed-probe-operand", {
      operandIsApprovedLiteral: true,
      argCount: 0,
      optionKeys: Object.keys(options).sort(),
      frozen: true,
    });
  });

  it("no caller command, argument, cwd or env value is ever replayed to the probe", async () => {
    // Two DIFFERENT callers, both missing, with distinctive inputs.
    const { sut, localProbeCalls } = await loadSut({
      probeStub: () => nativeShapeNode22(),
      syncResult: () => crossSpawnSynthesizedEnoent(),
    });
    missOnWin32(sut);
    onPlatform("win32", () =>
      outcome(() =>
        sut.execFileSyncCliCommand("a-second-different-caller-command", ["--second-arg"], callerOptions({ cwd: CALLER_CWD })),
      ),
    );
    // Cached, so still one probe — and that probe was the constant.
    expect(localProbeCalls).toHaveLength(1);
    const serialized = JSON.stringify(localProbeCalls);
    for (const sentinel of [...CALLER_SENTINELS, "a-second-different-caller-command", "--second-arg"]) {
      expect(serialized).not.toContain(sentinel);
    }
    record("no-user-command-replay", { probeCalls: 1, sentinelsChecked: CALLER_SENTINELS.length + 2 });
  });

  it("across this entire file, every operand the module ever probed with was the one constant", () => {
    expect(probeCalls.length).toBeGreaterThan(0);
    for (const call of probeCalls) {
      expect(call.command).toBe(APPROVED_CALIBRATION_TARGET);
      expect(call.args).toEqual([]);
    }
    // The operand cannot resolve on this host either: it is a win32-shaped path,
    // and nothing here ever handed it to a real `spawnSync`.
    expect(APPROVED_CALIBRATION_TARGET).toContain("|");
    // The substantive claim is about the OPERAND's shape, so it is made against
    // the explicitly-named path flavours. Bare `path.isAbsolute` is the host's
    // binding — posix off Windows, win32 on it — so it answers `false` here and
    // `true` on a Windows runner for the very same string, which makes the
    // operand's shape look host-dependent when it is a fixed literal. Both
    // flavours are asserted, which states the property exactly: this is a win32
    // absolute path and is NOT a POSIX one.
    expect(path.win32.isAbsolute(APPROVED_CALIBRATION_TARGET)).toBe(true);
    expect(path.posix.isAbsolute(APPROVED_CALIBRATION_TARGET)).toBe(false);
    // It cannot resolve on ANY host: `|` is illegal in a win32 filename, and the
    // literal is not a POSIX path at all. Never handed to a real `spawnSync`.
    expect(fs.existsSync(APPROVED_CALIBRATION_TARGET)).toBe(false);
    record("all-probe-operands-constant", {
      totalProbeCalls: probeCalls.length,
      distinctOperands: [...new Set(probeCalls.map((c) => c.command))].length,
      win32Absolute: true,
      posixAbsolute: false,
      operandExistsOnThisHost: false,
      reachedRealSpawnSync: false,
    });
  });
});

// ---------------------------------------------------------------------------
// H. Arbitrary real command failures are untouched
// ---------------------------------------------------------------------------
describe("failures that are NOT cross-spawn's resolution verdict are untouched and never probe", () => {
  it("a genuine Node spawn ENOENT (numeric errno) passes through unmodified", async () => {
    const genuine = () => ({
      pid: 0, status: null, signal: null, output: null, stdout: null, stderr: null,
      error: Object.assign(new Error("spawnSync ENOENT"), {
        code: "ENOENT", errno: RUNTIME_UV_ENOENT, syscall: "spawnSync",
      }),
    });
    const { sut, localProbeCalls } = await loadSut({ probeStub: null, syncResult: genuine });
    const r = missOnWin32(sut);
    expect(r.threw).toBe(true);
    expect(r.error.code).toBe("ENOENT");
    expect(r.error.errno).toBe(RUNTIME_UV_ENOENT);
    // No probe: the trigger is a STRING errno, which Node never produces.
    expect(localProbeCalls).toEqual([]);
    record("passthrough-genuine-enoent", { probeCalls: 0 });
  });

  it("an arbitrary non-zero exit from a command that DID resolve is untouched and never probes", async () => {
    const realFailure = {
      pid: 5150, status: 17, signal: null,
      output: [null, Buffer.from("partial stdout"), Buffer.from("real-command-stderr")],
      stdout: Buffer.from("partial stdout"), stderr: Buffer.from("real-command-stderr"),
      error: undefined,
    };
    const { sut, localProbeCalls } = await loadSut({ probeStub: null, syncResult: realFailure });
    const r = missOnWin32(sut);
    expect(r.threw).toBe(true);
    // Node's own `Command failed:` error, with the real fields intact — nothing
    // nulled, nothing reshaped.
    expect(r.error.message).toContain("Command failed:");
    expect(r.error.message).toContain("real-command-stderr");
    expect(r.error.status).toBe(17);
    expect(r.error.pid).toBe(5150);
    expect(r.error.stderr.toString()).toBe("real-command-stderr");
    expect(r.error.stdout.toString()).toBe("partial stdout");
    expect(Array.isArray(r.error.output)).toBe(true);
    expect(r.error.code).not.toBe("ENOENT");
    expect(r.error.code).not.toBe(REFUSAL_CODE);
    expect(localProbeCalls).toEqual([]);
    record("passthrough-real-nonzero-exit", { status: 17, probeCalls: 0, fieldsPreserved: true });
  });

  it("a non-ENOENT error with a string errno is still untouched — the code, not just the errno type, gates the path", async () => {
    const eacces = () => ({
      pid: 0, status: 1, signal: null, output: [null, null, null], stdout: null, stderr: null,
      error: Object.assign(new Error("spawnSync EACCES"), { code: "EACCES", errno: "EACCES" }),
    });
    const { sut, localProbeCalls } = await loadSut({ probeStub: null, syncResult: eacces });
    const r = missOnWin32(sut);
    expect(r.threw).toBe(true);
    expect(r.error.code).toBe("EACCES");
    expect(r.error.errno).toBe("EACCES"); // left exactly as it arrived
    expect(r.error.status).toBe(1);
    expect(localProbeCalls).toEqual([]);
    record("passthrough-non-enoent", { code: "EACCES", probeCalls: 0 });
  });

  it("a success is returned verbatim, with no probe and no reshaping", async () => {
    const success = { pid: 606, status: 0, signal: null, output: [null, "the-stdout", ""], stdout: "the-stdout", stderr: "", error: undefined };
    const { sut, localProbeCalls } = await loadSut({ probeStub: null, syncResult: success });
    const r = missOnWin32(sut);
    expect(r.threw).toBe(false);
    expect(r.returned).toBe("the-stdout");
    expect(localProbeCalls).toEqual([]);
    record("passthrough-success", { probeCalls: 0 });
  });
});

// ---------------------------------------------------------------------------
// I. Containment, and the honest classification of this evidence
// ---------------------------------------------------------------------------
describe("containment and evidence classification", () => {
  it("process.platform is restored strictly, on whatever host this ran on", () => {
    // The substantive oracle is RESTORATION — that no faked platform leaks out of
    // `onPlatform` into the rest of the process. `REAL_PLATFORM !== "win32"` was
    // never part of it: it asserted a property of the machine, which this file
    // does not control and does not need, and which fails on a Windows runner for
    // a suite whose platform is a fixture throughout.
    expect(process.platform).toBe(REAL_PLATFORM);
    // The descriptor itself is back, not just the value — a fake left behind as a
    // non-configurable own property would still read correctly here.
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    expect(descriptor.configurable).toBe(true);
    expect(descriptor.value).toBe(REAL_PLATFORM);
    // Restoration holds on the throwing path too: `onPlatform`'s `finally` runs
    // whether the driven call returns or throws, and the win32 refusal cases
    // depend on exactly that.
    const sentinel = new Error("nt1172jq: deliberate throw inside onPlatform");
    expect(() => onPlatform("win32", () => { throw sentinel; })).toThrow(sentinel);
    expect(process.platform).toBe(REAL_PLATFORM);
    // And every POSIX fixture value restores as well as the win32 one.
    for (const platform of POSIX_FIXTURE_PLATFORMS) {
      onPlatform(platform, () => expect(process.platform).toBe(platform));
      expect(process.platform).toBe(REAL_PLATFORM);
    }
    record("platform-restored", {
      hostPlatform: REAL_PLATFORM, // recorded as the measured host, not asserted
      restoredAfterReturn: true,
      restoredAfterThrow: true,
      descriptorRestored: true,
      platformsFaked: ["win32", ...POSIX_FIXTURE_PLATFORMS],
    });
  });

  it("no outbound request was attempted anywhere in this file", () => {
    expect(netGuard.attempts).toEqual([]);
    record("containment-no-network", { outboundAttempts: 0 });
  });

  it("this file declares itself a FIXTURE proof and names what it does not measure", () => {
    expect(evidence.evidenceClass).toBe("fixture-proof");
    expect(evidence.nativeWindowsEvidence).toBe(false);
    evidence.declaredUnmeasured = [
      "native win32 UV_ENOENT (-4058): the probe stubs present THIS runtime's number, read from the real util.getSystemErrorMap()",
      "that C:\\aigentry-cli-process-calibration|target really yields UV_ENOENT on a Windows kernel (native CI 36311416695 measured it; this file quotes, it does not reproduce)",
      "real spawnSync behaviour: spawnSync is substituted inside the module graph of the module under test",
      "cmd.exe routing, PATHEXT resolution, escape.argument quoting and win32 kill propagation",
      "Node's actual 20->22 stdout/stderr derivation: the two shapes are supplied as fixtures, not observed from a real failed spawn",
      "the host OS: process.platform is faked on BOTH branches, so running this file on a Windows runner still measures the fixture and never the kernel — native acceptance stays __tests__/cli-process.test.js run ON Windows",
    ];
    expect(evidence.declaredUnmeasured.length).toBeGreaterThanOrEqual(5);
    // The module under test is real; the drivers are not. Both stated.
    expect(evidence.moduleSha256).toBe(MODULE_SHA256);
    expect(evidence.mocked.length).toBeGreaterThanOrEqual(4);
    record("evidence-classification", {
      evidenceClass: evidence.evidenceClass,
      nativeWindowsEvidence: false,
      moduleUnderTestIsReal: true,
      declaredUnmeasured: evidence.declaredUnmeasured,
    });
  });
});
