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
//     letters, UNC) is NOT measured here and must not be claimed. The
//     encoding comparison below is now win32-CORRECT (see
//     `nativeUrlPathnameOf`) so the control case is meaningful there too, but
//     that is a comparison fix, not a measurement of win32 URL conversion.
//   * This module derives its own paths with fileURLToPath, never with
//     `new URL(...).pathname` — otherwise the fixture would carry the very
//     defect the suite is measuring and could not tell the two apart.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { joinOwnedChild } from "./cli-discovery-fixture.js";
import {
  copyFixtureEntry,
  FixtureCopyError,
  FIXTURE_COPY_REASONS,
} from "./portable-fixture-copy.js";

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

// ── Bounded diagnostics (DIAGNOSTIC ONLY) ─────────────────────
//
// Every diagnostic this module emits is a CLOSED SET: the literal tokens
// written out below, plus integer counts. A diagnostic string is printed to
// stdout on assertion failure, so it is an egress path, and arbitrary child
// stderr / handle-error / fs-error text can carry a provider key, a token or an
// absolute profile path. Those fields are therefore reduced to a count or to an
// allowlist member, with every unrecognised value collapsing to `other` — by
// CONSTRUCTION, not by redaction of free-form text, which no secret-shaped or
// path-shaped rule can do reliably. Mirrors the `diagEnum`/`diagInt` shape in
// `deliberation-e2e.test.js`.
const DIAG_CASE_KEY_ENUM = Object.freeze(ENCODED_PATH_CASES.map((c) => c.key));
const DIAG_SETTLED_BY_ENUM = Object.freeze([
  "response", "result", "child-closed", "timeout",
]);
const DIAG_SIGNAL_ENUM = Object.freeze([
  "SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGPIPE", "SIGABRT", "SIGSEGV",
]);
const DIAG_FS_ERROR_ENUM = Object.freeze([
  "ENOENT", "EACCES", "EPERM", "EEXIST", "EISDIR", "ENOTDIR", "EBUSY",
  "ENOSPC", "ENAMETOOLONG", "EINVAL", "ELOOP",
]);
// The leaves an install MUST contain — the exact three the suite's own
// precondition already asserts (encoded-install-path.test.js:104-106). They are
// literals written out here, and each is reported by this name and no other, so
// nothing derived from the owned (host-shaped) root can travel out with them.
const DIAG_REQUIRED_LEAVES = Object.freeze([
  "lib/speaker-discovery.js",
  "selectors/roles/critic.md",
  "selectors/role-presets.json",
]);
// Closed by construction: the five shapes an entry can have, plus one
// `error(<errno>)` token per allowlisted errno. An errno outside the allowlist
// is already collapsed to `error(other)` before it reaches this list.
const DIAG_ENTRY_TYPE_ENUM = Object.freeze([
  "absent", "file", "dir", "link", "other",
  ...DIAG_FS_ERROR_ENUM.map((code) => `error(${code})`),
  "error(other)", "error(none)",
]);

/** A member of `allowed`, else `none` / `other`. Never the raw value. */
function diagEnum(value, allowed) {
  if (value === null || value === undefined || value === "") return "none";
  return allowed.includes(value) ? value : "other";
}

/** An integer, else `none` (absent) / `other`. Never a free-form field. */
function diagInt(value) {
  if (value === null || value === undefined) return "none";
  return Number.isInteger(value) ? String(value) : "other";
}

/** A boolean, else `other`. */
function diagBool(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "other";
}

/**
 * What sits at `p`, as ONE member of `DIAG_ENTRY_TYPE_ENUM`, or
 * `error(<errno>)`. A single `lstat`: read-only, no `readdir`, no read of any
 * content, no path in the result. `lstat` rather than `stat` so a broken link
 * reads as `link` instead of `absent`.
 */
function diagEntryType(p) {
  let stats;
  try {
    stats = fs.lstatSync(p);
  } catch (err) {
    if (err && err.code === "ENOENT") return "absent";
    return `error(${diagEnum(err && err.code, DIAG_FS_ERROR_ENUM)})`;
  }
  if (stats.isSymbolicLink()) return "link";
  if (stats.isDirectory()) return "dir";
  if (stats.isFile()) return "file";
  return "other";
}

/**
 * Types of the required leaves under payload entry `name`, on BOTH sides of the
 * copy — so a later run can tell a leaf missing at the SOURCE from one that the
 * copy failed to land at the TARGET. Read-only; observes only the literal leaf
 * names above, never the directories they sit in.
 */
function diagLeafTypes(repoRoot, root, name) {
  return DIAG_REQUIRED_LEAVES
    .filter((leaf) => leaf.split("/")[0] === name)
    .map((leaf) => ({
      leaf,
      src: diagEntryType(path.join(repoRoot, ...leaf.split("/"))),
      dst: diagEntryType(path.join(root, ...leaf.split("/"))),
    }));
}

/** The percent-encoded form a file URL hands back for `p` via `.pathname`. */
export function encodedPathnameOf(p) {
  return new URL(pathToFileURL(p).href).pathname;
}

/**
 * `encodedPathnameOf(p)` re-spelled in this platform's native path syntax, so
 * a comparison against `p` measures PERCENT-ENCODING ONLY.
 *
 * On POSIX the two forms already coincide and this is the identity. On win32 a
 * file URL pathname is `/C:/dir/file` — leading slash, forward slashes, drive
 * letter — so the raw pathname can never equal `C:\dir\file` and the control
 * case below reported "needs encoding" for a plain-ASCII path. Undoing the
 * URL's own separator and root conventions (and NOTHING else) leaves the
 * encoding question intact: percent escapes are not touched here, so every
 * encoded case still compares unequal on win32.
 */
export function nativeUrlPathnameOf(p) {
  const pathname = encodedPathnameOf(p);
  if (process.platform !== "win32") return pathname;
  return pathname.replace(/^\//, "").replace(/\//g, path.sep);
}

/** True when `p` survives a file URL round trip through `.pathname` unchanged. */
export function needsNoEncoding(p) {
  return nativeUrlPathnameOf(p) === p;
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
  const payload = readInstallPayload(repoRoot);
  for (const [index, name] of payload.entries()) {
    // DIAGNOSTIC ONLY. On Windows 22 the copy did not fully land for non-ASCII
    // segment names (`lib/speaker-discovery.js` was missing from the install)
    // and the precondition assertion surfaced it one step late, with no cause.
    // This locates the failing copy — which payload entry, and the errno — at
    // the moment it happens.
    //
    // It deliberately does NOT normalise, re-encode or retry the path: whether
    // that is a Node 22 win32 fs.cpSync behaviour change, a runner codepage
    // effect or a swallowed error is UNRESOLVED, and a speculative
    // normalisation here would weaken the very adversarial case under test.
    //
    // The copy is `copyFixtureEntry` (`portable-fixture-copy.js`), not
    // `fs.cpSync(..., {recursive:true})`: a per-file walk that verifies what
    // landed, so the fixture does not depend on the recursive builtin. It
    // normalises, re-encodes and retries nothing, and refuses rather than
    // repairs, so the observations below and the suite's precondition assertion
    // still report exactly what they did. Each destination path here is fresh,
    // which is what that helper requires. Whether `fs.cpSync` itself is sound
    // remains UNRESOLVED and is measured only by `native-unicode-copy.test.js`.
    //
    // Bounded like every other diagnostic here: `name` is reported only as a
    // member of the payload list computed just above, the position is a count,
    // and the errno is an allowlist member. The segment basename is NOT
    // reported (it is part of the owned absolute root, i.e. host data), and
    // neither `err.message` nor `{ cause: err }` is attached, because a copy
    // error embeds the absolute source and destination paths verbatim.
    //
    // The win22 non-ASCII case is the OTHER failure mode: `cpSync` RETURNED,
    // so the guard below never fired, yet `lib/speaker-discovery.js` was not in
    // the install. The observations bracketing the call record that directly —
    // the type of each required leaf on the source and on the target, taken
    // immediately before and immediately after this one copy. They only read
    // (`lstat`); they do not re-copy, normalise, retry, extend a deadline or
    // suppress anything, so the existing precondition assertion still fails on
    // exactly the same case, at exactly the same place.
    const leavesBefore = diagLeafTypes(repoRoot, root, name);
    try {
      copyFixtureEntry(path.join(repoRoot, name), path.join(root, name));
    } catch (err) {
      // Two failure shapes, both reported as closed tokens: an fs errno (the
      // helper rethrows fs errors unchanged, so `code` survives) or one of the
      // helper's own contract refusals. Neither `err.message` nor the error
      // itself is attached, because a copy error embeds absolute paths.
      throw new Error(
        "encoded-install fixture failed to materialise an install payload entry "
        + `(entry=${diagEnum(name, payload)} `
        + `index=${diagInt(index)}/${diagInt(payload.length)} `
        + `code=${diagEnum(err && err.code, DIAG_FS_ERROR_ENUM)} `
        + `reason=${diagEnum(
          err instanceof FixtureCopyError ? err.reason : null,
          FIXTURE_COPY_REASONS
        )})`
      );
    }
    const leavesAfter = diagLeafTypes(repoRoot, root, name);
    // Reported only when a required leaf is NOT a file at the target after its
    // own copy returned — i.e. only on the defect. A green run stays silent,
    // and the line carries closed-set tokens and counts only: the payload entry
    // resolved against the payload list, its position, the literal leaf name,
    // and four entry types. No directory listing, no path, no file content.
    for (const [position, after] of leavesAfter.entries()) {
      if (after.dst === "file") continue;
      const before = leavesBefore[position] || { src: "none", dst: "none" };
      console.error(
        "encoded-install fixture payload observation "
        + `(entry=${diagEnum(name, payload)} `
        + `index=${diagInt(index)}/${diagInt(payload.length)} `
        + `leaf=${diagEnum(after.leaf, DIAG_REQUIRED_LEAVES)} `
        + `src_before=${diagEnum(before.src, DIAG_ENTRY_TYPE_ENUM)} `
        + `dst_before=${diagEnum(before.dst, DIAG_ENTRY_TYPE_ENUM)} `
        + `src_after=${diagEnum(after.src, DIAG_ENTRY_TYPE_ENUM)} `
        + `dst_after=${diagEnum(after.dst, DIAG_ENTRY_TYPE_ENUM)})`
      );
    }
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

/**
 * Compact, greppable one-liner for TAP-style evidence and failure messages.
 *
 * Closed enums and counts ONLY (see the bounded-diagnostics block above). The
 * two free-form fields this used to interpolate are the reason:
 *   * `stderr` was emitted as a 400-char slice of arbitrary child output,
 *   * `handleError` was emitted as an arbitrary Error message.
 * Both are reduced here — stderr to its byte/line counts, the handle error to
 * its presence — so no child text can travel out through an assertion message.
 * `key` is a caller-supplied string and is likewise resolved against the case
 * list rather than echoed. The useful fields are unchanged in name and meaning:
 * `case`, `answered`, `settledBy`, `elapsedMs`, `exit` and `signal` still read
 * exactly as before for every recognised value.
 */
export function describeOutcome(key, outcome) {
  const o = outcome || {};
  const stderrText = String(o.stderr === null || o.stderr === undefined ? "" : o.stderr);
  return [
    "case=" + diagEnum(key, DIAG_CASE_KEY_ENUM),
    "answered=" + diagBool(o.answered),
    "settledBy=" + diagEnum(o.settledBy, DIAG_SETTLED_BY_ENUM),
    "elapsedMs=" + diagInt(o.elapsedMs),
    "timeoutMs=" + diagInt(o.timeoutMs),
    "exit=" + diagInt(o.exitCode),
    "signal=" + diagEnum(o.signalCode, DIAG_SIGNAL_ENUM),
    "handleError=" + (o.handleError ? "present" : "none"),
    "stderrBytes=" + stderrText.length,
    "stderrLines=" + (stderrText ? stderrText.split("\n").length : 0),
  ].join(" ");
}
