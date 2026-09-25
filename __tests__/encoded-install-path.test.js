// dr1172as — task #1172: an install whose PATH needs percent-encoding must
// behave exactly like an install on an ordinary ASCII path.
//
// WHAT THIS SUITE MEASURES
// ------------------------
// Two independent product surfaces, each driven for real:
//
//   1. MCP startup. The real server entry is spawned as a child and a real
//      `initialize` request is written to its stdin as JSON-RPC over stdio.
//      The assertion is on the ANSWER, not on a regex over the source and not
//      on a file existing.
//
//   2. Bundled-asset resolution. `loadRolePrompt` / `loadRolePresets` are
//      called through the exported product API and compared against the bytes
//      actually sitting in that install under selectors/. The assertion is
//      POSITIVE (the resolver must return the real content), so a resolver
//      that silently swallows its own ENOENT cannot pass.
//
// Surface 2 matters on its own: it is reachable even when surface 1 is down,
// so the two failures are distinguished rather than collapsed into one symptom.
//
// EXPECTED BEHAVIOUR (not weakened for the current state of the product)
// ---------------------------------------------------------------------
// Every case below — including the encoded ones — asserts the CORRECT outcome.
// While the defect is present the encoded cases FAIL; that is the point. They
// are not annotated, skipped or softened to make the suite green.
//
// DECLARED LIMITS
// ---------------
//   * POSIX only. No Windows runtime is exercised, so nothing here says
//     anything about drive letters or UNC paths.
//   * Scope is startup + bundled-asset resolution. Installation, packaging,
//     security and the wider tool surface are NOT covered by this file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createCliDiscoveryStubs,
  buildFixtureEnv,
  FIXTURE_SEAM_CEILING,
  TRUSTED_OS_PATH_DIRS,
} from "./helpers/cli-discovery-fixture.js";
import {
  ENCODED_PATH_CASES,
  ENCODED_CASES,
  ORDINARY_CASE,
  HANDSHAKE_TIMEOUT_MS,
  encodedPathnameOf,
  needsNoEncoding,
  nativeUrlPathnameOf,
  materializeInstall,
  initializeOverStdio,
  resolveBundledAssets,
  describeOutcome,
} from "./helpers/encoded-install-fixture.js";

// Handshake bound plus room for spawn and the owned-child join.
const CASE_TIMEOUT_MS = HANDSHAKE_TIMEOUT_MS + 12000;

const installs = new Map();
let baseDir = null;

beforeAll(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "dr1172as-encoded-install-"));

  for (const testCase of ENCODED_PATH_CASES) {
    const root = path.join(baseDir, testCase.segment, "aigentry-deliberation");
    const install = materializeInstall({ root });

    // Owned HOME / TMPDIR / state for this case, and the 11 inert CLI stubs.
    // The child never sees the host PATH, so no real provider CLI, browser or
    // telepty binary is reachable from inside the test.
    const homeDir = fs.mkdtempSync(path.join(baseDir, "home-"));
    const stubs = createCliDiscoveryStubs({ root: homeDir });
    const env = buildFixtureEnv({ homeDir, stubDir: stubs.dir });

    installs.set(testCase.key, { ...install, testCase, homeDir, stubs, env });
  }
}, 120000);

afterAll(() => {
  if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
});

function installFor(key) {
  const install = installs.get(key);
  if (!install) throw new Error("no fixture install materialised for case " + key);
  return install;
}

async function readResolvedAssets(key) {
  const install = installFor(key);
  const outcome = await resolveBundledAssets({ root: install.root, env: install.env });
  expect(outcome.ok, describeOutcome(key, { ...outcome, answered: outcome.ok })).toBe(true);
  return outcome.payload;
}

describe("encoded install path — fixture preconditions", () => {
  it("materialises a real install with a real server entry for every case", () => {
    for (const testCase of ENCODED_PATH_CASES) {
      const install = installFor(testCase.key);
      expect(fs.existsSync(install.entry), install.entry).toBe(true);
      expect(fs.existsSync(path.join(install.root, "lib", "speaker-discovery.js"))).toBe(true);
      expect(fs.existsSync(path.join(install.root, "selectors", "roles", "critic.md"))).toBe(true);
      expect(fs.existsSync(path.join(install.root, "selectors", "role-presets.json"))).toBe(true);
      // The dependency graph is reached, never copied.
      expect(fs.lstatSync(path.join(install.root, "node_modules")).isSymbolicLink()).toBe(true);
    }
  });

  it("provisions 11 inert CLI stubs and a PATH with no host fallback", () => {
    for (const testCase of ENCODED_PATH_CASES) {
      const install = installFor(testCase.key);
      expect(install.stubs.speakers.length).toBe(FIXTURE_SEAM_CEILING);
      expect(install.stubs.speakers.length).toBe(11);
      const dirs = install.env.PATH.split(path.delimiter);
      expect(dirs[0]).toBe(install.stubs.dir);
      // Compared against the dirs the fixture actually built on this platform.
      // The POSIX pair this replaced was a literal, so on win32 — where the
      // fixture correctly supplies System32/Windows — the ASSERTION was the
      // thing that was wrong, not the PATH. The claim is unchanged: the owned
      // stub dir leads, and nothing but trusted OS primitives follows it.
      expect(dirs).toEqual([install.stubs.dir, ...TRUSTED_OS_PATH_DIRS]);
      expect(install.env.HOME).toBe(install.homeDir);
    }
  });

  // Runs on EVERY platform, win32 included. `needsNoEncoding` compares the
  // file-URL pathname re-spelled in native syntax, so the control is a real
  // statement about percent-encoding on win32 too rather than an accidental
  // assertion about drive letters and slash direction. No gate, no skip.
  it("the control case needs no percent-encoding at all", () => {
    const install = installFor(ORDINARY_CASE.key);
    expect(needsNoEncoding(install.root), encodedPathnameOf(install.root)).toBe(true);
  });

  it.each(ENCODED_CASES.map((c) => [c.key, c]))(
    "%s: the install path really does require percent-encoding",
    (key, testCase) => {
      const install = installFor(key);
      const encoded = encodedPathnameOf(install.root);
      // Native-form comparison for the same reason as the control: on win32 a
      // raw pathname differs from the install root for EVERY path, which would
      // make this inequality pass without saying anything about encoding.
      expect(
        nativeUrlPathnameOf(install.root),
        "case " + key + " encoded as " + encoded,
      ).not.toBe(install.root);
      expect(encoded).toContain(testCase.needle);
    },
  );
});

describe("encoded install path — MCP initialize over stdio", () => {
  it(
    "ordinary install answers initialize (control)",
    async () => {
      const install = installFor(ORDINARY_CASE.key);
      const outcome = await initializeOverStdio({
        entry: install.entry,
        cwd: install.root,
        env: install.env,
      });
      expect(outcome.answered, describeOutcome(ORDINARY_CASE.key, outcome)).toBe(true);
      expect(outcome.response.result.serverInfo.name).toBe("mcp-deliberation");
      expect(outcome.response.result.protocolVersion).toBeTruthy();
    },
    CASE_TIMEOUT_MS,
  );

  it.each(ENCODED_CASES.map((c) => [c.key, c]))(
    "%s: install under an encoded path answers initialize",
    async (key) => {
      const install = installFor(key);
      const outcome = await initializeOverStdio({
        entry: install.entry,
        cwd: install.root,
        env: install.env,
      });
      // Same expectation as the control. An install is not allowed to be
      // silently inert just because of the characters in its directory name.
      expect(outcome.answered, describeOutcome(key, outcome)).toBe(true);
      expect(outcome.response.result.serverInfo.name).toBe("mcp-deliberation");
    },
    CASE_TIMEOUT_MS,
  );
});

describe("encoded install path — bundled asset resolution via exported API", () => {
  it(
    "ordinary install resolves its own role prompt and presets (control)",
    async () => {
      const install = installFor(ORDINARY_CASE.key);
      const resolved = await readResolvedAssets(ORDINARY_CASE.key);
      const onDisk = fs.readFileSync(path.join(install.root, "selectors", "roles", "critic.md"), "utf-8").trim();
      expect(resolved.rolePrompt).toBe(onDisk);
      expect(resolved.presetNames.length).toBeGreaterThan(0);
    },
    CASE_TIMEOUT_MS,
  );

  it.each(ENCODED_CASES.map((c) => [c.key, c]))(
    "%s: install under an encoded path resolves its own role prompt",
    async (key) => {
      const install = installFor(key);
      const resolved = await readResolvedAssets(key);
      const roleFile = path.join(install.root, "selectors", "roles", "critic.md");
      const onDisk = fs.readFileSync(roleFile, "utf-8").trim();
      expect(onDisk.length, roleFile).toBeGreaterThan(0);
      expect(resolved.rolePrompt, "case " + key + " role prompt from " + install.root).toBe(onDisk);
    },
    CASE_TIMEOUT_MS,
  );

  it.each(ENCODED_CASES.map((c) => [c.key, c]))(
    "%s: install under an encoded path resolves its own role presets",
    async (key) => {
      const install = installFor(key);
      const resolved = await readResolvedAssets(key);
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(install.root, "selectors", "role-presets.json"), "utf-8"),
      );
      const expectedNames = Object.keys(onDisk.presets || {}).sort();
      expect(expectedNames.length).toBeGreaterThan(0);
      expect(resolved.presetNames, "case " + key).toEqual(expectedNames);
    },
    CASE_TIMEOUT_MS,
  );
});
