// dt1172ay tester — focused regression suite for the two harness defects the
// controller ratified on __tests__/helpers/mcp-harness.mjs.
//
// SCOPE. These cases cover the HARNESS ONLY. They do not import, start or
// assert anything about the product MCP server, and they are not a substitute
// for delegated-selection.test.js (70 cases, byte-unchanged, NOT run in this
// seal — see REPORT.md).
//
// WHAT IS REAL. createHarness, joinOwnedChild, buildFixtureEnv, assertInertPath
// (through createHarness), createStubCliBin and getInstallDir are the shipped
// functions, executed unmodified. Nothing is reimplemented here.
//
// WHAT IS INJECTED, and only inside this file:
//   * process.env.TMPDIR is pointed at a test-owned root under output/ so the
//     harness roots this suite creates are countable exactly, instead of being
//     fished out of the shared system temp dir.
//   * one vi.doMock of the join helper, used to drive createHarness down its
//     join-REJECT branch. The reject branch of the real joinOwnedChild is
//     proven separately (see "the join helper rejects ..."), because no honest
//     real child can survive SIGKILL.
//
// INERTNESS. Every child is a test-owned Node fixture written into the output
// temp root by this file. No network, no listener, no provider CLI, no
// browser, no Chrome profile, no telepty. Every child is joined by its exact
// handle through joinOwnedChild. There is no process-table scan anywhere: no
// ps, no pgrep, no find, no broadcast kill.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { joinOwnedChild } from "./helpers/cli-discovery-fixture.js";
import { createStubCliBin, isTrustedPathEntry } from "./helpers/stub-cli-bin.mjs";
import { createHarness, getInstallDir } from "./helpers/mcp-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(HERE, "..");
const OUTPUT = path.resolve(WORK, "..");

// Long enough for the harness init wait (a hard-coded 15000ms inside
// createHarness) plus the bounded join that follows it. Not a raised product
// timeout: nothing in the harness or the ratified suite is relaxed here.
const INIT_TIMEOUT_CASE_MS = 45000;

let TMP_ROOT = null;
// All three, because os.tmpdir() reads TMPDIR on POSIX but TEMP/TMP on win32.
// Each is captured as-was (including "was not set") and restored exactly.
const PREV_TMP_VARS = new Map();
const TMP_ENV_VARS = ['TMPDIR', 'TEMP', 'TMP'];
let ECHO_FIXTURE;
let SILENT_FIXTURE;
let IDLE_FIXTURE;
let STUBBORN_FIXTURE;

// An inert stand-in for an MCP server: answers any JSON-RPC request that has an
// id, records the environment it was actually handed, and does nothing else.
const ECHO_SRC = [
  "// dt1172ay inert, test-owned fixture. Not the product server.",
  "import fs from \"node:fs\";",
  "import path from \"node:path\";",
  "fs.writeFileSync(",
  "  path.join(process.env.HOME, \"dt1172ay-child-env.json\"),",
  "  JSON.stringify(process.env, null, 2)",
  ");",
  "let buffer = \"\";",
  "process.stdin.setEncoding(\"utf-8\");",
  "process.stdin.on(\"data\", (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split(\"\\n\");",
  "  buffer = lines.pop() || \"\";",
  "  for (const line of lines) {",
  "    if (!line.trim()) continue;",
  "    let msg = null;",
  "    try { msg = JSON.parse(line); } catch { continue; }",
  "    if (!msg || msg.id === undefined) continue;",
  "    process.stdout.write(JSON.stringify({",
  "      jsonrpc: \"2.0\",",
  "      id: msg.id,",
  "      result: { protocolVersion: \"2024-11-05\", capabilities: {} }",
  "    }) + \"\\n\");",
  "  }",
  "});",
  "process.stdin.resume();",
  "setInterval(() => {}, 1000);",
  ""
].join("\n");

// Spawns, never answers. Drives the harness init path to its timeout.
const SILENT_SRC = [
  "// dt1172ay inert, test-owned fixture: never answers an MCP request.",
  "process.stdin.resume();",
  "setInterval(() => {}, 1000);",
  ""
].join("\n");

// Alive, no stdio expectations. For the direct join cases.
const IDLE_SRC = [
  "// dt1172ay inert, test-owned fixture: stays alive until signalled.",
  "setInterval(() => {}, 1000);",
  ""
].join("\n");

// Ignores SIGTERM, so the join has to escalate to SIGKILL to observe an exit.
const STUBBORN_SRC = [
  "// dt1172ay inert, test-owned fixture: ignores SIGTERM.",
  "process.on(\"SIGTERM\", () => {});",
  "setInterval(() => {}, 1000);",
  "process.stdout.write(\"ready\\n\");",
  ""
].join("\n");

// Harness roots only. createStubCliBin uses the same dm1172av- prefix for its
// stub bin dirs, so a naive startsWith would count a live stub dir as a leak.
function harnessRoots() {
  return fs.readdirSync(TMP_ROOT)
    .filter(d => d.startsWith("dm1172av-") && !d.startsWith("dm1172av-stubbin-"))
    .sort();
}

beforeAll(() => {
  fs.mkdirSync(path.join(OUTPUT, ".tmp"), { recursive: true });
  TMP_ROOT = fs.mkdtempSync(path.join(OUTPUT, ".tmp", "dt1172ay-"));
  // On win32 os.tmpdir() reads TEMP then TMP and NEVER TMPDIR, so setting
  // TMPDIR alone left the redirection inert there and this beforeAll threw,
  // aborting the suite with 10 tests skipped. The same pattern already exists
  // in helpers/cli-discovery-fixture.js:153-157; it just was not applied here.
  for (const name of TMP_ENV_VARS) {
    PREV_TMP_VARS.set(name, process.env[name]);
    process.env[name] = TMP_ROOT;
  }
  // os.tmpdir() reads those vars on every call, so the redirection has to hold
  // before any harness root is minted. Assert it rather than assume it. This
  // assertion is what turned a silent mis-redirect into a visible failure and
  // is deliberately KEPT.
  expect(os.tmpdir()).toBe(TMP_ROOT);

  ECHO_FIXTURE = path.join(TMP_ROOT, "fixture-echo.mjs");
  SILENT_FIXTURE = path.join(TMP_ROOT, "fixture-silent.mjs");
  IDLE_FIXTURE = path.join(TMP_ROOT, "fixture-idle.mjs");
  STUBBORN_FIXTURE = path.join(TMP_ROOT, "fixture-stubborn.mjs");
  fs.writeFileSync(ECHO_FIXTURE, ECHO_SRC);
  fs.writeFileSync(SILENT_FIXTURE, SILENT_SRC);
  fs.writeFileSync(IDLE_FIXTURE, IDLE_SRC);
  fs.writeFileSync(STUBBORN_FIXTURE, STUBBORN_SRC);
});

afterAll(() => {
  for (const name of TMP_ENV_VARS) {
    const previous = PREV_TMP_VARS.get(name);
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  if (TMP_ROOT) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("mcp-harness inert environment", () => {
  it("forces the browser scan mode off AFTER the caller env merge, and a caller cannot re-open it", async () => {
    const stub = createStubCliBin(1);
    const handle = await createHarness({
      serverEntry: ECHO_FIXTURE,
      repoRoot: TMP_ROOT,
      stubDir: stub.dir,
      env: {
        // The caller tries to re-open both forced boundaries, and adds one key
        // of its own that must survive.
        DELIBERATION_BROWSER_SCAN_MODE: "on",
        DELIBERATION_TELEPTY_DISABLED: "0",
        DT1172AY_CALLER_MARKER: "present",
      },
    });
    try {
      const childEnv = JSON.parse(
        fs.readFileSync(path.join(handle.homeDir, "dt1172ay-child-env.json"), "utf-8")
      );

      // The knob the product actually reads is present and forced off, and the
      // caller value "on" lost — the forced switches are merged LAST.
      expect(childEnv.DELIBERATION_BROWSER_SCAN_MODE).toBe("off");
      expect(childEnv.DELIBERATION_TELEPTY_DISABLED).toBe("1");

      // Regression lock on the removal: the unsupported name no product code
      // reads must not be emitted again as a stand-in for the real knob.
      expect(childEnv.DELIBERATION_DISABLE_BROWSER).toBeUndefined();

      // Forcing the two switches must not swallow the rest of the merge.
      expect(childEnv.DT1172AY_CALLER_MARKER).toBe("present");
      expect(childEnv.HOME).toBe(handle.homeDir);

      // And the environment is still built without spreading process.env.
      const entries = childEnv.PATH.split(path.delimiter).filter(Boolean);
      expect(entries[0]).toBe(stub.dir);
      expect(entries.every(e => isTrustedPathEntry(e, stub.dir))).toBe(true);
    } finally {
      await handle.cleanup();
      stub.cleanup();
    }
  }, INIT_TIMEOUT_CASE_MS);

  it("does not force include_browser config metadata: a caller config still wins", async () => {
    const stub = createStubCliBin(1);
    const handle = await createHarness({
      serverEntry: ECHO_FIXTURE,
      repoRoot: TMP_ROOT,
      stubDir: stub.dir,
      config: { include_browser_speakers: true },
    });
    try {
      const config = JSON.parse(
        fs.readFileSync(path.join(getInstallDir(handle.homeDir), "config.json"), "utf-8")
      );
      // The harness default is false, but it is a DEFAULT, not a forced value.
      // Nothing in the dt1172ay repair pins this to false.
      expect(config.include_browser_speakers).toBe(true);
    } finally {
      await handle.cleanup();
      stub.cleanup();
    }
  }, INIT_TIMEOUT_CASE_MS);
});

describe("mcp-harness owned-root removal is authorised by a positive exit only", () => {
  it("joins a SIGTERM-responsive owned child on an OBSERVED exit", async () => {
    const child = spawn(process.execPath, [IDLE_FIXTURE], { stdio: "ignore" });
    const started = Date.now();
    await joinOwnedChild(child);
    const elapsed = Date.now() - started;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(child.signalCode).toBe("SIGTERM");
    // Settled on the SIGTERM, well before the 5000ms SIGKILL escalation.
    expect(elapsed).toBeLessThan(5000);
  }, 20000);

  it("escalates to SIGKILL for a SIGTERM-ignoring owned child and still settles on an OBSERVED exit", async () => {
    const child = spawn(process.execPath, [STUBBORN_FIXTURE], { stdio: ["ignore", "pipe", "ignore"] });
    // Without this the join races the fixture startup: a SIGTERM landing before
    // the handler is installed kills it by default disposition, and the case
    // would measure Node boot time instead of the escalation.
    await new Promise((resolve) => child.stdout.once("data", resolve));
    const started = Date.now();
    await joinOwnedChild(child, { timeoutMs: 800, deadlineMs: 6000 });
    const elapsed = Date.now() - started;
    expect(child.signalCode).toBe("SIGKILL");
    // The escalation happened AFTER the SIGTERM, not instead of it, and the
    // join did not resolve merely because a signal had been sent.
    expect(elapsed).toBeGreaterThanOrEqual(800);
  }, 20000);

  it("removes the owned root once cleanup observes the exit", async () => {
    const stub = createStubCliBin(1);
    const handle = await createHarness({
      serverEntry: ECHO_FIXTURE,
      repoRoot: TMP_ROOT,
      stubDir: stub.dir,
    });
    const home = handle.homeDir;
    expect(fs.existsSync(home)).toBe(true);
    expect(harnessRoots()).toContain(path.basename(home));

    await handle.cleanup();

    expect(handle.child.exitCode !== null || handle.child.signalCode !== null).toBe(true);
    expect(fs.existsSync(home)).toBe(false);
    expect(harnessRoots()).not.toContain(path.basename(home));
    stub.cleanup();
  }, INIT_TIMEOUT_CASE_MS);

  it("the join helper REJECTS for a handle that never reports an exit, instead of reporting it as joined", async () => {
    // Injected handle, confined to this case: a real child cannot survive
    // SIGKILL, so the only honest way to reach the reject branch of the real
    // joinOwnedChild is to hand it a handle that reports no exit facts. The
    // function under test is the shipped one.
    const handle = new EventEmitter();
    handle.pid = 0;
    handle.exitCode = null;
    handle.signalCode = null;
    handle.kill = () => true;

    await expect(joinOwnedChild(handle, { timeoutMs: 40, deadlineMs: 120 }))
      .rejects.toThrow(/reported no observed exit within/);

    // Every timer and listener it installed is disposed on settlement.
    expect(handle.listenerCount("exit")).toBe(0);
    expect(handle.listenerCount("error")).toBe(0);
  }, 20000);
});

describe("mcp-harness init-abort", () => {
  it("a harness that never receives an init response rejects, joins its child and removes the owned root", async () => {
    const stub = createStubCliBin(1);
    const before = harnessRoots();
    let caught = null;
    try {
      await createHarness({
        serverEntry: SILENT_FIXTURE,
        repoRoot: TMP_ROOT,
        stubDir: stub.dir,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.message).toMatch(/timeout waiting for response 1/);
    // The child DID exit, so this is the removal-authorised branch: the
    // original error is rethrown unwrapped and no root is preserved.
    expect(caught.preservedRoot).toBeUndefined();
    expect(caught.rootRemoved).toBeUndefined();
    expect(harnessRoots()).toEqual(before);
    stub.cleanup();
  }, INIT_TIMEOUT_CASE_MS);

  it("an init-abort whose join REJECTS preserves the owned root and reports BOTH errors", async () => {
    vi.resetModules();
    const joinFailure = new Error(
      "joinOwnedChild: owned child (pid=0) reported no observed exit within 10000ms"
    );
    let observedHandle = "unset";
    vi.doMock("./helpers/cli-discovery-fixture.js", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        joinOwnedChild: vi.fn(async (child) => {
          observedHandle = child;
          throw joinFailure;
        }),
      };
    });
    const { createHarness: createHarnessWithRejectingJoin } =
      await import("./helpers/mcp-harness.mjs");

    const stub = createStubCliBin(1);
    let caught = null;
    try {
      await createHarnessWithRejectingJoin({
        serverEntry: SILENT_FIXTURE,
        repoRoot: TMP_ROOT,
        stubDir: stub.dir,
      });
    } catch (err) {
      caught = err;
    }

    try {
      expect(caught).not.toBeNull();

      // BOTH errors survive, programmatically and in the message.
      expect(caught.joinError).toBe(joinFailure);
      expect(caught.initError).toBeTruthy();
      expect(caught.initError.message).toMatch(/timeout waiting for response 1/);
      expect(caught.cause).toBe(caught.initError);
      expect(caught.message).toMatch(/initialization error: [\s\S]*timeout waiting for response 1/);
      expect(caught.message).toMatch(/join error: [\s\S]*no observed exit/);

      // The root is PRESERVED. This is the defect: the prior revision caught
      // the join rejection and deleted the root anyway, under a child that had
      // not been observed to exit.
      expect(caught.rootRemoved).toBe(false);
      expect(typeof caught.preservedRoot).toBe("string");
      expect(fs.existsSync(caught.preservedRoot)).toBe(true);
      expect(harnessRoots()).toContain(path.basename(caught.preservedRoot));
      expect(caught.message).toMatch(/PRESERVED/);
      expect(caught.message).toMatch(/NOT removed/);

      // A child WAS spawned, so the join was asked about a real handle.
      expect(observedHandle).not.toBe("unset");
      expect(observedHandle).not.toBeNull();
      expect(typeof observedHandle.pid).toBe("number");
    } finally {
      // This case owns the handle the mocked join never reaped. Join it for
      // real, by its exact handle, then remove the root the harness correctly
      // refused to remove. Nothing global is signalled.
      vi.doUnmock("./helpers/cli-discovery-fixture.js");
      vi.resetModules();
      if (observedHandle && observedHandle !== "unset") await joinOwnedChild(observedHandle);
      if (caught && caught.preservedRoot) {
        fs.rmSync(caught.preservedRoot, { recursive: true, force: true });
      }
      stub.cleanup();
    }
  }, INIT_TIMEOUT_CASE_MS);

  it("a failure with NO child ever spawned still cleans the owned root", async () => {
    vi.resetModules();
    let observedHandle = "unset";
    vi.doMock("./helpers/cli-discovery-fixture.js", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        // Passthrough spy: the real join still runs, the case only needs to
        // see WHAT it was handed.
        joinOwnedChild: vi.fn(async (child) => {
          observedHandle = child;
          return actual.joinOwnedChild(child);
        }),
      };
    });
    const { createHarness: createHarnessSpied } = await import("./helpers/mcp-harness.mjs");

    const stub = createStubCliBin(1);
    const untrusted = path.join(TMP_ROOT, "untrusted-bin");
    const before = harnessRoots();
    let caught = null;
    try {
      await createHarnessSpied({
        serverEntry: ECHO_FIXTURE,
        repoRoot: TMP_ROOT,
        stubDir: stub.dir,
        // assertInertPath runs while the spawn arguments are being built, so it
        // throws BEFORE any process exists.
        env: { PATH: `${stub.pathValue}${path.delimiter}${untrusted}` },
      });
    } catch (err) {
      caught = err;
    }

    try {
      expect(caught).not.toBeNull();
      expect(caught.message).toMatch(/host PATH fallback/);
      expect(caught.message).toContain(untrusted);

      // Nothing was spawned: the join was handed null, which is the "no child
      // ever spawned" authorisation for removing the root.
      expect(observedHandle).toBeNull();

      // Root removed, original error rethrown unwrapped, no preserve claim.
      expect(caught.preservedRoot).toBeUndefined();
      expect(caught.rootRemoved).toBeUndefined();
      expect(harnessRoots()).toEqual(before);
    } finally {
      vi.doUnmock("./helpers/cli-discovery-fixture.js");
      vi.resetModules();
      stub.cleanup();
    }
  }, 20000);

  it("leaves no owned harness root behind across the whole suite", () => {
    expect(harnessRoots()).toEqual([]);
  });
});
