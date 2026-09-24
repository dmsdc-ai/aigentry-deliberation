// dr1172as — bounded, test-only fixture support for the encoded install path
// suite (`encoded-install-path.test.js`).
//
// WHY THIS EXISTS
// ---------------
// The product is normally exercised from the checkout it lives in, whose path
// happens to need no percent-encoding. Nothing in the existing suite ever puts
// an install under a directory containing a space, a non-ASCII character, a
// literal percent sign or a hash. This module materialises exactly that: real,
// unmodified product files laid out as an install under a controlled directory
// name, so the suite can drive the real server over real MCP stdio from there.
//
// WHAT IS REAL vs SYNTHETIC
// -------------------------
// Real: every product file (copied byte for byte from the repo root, never
// edited), the dependency graph (reached through a symlink, never copied and
// never written), the MCP stdio handshake, the exported resolver API.
// Synthetic: only the directory NAME the install sits under, and the owned
// HOME / TMPDIR / stub PATH the child runs with.
//
// DECLARED LIMITS
// ---------------
//   * POSIX only. The win32 behaviour of file URL to path conversion (drive
//     letters, UNC) is NOT measured here and must not be claimed.
//   * This module derives its own paths with fileURLToPath, never with
//     `new URL(...).pathname` — otherwise the fixture would carry the very
//     defect the suite is measuring and could not tell the two apart.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { joinOwnedChild } from "./cli-discovery-fixture.js";

export const HELPER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HELPER_DIR, "..", "..");

// Short on purpose: a broken install answers nothing, so every encoded case
// would otherwise pay the full wait. 4s is comfortably above the measured
// ordinary handshake (~0.15s) and keeps the whole suite inside 2 minutes.
export const HANDSHAKE_TIMEOUT_MS = 4000;
export const MCP_PROTOCOL_VERSION = "2024-11-05";

// One case per character class that a file URL must percent-encode, plus a
// combined case and the ordinary control. `needle` is the escape the encoded
// form MUST contain; the suite asserts it so a case cannot silently stop
// exercising encoding if someone renames a segment.
export const ENCODED_PATH_CASES = Object.freeze([
  { key: "ordinary", segment: "plain-ascii-install", needle: null, control: true },
  { key: "spaces", segment: "install dir with spaces", needle: "%20", control: false },
  { key: "non-ascii", segment: "설치경로-한글", needle: "%ED%95%9C", control: false },
  { key: "literal-percent", segment: "install-100%-done", needle: "%25", control: false },
  { key: "hash", segment: "install#1-hash", needle: "%23", control: false },
  { key: "combined", segment: "en coded 한글 100%tested #1", needle: "%20", control: false },
]);

export const ENCODED_CASES = ENCODED_PATH_CASES.filter((c) => !c.control);
export const ORDINARY_CASE = ENCODED_PATH_CASES.find((c) => c.control);

/** The percent-encoded form a file URL hands back for `p` via `.pathname`. */
export function encodedPathnameOf(p) {
  return new URL(pathToFileURL(p).href).pathname;
}

/** True when `p` survives a file URL round trip through `.pathname` unchanged. */
export function needsNoEncoding(p) {
  return encodedPathnameOf(p) === p;
}

/**
 * Top-level entries an install actually receives, read from the product
 * package.json `files` list so the fixture tracks the product rather than a
 * hand-maintained copy of it. Entries that do not exist are skipped.
 */
export function readInstallPayload(repoRoot = REPO_ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
  const entries = new Set(["package.json"]);
  for (const raw of pkg.files || []) {
    const top = String(raw).split("/")[0];
    if (top) entries.add(top);
  }
  return [...entries].filter((name) => fs.existsSync(path.join(repoRoot, name)));
}

/**
 * The dependency graph this checkout resolves against. It is REACHED, never
 * copied and never written: the fixture install links to the real graph so the
 * server under test loads the very same SDK the checkout does.
 */
export function resolveDependencyGraph(repoRoot = REPO_ROOT) {
  const nodeModules = path.join(repoRoot, "node_modules");
  if (!fs.existsSync(nodeModules)) return null;
  return fs.realpathSync(nodeModules);
}

/**
 * Lay the real product files out as an install under `root`.
 * @returns {{root: string, entry: string, graph: string}}
 */
export function materializeInstall({ root, repoRoot = REPO_ROOT } = {}) {
  if (!root) throw new Error("materializeInstall requires an owned root");
  const graph = resolveDependencyGraph(repoRoot);
  if (!graph) {
    throw new Error("encoded-install fixture needs a resolvable node_modules under " + repoRoot);
  }
  fs.mkdirSync(root, { recursive: true });
  for (const name of readInstallPayload(repoRoot)) {
    fs.cpSync(path.join(repoRoot, name), path.join(root, name), { recursive: true });
  }
  fs.symlinkSync(graph, path.join(root, "node_modules"));
  return { root, entry: path.join(root, "index.js"), graph };
}

function findResponse(buffer, id) {
  for (const line of buffer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.id === id) return parsed;
    } catch {
      // non-JSON line (banner, log) — ignore
    }
  }
  return null;
}

/**
 * Drive a REAL MCP `initialize` over REAL stdio against an owned child, and
 * report what was OBSERVED. Nothing is mocked: the child is the product entry
 * point, the bytes on the wire are JSON-RPC.
 *
 * Bounding is threefold so a broken install can never hang the suite:
 *   1. a poll that settles the moment the response line appears,
 *   2. a `close` listener that settles as soon as the child is gone (a server
 *      that never started its transport exits immediately, so this is the fast
 *      path for the failing cases — and a POSITIVE fact, not a timeout),
 *   3. a hard `timeoutMs` deadline.
 * The owned handle is ALWAYS joined in `finally`, by handle, never by scanning
 * or signalling anything the fixture did not spawn.
 */
export async function initializeOverStdio({
  entry,
  cwd,
  env,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  clientName = "dr1172as-encoded-install",
} = {}) {
  if (!entry) throw new Error("initializeOverStdio requires a server entry");
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let handleError = null;
  const startedAt = Date.now();

  try {
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => { handleError = handleError || err; });
    child.stdin.on("error", (err) => { handleError = handleError || err; });

    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0.0" },
      },
    };
    try {
      child.stdin.write(JSON.stringify(request) + "\n");
    } catch (err) {
      handleError = handleError || err;
    }

    const outcome = await new Promise((resolve) => {
      let settled = false;
      let poll = null;
      let deadline = null;
      const settle = (reason) => {
        if (settled) return;
        settled = true;
        if (poll !== null) clearInterval(poll);
        if (deadline !== null) clearTimeout(deadline);
        child.removeListener("close", onClose);
        const response = findResponse(stdout, 1);
        resolve({ answered: response !== null, response, settledBy: reason });
      };
      function onClose() { settle("child-closed"); }
      poll = setInterval(() => {
        if (findResponse(stdout, 1) !== null) settle("response");
      }, 20);
      deadline = setTimeout(() => settle("timeout"), timeoutMs);
      child.once("close", onClose);
    });

    return {
      ...outcome,
      elapsedMs: Date.now() - startedAt,
      timeoutMs,
      stdout,
      stderr,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      handleError: handleError ? handleError.message : null,
    };
  } finally {
    await joinOwnedChild(child, { timeoutMs: 2000, deadlineMs: 5000 });
  }
}

// Name of the probe module the fixture drops INSIDE an install to read that
// installs own exported API. It imports "./index.js" RELATIVELY, so no file
// URL is ever handed to a module loader on the command line — the resolution
// under test is the products own, not the runners.
export const RESOLVER_PROBE_NAME = "dr1172as-resolver-probe.mjs";
const RESOLVER_MARKER = "DR1172AS_RESOLVER ";

const RESOLVER_PROBE_SOURCE = [
  "// dr1172as test-only probe: reads bundled-asset resolution through the",
  "// exported product API of the install it sits in. Spawns nothing, contacts",
  "// nothing, writes nothing.",
  "import { loadRolePrompt, loadRolePresets } from \"./index.js\";",
  "const presets = loadRolePresets();",
  "const payload = {",
  "  rolePrompt: loadRolePrompt(\"critic\"),",
  "  presetNames: Object.keys((presets && presets.presets) || {}).sort(),",
  "};",
  "process.stdout.write(" + JSON.stringify(RESOLVER_MARKER) + " + JSON.stringify(payload) + \"\\n\");",
].join("\n") + "\n";

/**
 * Read `loadRolePrompt` / `loadRolePresets` from an install, in a CHILD process
 * that runs with that installs owned HOME / TMPDIR / stub PATH.
 *
 * A child rather than an in-process `import()` on purpose:
 *   * the module graph is rooted exactly where a real install roots it,
 *   * the owned environment really applies (an in-process import would read the
 *     runners HOME),
 *   * the test runners own loader is out of the path, so a runner quirk cannot
 *     be mistaken for a product defect.
 */
export async function resolveBundledAssets({
  root,
  env,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
} = {}) {
  if (!root) throw new Error("resolveBundledAssets requires an install root");
  const probe = path.join(root, RESOLVER_PROBE_NAME);
  fs.writeFileSync(probe, RESOLVER_PROBE_SOURCE);

  const child = spawn(process.execPath, [probe], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let handleError = null;
  const startedAt = Date.now();

  try {
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => { handleError = handleError || err; });

    const outcome = await new Promise((resolve) => {
      let settled = false;
      let poll = null;
      let deadline = null;
      const read = () => {
        for (const line of stdout.split("\n")) {
          if (!line.startsWith(RESOLVER_MARKER)) continue;
          try { return JSON.parse(line.slice(RESOLVER_MARKER.length)); } catch { return null; }
        }
        return null;
      };
      const settle = (reason) => {
        if (settled) return;
        settled = true;
        if (poll !== null) clearInterval(poll);
        if (deadline !== null) clearTimeout(deadline);
        child.removeListener("close", onClose);
        const payload = read();
        resolve({ ok: payload !== null, payload, settledBy: reason });
      };
      function onClose() { settle("child-closed"); }
      poll = setInterval(() => { if (read() !== null) settle("result"); }, 20);
      deadline = setTimeout(() => settle("timeout"), timeoutMs);
      child.once("close", onClose);
    });

    return {
      ...outcome,
      elapsedMs: Date.now() - startedAt,
      timeoutMs,
      stdout,
      stderr,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      handleError: handleError ? handleError.message : null,
    };
  } finally {
    await joinOwnedChild(child, { timeoutMs: 2000, deadlineMs: 5000 });
  }
}

/** Compact, greppable one-liner for TAP-style evidence and failure messages. */
export function describeOutcome(key, outcome) {
  return [
    "case=" + key,
    "answered=" + outcome.answered,
    "settledBy=" + outcome.settledBy,
    "elapsedMs=" + outcome.elapsedMs,
    "exit=" + outcome.exitCode,
    "signal=" + outcome.signalCode,
    "handleError=" + outcome.handleError,
    "stderr=" + JSON.stringify(String(outcome.stderr).slice(0, 400)),
  ].join(" ");
}
