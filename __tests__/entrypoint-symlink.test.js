/**
 * Regression: the main-module guard must start the stdio server for the real
 * entry AND for a symlinked entry, under default flags and under
 * --preserve-symlinks-main, and must stay silent (without crashing) whenever
 * argv[1] is absent, empty, unresolvable, or a different real file.
 *
 * Why both sides are canonicalised in index.js: the ESM loader resolves
 * symlinks in import.meta.url while path.resolve(argv[1]) stays lexical, so a
 * symlinked install never matched. Under --preserve-symlinks-main the main
 * module keeps its symlinked specifier instead, which flips which side is
 * lexical. Comparing realpaths on both sides is the only form that holds for
 * every combination, and it must not throw when argv[1] cannot be resolved.
 *
 * This file imports vitest, node builtins and exactly ONE shared test helper —
 * `helpers/portable-fixture-copy.js`, for the payload copy below — and never the
 * product itself. That helper is a leaf module: node builtins only, no product
 * import, no child process, no network. It builds its fixture from the package's
 * own declared payload allowlist, so it keeps working in an ordinary checkout on
 * any platform.
 *
 * Every child runs with an environment built from scratch: nothing inherited,
 * fake HOME plus XDG and temp variables inside the fixture, PATH restricted to
 * inert stubs, browser scanning switched off. Each child is given exactly one
 * MCP initialize request on stdin and then EOF. Each child has its own 10s
 * watchdog bound to that one handle, and every handle is joined before cleanup
 * removes the unique temp roots this file created.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { copyFixtureEntry } from "./helpers/portable-fixture-copy.js";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TESTS_DIR);
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
const IS_WIN = process.platform === "win32";
const PER_CHILD_MS = 10_000;

/** A plain name and a name that must survive percent-encoding in a file URL. */
const SEGMENTS = { ascii: "ordinary-install", encoded: "en coded 한글 100%tested #1" };

const FLAGS = { default: [], "preserve-symlinks-main": ["--preserve-symlinks-main"] };

/** Commands the product may shell out to. Stubbed so a child can never run them. */
const STUBBED = [
  "telepty", "npm", "npx", "git", "open", "osascript",
  "pbcopy", "pbpaste", "tmux", "curl", "wget", "ssh", "claude", "codex",
];

const INITIALIZE =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: PKG.name, version: PKG.version },
    },
  }) + "\n";

const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/** @type {string[]} the exact temp roots this file created */
const ownedTempRoots = [];
/** @type {import('node:child_process').ChildProcess[]} the exact children this file spawned */
const ownedChildren = [];
/** @type {object[]} */
const observations = [];

// ── Fixture construction ──────────────────────────────────────────────

/**
 * Resolve the installed dependency graph. A checkout may have a real
 * node_modules directory or a symlink to one; realpath accepts both.
 */
function resolveDependencyGraph() {
  const graph = path.join(REPO, "node_modules");
  if (!fs.existsSync(graph)) {
    throw new Error(`dependencies are not installed: ${graph} is missing`);
  }
  return fs.realpathSync(graph);
}

/**
 * Copy the package's own declared payload, expanding the allowlist entries in
 * package.json "files". package.json is always part of a published package and
 * is required here for the module type, so it is copied explicitly.
 *
 * The copy goes through `copyFixtureEntry` rather than
 * `fs.cpSync(..., {recursive:true})`, so the payload of the fixture built under
 * `en coded 한글 100%tested #1` does not depend on the recursive builtin. It
 * throws on a missing source, an unsupported entry or a file that did not land,
 * so a payload that fails to materialise surfaces HERE rather than as a puzzling
 * child failure later; each destination path below is fresh, which is what that
 * helper requires. Entries that do not exist are still skipped before the call,
 * exactly as before: the allowlist legitimately names files an ordinary checkout
 * may lack.
 */
function copyDeclaredPayload(dest) {
  const entries = ["package.json", ...(PKG.files ?? [])];
  const copied = [];
  for (const entry of entries) {
    const rel = entry.replace(/\/\*\*$/, "");
    const from = path.join(REPO, rel);
    if (!fs.existsSync(from)) continue;
    copyFixtureEntry(from, path.join(dest, rel));
    copied.push(rel);
  }
  return copied;
}

/** Inert stubs so a restricted PATH still resolves, but nothing can execute. */
function writeStubBin(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of STUBBED) {
    if (IS_WIN) {
      fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\nexit /b 97\r\n`, "utf8");
    } else {
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexit 97\n`, "utf8");
      fs.chmodSync(path.join(dir, name), 0o755);
    }
  }
}

/** Owned drivers covering the argv shapes that must never start a server. */
function writeDrivers(dir) {
  const tail = `await import("./index.js");\nprocess.stdout.write("IMPORT_OK\\n");\n`;
  const here = `import path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst here = path.dirname(fileURLToPath(import.meta.url));\n`;
  const drivers = {
    // argv[1] is this driver: a real, existing path that is not index.js
    "driver-import-library.mjs": tail,
    "driver-distinct-real-entry.mjs": `${here}process.argv[1] = path.join(here, "i18n.js");\n${tail}`,
    "driver-missing-argv.mjs": `process.argv = [process.argv[0]];\n${tail}`,
    "driver-empty-argv.mjs": `process.argv[1] = "";\n${tail}`,
    "driver-unresolvable-argv.mjs": `${here}process.argv[1] = path.join(here, "no-such-entry.js");\n${tail}`,
  };
  for (const [name, body] of Object.entries(drivers)) {
    fs.writeFileSync(path.join(dir, name), body, "utf8");
  }
}

/**
 * One temp root per name segment:
 *   <root>/real/<segment>   the package payload, entered directly
 *   <root>/linkroot         a directory link to <root>/real
 * Both entry paths therefore reach the same bytes through the same inode.
 * The root is canonicalised so the real-entry case is a genuine realpath even
 * where the platform temp directory is itself reached through a symlink.
 */
function buildFixture(segKey) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "entrypoint-symlink-")));
  ownedTempRoots.push(root);

  const realDir = path.join(root, "real");
  const productDir = path.join(realDir, SEGMENTS[segKey]);
  fs.mkdirSync(productDir, { recursive: true });

  const copied = copyDeclaredPayload(productDir);
  fs.symlinkSync(resolveDependencyGraph(), path.join(productDir, "node_modules"), LINK_TYPE);
  writeDrivers(productDir);

  fs.symlinkSync(realDir, path.join(root, "linkroot"), LINK_TYPE);

  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  const stubBin = path.join(root, "stub-bin");
  for (const d of [home, tmp, path.join(root, "xdg")]) fs.mkdirSync(d, { recursive: true });
  writeStubBin(stubBin);

  return {
    root,
    copied,
    home,
    tmp,
    stubBin,
    realDir: productDir,
    linkDir: path.join(root, "linkroot", SEGMENTS[segKey]),
    realEntry: path.join(productDir, "index.js"),
    linkEntry: path.join(root, "linkroot", SEGMENTS[segKey], "index.js"),
  };
}

/** Built from scratch: no variable is inherited from the runner. */
function childEnv(fx) {
  const xdg = path.join(fx.root, "xdg");
  const env = {
    PATH: fx.stubBin,
    HOME: fx.home,
    USERPROFILE: fx.home,
    XDG_CONFIG_HOME: path.join(xdg, "config"),
    XDG_DATA_HOME: path.join(xdg, "data"),
    XDG_CACHE_HOME: path.join(xdg, "cache"),
    XDG_STATE_HOME: path.join(xdg, "state"),
    TMPDIR: fx.tmp,
    TMP: fx.tmp,
    TEMP: fx.tmp,
    LANG: "en_US.UTF-8",
    NODE_ENV: "test",
  };
  if (IS_WIN) env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
  // Applied last so nothing above can re-enable a browser scan.
  env.DELIBERATION_BROWSER_SCAN_MODE = "off";
  return env;
}

// ── One child: one initialize, then EOF ───────────────────────────────

function runChild({ label, fx, cwd, nodeArgs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, nodeArgs, {
      cwd,
      env: childEnv(fx),
      stdio: ["pipe", "pipe", "pipe"],
    });
    ownedChildren.push(child);

    let stdout = "";
    let stderr = "";
    let settledBy = null;
    let handleError = null;

    // Bound to this one handle. No process scan, no group kill.
    const watchdog = setTimeout(() => {
      settledBy = "timeout";
      try {
        child.kill("SIGKILL");
      } catch (e) {
        handleError = String(e && e.message);
      }
    }, PER_CHILD_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => (handleError = String(e && e.message)));
    child.stdin.on("error", (e) => (handleError = handleError ?? String(e && e.message)));

    child.stdin.write(INITIALIZE);
    child.stdin.end();

    child.on("close", (exit, signal) => {
      clearTimeout(watchdog);
      const rec = {
        label,
        command: [process.execPath, ...nodeArgs],
        cwd,
        exit,
        signal,
        settledBy: settledBy ?? "child-closed",
        elapsedMs: Date.now() - started,
        answered: answeredInitialize(stdout),
        importOk: stdout.includes("IMPORT_OK"),
        handleError,
        stdout,
        stderr,
      };
      observations.push(rec);
      resolve(rec);
    });
  });
}

/** True only for a real JSON-RPC initialize result on the transport. */
function answeredInitialize(stdout) {
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const msg = JSON.parse(s);
      if (msg.id === 1 && msg.result && (msg.result.serverInfo || msg.result.protocolVersion)) {
        return true;
      }
    } catch {
      // A non-JSON line on stdout is not an answer.
    }
  }
  return false;
}

// ── Fixtures ──────────────────────────────────────────────────────────

/** @type {Record<string, ReturnType<typeof buildFixture>>} */
const fixtures = {};

beforeAll(() => {
  for (const segKey of Object.keys(SEGMENTS)) fixtures[segKey] = buildFixture(segKey);
});

afterAll(async () => {
  // Join the exact children this file spawned before removing their fixtures.
  await Promise.all(
    ownedChildren.map(
      (c) =>
        new Promise((res) => {
          if (c.exitCode !== null || c.signalCode !== null) return res();
          c.once("close", res);
        }),
    ),
  );
  for (const root of ownedTempRoots) fs.rmSync(root, { recursive: true, force: true });
});

// ── Apparatus ─────────────────────────────────────────────────────────

describe("entrypoint guard fixture", () => {
  it("serves both entry views from one inode, so only the path differs", () => {
    for (const segKey of Object.keys(SEGMENTS)) {
      const fx = fixtures[segKey];
      expect(fs.lstatSync(path.join(fx.root, "linkroot")).isSymbolicLink()).toBe(true);
      expect(sha256(fx.realEntry)).toBe(sha256(fx.linkEntry));
      expect(fs.statSync(fx.realEntry).ino).toBe(fs.statSync(fx.linkEntry).ino);
    }
  });

  it("runs the checked-out index.js unmodified", () => {
    for (const segKey of Object.keys(SEGMENTS)) {
      expect(sha256(fixtures[segKey].realEntry)).toBe(sha256(path.join(REPO, "index.js")));
    }
  });

  it("enters through a genuine realpath, so the real-entry case is a clean control", () => {
    for (const segKey of Object.keys(SEGMENTS)) {
      expect(fs.realpathSync(fixtures[segKey].realDir)).toBe(fixtures[segKey].realDir);
    }
  });

  it("copies the package's declared payload and links the installed graph", () => {
    for (const segKey of Object.keys(SEGMENTS)) {
      const fx = fixtures[segKey];
      expect(fx.copied).toContain("index.js");
      expect(fx.copied).toContain("package.json");
      expect(fx.copied).toContain("lib");
      expect(fs.existsSync(path.join(fx.realDir, "node_modules"))).toBe(true);
    }
  });
});

// ── The regression itself ─────────────────────────────────────────────

for (const segKey of Object.keys(SEGMENTS)) {
  for (const [flagName, flagArgs] of Object.entries(FLAGS)) {
    describe(`stdio server starts | ${segKey} path | ${flagName}`, () => {
      for (const entryKind of ["real", "symlinked"]) {
        it(`${entryKind} entry answers initialize`, async () => {
          const fx = fixtures[segKey];
          const entry = entryKind === "real" ? fx.realEntry : fx.linkEntry;
          const cwd = entryKind === "real" ? fx.realDir : fx.linkDir;

          const r = await runChild({
            label: `${segKey}--${entryKind}--${flagName}`,
            fx,
            cwd,
            nodeArgs: [...flagArgs, entry],
          });

          expect(r.handleError).toBeNull();
          expect(r.settledBy).toBe("child-closed");
          expect(r.signal).toBeNull();
          expect(r.stderr).toBe("");
          expect(r.exit).toBe(0);
          expect(r.answered).toBe(true);
        });
      }
    });
  }
}

const NEGATIVES = [
  ["imported as a library", "driver-import-library.mjs"],
  ["a different real entry", "driver-distinct-real-entry.mjs"],
  ["no argv[1]", "driver-missing-argv.mjs"],
  ["an empty argv[1]", "driver-empty-argv.mjs"],
  ["an unresolvable argv[1]", "driver-unresolvable-argv.mjs"],
];

describe("stdio server stays silent", () => {
  for (const [what, driver] of NEGATIVES) {
    it(`with ${what}: no server, and import still succeeds`, async () => {
      const fx = fixtures.ascii;
      const r = await runChild({
        label: `negative--${driver}`,
        fx,
        cwd: fx.realDir,
        nodeArgs: [path.join(fx.realDir, driver)],
      });

      expect(r.handleError).toBeNull();
      expect(r.settledBy).toBe("child-closed");
      expect(r.signal).toBeNull();
      expect(r.stderr).toBe("");
      expect(r.exit).toBe(0);
      expect(r.importOk).toBe(true);
      expect(r.answered).toBe(false);
    });
  }
});
