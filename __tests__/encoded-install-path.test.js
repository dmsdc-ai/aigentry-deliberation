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
import { fileURLToPath, pathToFileURL } from "node:url";
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

// ── Owned vs ancestor segments ────────────────────────────────
//
// The encoding question this suite asks is about the segment the FIXTURE
// creates, never about where the host happens to put a temp directory. On the
// GitHub win32 runners the ancestor is `C:\Users\RUNNER~1\AppData\Local\Temp`,
// and a file URL encodes that 8.3 short name's `~` as `%7E` — so a whole-path
// round trip reported "needs encoding" for the plain-ASCII CONTROL
// (CI 36076593173: `/C:/Users/RUNNER%7E1/.../plain-ascii-install/...`). The
// same ancestor escape also made the encoded cases' inequality vacuous: it
// would have held even for a segment that needed no encoding at all.
//
// So both are measured on the owned tail only: the case segment plus the
// install directory name, i.e. exactly the two segments `beforeAll` joins onto
// `baseDir`. Nothing is normalised, no escape is undone, no segment is
// renamed, and the install stays exactly where it was materialised — moving it
// to a cleaner host path would delete the adversarial condition instead of
// measuring it.
function ownedSegments(root) {
  return path.relative(baseDir, root).split(path.sep).filter(Boolean);
}

/** The same owned segments as a file URL spells them, in native syntax. */
function encodedOwnedSegments(root) {
  const owned = ownedSegments(root);
  const spelled = nativeUrlPathnameOf(root).split(path.sep).filter(Boolean);
  return spelled.slice(spelled.length - owned.length);
}

/** True when the fixture's OWN segments survive the round trip unchanged. */
function ownedTailNeedsNoEncoding(root) {
  return encodedOwnedSegments(root).join("/") === ownedSegments(root).join("/");
}

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

  // Runs on EVERY platform, win32 included. The comparison is on the
  // fixture-owned segments, re-spelled in native syntax by
  // `nativeUrlPathnameOf`, so it is a real statement about percent-encoding on
  // win32 too rather than an accidental assertion about drive letters, slash
  // direction, or the host's temp directory. No gate, no skip.
  it("the control case's own install segments need no percent-encoding at all", () => {
    const install = installFor(ORDINARY_CASE.key);
    // The segments under test are the ones this file creates, and they are the
    // literal names from the case table — asserted, so the check cannot drift
    // onto some other part of the path.
    expect(ownedSegments(install.root)).toEqual([
      ORDINARY_CASE.segment,
      "aigentry-deliberation",
    ]);
    expect(
      encodedOwnedSegments(install.root).join("/"),
      "control owned tail",
    ).toEqual(ownedSegments(install.root).join("/"));
    expect(ownedTailNeedsNoEncoding(install.root)).toBe(true);
  });

  // The control's substantive claim is SEMANTIC, and it holds for every case on
  // every platform: a real file-URL round trip through the url API is lossless
  // even when the host ancestor carries `~`, a space or a non-ASCII character.
  // What the encoded cases expose is the naive `.pathname` read, not a path
  // that has stopped identifying its own install.
  it("every install root survives a real file-URL round trip unchanged", () => {
    for (const testCase of ENCODED_PATH_CASES) {
      const install = installFor(testCase.key);
      expect(
        fileURLToPath(pathToFileURL(install.root)),
        "case " + testCase.key,
      ).toBe(install.root);
      expect(fs.existsSync(install.root)).toBe(true);
    }
  });

  it.each(ENCODED_CASES.map((c) => [c.key, c]))(
    "%s: the fixture's OWN install segment really does require percent-encoding",
    (key, testCase) => {
      const install = installFor(key);
      const ownedEncoded = encodedOwnedSegments(install.root).join("/");
      // The exact adversarial name, byte for byte: nothing here renames or
      // normalises a segment, so a Unicode-normalising copy step could not be
      // mistaken for a passing case.
      expect(ownedSegments(install.root)[0]).toBe(testCase.segment);
      // The inequality is now carried by the OWNED tail, so it cannot be
      // satisfied by an ancestor escape the fixture does not control, and the
      // escape it names must come from the segment under test.
      expect(
        ownedEncoded,
        "case " + key + " owned tail encoded as " + ownedEncoded,
      ).not.toBe(ownedSegments(install.root).join("/"));
      expect(ownedEncoded).toContain(testCase.needle);
      // The absolute form still contains the escape: the owned-tail comparison
      // narrows WHERE the claim is made, it does not weaken it.
      expect(encodedPathnameOf(install.root)).toContain(testCase.needle);
    },
  );

  // The guard on the repair itself. The control predicate must REJECT every
  // hostile owned segment: if `ownedTailNeedsNoEncoding` ever started counting
  // a space, a non-ASCII byte, a literal percent or a hash as plain ASCII, the
  // control above would pass for the wrong reason and the whole precondition
  // block would go quiet.
  it.each(ENCODED_CASES.map((c) => [c.key, c]))(
    "%s: a hostile owned segment cannot pass the control's plain-ASCII check",
    (key) => {
      const install = installFor(key);
      expect(ownedTailNeedsNoEncoding(install.root), "case " + key).toBe(false);
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
