// wv1172bu — independent acceptance measurement of lib/cli-process.js (task 1172).
//
// WHY THIS FILE EXISTS
// Candidate `wc1172bt` routes every provider-CLI launch through a new module,
// `lib/cli-process.js`, which wraps `cross-spawn` in two exports:
// `spawnCliCommand` (async, drop-in for `child_process.spawn`) and
// `execFileSyncCliCommand` (sync, drop-in for `child_process.execFileSync`).
// The author ran `node --check` and an *inline re-implementation* of the sync
// wrapper against `child_process.spawnSync`. Neither touches the shipped
// exports. This file imports and executes THE ACTUAL EXPORTS, and measures the
// sync failure contract against the REAL `child_process.execFileSync` rather
// than against a copy of the wrapper's own logic.
//
// WHAT IS REAL HERE
//   - `lib/cli-process.js` is imported unmodified and its two exports are the
//     subject under test. `cross-spawn@7.0.6` underneath is the real library.
//   - Every child is a fixed, inert, owned JavaScript body this file wrote,
//     reached only through `process.execPath` (directly, or via an owned
//     bare-name shim / owned `.cmd` shim). No provider CLI, no auth, no
//     browser, no MCP, no telepty, no host CLI discovery, no network, no
//     `shell: true`, and never a command string taken from the user.
//
// DECLARED LIMITS — read before quoting any green from this file
//   1. THIS HOST IS NOT WINDOWS. `cross-spawn`'s entire fix lives in
//      `lib/parse.js parseNonShell`, which returns unchanged on non-win32.
//      Therefore on darwin/linux these tests measure the PASS-THROUGH ONLY:
//      they prove the wrappers did not *regress* POSIX behaviour, and they
//      prove the Node-contract parity of the sync wrapper. They DO NOT and
//      CANNOT prove the `.cmd`/PATHEXT fix that motivated the change. Any
//      assertion whose outcome depends on the platform records which mechanism
//      resolved it (`resolutionMechanism`) instead of being skipped. There is
//      no `skipIf`, no platform-conditional weakening and no inflated timeout
//      anywhere in this file — the same bodies run on win32, where the same
//      assertions are the Windows acceptance gate.
//   2. ADOPTION IS PROVEN BOTH STATICALLY AND DYNAMICALLY (updated, wv1172bu-v2).
//      v1 could only prove adoption statically: the then-frozen tree was a
//      45-leaf subset and `lib/transport.js` / `lib/speaker-discovery.js` threw
//      ERR_MODULE_NOT_FOUND on `../index.js`, `../browser-control-port.js`,
//      `../i18n.js`, `../logger-emit.js`, `../model-router.js`. The controller
//      has since staged `input-delta/` (34 leaves, rev 796be828), which
//      completes the tree. Both modules now import, so the dynamic proof v1
//      declared as owed is DELIVERED below: the real product callers
//      (`invokeCliReviewer`, `checkCliLiveness`, `runCliAutoTurnCore`) execute
//      against a mocked `lib/cli-process.js` and an in-memory session, which
//      shows the new module is genuinely on the product path. The static,
//      sha256-pinned callsite assertions are KEPT alongside it — they pin the
//      shape of the change, the dynamic tests pin that it is reached.
//      No real provider, browser, MCP, network, auth or host CLI is involved.
//   3. The sync wrapper's stderr-passthrough branch (`!options.stdio`) is
//      UNREACHABLE from the product: both product callers always set `stdio`
//      (`invokeCliReviewer` sets `["pipe","pipe","pipe"]` or
//      `["ignore","pipe","pipe"]`; `checkCliLiveness` sets `"ignore"`). It is
//      exercised here as an export-contract test, and recorded as product-dead.
//   4. Bounds are fixed and never retried: <=5s per child, <=2s owned cleanup.
//      A child is "joined" only when an `'exit'`/`'close'` listener actually
//      fired, or when spawn produced no pid at all. If any owned child is
//      unjoined when the cleanup bound expires the owned root is PRESERVED and
//      cleanup fails loudly; the root is never removed from under a live child.
//   5. Nothing here speaks to the Linux archive stall.
//   6. v3 CORRECTIONS, from the first real native run (CI 36215641444,
//      WindowsNode20 job 108330955350, 5 red of 414). Three of the five reds
//      belonged to this file; all three are corrected here, and NOTHING is
//      skipped, gated by platform, or converted into an expected failure:
//        a. "missing command" measured a REAL product divergence, not a test
//           defect: the sync wrapper handed back cross-spawn's synthesized
//           ENOENT verbatim. Fixed in `lib/cli-process.js`; the assertion here
//           is unchanged and now additionally pins errno type, status and
//           streams in the bare-name-absent case.
//        b. "signal death" was a TEST defect: it hard-coded the POSIX
//           status/signal pair before comparing Node. Windows has no POSIX
//           signals, and Node reports the TerminateProcess exit status there.
//           Now: exact Node parity plus abnormal non-zero termination.
//        c. both bare-name cases were a FIXTURE defect: the `.cmd` embedded the
//           fixture's non-ASCII absolute path, which cmd.exe decodes through the
//           console OEM codepage. Now an ASCII body with a `%~dp0` locator. The
//           owned root is still unicode-and-spaces; it was not made ASCII.
//      STILL OPEN after this file goes green, and not addressed by it: Windows
//      child/grandchild teardown. cross-spawn inserts a `cmd.exe` between the
//      product and the provider, so a `kill()` reaches the wrapper and the
//      provider grandchild's fate is unmeasured (it is still listed in
//      `declaredUnmeasured`). Green argv fidelity does not answer it.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  spawnCliCommand,
  execFileSyncCliCommand,
} from "../lib/cli-process.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUTPUT = path.resolve(REPO, "..");

const IS_WINDOWS = process.platform === "win32";

// Bounds — fixed, never raised (limit 4).
const CHILD_MS = 5000;
const CLEANUP_MS = 2000;
const SLEEP_MS = 2000; // fixture sleep, always longer than the timeouts we set
const SYNC_TIMEOUT_MS = 300; // the timeout we ask the wrapper to enforce

// Trusted OS primitives only. Deliberately excludes every directory a real
// agent CLI could live in (nvm, homebrew, ~/.local, cmux shims). There is NO
// host PATH fallback: a child sees the owned bin dir and these, nothing else.
const TRUSTED_OS_PATH_DIRS = IS_WINDOWS
  ? [
      path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
      process.env.SystemRoot || "C:\\Windows",
    ]
  : ["/usr/bin", "/bin"];

// Name of the environment variable whose *value* must never reach a child's
// argv. The value is a fixed local token, not a real credential, but it is
// still never printed: assertions below compare booleans, never the value.
const SENTINEL_VAR = "WV1172BU_EXPANSION_SENTINEL";
const SENTINEL_VALUE = "wv1172bu-sentinel-must-not-expand";

const FIXTURE_MARKER = "WV1172BU_FIXTURE_OK";
const INJECTION_MARKER = "WV1172BU_INJECTED";

// ---------------------------------------------------------------------------
// The one inert fixture body. Behaviour is chosen by the owned env only, so a
// single audited body covers every case and no case can smuggle in a command.
// ---------------------------------------------------------------------------
const FIXTURE_BODY = `"use strict";
// wv1172bu inert fixture. Writes nothing outside FIXTURE_WITNESS_DIR, opens no
// socket, spawns no child, reads no host secret.
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const mode = process.env.FIXTURE_MODE || "echo";
const witnessDir = process.env.FIXTURE_WITNESS_DIR || "";

// One record per actual process start. Two records means a second process ran.
if (witnessDir) {
  const rec = {
    pid: process.pid,
    mode: mode,
    argv: argv,
    cwd: process.cwd(),
    execPath: process.execPath,
  };
  fs.writeFileSync(
    path.join(witnessDir, "witness-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".json"),
    JSON.stringify(rec)
  );
}

function envelope(extra) {
  return JSON.stringify(Object.assign({
    marker: ${JSON.stringify(FIXTURE_MARKER)},
    mode: mode,
    argv: argv,
    argc: argv.length,
    cwd: process.cwd(),
    // NOTE: the pid is deliberately NOT in this envelope. The Node-contract
    // parity suite compares the candidate's stdout byte-for-byte against real
    // execFileSync's stdout, and those are two different processes. The pid is
    // recorded in the witness file instead, where counting processes is the
    // point.
    // Names only, never values.
    envKeys: Object.keys(process.env).sort(),
    sentinelVarPresent: Object.prototype.hasOwnProperty.call(process.env, ${JSON.stringify(SENTINEL_VAR)}),
  }, extra || {}));
}

function finish(text) {
  process.stdout.write(text);
}

if (mode === "sleep") {
  setTimeout(function () { finish(envelope()); process.exit(0); }, Number(process.env.FIXTURE_SLEEP_MS || ${SLEEP_MS}));
} else if (mode === "selfsignal") {
  process.kill(process.pid, "SIGTERM");
} else if (mode === "stderr") {
  process.stderr.write(String(process.env.FIXTURE_STDERR || "fixture-stderr"));
  finish(envelope());
  process.exit(0);
} else if (mode === "fail") {
  process.stderr.write(String(process.env.FIXTURE_STDERR || "fixture-failed"));
  finish(envelope());
  process.exit(Number(process.env.FIXTURE_EXIT || 3));
} else if (mode === "failquiet") {
  finish(envelope());
  process.exit(Number(process.env.FIXTURE_EXIT || 4));
} else if (mode === "stdin") {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", function (d) { buf += d; });
  process.stdin.on("end", function () {
    finish(envelope({ stdinText: buf, stdinBytes: Buffer.byteLength(buf) }));
    process.exit(0);
  });
} else {
  finish(envelope());
  process.exit(0);
}
`;

// ---------------------------------------------------------------------------
// Owned state
// ---------------------------------------------------------------------------
// Hard network backstop. The product swallows bus-notification failures with
// `.catch(() => {})`, so a real outbound request would otherwise leave no trace.
// Every attempt is recorded AND thrown, and the suite asserts zero attempts.
const netGuard = {
  attempts: [],
  originalFetch: undefined,
  install() {
    this.originalFetch = globalThis.fetch;
    globalThis.fetch = (...args) => {
      const target = typeof args[0] === "string" ? args[0] : String(args[0]?.url ?? args[0]);
      this.attempts.push(target);
      throw new Error(`wv1172bu netGuard: outbound fetch blocked -> ${target}`);
    };
  },
  restore() {
    if (this.originalFetch !== undefined) globalThis.fetch = this.originalFetch;
  },
};

const owned = {
  root: null,
  bodyPath: null,
  binDir: null,
  emptyBinDir: null,
  witnessDir: null,
  fake: {},
  handles: [],
  preserved: false,
};

const evidence = {
  track: "wv1172bu",
  task: "1172",
  subject: "lib/cli-process.js exports spawnCliCommand / execFileSyncCliCommand",
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  isWindows: IS_WINDOWS,
  windowsFixApplied: IS_WINDOWS, // cross-spawn parseNonShell only acts on win32
  evidenceClass: IS_WINDOWS ? "native-windows" : "local-posix-passthrough",
  bounds: { childMs: CHILD_MS, cleanupMs: CLEANUP_MS },
  crossSpawnVersion: null,
  sourceHashes: {},
  cases: [],
  declaredUnmeasured: [],
  cleanup: null,
};

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function record(name, data) {
  evidence.cases.push(Object.assign({ case: name }, data));
}

/** Owned PATH: the given bin dir first, then trusted OS primitives. No host PATH. */
function pathValue(binDir) {
  return [binDir, ...TRUSTED_OS_PATH_DIRS].join(path.delimiter);
}

/**
 * Sealed child environment. HOME/XDG/TMP/LOCALAPPDATA all point under the owned
 * root, PATH is explicit and trusted, and no raw host environment is inherited.
 */
function sealedEnv(extra = {}) {
  const env = {
    PATH: pathValue(owned.binDir),
    HOME: owned.fake.home,
    USERPROFILE: owned.fake.home,
    TMPDIR: owned.fake.tmp,
    TMP: owned.fake.tmp,
    TEMP: owned.fake.tmp,
    LOCALAPPDATA: owned.fake.localAppData,
    APPDATA: owned.fake.appData,
    XDG_CONFIG_HOME: owned.fake.xdgConfig,
    XDG_CACHE_HOME: owned.fake.xdgCache,
    XDG_DATA_HOME: owned.fake.xdgData,
    XDG_STATE_HOME: owned.fake.xdgState,
    XDG_RUNTIME_DIR: owned.fake.xdgRuntime,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    FIXTURE_WITNESS_DIR: owned.witnessDir,
  };
  if (IS_WINDOWS) {
    // OS primitives cmd.exe itself needs. Not host configuration.
    env.SystemRoot = process.env.SystemRoot || "C:\\Windows";
    env.windir = process.env.windir || env.SystemRoot;
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * Write the owned bare-name shim: extensionless on POSIX, `.cmd` on win32.
 *
 * WIN32 CODEPAGE CONTRACT (v3, corrected from native CI 36215641444 /
 * WindowsNode20 job 108330955350). v2 wrote the fixture's ABSOLUTE path into the
 * batch body. `fs.writeFileSync` emits UTF-8, but `cmd.exe` decodes a `.cmd`
 * through the console OEM codepage (437 on the runner), so the owned root's
 * `ünïcödé 한글` bytes reached Node as mojibake and the child died with
 * MODULE_NOT_FOUND on a corrupted path — both bare-name cases went red for that
 * reason alone. The defect was the ENCODING OF A STRING LITERAL, not the Unicode
 * directory: Windows itself handles the directory fine.
 *
 * So the body is kept pure ASCII and the non-ASCII part of the path is never
 * written into it. `%~dp0` is expanded by cmd.exe at run time from `%0`, which
 * arrived as a UTF-16 command-line argument and never passed through a codepage,
 * exactly as npm's own `npm.cmd` locates `npm-cli.js` beside itself. The owned
 * root KEEPS its spaces and non-ASCII, so this suite still measures them — now
 * through the OS, instead of through a codepage-dependent literal.
 */
function writeShim(binDir, name) {
  if (IS_WINDOWS) {
    // The whole point of the candidate: a bare name that only resolves via
    // PATHEXT to a `.cmd`, which `child_process` cannot launch without a shell.
    const p = path.join(binDir, `${name}.cmd`);
    // Relative, so the unicode/space segments stay out of the file's bytes.
    const bodyRel = path.relative(binDir, owned.bodyPath);
    const body = `@echo off\r\n"${process.execPath}" "%~dp0${bodyRel}" %*\r\n`;
    // Codepage safety is the entire point of the change, so it is enforced and
    // not merely intended: if anything non-ASCII ever entered this body again
    // (a Node installed under a non-ASCII path, a renamed fixture) cmd.exe would
    // corrupt it exactly as it corrupted v2. Fail loudly instead of silently
    // re-running the same regression.
    if (/[^\x20-\x7E\r\n]/.test(body)) {
      throw new Error(
        "wv1172bu: the win32 .cmd shim body must be pure ASCII — refusing to " +
          "write a codepage-dependent literal (see the v3 contract above)"
      );
    }
    fs.writeFileSync(p, body);
    return p;
  }
  // POSIX counterpart: extensionless, owned JS, launched through process.execPath
  // via its own shebang. Same bare-name lookup, no shell involved.
  const p = path.join(binDir, name);
  fs.writeFileSync(
    p,
    `#!${process.execPath}\n"use strict";\nrequire(${JSON.stringify(owned.bodyPath)});\n`
  );
  fs.chmodSync(p, 0o755);
  return p;
}

function readWitnesses() {
  return fs
    .readdirSync(owned.witnessDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(owned.witnessDir, f), "utf8")));
}

function clearWitnesses() {
  for (const f of fs.readdirSync(owned.witnessDir)) {
    fs.rmSync(path.join(owned.witnessDir, f), { force: true });
  }
}

/** Register an async child so cleanup can join it. */
function track(child, label) {
  const h = {
    label,
    child,
    joined: false,
    pidPresent: typeof child.pid === "number",
    escalated: false,
  };
  if (!h.pidPresent) h.joined = true; // nothing to outlive anything
  const join = () => { h.joined = true; };
  child.on("exit", join);
  child.on("close", join);
  child.on("error", () => { if (!h.pidPresent) h.joined = true; });
  owned.handles.push(h);
  return h;
}

/** Normalize a stdout/stderr value so a Buffer and a string are distinguishable. */
function norm(v) {
  if (v === null || v === undefined) return v === undefined ? "<undefined>" : null;
  if (Buffer.isBuffer(v)) return { type: "Buffer", utf8: v.toString("utf8") };
  if (typeof v === "string") return { type: "string", utf8: v };
  return { type: typeof v, utf8: String(v) };
}

/**
 * Capture the full observable outcome of a sync call — returned value on
 * success, or every field of the thrown error on failure — so the candidate
 * export and the real `child_process.execFileSync` can be compared field by
 * field rather than by prose.
 */
function syncShape(fn) {
  try {
    return { threw: false, returned: norm(fn()) };
  } catch (e) {
    return {
      threw: true,
      isError: e instanceof Error,
      name: e.name,
      message: e.message,
      code: e.code,
      errnoType: typeof e.errno,
      errno: e.errno,
      syscall: e.syscall,
      status: e.status,
      signal: e.signal,
      pidPresent: typeof e.pid === "number",
      stdout: norm(e.stdout),
      stderr: norm(e.stderr),
      outputLength: Array.isArray(e.output) ? e.output.length : null,
      // Node's checkExecSyncError assigns the result onto the spawn error,
      // which makes `err.error` point back at `err`. Parity must include it.
      selfReferential: e.error === e,
    };
  }
}

/** Run the same (command, args, options) through both implementations. */
function parity(name, command, args, options) {
  const candidate = syncShape(() => execFileSyncCliCommand(command, args, options));
  const node = syncShape(() => execFileSync(command, args, options));
  record(`parity:${name}`, {
    command,
    args,
    optionKeys: Object.keys(options).sort(),
    candidate: candidate,
    node: node,
    identical: JSON.stringify(candidate) === JSON.stringify(node),
  });
  return { candidate, node };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeAll(() => {
  netGuard.install();

  // Owned root lives under output/, and its name carries spaces and non-ASCII
  // on purpose: every path-bearing test below runs out of this directory, so
  // "spaces/unicode in paths" is a property of the whole suite, not one case.
  const runtimeBase = path.join(OUTPUT, "runtime");
  fs.mkdirSync(runtimeBase, { recursive: true });
  owned.root = fs.mkdtempSync(path.join(runtimeBase, "wv1172bu cli proc ünïcödé 한글 "));

  const mk = (rel) => {
    const p = path.join(owned.root, rel);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  owned.binDir = mk("owned bin ünïcödé");
  owned.emptyBinDir = mk("empty bin");
  owned.witnessDir = mk("witness");
  owned.fake.home = mk("fake/home");
  owned.fake.tmp = mk("fake/tmp");
  owned.fake.localAppData = mk("fake/localappdata");
  owned.fake.appData = mk("fake/appdata");
  owned.fake.xdgConfig = mk("fake/xdg/config");
  owned.fake.xdgCache = mk("fake/xdg/cache");
  owned.fake.xdgData = mk("fake/xdg/data");
  owned.fake.xdgState = mk("fake/xdg/state");
  owned.fake.xdgRuntime = mk("fake/xdg/runtime");
  owned.cwdDir = mk("owned cwd");

  // `.cjs` so the body is CommonJS regardless of any package.json above it.
  owned.bodyPath = path.join(owned.root, "wv1172bu-fixture.cjs");
  fs.writeFileSync(owned.bodyPath, FIXTURE_BODY);

  owned.shimPath = writeShim(owned.binDir, "wv1172bu-cli");

  evidence.ownedRootRelative = path.relative(OUTPUT, owned.root);
  evidence.fixtureSha256 = sha256File(owned.bodyPath);
  evidence.shimRelative = path.relative(owned.root, owned.shimPath);
  evidence.trustedPathDirs = TRUSTED_OS_PATH_DIRS;
  // v3 shim-encoding facts, as booleans: the body itself is never persisted,
  // because it embeds process.execPath and this evidence file carries no host
  // paths. See writeShim's win32 codepage contract.
  // Recorded per platform: ASCII-only is a win32 contract, not a POSIX one.
  {
    const shimBytes = fs.readFileSync(owned.shimPath);
    const shimBody = shimBytes.toString("utf8");
    evidence.shimBodyEncodingContract = IS_WINDOWS
      ? "win32: cmd.exe OEM codepage — body must be ASCII-only"
      : "posix: shebang + Node UTF-8 — non-ASCII body is valid";
    // Raw measurement, not a contract claim: true on win32, false on POSIX.
    evidence.shimBodyAsciiOnly = !/[^\x20-\x7E\r\n]/.test(shimBody);
    // POSIX counterpart: non-ASCII body present and lossless as UTF-8.
    evidence.shimBodyNonAsciiIsLosslessUtf8 =
      !IS_WINDOWS &&
      /[^\x00-\x7F]/.test(shimBody) &&
      Buffer.compare(shimBytes, Buffer.from(shimBody, "utf8")) === 0 &&
      !shimBody.includes(String.fromCharCode(0xfffd));
    evidence.shimFixtureLocator = IS_WINDOWS
      ? "%~dp0 self-relative (expanded from %0, never codepage-decoded)"
      : "shebang + absolute UTF-8 require";
    evidence.shimLocatesFixtureCorrectly = IS_WINDOWS
      ? shimBody.includes("%~dp0") && !shimBody.includes(owned.root)
      : shimBody.includes(owned.bodyPath); // POSIX: UTF-8 shebang file, no codepage
  }

  for (const rel of ["lib/cli-process.js", "lib/transport.js", "lib/speaker-discovery.js", "package.json"]) {
    evidence.sourceHashes[rel] = sha256File(path.join(REPO, rel));
  }
  evidence.crossSpawnVersion = JSON.parse(
    fs.readFileSync(path.join(REPO, "node_modules/cross-spawn/package.json"), "utf8")
  ).version;

  evidence.declaredUnmeasured = [
    "win32 cmd.exe routing in cross-spawn parse.js parseNonShell (non-win32 returns unchanged)",
    "win32 OEM-codepage decoding of the .cmd shim body (the v3 ASCII/%~dp0 contract is enforced at write time by writeShim and asserted only on a win32 run)",
    "win32 PATHEXT resolution of a bare name to a .cmd shim",
    "win32 escape.argument quoting of metacharacters through cmd.exe /d /s /c",
    "win32 synthesized ENOENT from enoent.js verifyENOENT/verifyENOENTSync",
    "win32 kill propagation from the cmd.exe wrapper to the provider grandchild",
    "dynamic adoption of cli-process.js by transport.js / speaker-discovery.js (frozen tree is a 45-leaf subset; 4 root modules absent)",
  ];
});

afterAll(() => {
  netGuard.restore();
  evidence.networkAttempts = netGuard.attempts;

  const started = Date.now();
  const cleanup = {
    handles: owned.handles.length,
    escalated: 0,
    escalationErrors: [],
    unjoined: [],
    boundMs: CLEANUP_MS,
  };

  // At most one SIGKILL per owned handle, sent once before the join wait.
  for (const h of owned.handles) {
    if (h.joined) continue;
    try {
      h.child.kill("SIGKILL");
      h.escalated = true;
      cleanup.escalated += 1;
    } catch (err) {
      cleanup.escalationErrors.push(`${h.label}: ${err.code || err.message}`);
    }
  }

  const deadline = started + CLEANUP_MS;
  while (Date.now() < deadline && owned.handles.some((h) => !h.joined)) {
    // Synchronous wait; afterAll cannot await the event loop for us here.
    try {
      execFileSync(process.execPath, ["-e", "setTimeout(()=>{},25)"], { timeout: 1000, stdio: "ignore" });
    } catch { /* bounded nudge only */ }
  }

  cleanup.unjoined = owned.handles.filter((h) => !h.joined).map((h) => h.label);
  cleanup.allJoined = cleanup.unjoined.length === 0;
  cleanup.waitedMs = Date.now() - started;
  evidence.cleanup = cleanup;

  // Persist evidence BEFORE any removal, so a preserved-root failure still has it.
  const evidenceDir = path.join(OUTPUT, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "cli-process-evidence.json"),
    JSON.stringify(evidence, null, 2)
  );

  if (!cleanup.allJoined) {
    owned.preserved = true;
    throw new Error(
      `owned cleanup failed: ${cleanup.unjoined.length} child(ren) unjoined after ${cleanup.waitedMs}ms ` +
        `(${cleanup.unjoined.join(", ")}); owned root PRESERVED at ${evidence.ownedRootRelative}`
    );
  }
  fs.rmSync(owned.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A. Module contract — the real exports, not a copy
// ---------------------------------------------------------------------------
describe("cli-process module contract", () => {
  it("exports exactly the two documented functions", async () => {
    const mod = await import("../lib/cli-process.js");
    expect(Object.keys(mod).sort()).toEqual([
      "execFileSyncCliCommand",
      "spawnCliCommand",
    ]);
    expect(typeof spawnCliCommand).toBe("function");
    expect(typeof execFileSyncCliCommand).toBe("function");
  });

  it("is backed by the pinned cross-spawn and imports no shell", () => {
    expect(evidence.crossSpawnVersion).toBe("7.0.6");
    const src = fs.readFileSync(path.join(REPO, "lib/cli-process.js"), "utf8");
    expect(src).toContain('import crossSpawn from "cross-spawn"');
    expect(src).not.toMatch(/from\s+"child_process"/);
    expect(src).not.toMatch(/shell\s*:\s*true/);
    expect(src).not.toMatch(/\bexec\s*\(|execSync\s*\(/);
  });

  it("declares its own POSIX pass-through honestly: cross-spawn only rewrites on win32", () => {
    const parse = fs.readFileSync(
      path.join(REPO, "node_modules/cross-spawn/lib/parse.js"),
      "utf8"
    );
    // The early return that makes every assertion in this file a pass-through
    // measurement on this host. Asserted so the limit cannot silently lapse.
    expect(parse).toMatch(/function parseNonShell\(parsed\)\s*\{\s*if \(!isWin\)\s*\{\s*return parsed;/);
    expect(evidence.evidenceClass).toBe(
      IS_WINDOWS ? "native-windows" : "local-posix-passthrough"
    );
  });
});

// ---------------------------------------------------------------------------
// B. Sync wrapper vs the REAL child_process.execFileSync, field by field
// ---------------------------------------------------------------------------
describe("execFileSyncCliCommand matches the Node execFileSync contract", () => {
  const direct = (mode, extraEnv) => ({
    encoding: "utf-8",
    env: sealedEnv(Object.assign({ FIXTURE_MODE: mode }, extraEnv || {})),
    cwd: owned.cwdDir,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: CHILD_MS,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });

  it("success: returns the child's stdout identically", () => {
    const { candidate, node } = parity("success", process.execPath, [owned.bodyPath, "ok"], direct("echo"));
    expect(candidate.threw).toBe(false);
    expect(candidate).toEqual(node);
    expect(candidate.returned.utf8).toContain(FIXTURE_MARKER);
  });

  it("encoding absent: returns a Buffer, identically", () => {
    const opts = direct("echo");
    delete opts.encoding;
    const { candidate, node } = parity("buffer-return", process.execPath, [owned.bodyPath], opts);
    expect(candidate.threw).toBe(false);
    expect(candidate.returned.type).toBe("Buffer");
    expect(candidate).toEqual(node);
  });

  it("input + encoding: the child sees the piped stdin, identically", () => {
    const opts = Object.assign(direct("stdin"), { input: "wv1172bu-piped-prompt" });
    const { candidate, node } = parity("input-encoding", process.execPath, [owned.bodyPath], opts);
    expect(candidate.threw).toBe(false);
    expect(JSON.parse(candidate.returned.utf8).stdinText).toBe("wv1172bu-piped-prompt");
    expect(candidate).toEqual(node);
  });

  it("non-zero exit WITH stderr: same thrown message, status and streams", () => {
    const opts = direct("fail", { FIXTURE_EXIT: "3", FIXTURE_STDERR: "boom-detail" });
    const { candidate, node } = parity("nonzero-with-stderr", process.execPath, [owned.bodyPath], opts);
    expect(candidate.threw).toBe(true);
    expect(candidate.status).toBe(3);
    expect(candidate.signal).toBe(null);
    expect(candidate.message).toContain("Command failed:");
    expect(candidate.message).toContain("boom-detail");
    expect(candidate.stderr.utf8).toContain("boom-detail");
    expect(candidate).toEqual(node);
  });

  it("non-zero exit WITHOUT stderr: message carries no trailing detail, identically", () => {
    const opts = direct("failquiet", { FIXTURE_EXIT: "4" });
    const { candidate, node } = parity("nonzero-no-stderr", process.execPath, [owned.bodyPath], opts);
    expect(candidate.threw).toBe(true);
    expect(candidate.status).toBe(4);
    expect(candidate.message.startsWith("Command failed:")).toBe(true);
    expect(candidate.message.includes("\n")).toBe(false);
    expect(candidate).toEqual(node);
  });

  it("missing command: same spawn-error shape including err.error === err", () => {
    const opts = direct("echo");
    const { candidate, node } = parity(
      "missing-command",
      "wv1172bu-definitely-not-a-command",
      ["--version"],
      opts
    );
    expect(candidate.threw).toBe(true);
    expect(candidate.code).toBe("ENOENT");
    expect(candidate.selfReferential).toBe(true);
    expect(candidate).toEqual(node);
  });

  it("timeout: same ETIMEDOUT shape — and `killed` is NOT set on either", () => {
    const opts = Object.assign(direct("sleep"), { timeout: SYNC_TIMEOUT_MS });
    const { candidate, node } = parity("timeout", process.execPath, [owned.bodyPath], opts);
    expect(candidate.threw).toBe(true);
    expect(candidate.code).toBe("ETIMEDOUT");
    expect(candidate.selfReferential).toBe(true);
    expect(candidate).toEqual(node);

    // Independent confirmation of the author's reported pre-existing dead
    // branch: transport.js invokeCliReviewer maps timeouts via `error.killed`,
    // but neither implementation ever sets it, so that branch cannot fire.
    let candidateKilled = "unset";
    let nodeKilled = "unset";
    try { execFileSyncCliCommand(process.execPath, [owned.bodyPath], opts); }
    catch (e) { candidateKilled = Object.prototype.hasOwnProperty.call(e, "killed") ? String(e.killed) : "unset"; }
    try { execFileSync(process.execPath, [owned.bodyPath], opts); }
    catch (e) { nodeKilled = Object.prototype.hasOwnProperty.call(e, "killed") ? String(e.killed) : "unset"; }
    record("timeout-killed-property", { candidateKilled, nodeKilled });
    expect(candidateKilled).toBe("unset");
    expect(nodeKilled).toBe("unset");
  });

  it("signal death: abnormal non-zero termination, reported identically to Node", () => {
    const opts = direct("selfsignal");
    const { candidate, node } = parity("signal-death", process.execPath, [owned.bodyPath], opts);
    expect(candidate.threw).toBe(true);

    // v3 correction (native CI 36215641444): v2 asserted `status === null` and
    // `signal === "SIGTERM"` BEFORE comparing against Node, which hard-coded the
    // POSIX reporting pair. Windows has no POSIX signals at all — libuv turns
    // `process.kill(pid, "SIGTERM")` into a TerminateProcess, so Node itself
    // reports `signal: null` and a non-zero exit status, and the run went red on
    // the wrapper's behalf for something Node does identically. Asserting the
    // POSIX pair here claimed a Windows signal the OS never delivers.
    //
    // What is genuinely cross-platform, and what this case is actually for: the
    // child died abnormally, the wrapper threw for it, and the wrapper reports
    // EXACTLY what Node reports.
    //
    // WHICH shape is correct is a property of the OS, so it is selected by the
    // platform and then asserted IN FULL — not read back off the value under
    // test. Branching on `candidate.signal` would have made the expectation
    // circular: a wrapper that lost the signal on POSIX would simply have
    // selected the other branch. Neither branch is softened to "either is fine",
    // and neither is skipped.
    //
    //   POSIX  the fixture's `process.kill(process.pid, "SIGTERM")` is really
    //          delivered, is unhandled, and kills the child: `status` null,
    //          `signal` "SIGTERM".
    //   win32  there is no signal delivery at all. libuv's `uv__kill` turns
    //          SIGTERM into `TerminateProcess(handle, 1)`, and `term_signal` is
    //          reported only when the PARENT killed the child through
    //          `uv_process_kill` — which never happens here, because the child
    //          terminates itself. So Node reports `signal: null` and a non-zero
    //          exit status, and the wrapper must report exactly that, non-zero
    //          being the part that proves the death was abnormal.
    if (IS_WINDOWS) {
      expect(candidate.signal).toBe(null);
      expect(candidate.status).not.toBe(null);
      expect(candidate.status).not.toBe(0);
    } else {
      expect(candidate.signal).toBe("SIGTERM");
      expect(candidate.status).toBe(null);
    }
    // The real parity assertion, unchanged and unweakened.
    expect(candidate).toEqual(node);

    record("signal-death-reporting", {
      reportedVia: IS_WINDOWS ? "exit-status" : "signal",
      signal: candidate.signal,
      status: candidate.status,
      abnormal: true,
      note: IS_WINDOWS
        ? "win32: no signal delivery; TerminateProcess(handle, 1) surfaces as a non-zero status"
        : "POSIX: SIGTERM was delivered and is reported as the signal",
    });
  });

  it("stdio:'ignore' yields a null stdout return, identically", () => {
    const opts = Object.assign(direct("echo"), { stdio: "ignore" });
    delete opts.encoding;
    const { candidate, node } = parity("stdio-ignore", process.execPath, [owned.bodyPath], opts);
    expect(candidate.threw).toBe(false);
    expect(candidate.returned).toBe(null);
    expect(candidate).toEqual(node);
  });

  it("caller options are passed through untouched (cwd honoured by the child)", () => {
    const out = execFileSyncCliCommand(process.execPath, [owned.bodyPath], direct("echo"));
    const env = JSON.parse(out);
    expect(fs.realpathSync(env.cwd)).toBe(fs.realpathSync(owned.cwdDir));
    // Sealed env reached the child, and no raw host variable leaked in.
    expect(env.envKeys).toContain("XDG_STATE_HOME");
    expect(env.envKeys).not.toContain("AIGENTRY_TARGET_CWD");
    expect(env.envKeys).not.toContain("CLAUDECODE");
    record("caller-options-passthrough", { cwdHonoured: true, envKeyCount: env.envKeys.length });
  });

  it("writes the child's stderr through to the parent only when stdio is absent (product-dead branch)", () => {
    // Export-contract test. Limit 3: no product caller reaches this branch.
    const opts = direct("stderr", { FIXTURE_STDERR: "passthrough-probe" });
    delete opts.stdio;
    const { candidate, node } = parity("stderr-passthrough-no-stdio", process.execPath, [owned.bodyPath], opts);
    expect(candidate.threw).toBe(false);
    expect(candidate).toEqual(node);
    record("stderr-passthrough-reachability", {
      reachableFromProduct: false,
      why: "invokeCliReviewer always sets stdio; checkCliLiveness sets stdio:'ignore'",
    });
  });
});

// ---------------------------------------------------------------------------
// C. Async wrapper behaviour
// ---------------------------------------------------------------------------
describe("spawnCliCommand async behaviour", () => {
  const asyncOpts = (mode, extraEnv) => ({
    env: sealedEnv(Object.assign({ FIXTURE_MODE: mode }, extraEnv || {})),
    cwd: owned.cwdDir,
    windowsHide: true,
  });

  /** Drive a child to close within CHILD_MS, collecting streams. No retry. */
  function run(label, command, args, options, onChild) {
    return new Promise((resolve) => {
      const child = spawnCliCommand(command, args, options);
      const h = track(child, label);
      let stdout = "";
      let stderr = "";
      const events = [];
      let settled = false;
      const timer = setTimeout(() => {
        events.push("bound-exceeded");
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, CHILD_MS);

      const done = (out) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(out);
      };

      if (child.stdout) child.stdout.on("data", (d) => { stdout += d.toString(); });
      if (child.stderr) child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("error", (err) => {
        events.push("error");
        done({ phase: "error", err, code: err.code, stdout, stderr, events, handle: h, pidPresent: h.pidPresent });
      });
      child.on("close", (code, signal) => {
        events.push("close");
        done({ phase: "close", code, signal, stdout, stderr, events, handle: h, pidPresent: h.pidPresent });
      });
      if (onChild) onChild(child);
    });
  }

  it("returns a live ChildProcess with the caller's default piped handles", async () => {
    const r = await run("async-default-handles", process.execPath, [owned.bodyPath], asyncOpts("echo"));
    expect(r.phase).toBe("close");
    expect(r.code).toBe(0);
    expect(r.pidPresent).toBe(true);
    expect(r.stdout).toContain(FIXTURE_MARKER);
    record("async-success", { command: "process.execPath", exit: r.code, stdoutBytes: r.stdout.length, stderrBytes: r.stderr.length });
  });

  it("honours a caller stdio option instead of forcing pipes", async () => {
    const opts = Object.assign(asyncOpts("echo"), { stdio: "ignore" });
    const seen = {};
    const r = await run("async-stdio-ignore", process.execPath, [owned.bodyPath], opts, (c) => {
      seen.stdout = c.stdout;
      seen.stderr = c.stderr;
      seen.stdin = c.stdin;
    });
    expect(r.phase).toBe("close");
    expect(r.code).toBe(0);
    expect(seen.stdout).toBe(null);
    expect(seen.stderr).toBe(null);
    expect(seen.stdin).toBe(null);
  });

  it("preserves the stdin handle so the product's write/end pattern still works", async () => {
    const prompt = "wv1172bu-async-turn-prompt";
    const r = await run("async-stdin", process.execPath, [owned.bodyPath], asyncOpts("stdin"), (c) => {
      // Exactly the product's pattern at transport.js cli_auto / synthesis.
      c.stdin.write(prompt);
      c.stdin.end();
    });
    expect(r.phase).toBe("close");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).stdinText).toBe(prompt);
  });

  it("separates stdout and stderr", async () => {
    const r = await run("async-stderr", process.execPath, [owned.bodyPath], asyncOpts("stderr", { FIXTURE_STDERR: "async-err-detail" }));
    expect(r.phase).toBe("close");
    expect(r.stderr).toContain("async-err-detail");
    expect(r.stdout).toContain(FIXTURE_MARKER);
    expect(r.stdout).not.toContain("async-err-detail");
  });

  it("reports a non-zero exit on close", async () => {
    const r = await run("async-nonzero", process.execPath, [owned.bodyPath], asyncOpts("fail", { FIXTURE_EXIT: "7", FIXTURE_STDERR: "async-fail" }));
    expect(r.phase).toBe("close");
    expect(r.code).toBe(7);
    record("async-nonzero", { exit: r.code, stderrHead: r.stderr.slice(0, 120) });
  });

  it("delivers a missing command as an 'error' event carrying ENOENT, never a silent exit 0", async () => {
    const r = await run("async-missing", "wv1172bu-definitely-not-a-command", ["-p"], asyncOpts("echo"));
    expect(r.phase).toBe("error");
    expect(r.code).toBe("ENOENT");
    // The product rejects on 'error' and guards 'close' behind `settled`, so
    // this is the shape transport.js depends on. Which layer produced it is
    // platform-dependent and recorded, not asserted away.
    record("async-missing-command", {
      phase: r.phase,
      code: r.code,
      enoentOrigin: IS_WINDOWS
        ? "cross-spawn enoent.js hookChildProcess (synthesized, replaces 'exit')"
        : "node/libuv (cross-spawn does not hook on POSIX)",
    });
  });

  it("a signalled child is reported and joined without a retry", async () => {
    const r = await run("async-signal", process.execPath, [owned.bodyPath], asyncOpts("sleep", { FIXTURE_SLEEP_MS: String(SLEEP_MS) }), (c) => {
      setTimeout(() => { try { c.kill("SIGTERM"); } catch { /* raced to exit */ } }, 150);
    });
    expect(r.phase).toBe("close");
    expect(r.signal === "SIGTERM" || r.code !== 0).toBe(true);
    expect(r.handle.joined).toBe(true);
    record("async-signal", { signal: r.signal, code: r.code, joined: r.handle.joined });
  });

  it("every owned async child spawned so far has been joined", () => {
    const unjoined = owned.handles.filter((h) => !h.joined).map((h) => h.label);
    expect(unjoined).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D. Argument fidelity and inertness
// ---------------------------------------------------------------------------
describe("argument fidelity: metacharacters are data, not a second command", () => {
  const METACHAR_ARGS = [
    "plain",
    "with spaces",
    'double"quote',
    "single'quote",
    "amp&more",
    "pipe|more",
    "gt>more",
    "lt<more",
    "caret^more",
    "paren(group)",
    "bracket[]more",
    "bang!more",
    "semi;more",
    "back`tick`",
    "dollar$HOME",
    "star*glob",
    "question?mark",
    "comma,more",
    "trailing\\backslash\\",
    "ünïcödé-한글-emoji",
  ];

  const INJECTION_ARGS = [
    `&& echo ${INJECTION_MARKER}`,
    `| echo ${INJECTION_MARKER}`,
    `; echo ${INJECTION_MARKER}`,
    `$(echo ${INJECTION_MARKER})`,
    `\`echo ${INJECTION_MARKER}\``,
    `& echo ${INJECTION_MARKER}`,
  ];

  it("sync: every metacharacter argument arrives byte-identical in the child's argv", () => {
    clearWitnesses();
    const out = execFileSyncCliCommand(
      process.execPath,
      [owned.bodyPath, ...METACHAR_ARGS],
      {
        encoding: "utf-8",
        env: sealedEnv({ FIXTURE_MODE: "echo" }),
        cwd: owned.cwdDir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: CHILD_MS,
        windowsHide: true,
      }
    );
    const env = JSON.parse(out);
    expect(env.argv).toEqual(METACHAR_ARGS);
    expect(env.argc).toBe(METACHAR_ARGS.length);

    const witnesses = readWitnesses();
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0].argv).toEqual(METACHAR_ARGS);
    record("metachar-sync", {
      argCount: METACHAR_ARGS.length,
      witnessCount: witnesses.length,
      argvIdentical: true,
    });
  });

  it("async: every metacharacter argument arrives byte-identical in the child's argv", async () => {
    clearWitnesses();
    const stdout = await new Promise((resolve) => {
      const child = spawnCliCommand(process.execPath, [owned.bodyPath, ...METACHAR_ARGS], {
        env: sealedEnv({ FIXTURE_MODE: "echo" }),
        cwd: owned.cwdDir,
        windowsHide: true,
      });
      track(child, "metachar-async");
      let buf = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, CHILD_MS);
      child.stdout.on("data", (d) => { buf += d.toString(); });
      child.on("close", () => { clearTimeout(timer); resolve(buf); });
    });
    expect(JSON.parse(stdout).argv).toEqual(METACHAR_ARGS);
    expect(readWitnesses()).toHaveLength(1);
  });

  it("shell-injection payloads run exactly one process and create no side effect", () => {
    clearWitnesses();
    const before = fs.readdirSync(owned.root).sort();
    const out = execFileSyncCliCommand(
      process.execPath,
      [owned.bodyPath, ...INJECTION_ARGS],
      {
        encoding: "utf-8",
        env: sealedEnv({ FIXTURE_MODE: "echo" }),
        cwd: owned.cwdDir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: CHILD_MS,
        windowsHide: true,
      }
    );

    // 1. The payload is data: argv is exactly what we passed.
    expect(JSON.parse(out).argv).toEqual(INJECTION_ARGS);
    // 2. Exactly one process started — not a second command.
    const witnesses = readWitnesses();
    expect(witnesses).toHaveLength(1);
    expect(new Set(witnesses.map((w) => w.pid)).size).toBe(1);
    // 3. The marker appears ONLY as argv data. Each payload carries the marker
    //    once, so the count must be exactly the payload count: one more would
    //    mean something echoed it, i.e. a shell interpreted the payload.
    //    (Asserting the marker is simply absent would be wrong — the payloads
    //    contain it by construction and are echoed back as data.)
    const markerHits = out.split(INJECTION_MARKER).length - 1;
    expect(markerHits).toBe(INJECTION_ARGS.length);
    // 4. stdout is exactly one JSON envelope with nothing appended, so no
    //    second process wrote to the same stdout.
    expect(out.trim().startsWith("{")).toBe(true);
    expect(out.trim().endsWith("}")).toBe(true);
    expect(JSON.stringify(JSON.parse(out.trim())).length).toBeGreaterThan(0);
    expect(out.trim().split(FIXTURE_MARKER).length - 1).toBe(1);
    // 5. No file appeared anywhere in the owned root.
    expect(fs.readdirSync(owned.root).sort()).toEqual(before);
    record("injection-inertness", {
      payloadCount: INJECTION_ARGS.length,
      processesStarted: witnesses.length,
      markerHitsInStdout: markerHits,
      markerHitsExpected: INJECTION_ARGS.length,
      fixtureEnvelopes: 1,
      newOwnedFiles: 0,
    });
  });

  it("an environment reference in an argument is never expanded (value redacted)", () => {
    clearWitnesses();
    const refs = [
      `%${SENTINEL_VAR}%`, // win32 form
      `$${SENTINEL_VAR}`, // POSIX form
      `\${${SENTINEL_VAR}}`, // POSIX braced form
      `!${SENTINEL_VAR}!`, // cmd delayed-expansion form
    ];
    const out = execFileSyncCliCommand(process.execPath, [owned.bodyPath, ...refs], {
      encoding: "utf-8",
      env: sealedEnv({ FIXTURE_MODE: "echo", [SENTINEL_VAR]: SENTINEL_VALUE }),
      cwd: owned.cwdDir,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: CHILD_MS,
      windowsHide: true,
    });
    const env = JSON.parse(out);

    // The variable really was set in the child, so a non-expansion below is a
    // genuine negative and not a vacuous pass.
    expect(env.sentinelVarPresent).toBe(true);
    // Literal placeholders survive verbatim.
    expect(env.argv).toEqual(refs);
    // And the value never appears. Compared as a boolean so it is never printed.
    const leakedInArgv = env.argv.some((a) => a.includes(SENTINEL_VALUE));
    const leakedInStdout = out.includes(SENTINEL_VALUE);
    expect(leakedInArgv).toBe(false);
    expect(leakedInStdout).toBe(false);
    record("env-expansion-sentinel", {
      sentinelVar: SENTINEL_VAR,
      sentinelValueRecorded: false,
      varPresentInChild: true,
      formsTested: refs.length,
      leakedInArgv: false,
      leakedInStdout: false,
      note: IS_WINDOWS
        ? "measured through cmd.exe /d /s /c with escape.argument"
        : "POSIX: no shell is involved, so this is a pass-through negative only",
    });
  });
});

// ---------------------------------------------------------------------------
// E. PATH / PATHEXT resolution of a bare name
// ---------------------------------------------------------------------------
describe("bare-name resolution honours the caller's PATH", () => {
  // v3 regression control for native CI 36215641444 (both bare-name cases).
  // Named separately so a future edit cannot quietly put an absolute non-ASCII
  // path back into the batch body and reintroduce the OEM-decoding corruption.
  // The ASCII half is win32-only (cmd.exe decodes through a codepage); POSIX
  // embeds the absolute path and is read as UTF-8. Both must still resolve the
  // bare name through the adapter with exact argv.
  it("the owned shim honours its platform's encoding contract: win32 ASCII %~dp0 body, POSIX lossless-UTF-8 absolute body", () => {
    const bodyBytes = fs.readFileSync(owned.shimPath);
    const body = bodyBytes.toString("utf8");
    expect(evidence.shimLocatesFixtureCorrectly).toBe(true);
    // The owned root is NOT made ASCII to achieve this — it still carries spaces
    // and non-ASCII, and every case in this file runs out of it.
    expect(/[^\x00-\x7F]/.test(owned.root)).toBe(true);
    expect(owned.root).toContain("한글");

    if (IS_WINDOWS) {
      // cmd.exe expands %~dp0 from %0, which arrived as UTF-16 and never went
      // through a codepage. The corrupting literal is simply absent.
      expect(evidence.shimBodyAsciiOnly).toBe(true);
      expect(/[^\x20-\x7E\r\n]/.test(body)).toBe(false);
      expect(body).toContain("%~dp0");
      expect(body).not.toContain(owned.root);
      expect(body.endsWith("%*\r\n")).toBe(true);
    } else {
      // No codepage here: kernel shebang + Node UTF-8. The opposite contract —
      // the absolute non-ASCII path is present and survives byte-for-byte.
      expect(evidence.shimBodyNonAsciiIsLosslessUtf8).toBe(true);
      expect(/[^\x00-\x7F]/.test(body)).toBe(true);
      expect(Buffer.compare(bodyBytes, Buffer.from(body, "utf8"))).toBe(0);
      expect(body.includes(String.fromCharCode(0xfffd))).toBe(false);
      expect(body).toContain(owned.bodyPath);
      expect(body.startsWith(`#!${process.execPath}\n`)).toBe(true);
    }

    // The encoding claim is vacuous unless the shim actually launches: bare name
    // through the adapter, exact argv. Crosses PATHEXT/cmd.exe on win32.
    clearWitnesses();
    const out = execFileSyncCliCommand("wv1172bu-cli", ["--encoding-probe"], {
      encoding: "utf-8",
      env: sealedEnv({ FIXTURE_MODE: "echo" }),
      cwd: owned.cwdDir,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: CHILD_MS,
      windowsHide: true,
    });
    expect(out).toContain(FIXTURE_MARKER);
    expect(JSON.parse(out).argv).toEqual(["--encoding-probe"]);
    expect(readWitnesses()).toHaveLength(1);

    record("shim-encoding-contract", {
      shimRelative: evidence.shimRelative,
      platform: process.platform,
      // The win32 OEM-codepage half is NOT measured on a POSIX run.
      bodyEncodingContract: evidence.shimBodyEncodingContract,
      bodyAsciiOnly: evidence.shimBodyAsciiOnly,
      bodyNonAsciiIsLosslessUtf8: evidence.shimBodyNonAsciiIsLosslessUtf8,
      windowsCodepageSurfaceMeasuredHere: IS_WINDOWS,
      fixtureLocator: evidence.shimFixtureLocator,
      ownedRootStillNonAscii: true,
      adapterArgvExact: true,
      regressionOf: "native CI 36215641444 WindowsNode20 job 108330955350: MODULE_NOT_FOUND on an OEM-mangled absolute path",
    });
  });

  it("resolves a bare name from the owned bin dir on the caller's PATH (sync)", () => {
    clearWitnesses();
    const out = execFileSyncCliCommand("wv1172bu-cli", ["--version"], {
      encoding: "utf-8",
      env: sealedEnv({ FIXTURE_MODE: "echo" }),
      cwd: owned.cwdDir,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: CHILD_MS,
      windowsHide: true,
    });
    expect(out).toContain(FIXTURE_MARKER);
    expect(JSON.parse(out).argv).toEqual(["--version"]);
    const witnesses = readWitnesses();
    expect(witnesses).toHaveLength(1);

    record("bare-name-sync", {
      command: "wv1172bu-cli",
      shimOnDisk: path.basename(owned.shimPath),
      // On win32 the shim is `wv1172bu-cli.cmd` and the bare name carries no
      // extension, so a green here REQUIRES PATHEXT — that is the fix. On
      // POSIX the shim is extensionless and the name matches exactly, so
      // PATHEXT plays no part. Recorded, never skipped.
      resolutionMechanism: IS_WINDOWS
        ? "cross-spawn resolveCommand -> which + PATHEXT -> .cmd, then cmd.exe /d /s /c"
        : "execvp against the child env PATH, exact name, no shell",
      pathextRequired: IS_WINDOWS,
      pathEntryCount: pathValue(owned.binDir).split(path.delimiter).length,
    });
  });

  it("resolves the same bare name asynchronously", async () => {
    clearWitnesses();
    const r = await new Promise((resolve) => {
      const child = spawnCliCommand("wv1172bu-cli", ["-p"], {
        env: sealedEnv({ FIXTURE_MODE: "echo" }),
        cwd: owned.cwdDir,
        windowsHide: true,
      });
      track(child, "bare-name-async");
      let buf = "";
      let errCode = null;
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, CHILD_MS);
      if (child.stdout) child.stdout.on("data", (d) => { buf += d.toString(); });
      child.on("error", (e) => { errCode = e.code; clearTimeout(timer); resolve({ buf, errCode }); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ buf, errCode, code }); });
    });
    expect(r.errCode).toBe(null);
    expect(r.code).toBe(0);
    expect(r.buf).toContain(FIXTURE_MARKER);
  });

  it("a bare name absent from the caller's PATH fails with ENOENT and starts nothing", () => {
    clearWitnesses();
    const shape = syncShape(() =>
      execFileSyncCliCommand("wv1172bu-cli", ["--version"], {
        encoding: "utf-8",
        // Same command, PATH pointed at an empty owned dir. Proves resolution
        // really came from options.env.PATH above and not from the host.
        env: sealedEnv({ PATH: pathValue(owned.emptyBinDir), FIXTURE_MODE: "echo" }),
        cwd: owned.cwdDir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: CHILD_MS,
        windowsHide: true,
      })
    );
    expect(shape.threw).toBe(true);
    expect(shape.code).toBe("ENOENT");
    // v3: the errno type is now asserted, not merely recorded. v2 recorded the
    // string/number divergence as a source-derived note; native CI 36215641444
    // measured it, and lib/cli-process.js normalizes it, so the wrapper owes a
    // numeric libuv errno on BOTH platforms — that is the whole point of the fix.
    expect(shape.errnoType).toBe("number");
    expect(typeof shape.errno).toBe("number");
    // A wrapper that merely *rewrote* the errno while leaving cmd.exe's status
    // and streams in place would still be diverging, so pin those too.
    expect(shape.status).toBe(null);
    expect(shape.signal).toBe(null);
    expect(shape.stdout).toBe(null);
    expect(shape.stderr).toBe(null);
    expect(shape.outputLength).toBe(null);
    expect(readWitnesses()).toHaveLength(0);
    record("bare-name-absent-from-path", {
      code: shape.code,
      errnoType: shape.errnoType,
      processesStarted: 0,
      // v2's note, kept as the record of WHY the wrapper now normalizes: on win32
      // cross-spawn's enoent.js synthesizes this ENOENT with `errno: "ENOENT"` (a
      // STRING) and leaves cmd.exe's `status: 1` and streams attached, whereas
      // Node's own ENOENT carries a NUMERIC errno with null status/streams.
      win32ErrnoDivergence: "cross-spawn notFoundError sets errno to the string 'ENOENT'",
      normalizedByWrapper: "lib/cli-process.js normalizeUnresolvedCommand restores the native numeric errno and null status/streams",
      // No process is started by the fixture, but note honestly that on win32 a
      // cmd.exe DID run and exit 1 before cross-spawn classified the failure;
      // it writes no witness, so the zero-witness assertion above still holds.
      win32CmdExeRanBeforeClassification: IS_WINDOWS,
    });
  });
});

// ---------------------------------------------------------------------------
// F. Adoption by the product — static, byte-pinned, with the blocker measured
// ---------------------------------------------------------------------------
describe("product adoption of cli-process.js", () => {
  const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

  it("the analysed bytes are the frozen candidate bytes", () => {
    // Pins every assertion in this suite to the manifest'd candidate, so the
    // structural claims below cannot drift onto some other revision.
    //
    // PIN UPDATE (v3) — exactly one module changed: `lib/cli-process.js`.
    //   was: 35c913692ad9bbdc5c3e62e53fb6fb76ad01941346e57765a30e9d543e2d37e8
    //   now: f29f71b3598ed3fd4cddd33237680d05e1c1bda2eb57176dc0e66ce0b8fb2e78
    // Review basis for the update: native CI 36215641444 / WindowsNode20 job
    // 108330955350 measured the sync wrapper returning cross-spawn's synthesized
    // ENOENT verbatim (string `errno`, cmd.exe's `status: 1`, cmd.exe's streams,
    // 3-element `output`) where Node reports a numeric libuv errno with null
    // status and null streams. The module gained `normalizeUnresolvedCommand`,
    // which restores the native shape for that one case, keyed off cross-spawn's
    // own resolution verdict (`lib/enoent.js verifyENOENTSync` fires only when
    // `status === 1 && !parsed.file`, reviewed at cross-spawn 7.0.6) and never
    // off cmd.exe's localized text. `spawnCliCommand`, `checkExecSyncError`, the
    // pass-through of caller options and the cross-spawn 7.0.6 pin are all
    // unchanged; no dependency, API, permission or provider choice changed.
    // transport.js and speaker-discovery.js are byte-unchanged, so their pins
    // below are the frozen values.
    expect(evidence.sourceHashes["lib/cli-process.js"]).toBe(
      "f29f71b3598ed3fd4cddd33237680d05e1c1bda2eb57176dc0e66ce0b8fb2e78"
    );
    expect(evidence.sourceHashes["lib/transport.js"]).toBe(
      "3f1a1b002c6423f0826ff5d91a522311847931337ba2f55e50c45e8bc7d0d28c"
    );
    expect(evidence.sourceHashes["lib/speaker-discovery.js"]).toBe(
      "56c18364517fcd663f0b09217dba37828824acab04a2b6ceef18dcda6ac526a4"
    );
  });

  it("the input-delta tree is complete: both product modules now import, inertly", async () => {
    // v1 asserted the opposite and said a completed frozen set would fail this
    // test and re-owe the dynamic proof. input-delta did complete it, so this
    // now asserts importability, and the dynamic proof is delivered below.
    for (const rel of ["browser-control-port.js", "i18n.js", "logger-emit.js", "model-router.js", "index.js"]) {
      expect(fs.existsSync(path.join(REPO, rel))).toBe(true);
    }
    const transport = await import("../lib/transport.js");
    const discovery = await import("../lib/speaker-discovery.js");
    expect(typeof transport.invokeCliReviewer).toBe("function");
    expect(typeof transport.runCliAutoTurnCore).toBe("function");
    expect(typeof discovery.checkCliLiveness).toBe("function");
    record("adoption-dynamic-unblocked", {
      deltaRev: "796be828",
      transportExports: Object.keys(transport).length,
      discoveryExports: Object.keys(discovery).length,
      note: "import is side-effect free: no server, socket or child at module load",
    });
  });

  it("transport.js routes all 8 provider launches and its 1 sync review call through the new module", () => {
    const src = read("lib/transport.js");
    expect(src).toContain('import { spawnCliCommand, execFileSyncCliCommand } from "./cli-process.js";');
    // `spawn` is no longer imported from child_process, so a stray provider
    // `spawn(` cannot silently come back.
    expect(src).toContain('import { execFileSync } from "child_process";');
    expect(src).not.toMatch(/import \{[^}]*\bspawn\b[^}]*\} from "child_process"/);
    expect(src.match(/spawnCliCommand\(/g)).toHaveLength(8);
    expect(src.match(/execFileSyncCliCommand\(/g)).toHaveLength(1);
    expect(src.match(/[^A-Za-z_.]spawn\(/g)).toBe(null);
    // The four provider shapes, in both the cli_auto and the synthesis block.
    for (const target of ['spawnCliCommand("claude"', 'spawnCliCommand("codex"', 'spawnCliCommand("gemini"', "spawnCliCommand(hint.cmd"]) {
      expect(src.match(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(2);
    }
    expect(src).not.toMatch(/shell\s*:\s*true/);
    record("adoption-transport", { spawnCliCommand: 8, execFileSyncCliCommand: 1, bareSpawn: 0 });
  });

  it("speaker-discovery.js routes only the 2 liveness probes, leaving OS calls untouched", () => {
    const src = read("lib/speaker-discovery.js");
    expect(src).toContain('import { execFileSyncCliCommand } from "./cli-process.js";');
    expect(src.match(/execFileSyncCliCommand\(/g)).toHaveLength(2);
    expect(src).toMatch(/execFileSyncCliCommand\(command, \["--version"\]/);
    expect(src).toMatch(/execFileSyncCliCommand\(command, \["--help"\]/);
    // Scope discipline: the non-provider OS calls must NOT have been swept in.
    expect(src).toMatch(/execFileSync\("where"/);
    expect(src).toMatch(/execFileSync\("cp"/);
    expect(src).toMatch(/execFileSync\("osascript"/);
    expect(src).not.toMatch(/shell\s*:\s*true/);
    record("adoption-speaker-discovery", {
      execFileSyncCliCommand: 2,
      untouchedOsCalls: ["where", "cp", "osascript", "spawn(chrome)"],
    });
  });

  it("the declared cross-spawn dependency is pinned and present at that exact version", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies["cross-spawn"]).toBe("7.0.6");
    expect(evidence.crossSpawnVersion).toBe("7.0.6");
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.packages[""].dependencies["cross-spawn"]).toBe("7.0.6");
    record("dependency-pin", { declared: "7.0.6", resolvedOnDisk: evidence.crossSpawnVersion });
  });

  it("records what this host did NOT measure", () => {
    expect(evidence.declaredUnmeasured.length).toBeGreaterThanOrEqual(6);
    expect(evidence.windowsFixApplied).toBe(IS_WINDOWS);
    record("unmeasured-declaration", {
      evidenceClass: evidence.evidenceClass,
      items: evidence.declaredUnmeasured,
    });
  });
});

// ---------------------------------------------------------------------------
// G. Product CLI-caller regression (wv1172bu-v2).
//
// The REAL product callers run. Only `lib/cli-process.js` is substituted, via
// `vi.doMock` — chosen over `vi.mock` deliberately: `vi.mock` is hoisted and
// would replace the module for the whole file, destroying suites A–F which must
// execute the genuine exports. `doMock` affects only the dynamic imports that
// follow it, so the real-execution evidence above stays real.
//
// Nothing here starts a process: the substitute records its arguments and hands
// back an inert in-memory fake. The session store is injected in-memory too, so
// there is no filesystem, provider, browser, MCP, network or auth involvement.
// ---------------------------------------------------------------------------
describe("product CLI-caller regression against a substituted cli-process", () => {
  /** An inert stand-in for a ChildProcess. Starts nothing; emits on demand. */
  function fakeChild({ stdout = "", stderr = "", code = 0, signal = null } = {}) {
    const child = new EventEmitter();
    child.pid = 424242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = { written: [], write(c) { this.written.push(String(c)); }, end() { this.ended = true; }, ended: false };
    child.killed = [];
    child.kill = (sig) => { child.killed.push(sig); return true; };
    setImmediate(() => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", code, signal));
    });
    return child;
  }

  /**
   * Fresh module graph with cli-process.js substituted.
   *
   * `lib/telepty.js` is ALSO partially substituted, and that is a containment
   * requirement rather than a convenience: `submitDeliberationTurn` (which the
   * cli_auto turn calls on success) invokes `notifyTeleptyBus`, and that
   * function does a real `fetch` to `http://${TELEPTY_HOST||localhost}:3848/
   * api/bus/publish` after calling `loadTeleptyAuthToken()`. This session is
   * forbidden network, telepty and credential access, so only that one export
   * is replaced — `importOriginal` keeps envelope construction and Zod
   * validation REAL, so the product's own payload contract is still exercised.
   * The failure would have been swallowed by the product's `.catch(() => {})`,
   * i.e. it would have happened silently. `netGuard` below is the backstop.
   *
   * @returns the substitute spies plus the freshly imported product modules.
   */
  async function withSubstitutedCliProcess() {
    vi.resetModules();
    const spawnCli = vi.fn();
    const execFileSyncCli = vi.fn();
    const busNotify = vi.fn(async () => ({ ok: false, error: "suppressed by harness" }));
    vi.doMock("../lib/cli-process.js", () => ({
      spawnCliCommand: spawnCli,
      execFileSyncCliCommand: execFileSyncCli,
    }));
    vi.doMock("../lib/telepty.js", async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, notifyTeleptyBus: busNotify };
    });
    const transport = await import("../lib/transport.js");
    const discovery = await import("../lib/speaker-discovery.js");
    const session = await import("../lib/session.js");
    return { spawnCli, execFileSyncCli, busNotify, transport, discovery, session };
  }

  afterEach(() => {
    vi.doUnmock("../lib/cli-process.js");
    vi.doUnmock("../lib/telepty.js");
    vi.resetModules();
  });

  // ---- sync reviewer path: transport.js invokeCliReviewer ----

  it("invokeCliReviewer('claude') reaches execFileSyncCliCommand with the product's exact options", async () => {
    const { execFileSyncCli, transport } = await withSubstitutedCliProcess();
    execFileSyncCli.mockReturnValue("  reviewed-by-claude  ");

    const r = transport.invokeCliReviewer("claude", "REVIEW_PROMPT", 9000);

    expect(execFileSyncCli).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileSyncCli.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toEqual(["-p", "--output-format", "text", "--no-input"]);
    expect(opts.input).toBe("REVIEW_PROMPT");
    expect(opts.encoding).toBe("utf-8");
    expect(opts.timeout).toBe(9000);
    expect(opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(opts.maxBuffer).toBe(10 * 1024 * 1024);
    expect(opts.windowsHide).toBe(true);
    expect(typeof opts.env).toBe("object");
    // CLAUDECODE is stripped for claude to avoid a nested session.
    expect("CLAUDECODE" in opts.env).toBe(false);
    // The return value flows out of the new module, so the product is not
    // quietly still using child_process on this path.
    expect(r).toEqual({ ok: true, response: "reviewed-by-claude" });
    record("product-invokeCliReviewer-claude", { cmd, args, optionKeys: Object.keys(opts).sort(), ok: r.ok });
  });

  it("invokeCliReviewer('codex') pipes the prompt and still strips the codex banner", async () => {
    const { execFileSyncCli, transport } = await withSubstitutedCliProcess();
    execFileSyncCli.mockReturnValue("noise\ncodex\ntokens used\n1,234\nreal-review-body\n");

    const r = transport.invokeCliReviewer("codex", "CODEX_PROMPT", 4000);

    const [cmd, args, opts] = execFileSyncCli.mock.calls[0];
    expect(cmd).toBe("codex");
    expect(args).toEqual(["exec", "-"]);
    expect(opts.input).toBe("CODEX_PROMPT");
    expect(r.ok).toBe(true);
    expect(r.response).toBe("real-review-body");
    record("product-invokeCliReviewer-codex", { args, response: r.response });
  });

  it("invokeCliReviewer('gemini') passes the prompt as an argument with stdin ignored", async () => {
    const { execFileSyncCli, transport } = await withSubstitutedCliProcess();
    execFileSyncCli.mockReturnValue("gemini-review");

    const r = transport.invokeCliReviewer("gemini", "GEM_PROMPT", 3000);

    const [cmd, args, opts] = execFileSyncCli.mock.calls[0];
    expect(cmd).toBe("gemini");
    expect(args).toEqual(["-p", "GEM_PROMPT"]);
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(opts.input).toBeUndefined();
    expect(r).toEqual({ ok: true, response: "gemini-review" });
  });

  it("a thrown wrapper error is surfaced, and the `killed` timeout branch stays unreachable", async () => {
    const { execFileSyncCli, transport } = await withSubstitutedCliProcess();
    // Exactly the shape suite B measured the real wrapper to throw on timeout:
    // ETIMEDOUT with NO `killed` property.
    const err = Object.assign(new Error("spawnSync claude ETIMEDOUT"), {
      code: "ETIMEDOUT", status: null, signal: "SIGTERM",
    });
    execFileSyncCli.mockImplementation(() => { throw err; });

    const r = transport.invokeCliReviewer("claude", "P", 100);

    expect(r.ok).toBe(false);
    // NOT "timeout" — because `error.killed` is never set. Finding 3, now shown
    // end-to-end on the product path rather than inferred from the wrapper.
    expect(r.error).toBe("spawnSync claude ETIMEDOUT");
    record("product-timeout-mapping", { ok: r.ok, error: r.error, mappedToTimeout: r.error === "timeout" });
  });

  // ---- sync liveness path: speaker-discovery.js checkCliLiveness ----

  it("checkCliLiveness probes --version through execFileSyncCliCommand", async () => {
    const { execFileSyncCli, discovery } = await withSubstitutedCliProcess();
    execFileSyncCli.mockReturnValue("1.2.3");

    expect(discovery.checkCliLiveness("claude")).toBe(true);
    expect(execFileSyncCli).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileSyncCli.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toEqual(["--version"]);
    expect(opts.stdio).toBe("ignore");
    expect(opts.timeout).toBe(5000);
    expect(opts.windowsHide).toBe(true);
    expect("CLAUDECODE" in opts.env).toBe(false);
  });

  it("checkCliLiveness falls back to --help, then reports false — both via the new module", async () => {
    const { execFileSyncCli, discovery } = await withSubstitutedCliProcess();
    execFileSyncCli.mockImplementation((cmd, args) => {
      if (args[0] === "--version") throw new Error("no --version");
      return "help text";
    });
    expect(discovery.checkCliLiveness("codex")).toBe(true);
    expect(execFileSyncCli.mock.calls.map((c) => c[1][0])).toEqual(["--version", "--help"]);

    execFileSyncCli.mockReset();
    execFileSyncCli.mockImplementation(() => { throw new Error("absent"); });
    expect(discovery.checkCliLiveness("codex")).toBe(false);
    expect(execFileSyncCli).toHaveBeenCalledTimes(2);
    record("product-checkCliLiveness", { probeOrder: ["--version", "--help"], bothFailToFalse: true });
  });

  // ---- async turn path: transport.js runCliAutoTurnCore ----

  /** In-memory session store. No filesystem, no lock files, no markdown. */
  function injectInMemorySession(session, state) {
    session.initSessionDeps({
      readJsonFileSafe: () => JSON.parse(JSON.stringify(state)),
      getSessionFile: () => path.join(owned.root, "not-written.json"),
      getSessionProject: () => "wv1172bu-owned",
      normalizeProjectSlug: () => "wv1172bu-owned",
      listStateProjects: () => ["wv1172bu-owned"],
      getSessionsDir: () => owned.root,
      getProjectStateDir: () => owned.root,
      getLocksDir: () => owned.root,
      writeTextAtomic: () => {},
      writeJsonFileAtomic: () => {},
      withSessionLock: (ref, fn) => fn(),
      appendRuntimeLog: () => {},
    });
  }

  // `current_round`/`max_rounds` are required by the REAL telepty envelope Zod
  // schema that `submitDeliberationTurn` builds. They are in the fixture because
  // the product demands them, not to dodge a check.
  const cliSessionState = () => ({
    id: "wv1172bu-owned-session",
    project: "wv1172bu-owned",
    status: "active",
    topic: "owned inert fixture session",
    speakers: ["claude"],
    current_speaker: "claude",
    current_round: 1,
    max_rounds: 3,
    participant_profiles: [{ speaker: "claude", type: "cli" }],
    log: [],
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  });

  it("runCliAutoTurnCore launches the provider through spawnCliCommand and pipes the prompt", async () => {
    const { spawnCli, execFileSyncCli, transport, session } = await withSubstitutedCliProcess();
    execFileSyncCli.mockReturnValue("1.0.0"); // liveness gate passes
    let seen = null;
    spawnCli.mockImplementation((...call) => {
      seen = fakeChild({ stdout: "ASYNC_TURN_RESPONSE" });
      return seen;
    });
    injectInMemorySession(session, cliSessionState());

    const r = await transport.runCliAutoTurnCore("wv1172bu-owned-session", "claude", 5);

    expect(spawnCli).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnCli.mock.calls[0];
    expect(cmd).toBe("claude");
    // The product's own arg builder, unchanged by the candidate.
    expect(args).toEqual(["-p", "--output-format", "text"]);
    expect(opts.windowsHide).toBe(true);
    expect(typeof opts.env).toBe("object");
    expect("CLAUDECODE" in opts.env).toBe(false);
    // The product's write/end pattern still reaches the handle the wrapper returns.
    expect(seen.stdin.written.length).toBe(1);
    expect(seen.stdin.ended).toBe(true);
    expect(seen.stdin.written[0].length).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
    expect(r.response).toBe("ASYNC_TURN_RESPONSE");
    expect(seen.killed).toEqual([]); // no timeout fired, nothing signalled
    record("product-runCliAutoTurnCore", {
      cmd, args, optionKeys: Object.keys(opts).sort(),
      stdinWrites: seen.stdin.written.length, stdinEnded: seen.stdin.ended,
      ok: r.ok, promptBytes: seen.stdin.written[0].length,
    });
  });

  it("a non-zero close with no stdout is reported as a failed turn, not a silent success", async () => {
    const { spawnCli, execFileSyncCli, transport, session } = await withSubstitutedCliProcess();
    execFileSyncCli.mockReturnValue("1.0.0");
    spawnCli.mockImplementation(() => fakeChild({ stdout: "", stderr: "provider-blew-up", code: 9 }));
    injectInMemorySession(session, cliSessionState());

    const r = await transport.runCliAutoTurnCore("wv1172bu-owned-session", "claude", 5);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("CLI exit code 9");
    expect(r.error).toContain("provider-blew-up");
  });

  it("an 'error' event (the win32 ENOENT shape) rejects the turn — the contract transport relies on", async () => {
    const { spawnCli, execFileSyncCli, transport, session } = await withSubstitutedCliProcess();
    execFileSyncCli.mockReturnValue("1.0.0");
    spawnCli.mockImplementation(() => {
      const child = new EventEmitter();
      child.pid = undefined;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = { write() {}, end() {} };
      child.kill = () => true;
      // cross-spawn on win32 emits 'error' IN PLACE OF 'exit' for an
      // unresolvable command; 'close' may still follow and must not un-settle.
      setImmediate(() => {
        child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
        setImmediate(() => child.emit("close", 1, null));
      });
      return child;
    });
    injectInMemorySession(session, cliSessionState());

    const r = await transport.runCliAutoTurnCore("wv1172bu-owned-session", "claude", 5);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("ENOENT");
    record("product-async-enoent-contract", {
      ok: r.ok, error: r.error,
      note: "settled-guarded: the later 'close' did not convert the rejection into a success",
    });
  });

  it("the telepty bus notification is suppressed and NO outbound request was made", async () => {
    const { spawnCli, execFileSyncCli, busNotify, transport, session } = await withSubstitutedCliProcess();
    execFileSyncCli.mockReturnValue("1.0.0");
    spawnCli.mockImplementation(() => fakeChild({ stdout: "BUS_CHECK" }));
    injectInMemorySession(session, cliSessionState());

    const r = await transport.runCliAutoTurnCore("wv1172bu-owned-session", "claude", 5);
    expect(r.ok).toBe(true);
    // The product DOES try to notify the bus on a successful turn — proving the
    // substitution was necessary, not decorative.
    expect(busNotify).toHaveBeenCalled();
    // And the real one never ran: zero outbound attempts across the whole file.
    expect(netGuard.attempts).toEqual([]);
    record("containment-no-network", {
      busNotifyCalls: busNotify.mock.calls.length,
      outboundAttempts: netGuard.attempts.length,
      suppressedExport: "lib/telepty.js notifyTeleptyBus (real impl does fetch localhost:3848 + loadTeleptyAuthToken)",
    });
  });

  it("the liveness gate runs before any launch, so an absent CLI never spawns", async () => {
    const { spawnCli, execFileSyncCli, transport, session } = await withSubstitutedCliProcess();
    execFileSyncCli.mockImplementation(() => { throw new Error("absent"); });
    injectInMemorySession(session, cliSessionState());

    const r = await transport.runCliAutoTurnCore("wv1172bu-owned-session", "claude", 5);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("not available");
    expect(spawnCli).not.toHaveBeenCalled();
    record("product-liveness-gate", { spawnCalls: spawnCli.mock.calls.length, error: r.error });
  });
});
