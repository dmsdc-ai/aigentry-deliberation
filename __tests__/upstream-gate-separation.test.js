/**
 * ug1172se — task #1172: the upstream `fs.cpSync` diagnostic must be SEPARATED
 * from the product gates, and separation must not become suppression.
 *
 * WHAT THIS FILE IS
 * -----------------
 * A drift detector over four wiring artefacts: `package.json`, `ci.yml`,
 * `upstream-runtime.yml` and `release.yml`. It uses two oracles and nothing
 * else:
 *
 *   * `JSON.parse` on `package.json`, compared against EXACT command strings.
 *     Not a shell tokeniser, not a glob matcher — literal string equality.
 *   * `node:crypto` sha256 BYTE PINS on the three workflow files, plus exact
 *     whole-line membership for the handful of lines that carry the separation
 *     contract. Not a YAML parser.
 *
 * On top of the pins it asserts one COVERAGE property, because separation that
 * silently shrinks where the diagnostic runs would be a loss dressed up as a
 * move: the upstream lane must carry the same 3 OS x 3 Node = 9 arms the product
 * gate used to give the diagnostic for free, taken from `ci.yml`'s own matrix
 * lines, while the original windows-latest Node 20/22 raw-before-install job and
 * its always-run comparison stay exactly as reviewed.
 *
 * WHAT A BYTE PIN PROVES, AND WHAT IT DOES NOT
 * --------------------------------------------
 * A pin proves the reviewed bytes are still the bytes on disk (modulo CRLF,
 * which is normalised away before hashing — see `readText`). That is ALL it
 * proves. It is a SOURCE-DRIFT DETECTOR, not a semantic oracle:
 *
 *   * It does NOT prove GitHub Actions schedules, runs, or fails the job.
 *   * It does NOT prove Vitest collects any particular file.
 *   * A deliberate, reviewed change to a workflow SHOULD fail this file. The
 *     fix is to re-read the diff, then update the pin — never to loosen it.
 *
 * WHAT MUST BE PROVED BY EXECUTION, NOT HERE
 * -------------------------------------------
 * The one claim that matters most — "the product list loses exactly one file
 * and the explicit upstream script still selects it" — is a RUNNER claim and
 * this file cannot establish it. The independent tester must show it by real
 * Vitest enumeration, e.g. comparing the collected file list of
 *
 *     npx vitest list                                   (no exclusion)
 *     npm test -- --reporter=verbose                    (product gate)
 *     npm run test:upstream -- --reporter=verbose       (upstream lane)
 *
 * The nine restored arms are likewise only a SOURCE claim here. That GitHub
 * dispatches nine `upstream-runtime-coverage` jobs, and that the diagnostic
 * really executes on the ubuntu / macOS / Node-18 arms, has to be read off real
 * runs — this file only proves the matrix that would produce them is on disk.
 *
 * No handwritten glob converter appears below, and none should be added: a
 * reimplementation of picomatch would only prove itself.
 *
 * WHY THE PRODUCT EXCLUSION IS ONE BARE PATH
 * -------------------------------------------
 * Read off the installed Vitest 4.0.18 sources, not guessed:
 *
 *   * `config.cjs:16`  `defaultExclude = ["**\/node_modules/**", "**\/.git/**"]`
 *     and `config.cjs:52`  `exclude: defaultExclude` — those two are the
 *     built-in defaults.
 *   * `cac.js:1344-1347` `normalizeCliOptions` moves `argv.exclude` to
 *     `argv.cliExclude` and DELETES `argv.exclude`, so a CLI `--exclude` can
 *     never land on `test.exclude`.
 *   * `coverage.js:2615` `if (resolved.cliExclude) resolved.exclude.push(...)`
 *     — the CLI value is APPENDED to the resolved defaults.
 *
 * So CLI `--exclude` extends; it does not replace. Restating `node_modules` is
 * redundant and `**\/dist/**` would be an unauthorised broadening. The product
 * gate therefore passes exactly one bare path and nothing else.
 *
 * WHAT THIS FILE DOES NOT MEASURE
 * --------------------------------
 * Nothing about `fs.cpSync`, Windows, or whether the diagnostic currently
 * passes. It does not re-test the installer copy caller — that is
 * `__tests__/installer-unicode.test.js`, which it asserts stays in the product
 * gate. It is not release acceptance.
 *
 * Dependencies: vitest + node builtins only.
 */

import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TESTS_DIR);

const DIAGNOSTIC_TEST = "__tests__/native-unicode-copy.test.js";
const DIAGNOSTIC_SCRIPT = "scripts/diagnose-native-unicode-copy.mjs";
const CI = ".github/workflows/ci.yml";
const UPSTREAM = ".github/workflows/upstream-runtime.yml";
const RELEASE = ".github/workflows/release.yml";

/**
 * Read a file and normalise CRLF to LF before anything hashes or matches it.
 * The product gate runs on `windows-latest`, where a checkout may carry CRLF;
 * a pin that flipped on line endings alone would be a false alarm, not drift.
 */
const readText = (rel) =>
  fs.readFileSync(path.join(REPO, ...rel.split("/")), "utf8").replace(/\r\n/g, "\n");
const exists = (rel) => fs.existsSync(path.join(REPO, ...rel.split("/")));
const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const linesOf = (text) => text.split(/\r?\n/);
const countLine = (text, line) => linesOf(text).filter((l) => l === line).length;

/**
 * Count the entries of a `key: [a, b, c]` matrix line. Not a YAML parser: it
 * reads ONE already-asserted literal line between its own brackets, and is only
 * ever applied to lines this file has first proved are present verbatim. It
 * exists so the arm arithmetic (3 OS x 3 Node = 9) is stated as arithmetic
 * rather than as a hard-coded 9 that a list edit could quietly falsify.
 */
const matrixEntries = (line) =>
  line
    .slice(line.indexOf("[") + 1, line.lastIndexOf("]"))
    .split(",")
    .map((s) => s.trim());

// ── The reviewed package scripts, verbatim ───────────────────────────────────
//
// Compared with `toEqual` over the WHOLE scripts object, so an added, removed
// or renamed script fails just as loudly as an edited one.
const EXPECTED_SCRIPTS = Object.freeze({
  start: "node index.js",
  test: "vitest run --exclude=__tests__/native-unicode-copy.test.js",
  "test:watch": "vitest --exclude=__tests__/native-unicode-copy.test.js",
  "test:upstream": "vitest run __tests__/native-unicode-copy.test.js",
  prepublishOnly: "npm test",
  postversion: "node install.js",
  "release:patch": "npm version patch && git push && git push --tags",
  "release:minor": "npm version minor && git push && git push --tags",
  "release:major": "npm version major && git push && git push --tags",
});

// ── Reviewed workflow bytes ──────────────────────────────────────────────────
//
// `release.yml` is pinned at its FROZEN release hash: this change must not have
// touched the publication gate, and the pin says so.
const EXPECTED_SHA256 = Object.freeze({
  [CI]: "d836f1ef40f7ece39b02fcc64705653b326e72222f2ba645d478b308caeff0c6",
  [UPSTREAM]: "cc81fafbcd1e380f3fd60b061760daa48b3b1c4e260949766b803b4df368cb9b",
  [RELEASE]: "30fb347a7bc418dec40db77d6b093a07dca1af36c0a4c3efb7beccd3f84c3490",
});

// ── Lines that carry the contract ────────────────────────────────────────────
//
// Exact whole lines, indentation included, asserted by array membership. These
// exist so a pin failure is READABLE: the pin says "something moved", these say
// which part of the separation contract is gone.
const REQUIRED_LINES = Object.freeze({
  [CI]: Object.freeze([
    "        os: [ubuntu-latest, macos-latest, windows-latest]",
    "        node: [18, 20, 22]",
    "        run: npm test",
    "        run: npm ci",
  ]),
  [UPSTREAM]: Object.freeze([
    "    runs-on: windows-latest",
    "    timeout-minutes: 10",
    "      fail-fast: false",
    "        node: [20, 22]",
    "        timeout-minutes: 3",
    "        run: node scripts/diagnose-native-unicode-copy.mjs",
    "        if: always()",
    "        run: npm ci",
    "        timeout-minutes: 5",
    "        run: npm run test:upstream",
    // The restored coverage job: the nine arms the diagnostic used to get for
    // free from the product gate. Same three lines `ci.yml` uses, asserted
    // against `ci.yml`'s own text in "restores all nine diagnostic arms".
    "    runs-on: ${{ matrix.os }}",
    "        os: [ubuntu-latest, macos-latest, windows-latest]",
    "        node: [18, 20, 22]",
  ]),
  [RELEASE]: Object.freeze(["      - run: npm test", "    needs: test"]),
});

/** Keys and shell forms that turn a red job green. Absent from `upstream.yml`. */
const MASKING_TOKENS = Object.freeze([
  "continue-on-error",
  "continue_on_error",
  "allow-failure",
  "allowFailure",
  "|| true",
  "|| echo",
  "exit 0",
  "if: false",
  "passWithNoTests",
]);

const maskingTokensIn = (text) => MASKING_TOKENS.filter((t) => text.includes(t));

/** Config files that could install a GLOBAL Vitest exclusion. */
const CONFIG_CANDIDATES = Object.freeze([
  "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs", "vitest.config.ts",
  "vitest.workspace.js", "vitest.workspace.mjs", "vitest.workspace.ts", "vitest.workspace.json",
  "vite.config.js", "vite.config.mjs", "vite.config.cjs", "vite.config.ts",
]);

const PKG = JSON.parse(readText("package.json"));
const TEXT = Object.freeze({
  [CI]: readText(CI),
  [UPSTREAM]: readText(UPSTREAM),
  [RELEASE]: readText(RELEASE),
});

// ── Product gate ─────────────────────────────────────────────────────────────

describe("ug1172se product gate", () => {
  it("declares exactly the reviewed scripts, verbatim", () => {
    expect(PKG.scripts).toEqual(EXPECTED_SCRIPTS);
  });

  it("excludes one bare path and passes no other exclusion", () => {
    // Stated as its own assertion because it is the whole point of the change.
    // Literal equality: no tokenizer, no glob expansion, no inference.
    expect(PKG.scripts.test).toBe("vitest run --exclude=__tests__/native-unicode-copy.test.js");
    expect(PKG.scripts["test:watch"]).toBe("vitest --exclude=__tests__/native-unicode-copy.test.js");
  });

  it("keeps watch mode and the publish path on the same definition", () => {
    // `prepublishOnly` delegates rather than duplicating, so the publish path
    // and CI cannot drift apart.
    expect(PKG.scripts.prepublishOnly).toBe("npm test");
    expect(PKG.scripts["test:watch"].startsWith("vitest --exclude=")).toBe(true);
    expect(PKG.scripts["test:watch"].slice("vitest".length)).toBe(
      PKG.scripts.test.slice("vitest run".length)
    );
  });

  it("changes no dependency, version or publication payload", () => {
    expect(PKG.version).toBe("0.0.47");
    expect(PKG.devDependencies).toEqual({ vitest: "^4.0.18" });
    expect(PKG.dependencies).toEqual({
      "@dmsdc-ai/aigentry-logger": "^0.2.0",
      "@modelcontextprotocol/sdk": "^1.26.0",
      "cross-spawn": "7.0.6",
      ws: "^8.18.0",
    });
    expect(PKG.files).toEqual([
      "index.js", "i18n.js", "model-router.js", "clipboard.js", "install.js",
      "doctor.js", "browser-control-port.js", "degradation-state-machine.js",
      "logger-emit.js", "session-monitor.sh", "session-monitor-win.js",
      "selectors/**", "skills/**", "lib/**", "examples/**", "LICENSE", "README.md",
    ]);
  });

  it("installs no global Vitest exclusion", () => {
    // A global `exclude` would silently reduce `npm run test:upstream` to zero
    // collected tests and report success. There is deliberately no config file.
    expect(CONFIG_CANDIDATES.filter(exists)).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(PKG, "vitest")).toBe(false);
  });
});

// ── Artefacts ────────────────────────────────────────────────────────────────

describe("ug1172se artefacts", () => {
  it("keeps the diagnostic test and its runner-free script on disk", () => {
    expect(exists(DIAGNOSTIC_TEST)).toBe(true);
    expect(exists(DIAGNOSTIC_SCRIPT)).toBe(true);
    expect(exists(UPSTREAM)).toBe(true);
  });

  it("keeps the real installer caller's coverage in the product gate", () => {
    // `install.js` copies with copyFileIfExists / copyDirRecursive ->
    // fs.copyFileSync, never fs.cpSync. That caller's test is a PRODUCT test
    // and is not affected by the one-file exclusion.
    expect(exists("__tests__/installer-unicode.test.js")).toBe(true);
    expect(exists("__tests__/encoded-install-path.test.js")).toBe(true);
    expect(PKG.scripts.test).not.toContain("installer-unicode");
    expect(PKG.scripts.test).not.toContain("encoded-install-path");
  });
});

// ── Workflow byte pins ───────────────────────────────────────────────────────

describe("ug1172se workflow byte pins", () => {
  it.each(Object.keys(EXPECTED_SHA256))("%s matches its reviewed bytes", (file) => {
    // DRIFT DETECTOR, NOT A SEMANTIC ORACLE. If this fails, read the diff and
    // update the pin deliberately; do not relax the assertion.
    expect(sha256(TEXT[file])).toBe(EXPECTED_SHA256[file]);
  });

  it.each(Object.keys(REQUIRED_LINES))("%s still carries its contract lines", (file) => {
    const lines = linesOf(TEXT[file]);
    expect(REQUIRED_LINES[file].filter((l) => !lines.includes(l))).toEqual([]);
  });

  it("runs the raw diagnostic before any dependency install", () => {
    const lines = linesOf(TEXT[UPSTREAM]);
    const raw = lines.indexOf("        run: node scripts/diagnose-native-unicode-copy.mjs");
    const install = lines.indexOf("        run: npm ci");
    const compare = lines.indexOf("        run: npm run test:upstream");
    expect(raw).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(raw);
    expect(compare).toBeGreaterThan(install);
  });

  // ── The coverage the separation must not cost ───────────────────────────────
  //
  // Baseline `npm test` was a bare `vitest run`, so the diagnostic file was
  // COLLECTED on every arm of the product matrix: 3 OS x 3 Node = 9 arms per
  // push. Excluding it from the product gate removes all nine; the upstream lane
  // has to put them back, or the ubuntu / macOS / Node-18 observations are simply
  // gone. That is a coverage claim about the WORKFLOW SOURCE, which is what this
  // file can check — whether GitHub actually dispatches nine jobs remains a
  // runner claim for the independent tester.

  it("restores all nine diagnostic arms the product gate used to provide", () => {
    const ciLines = linesOf(TEXT[CI]);
    const upLines = linesOf(TEXT[UPSTREAM]);

    // Taken from `ci.yml`'s own text, not restated here, so the two lanes cannot
    // drift apart: widening the product matrix without widening this one fails.
    const osLine = ciLines.find((l) => l.trimStart().startsWith("os: ["));
    const nodeLine = ciLines.find((l) => l.trimStart().startsWith("node: [18"));
    expect(osLine).toBe("        os: [ubuntu-latest, macos-latest, windows-latest]");
    expect(nodeLine).toBe("        node: [18, 20, 22]");

    expect(upLines).toContain(osLine);
    expect(upLines).toContain(nodeLine);
    expect(upLines).toContain("    runs-on: ${{ matrix.os }}");

    expect(matrixEntries(osLine)).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);
    expect(matrixEntries(nodeLine)).toEqual(["18", "20", "22"]);
    expect(matrixEntries(osLine).length * matrixEntries(nodeLine).length).toBe(9);

    // The restored arms run the diagnostic through the explicit upstream script,
    // the same one the Windows comparison uses — not a re-spelled command.
    expect(countLine(TEXT[UPSTREAM], "        run: npm run test:upstream")).toBe(2);
  });

  it("keeps the two raw-before-install comparisons on the original Windows arms", () => {
    const upLines = linesOf(TEXT[UPSTREAM]);

    // Exactly one raw builtin-only reproduction, still on windows-latest, still
    // on Node 20 and 22 -> two arms, i.e. two raw-vs-Vitest comparisons. The
    // restored coverage job must ADD arms, never dilute or replace these.
    expect(countLine(TEXT[UPSTREAM], "        run: node scripts/diagnose-native-unicode-copy.mjs")).toBe(1);
    expect(upLines).toContain("    runs-on: windows-latest");
    expect(upLines).toContain("        node: [20, 22]");
    expect(matrixEntries("        node: [20, 22]").length).toBe(2);

    // Both always-run steps of that job survive: the install and the comparison.
    expect(countLine(TEXT[UPSTREAM], "        if: always()")).toBe(2);

    // The raw job comes FIRST, so the ordering assertion above reads its steps
    // and not the coverage job's install.
    expect(upLines.indexOf("    runs-on: windows-latest")).toBeLessThan(
      upLines.indexOf("    runs-on: ${{ matrix.os }}")
    );
  });

  it("cannot mask a failure in the upstream lane", () => {
    expect(maskingTokensIn(TEXT[UPSTREAM])).toEqual([]);
  });

  it("does not wire the upstream lane into a product gate", () => {
    for (const file of [CI, RELEASE]) {
      expect(TEXT[file]).not.toContain("native-unicode");
      expect(TEXT[file]).not.toContain("upstream-runtime");
      expect(TEXT[file]).not.toContain("test:upstream");
    }
  });
});

// ── Negative mutations ───────────────────────────────────────────────────────
//
// Each mutation is applied directly to a copy of the real artefact. Script
// mutations must break the exact-value comparison; workflow mutations must
// break the byte pin (and, where relevant, the masking scan). A mutation that
// fails to change anything is itself a failure, so the "changed" side is
// asserted first.

const SCRIPT_MUTATIONS = Object.freeze([
  ["no exclusion — the diagnostic runs in the product gate", { test: "vitest run" }],
  [
    "r1 over-broadening — node_modules/dist restated as if CLI replaced defaults",
    {
      test:
        'vitest run --exclude="**/node_modules/**" --exclude="**/dist/**" ' +
        '--exclude="**/__tests__/native-unicode-copy.test.js"',
    },
  ],
  ["exclusion broadened to the whole test directory", { test: "vitest run --exclude=__tests__/**" }],
  [
    "exclusion broadened to every native test",
    { test: "vitest run --exclude=__tests__/*native*.test.js" },
  ],
  [
    "a second, unrelated test swept in",
    {
      test:
        "vitest run --exclude=__tests__/native-unicode-copy.test.js " +
        "--exclude=__tests__/installer-unicode.test.js",
    },
  ],
  [
    "product gate narrowed to a single file",
    { test: "vitest run --exclude=__tests__/native-unicode-copy.test.js __tests__/doctor.test.js" },
  ],
  ["prepublishOnly bypasses the product gate definition", { prepublishOnly: "vitest run" }],
  ["watch mode diverges from the product gate", { "test:watch": "vitest" }],
  ["explicit upstream script removed", { "test:upstream": undefined }],
  ["upstream script points at a different file", { "test:upstream": "vitest run __tests__/installer-unicode.test.js" }],
  ["upstream script runs the whole suite", { "test:upstream": "vitest run" }],
  [
    "upstream script inherits the exclusion — zero-test masking",
    {
      "test:upstream":
        "vitest run --exclude=__tests__/native-unicode-copy.test.js " + DIAGNOSTIC_TEST,
    },
  ],
  [
    "upstream script tolerates an empty run",
    { "test:upstream": "vitest run --passWithNoTests " + DIAGNOSTIC_TEST },
  ],
  ["upstream script swallows a non-zero exit", { "test:upstream": "vitest run " + DIAGNOSTIC_TEST + " || true" }],
]);

const WORKFLOW_MUTATIONS = Object.freeze([
  [UPSTREAM, "a failure-tolerating key is added", "    runs-on: windows-latest", "    runs-on: windows-latest\n    continue-on-error: true", true],
  [UPSTREAM, "the comparison is forced to exit zero", "        run: npm run test:upstream", "        run: npm run test:upstream || true", true],
  [UPSTREAM, "the job is switched off", "    runs-on: windows-latest", "    if: false\n    runs-on: windows-latest", true],
  [UPSTREAM, "the plain-node raw diagnostic is dropped", "        run: node scripts/diagnose-native-unicode-copy.mjs", "        run: node --version", false],
  [UPSTREAM, "a Node version is dropped", "        node: [20, 22]", "        node: [20]", false],
  [UPSTREAM, "it stops running on Windows", "    runs-on: windows-latest", "    runs-on: ubuntu-latest", false],
  [UPSTREAM, "the comparison stops running after a red raw step", "        if: always()\n        timeout-minutes: 5", "        timeout-minutes: 5", false],
  [UPSTREAM, "it is demoted to manual-only", "on:\n  push:\n    branches: [main]", "on:\n  workflow_dispatch:", false],
  [UPSTREAM, "the job timeout is removed", "    timeout-minutes: 10\n", "", false],
  // Regressions of the restored nine arms. Each drops coverage the product gate
  // used to provide, and each must break the pin.
  [UPSTREAM, "the restored coverage loses macOS", "        os: [ubuntu-latest, macos-latest, windows-latest]", "        os: [ubuntu-latest, windows-latest]", false],
  [UPSTREAM, "the restored coverage loses Node 18", "        node: [18, 20, 22]", "        node: [20, 22]", false],
  [UPSTREAM, "the restored coverage collapses back to one runner", "    runs-on: ${{ matrix.os }}", "    runs-on: windows-latest", false],
  [UPSTREAM, "the restored coverage stops invoking the upstream script", "      - name: Diagnostic under Vitest\n        timeout-minutes: 5\n        run: npm run test:upstream", "      - name: Diagnostic under Vitest\n        timeout-minutes: 5\n        run: node --version", false],
  [CI, "the diagnostic is wired back into the product gate", "      - name: Test\n        run: npm test", "      - name: Test\n        run: npm test\n\n      - name: Diagnostic\n        run: node scripts/diagnose-native-unicode-copy.mjs", false],
  [CI, "the product matrix loses a Node version", "        node: [18, 20, 22]", "        node: [20, 22]", false],
  [CI, "the product matrix loses an OS", "        os: [ubuntu-latest, macos-latest, windows-latest]", "        os: [ubuntu-latest, macos-latest]", false],
  [CI, "the product job stops running the suite", "        run: npm test", "        run: echo skipped", false],
  [RELEASE, "the release gate stops running the suite", "      - run: npm test", "      - run: echo skipped", false],
  [RELEASE, "publish no longer waits for the release test job", "    needs: test\n", "", false],
]);

describe("ug1172se negative mutations", () => {
  it.each(SCRIPT_MUTATIONS)("rejects script mutation: %s", (_name, patch) => {
    const mutated = { ...PKG.scripts };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete mutated[key];
      else mutated[key] = value;
    }
    expect(mutated, "mutation changed nothing").not.toEqual(PKG.scripts);
    expect(mutated).not.toEqual(EXPECTED_SCRIPTS);
  });

  it.each(WORKFLOW_MUTATIONS)(
    "rejects %s mutation: %s",
    (file, _name, find, replace, expectMasking) => {
      const original = TEXT[file];
      expect(original.includes(find), "mutation anchor not found").toBe(true);
      const mutated = original.replace(find, replace);
      expect(mutated, "mutation changed nothing").not.toBe(original);
      expect(sha256(mutated)).not.toBe(EXPECTED_SHA256[file]);
      if (expectMasking) expect(maskingTokensIn(mutated).length).toBeGreaterThan(0);
    }
  );

  it("detects a global Vitest config being introduced", () => {
    // Asserted as a rule about the candidate list rather than by writing a
    // file: this test never mutates the working tree.
    expect(CONFIG_CANDIDATES).toContain("vitest.config.js");
    expect(CONFIG_CANDIDATES.filter(exists)).toEqual([]);
  });
});
