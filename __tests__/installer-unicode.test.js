// ic1172cx — task #1172: the REAL installer copy caller must land a byte-exact
// payload under non-ASCII source AND destination paths.
//
// WHAT THIS MEASURES
// ------------------
// `install.js` copies its payload with its OWN caller, not with `fs.cpSync`:
//
//   * `copyFileIfExists` -> `fs.copyFileSync`   (install.js:72-78)  for FILES_TO_COPY
//   * `copyDirRecursive` -> `fs.mkdirSync` + `fs.readdirSync` + `fs.copyFileSync`
//     (install.js:80-92), driven at install.js:110-116               for DIRS_TO_COPY
//
// That caller has never been executed by any test, on any platform or Node
// version. This file executes it — the actual, unmodified `install.js`, in a
// bounded owned Node child, against a real filesystem — and asserts that every
// FILES_TO_COPY entry and the complete recursive DIRS_TO_COPY payload land under
// `INSTALL_DIR` with BYTE-EXACT content and EXACTLY PRESERVED names, including
// nested non-ASCII directory and file names and non-UTF-8 binary file bodies.
//
// WHAT THIS DOES NOT MEASURE, AND MUST NOT BE READ AS
// ---------------------------------------------------
//   * It says NOTHING about `fs.cpSync`. The upstream `native-unicode-copy`
//     diagnostic remains the only measurement of that, it is unchanged by this
//     file, and it stays red and stays blocking until a separately reviewed gate
//     decision says otherwise. Nothing here may be cited to reclassify it.
//   * It is NOT evidence of a packaged, published or natively-CI-accepted
//     release. It is one test file run by one runner. Independent execution,
//     native 3-OS CI, security review and installed-release evidence are all
//     still owed and are NOT supplied here.
//   * It does NOT install dependencies, register an MCP server with any host,
//     log in, contact a registry, or run any external program. Those boundaries
//     are stubbed at a single audited seam (see THE SEAM below), and the
//     distinction between "real installer code + real filesystem" and "stubbed
//     dependency install / provider registration" is asserted explicitly rather
//     than left to be assumed.
//
// WHAT IS REAL vs SYNTHETIC
// -------------------------
// REAL: `install.js` itself, byte for byte (its sha256 is asserted identical to
// the release copy both before and after the run), its `copyFileSync` /
// `copyDirRecursive` walk, `INSTALL_DIR` derivation from the environment, the
// filesystem, and a real Node child process.
//
// SYNTHETIC: the payload BODIES and nested names under the owned source root,
// the directory NAMES the source and the destination sit under, the isolated
// HOME / USERPROFILE / LOCALAPPDATA / APPDATA / XDG / TMP the child runs with,
// and the four external commands, which are intercepted, never executed.
//
// `install.js` resolves its payload source from `__dirname`, so exercising it
// against a non-ASCII SOURCE path requires the file to sit in a non-ASCII
// directory. It is therefore placed in an owned root by a byte-identical
// `readFileSync` + `writeFileSync` (never `copyFileSync`, which is the primitive
// under test — the fixture must not depend on it), and the copy's sha256 is
// verified equal to the release file before the child runs. No regex rewrite, no
// re-spelling, no patch: the bytes are identical or the test fails.
//
// THE SEAM (narrow, audited, and verified to have been exercised)
// --------------------------------------------------------------
// `install.js` reaches outside the process through exactly one import:
// `import { execSync } from "node:child_process"` (install.js:19). A bootstrap
// module replaces `execSync` on the builtin and calls `syncBuiltinESMExports()`
// BEFORE dynamically importing the untouched installer, so the installer's own
// binding resolves to the interceptor.
//
//   * The seam's completeness is audited by asserting, against the release
//     source text, that `node:child_process` is imported exactly once and binds
//     `execSync` and nothing else. That is a SEAM AUDIT. It is not, and is never
//     used as, the copy assertion — the copy is asserted from bytes on disk.
//   * The interceptor holds an EXACT allowlist of four command strings. The
//     `claude mcp add` entry embeds the exact expected server entry point, so a
//     mangled non-ASCII `INSTALL_DIR` is rejected rather than accepted.
//   * Every unknown command is REJECTED (it throws) and recorded. The test
//     asserts the rejected list is empty and that all four allowlisted commands
//     were actually reached, so a seam that silently stopped intercepting fails.
//   * `fs` is NEVER mocked, stubbed, spied or replaced — not here and not in the
//     child. The copy under test is the real one writing real bytes.
//
// If this seam could not be made safe the correct outcome would be a HOLD, never
// a real `npm install`, a real `claude mcp add` or a real login. It is safe here
// because the entire external surface is one statically-imported function.
//
// "ASCII CONTROL" — DECLARED READING
// ----------------------------------
// The specification asks for "ASCII control and non-ASCII source and
// destination". This file reads "ASCII control" as the ASCII CONTROL CASE — a
// plain-ASCII baseline arm (`ordinary`) carried alongside the non-ASCII arms so
// that a failure can be attributed to the non-ASCII segment rather than to the
// installer, the harness or the filesystem. It is NOT read as "filenames
// containing ASCII control characters (U+0001-U+001F)": those are outright
// illegal in win32 filenames, so that arm could not run on the very platform
// (Windows / Node 22) this regression concerns, and requesting it alongside
// "preserve exact names" and a Windows portability goal would be incoherent.
// The reading is stated here, and in the task REPORT, rather than chosen
// silently.
//
// DELIBERATE NON-BEHAVIOURS
// -------------------------
//   * No platform arm and no Node version is skipped. There is no
//     `it.skipIf`, no `process.platform` branch that drops an assertion, and no
//     early return: on a platform where the defect is live this FAILS.
//   * No path is normalised, re-encoded or re-spelled — not by `path.normalize`,
//     not by `String.prototype.normalize`. The segment literals are duplicated
//     byte for byte from the sibling suites' `ENCODED_PATH_CASES` so that a pass
//     here and a failure there cannot be explained by a different string.
//   * Nothing is retried, repaired or re-copied. A failed arm stays failed.
//   * The negative controls are real: a comparator that cannot fail proves
//     nothing, so the comparator is itself exercised against a MISSING, a
//     PARTIAL (truncated) and a CORRUPT (single flipped byte) tree in a separate
//     owned scratch directory, and each must be reported unequal. Those trees
//     are never read by, merged into or substituted for the real destination.
//   * Cleanup is bound to the owned child HANDLE and to owned directories only:
//     no process scan, no process-group kill, no unowned PID, no `rm` outside a
//     root this file created and can prove it owns by prefix.
//
// BOUNDED OUTPUT
// --------------
// The installer prints its absolute `INSTALL_DIR` to stdout, so child output is
// captured with a hard byte cap and NEVER echoed. Everything that can reach an
// assertion message is a closed set: a case key, an arm name, a payload-relative
// path resolved against the literal list of entries this file authored, an entry
// type, an integer byte count, an allowlisted errno, a fixed-width hex digest of
// content this file authored, and a command label from a four-member enum. No
// absolute path, no host directory listing, no child output text and no file
// body ever reaches an assertion message.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
// `pathToFileURL` is used by the child bootstrap, not here; see BOOTSTRAP_SOURCE.
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";

// ── Locating the release under test ──────────────────────────────────────────
//
// The release root is the directory holding `install.js`. Normally that is the
// parent of a `__tests__/` directory, which is how every sibling suite resolves
// it (`encoded-install-fixture.js:43`). `IC1172CX_RELEASE_ROOT` is an EXPLICIT
// opt-in override for a runner that stages this file outside the release tree.
//
// `fileURLToPath`, never `new URL(...).pathname`: a file URL percent-encodes
// every character that is not URL-path-safe, so `.pathname` hands back `%20` and
// UTF-8 escapes for exactly the segments this suite exists to exercise. Nothing
// here reads, expands or probes HOME to locate anything; the host `HOME` is not
// consulted at any point, and no `~` is expanded.
const RELEASE_ROOT = process.env.IC1172CX_RELEASE_ROOT
  ? path.resolve(process.env.IC1172CX_RELEASE_ROOT)
  : path.resolve(TEST_DIR, "..");
const RELEASE_INSTALL_JS = path.join(RELEASE_ROOT, "install.js");

// ── Destination / source cases ───────────────────────────────────────────────
//
// Duplicated byte for byte from `ENCODED_PATH_CASES`
// (`__tests__/helpers/encoded-install-fixture.js:55-62`) and from
// `native-unicode-copy.test.js:80-87`. This file is self-contained on purpose:
// importing a helper would drag a spawned MCP child and a `node_modules`
// requirement onto its import path, and the point here is the installer alone.
//
// `ordinary` is the ASCII control arm (see "ASCII CONTROL" above). Every other
// arm carries at least one character that a file URL must percent-encode; two
// (`non-ascii`, `combined`) carry non-ASCII characters, which is the shape the
// win32 Node 22 regression was observed under.
const CASES = Object.freeze([
  { key: "ordinary", segment: "plain-ascii-install", nonAscii: false },
  { key: "spaces", segment: "install dir with spaces", nonAscii: false },
  { key: "non-ascii", segment: "설치경로-한글", nonAscii: true },
  { key: "literal-percent", segment: "install-100%-done", nonAscii: false },
  { key: "hash", segment: "install#1-hash", nonAscii: false },
  { key: "combined", segment: "en coded 한글 100%tested #1", nonAscii: true },
]);
const CASE_KEY_ENUM = Object.freeze(CASES.map((c) => c.key));

// ── The product's own copy lists ─────────────────────────────────────────────
//
// Duplicated from `install.js:42-57`. They are ASSERTED equal to the release
// source below ("tracks the product's own copy lists"), so this file cannot
// drift into testing a payload the installer no longer copies.
const FILES_TO_COPY = Object.freeze([
  "index.js",
  "logger-emit.js",
  "clipboard.js",
  "i18n.js",
  "browser-control-port.js",
  "degradation-state-machine.js",
  "model-router.js",
  "doctor.js",
  "session-monitor.sh",
  "session-monitor-win.js",
  "package.json",
  "package-lock.json",
]);
const DIRS_TO_COPY = Object.freeze(["selectors", "skills", "lib"]);

// The skill source `install.js:32` reads and `install.js:258` copies into the
// isolated HOME. It is a third real `copyFileSync` caller at the same boundary,
// so it is asserted too.
const SKILL_REL = Object.freeze(["skills", "deliberation-gate", "SKILL.md"]);

// ── The owned synthetic payload ──────────────────────────────────────────────
//
// Bodies are this file's own invention. Three of them are BINARY: they contain
// every byte value 0x00-0xFF, including NUL and standalone 0x80-0xBF
// continuation bytes that are not valid UTF-8. A copy that round-trips content
// through a string decoder cannot reproduce them, so "byte-exact" here means
// byte-exact and not "renders the same".
//
// `package.json` must be real JSON with `"type": "module"` — `install.js` is ESM
// and the installer itself reads `version` from it (`install.js:268`).

/** Every byte value, twice, with a NUL-heavy tail. Not valid UTF-8. */
function binaryBody(salt) {
  const ramp = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const tail = Buffer.alloc(16, 0x00);
  const mark = Buffer.from([0xef, 0xbb, 0xbf, 0x80, 0x81, 0xfe, 0xff, salt & 0xff]);
  return Buffer.concat([ramp, mark, ramp, tail]);
}

/** UTF-8 text body carrying non-ASCII content as well as a non-ASCII name. */
function textBody(label) {
  return Buffer.from(
    "// ic1172cx owned fixture — " + label + "\n" +
      "export const LABEL = \"" + label + "\";\n" +
      "// 한글 본문 100% #1 — content encoding must survive unchanged.\n",
    "utf-8"
  );
}

const OWNED_PACKAGE_JSON = Buffer.from(
  JSON.stringify(
    {
      name: "@dmsdc-ai/aigentry-deliberation",
      version: "0.0.0-ic1172cx-fixture",
      type: "module",
      private: true,
    },
    null,
    2
  ) + "\n",
  "utf-8"
);

/**
 * The flat payload, one entry per FILES_TO_COPY name and in that order, so the
 * installer's own `copied` counter is predictable. `session-monitor-win.js` is
 * BINARY: the flat `copyFileSync` arm must carry raw bytes too, not only text.
 */
const OWNED_FLAT_FILES = Object.freeze(
  FILES_TO_COPY.map((name) => {
    if (name === "package.json") return { name, body: OWNED_PACKAGE_JSON };
    if (name === "package-lock.json") {
      return {
        name,
        body: Buffer.from(
          JSON.stringify({ name: "ic1172cx-fixture", lockfileVersion: 3, packages: {} }, null, 2) + "\n",
          "utf-8"
        ),
      };
    }
    if (name === "session-monitor-win.js") return { name, body: binaryBody(0x11) };
    return { name, body: textBody(name) };
  })
);

/**
 * The nested payload, under the three DIRS_TO_COPY roots. Every character class
 * the cases cover appears in a NESTED name as well as in the enclosing root
 * segment: Korean directory and file names, a space, a literal percent and a
 * hash. Two leaves are binary.
 *
 * `rel` is always written with forward slashes and split on "/" at use, so the
 * literals stay readable and platform-correct without any path rewriting.
 */
const OWNED_NESTED_FILES = Object.freeze([
  { rel: "selectors/role-presets.json", body: Buffer.from('{\n  "presets": {\n    "critic": ["critic"]\n  }\n}\n', "utf-8") },
  { rel: "selectors/역할/평론가.md", body: textBody("selectors/역할/평론가.md") },
  { rel: "selectors/역할/nested 100% #1/깊은 파일.bin", body: binaryBody(0x22) },
  { rel: "skills/deliberation-gate/SKILL.md", body: textBody("skills/deliberation-gate/SKILL.md") },
  { rel: "skills/숙의 게이트/스킬 #1.md", body: textBody("skills/숙의 게이트/스킬 #1.md") },
  { rel: "lib/session.js", body: textBody("lib/session.js") },
  { rel: "lib/speaker-discovery.js", body: textBody("lib/speaker-discovery.js") },
  { rel: "lib/라이브러리 100%/#1 이름.bin", body: binaryBody(0x33) },
]);

/** Directories the nested payload implies, outermost first. */
const OWNED_NESTED_DIRS = Object.freeze([
  "selectors",
  "selectors/역할",
  "selectors/역할/nested 100% #1",
  "skills",
  "skills/deliberation-gate",
  "skills/숙의 게이트",
  "lib",
  "lib/라이브러리 100%",
]);

// Every payload-relative name this file can legitimately observe. Anything else
// collapses to `other` rather than being echoed into a message.
const PAYLOAD_REL_ENUM = Object.freeze([
  ...OWNED_NESTED_DIRS,
  ...OWNED_NESTED_FILES.map((f) => f.rel),
  ...FILES_TO_COPY,
  SKILL_REL.join("/"),
]);

// ── Bounded diagnostics ──────────────────────────────────────────────────────

const ENTRY_TYPE_ENUM = Object.freeze(["file", "dir", "link", "other", "absent"]);
const FS_ERROR_ENUM = Object.freeze([
  "ENOENT", "EACCES", "EPERM", "EEXIST", "EISDIR", "ENOTDIR", "EBUSY",
  "ENOSPC", "ENAMETOOLONG", "EINVAL", "ELOOP", "EXDEV", "EMFILE", "ENFILE",
]);
const SIGNAL_ENUM = Object.freeze([
  "SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGPIPE", "SIGABRT", "SIGSEGV",
]);
const SETTLED_BY_ENUM = Object.freeze(["child-closed", "timeout"]);

// The four external commands `install.js` issues on the install path, by label.
// `install.js:65` (`commandExists`), `:141` (remove), `:142` (add), `:122` (npm).
const COMMAND_LABEL_ENUM = Object.freeze([
  "command-exists-claude",
  "claude-mcp-remove",
  "claude-mcp-add",
  "npm-install",
]);
// The bounded tokens the child may report for a REJECTED command. Closed by
// construction: a leading-word enum, or `other`.
const REJECT_TOKEN_ENUM = Object.freeze([
  "reject(claude)", "reject(npm)", "reject(npx)", "reject(node)", "reject(where)",
  "reject(command)", "reject(git)", "reject(sh)", "reject(cmd)", "reject(other)",
]);

// The negative-control mutations the comparator must detect.
const MUTATION_ENUM = Object.freeze(["pristine", "missing", "partial", "corrupt"]);

// An owned destination subtree holds at most a few dozen entries. The cap turns
// an unexpected explosion into a reported count rather than an unbounded dump.
const MAX_ENTRIES = 256;
// Nothing this file writes exceeds ~1 KiB. A larger file under an owned
// destination is reported by size and never read.
const MAX_READ_BYTES = 256 * 1024;
// Child output is captured for byte/line counts only and never echoed.
const MAX_CAPTURE_BYTES = 128 * 1024;
// One installer run with no real npm and no real registration is sub-second.
// This deadline exists so a wedged child can never hang the suite.
const CHILD_TIMEOUT_MS = 20000;

const TMP_PREFIX = "ic1172cx-installer-unicode-";

const CLEANUP_REASON_ENUM = Object.freeze([
  "no-root", "unowned-root",
  ...FS_ERROR_ENUM.map((code) => "rm(" + code + ")"),
  "rm(other)", "rm(none)",
  ...ENTRY_TYPE_ENUM.map((type) => "residual(" + type + ")"),
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

/** The allowlisted errno of a caught fs error, else `other` / `none`. */
function diagErrno(err) {
  if (!err) return "none";
  return diagEnum(err.code, FS_ERROR_ENUM);
}

/** Full sha256 of `buf`, a fixed-width hex token over content this file authored. */
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** One closed-token line describing one payload entry. */
function entryLine({ rel, type, bytes, hash }) {
  return [
    "rel=" + diagEnum(rel, PAYLOAD_REL_ENUM),
    "type=" + diagEnum(type, ENTRY_TYPE_ENUM),
    "bytes=" + diagInt(bytes),
    "hash=" + (hash || "none"),
  ].join(" ");
}

function expectedFileLine(rel, body) {
  return entryLine({ rel, type: "file", bytes: body.length, hash: sha256(body) });
}

function expectedDirLine(rel) {
  return entryLine({ rel, type: "dir", bytes: null, hash: null });
}

/**
 * Expected closed-token lines for the payload subtree rooted at DIRS_TO_COPY
 * entry `top`, relative to that entry's own parent — i.e. the same `rel` space
 * `observeOwnedTree` produces when it is pointed at the payload root.
 */
function expectedSubtreeLines(top) {
  const rows = [
    ...OWNED_NESTED_DIRS.filter((d) => d === top || d.startsWith(top + "/")).map((d) => ({
      rel: d,
      line: expectedDirLine(d),
    })),
    ...OWNED_NESTED_FILES.filter((f) => f.rel.startsWith(top + "/")).map((f) => ({
      rel: f.rel,
      line: expectedFileLine(f.rel, f.body),
    })),
  ];
  // `observeOwnedTree` is pointed INSIDE `top` and re-prefixes every entry with
  // `top`, so the keys here keep their full payload-relative form and only the
  // `top` row itself — which has no counterpart inside its own listing — is
  // dropped.
  return Object.freeze(
    rows
      .filter((r) => r.rel !== top)
      .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
      .map((r) => r.line)
  );
}

// ── Owned-tree observation ───────────────────────────────────────────────────

/**
 * Enumerate `root` and describe every entry as a closed-token line, with `rel`
 * prefixed by `relBase` so the lines sit in the PAYLOAD_REL_ENUM space.
 *
 * Read-only: `readdirSync` + `statSync` + `readFileSync`. Never a write, never a
 * copy, never a retry. Descent stays inside `root` by construction (it walks
 * dirents it just read); a symlink is recorded as `link` and NOT followed, so no
 * traversal can leave the owned root.
 *
 * `MAX_ENTRIES` is enforced per ENTRY — inside the dirent loop as well as
 * between directories — because one directory can hold more entries than the cap
 * on its own, and a check that only ran between directories would let it push
 * every one of them first. Bounding only between directories is not bounding.
 */
function observeOwnedTree(root, relBase) {
  const entries = [];
  let truncated = false;
  const stack = [""];
  walk: while (stack.length > 0) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const rel = stack.pop();
    const abs = rel === "" ? root : path.join(root, ...rel.split("/"));
    let dirents;
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      entries.push({
        rel: rel === "" ? "." : rel,
        type: "other",
        bytes: null,
        hash: "error(" + diagErrno(err) + ")",
      });
      continue;
    }
    for (const dirent of dirents) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break walk;
      }
      const childRel = rel === "" ? dirent.name : rel + "/" + dirent.name;
      const childAbs = path.join(abs, dirent.name);
      if (dirent.isSymbolicLink()) {
        entries.push({ rel: childRel, type: "link", bytes: null, hash: null });
        continue;
      }
      if (dirent.isDirectory()) {
        entries.push({ rel: childRel, type: "dir", bytes: null, hash: null });
        stack.push(childRel);
        continue;
      }
      if (!dirent.isFile()) {
        entries.push({ rel: childRel, type: "other", bytes: null, hash: null });
        continue;
      }
      let stats;
      try {
        stats = fs.statSync(childAbs);
      } catch (err) {
        entries.push({ rel: childRel, type: "file", bytes: null, hash: "error(" + diagErrno(err) + ")" });
        continue;
      }
      if (stats.size > MAX_READ_BYTES) {
        entries.push({ rel: childRel, type: "file", bytes: stats.size, hash: "oversize" });
        continue;
      }
      let buf;
      try {
        buf = fs.readFileSync(childAbs);
      } catch (err) {
        entries.push({ rel: childRel, type: "file", bytes: stats.size, hash: "error(" + diagErrno(err) + ")" });
        continue;
      }
      entries.push({ rel: childRel, type: "file", bytes: buf.length, hash: sha256(buf) });
    }
  }
  const prefixed = entries.map((e) => ({
    ...e,
    rel: relBase ? relBase + "/" + e.rel : e.rel,
  }));
  prefixed.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const lines = prefixed.map(entryLine);
  if (truncated) lines.push("truncated=true cap=" + diagInt(MAX_ENTRIES));
  return lines;
}

/** Type of a single path, as one member of `ENTRY_TYPE_ENUM`. One `lstat`. */
function entryTypeOf(p) {
  let stats;
  try {
    stats = fs.lstatSync(p);
  } catch (err) {
    return err && err.code === "ENOENT" ? "absent" : "other";
  }
  if (stats.isSymbolicLink()) return "link";
  if (stats.isDirectory()) return "dir";
  if (stats.isFile()) return "file";
  return "other";
}

/**
 * One closed-token line for a single expected FILE, read from disk. Used for the
 * flat FILES_TO_COPY arm and for the installed skill file, where the expected
 * body is known and the name is a literal from a frozen list.
 */
function observeOwnedFile(abs, rel) {
  const type = entryTypeOf(abs);
  if (type !== "file") return entryLine({ rel, type, bytes: null, hash: null });
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (err) {
    return entryLine({ rel, type: "file", bytes: null, hash: "error(" + diagErrno(err) + ")" });
  }
  return entryLine({ rel, type: "file", bytes: buf.length, hash: sha256(buf) });
}

// ── The child bootstrap ──────────────────────────────────────────────────────
//
// Written to an owned directory OUTSIDE the payload source root, so it can never
// be picked up as payload, and imported by absolute path. The installer is
// reached through `pathToFileURL(...).href`: a module specifier is a URL, and a
// source root containing a space, a `#` or a `%` cannot be handed to `import()`
// as a bare path without being mis-parsed as a fragment or an escape.
//
// It replaces ONE function on ONE builtin, then calls `syncBuiltinESMExports()`
// so the installer's static `import { execSync }` binding resolves to the
// interceptor, then imports the untouched installer. `fs` is not touched.
const BOOTSTRAP_NAME = "ic1172cx-install-bootstrap.mjs";
const BOOTSTRAP_SOURCE = [
  "// ic1172cx test-only bootstrap. Replaces node:child_process execSync with an",
  "// exact-allowlist interceptor, syncs the builtin's ESM exports, then imports",
  "// the untouched installer. Executes no external program. Does not touch fs.",
  "import { createRequire, syncBuiltinESMExports } from \"node:module\";",
  "import { pathToFileURL } from \"node:url\";",
  "import fs from \"node:fs\";",
  "",
  "const INSTALL_JS = process.env.IC1172CX_INSTALL_JS;",
  "const REPORT_PATH = process.env.IC1172CX_REPORT;",
  "const EXPECTED_ENTRY = process.env.IC1172CX_EXPECTED_ENTRY;",
  "if (!INSTALL_JS || !REPORT_PATH || !EXPECTED_ENTRY) {",
  "  process.stderr.write(\"ic1172cx bootstrap: missing owned inputs\\n\");",
  "  process.exit(3);",
  "}",
  "",
  "// EXACT allowlist, in COMMAND_LABEL_ENUM order. The `claude mcp add` entry",
  "// embeds the exact server entry point the installer must derive, so a mangled",
  "// non-ASCII INSTALL_DIR is REJECTED here rather than silently accepted.",
  "const ALLOWLIST = [",
  "  process.platform === \"win32\" ? \"where claude\" : \"command -v claude\",",
  "  \"claude mcp remove deliberation -s user\",",
  "  'claude mcp add deliberation -s user -- node \"' + EXPECTED_ENTRY + '\"',",
  "  \"npm install --production --no-audit --no-fund\",",
  "];",
  "const LABELS = [",
  "  \"command-exists-claude\",",
  "  \"claude-mcp-remove\",",
  "  \"claude-mcp-add\",",
  "  \"npm-install\",",
  "];",
  "const LEADING_WORDS = [\"claude\", \"npm\", \"npx\", \"node\", \"where\", \"command\", \"git\", \"sh\", \"cmd\"];",
  "",
  "const calls = [];",
  "const rejected = [];",
  "let installError = null;",
  "",
  "/** A rejected command as ONE closed token: its leading word, or `other`. */",
  "function rejectToken(text) {",
  "  const word = String(text).trim().split(/\\s+/)[0] || \"\";",
  "  return \"reject(\" + (LEADING_WORDS.includes(word) ? word : \"other\") + \")\";",
  "}",
  "",
  "const require = createRequire(import.meta.url);",
  "const childProcess = require(\"node:child_process\");",
  "function interceptedExecSync(command) {",
  "  const text = typeof command === \"string\" ? command : String(command);",
  "  const index = ALLOWLIST.indexOf(text);",
  "  if (index === -1) {",
  "    rejected.push(rejectToken(text));",
  "    const err = new Error(\"ic1172cx: external command rejected by test bootstrap\");",
  "    err.code = \"IC1172CX_REJECTED\";",
  "    throw err;",
  "  }",
  "  calls.push(LABELS[index]);",
  "  // Stubbed dependency install / provider registration: a successful exit with",
  "  // empty stdout. No registry, no login, no CLI, no app is reached.",
  "  return Buffer.alloc(0);",
  "}",
  "childProcess.execSync = interceptedExecSync;",
  "syncBuiltinESMExports();",
  "",
  "try {",
  "  await import(pathToFileURL(INSTALL_JS).href);",
  "} catch (err) {",
  "  // Name and code only. An installer error embeds absolute source and",
  "  // destination paths in its message, which must not travel out.",
  "  installError = {",
  "    name: (err && err.name) || \"other\",",
  "    code: (err && err.code) || \"none\",",
  "  };",
  "}",
  "",
  "fs.writeFileSync(",
  "  REPORT_PATH,",
  "  JSON.stringify({",
  "    calls,",
  "    rejected,",
  "    installError,",
  "    seamIntact: childProcess.execSync === interceptedExecSync,",
  "    allowlistSize: ALLOWLIST.length,",
  "    platform: process.platform,",
  "    nodeMajor: Number(process.versions.node.split(\".\")[0]),",
  "  })",
  ");",
  "process.exit(installError ? 1 : 0);",
].join("\n") + "\n";

// ── Isolated environment ─────────────────────────────────────────────────────

/**
 * Trusted OS PATH entries, and nothing else. Shaped exactly like
 * `TRUSTED_OS_PATH_DIRS` (`__tests__/helpers/cli-discovery-fixture.js:66-72`).
 * The child never sees the host PATH, so even if the seam were bypassed there is
 * no `claude`, no `npm` and no browser to reach.
 */
const TRUSTED_OS_PATH_DIRS = IS_WIN
  ? [
      path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
      process.env.SystemRoot || "C:\\Windows",
    ]
  : ["/usr/bin", "/bin"];

/**
 * A complete environment built from scratch — NOT `{...process.env}`. Every
 * variable the installer can derive a path from is pinned inside the owned home:
 * HOME, USERPROFILE, LOCALAPPDATA, APPDATA, the XDG base directories and the
 * three temp variables. The host HOME is never read and never expanded.
 */
function isolatedEnv(homeDir) {
  const tmpDir = path.join(homeDir, "tmp");
  const localAppData = path.join(homeDir, "AppData", "Local");
  const roamingAppData = path.join(homeDir, "AppData", "Roaming");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(roamingAppData, { recursive: true });

  const env = {
    PATH: [...TRUSTED_OS_PATH_DIRS].join(path.delimiter),
    HOME: homeDir,
    USERPROFILE: homeDir,
    LOCALAPPDATA: localAppData,
    APPDATA: roamingAppData,
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
    XDG_STATE_HOME: path.join(homeDir, ".local", "state"),
    XDG_CACHE_HOME: path.join(homeDir, ".cache"),
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
  };
  if (IS_WIN) {
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    env.SystemRoot = process.env.SystemRoot || "C:\\Windows";
    env.ComSpec = process.env.ComSpec || path.join(env.SystemRoot, "System32", "cmd.exe");
  }
  return env;
}

/**
 * `INSTALL_DIR` exactly as `install.js:25-29` derives it from the environment
 * above. Duplicated rather than imported because importing the installer would
 * execute it; the derivation is asserted against what the installer actually
 * produced, via the `claude mcp add` allowlist entry.
 */
function installDirFor(env) {
  return IS_WIN
    ? path.join(env.LOCALAPPDATA, "mcp-deliberation")
    : path.join(env.HOME, ".local", "lib", "mcp-deliberation");
}

/** `toForwardSlash(path.join(INSTALL_DIR, "index.js"))` — `install.js:38-40,134`. */
function serverEntryFor(env) {
  return path.join(installDirFor(env), "index.js").replace(/\\/g, "/");
}

// ── Owned child, bound to its own handle ─────────────────────────────────────

/**
 * Run the bootstrap in a bounded owned child and return closed facts about it.
 *
 * Bounded three ways: captured output has a hard byte cap, the child has a hard
 * deadline, and the handle is ALWAYS joined in `finally`. The join signals the
 * handle this function spawned and nothing else — no process scan, no negative
 * PID, no process group, no unowned PID. `close` (not `exit`) is awaited so the
 * stdio streams are drained before the owned root is inspected or removed.
 */
async function runOwnedInstaller({ bootstrapPath, cwd, env, timeoutMs = CHILD_TIMEOUT_MS }) {
  const child = spawn(process.execPath, [bootstrapPath], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdoutBytes = 0;
  let stdoutLines = 0;
  let stderrBytes = 0;
  let stderrLines = 0;
  let captured = "";
  let handleError = null;

  const absorb = (chunk, isStdout) => {
    const text = String(chunk);
    if (isStdout) {
      stdoutBytes += Buffer.byteLength(text);
      stdoutLines += text.split("\n").length - 1;
    } else {
      stderrBytes += Buffer.byteLength(text);
      stderrLines += text.split("\n").length - 1;
    }
    // Capped accumulation, kept ONLY so the installer's own `N item(s) copied`
    // counter can be read back as an integer. Never echoed, never asserted as
    // text, never included in a message.
    if (captured.length < MAX_CAPTURE_BYTES) {
      captured += text.slice(0, MAX_CAPTURE_BYTES - captured.length);
    }
  };

  try {
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (c) => absorb(c, true));
    child.stderr.on("data", (c) => absorb(c, false));
    child.on("error", (err) => { handleError = handleError || err; });

    const settledBy = await new Promise((resolve) => {
      let settled = false;
      let deadline = null;
      const settle = (reason) => {
        if (settled) return;
        settled = true;
        if (deadline !== null) clearTimeout(deadline);
        child.removeListener("close", onClose);
        resolve(reason);
      };
      function onClose() { settle("child-closed"); }
      deadline = setTimeout(() => settle("timeout"), timeoutMs);
      child.once("close", onClose);
    });

    // The installer logs `   → N item(s) copied` (`install.js:117`). Only the
    // integer is kept; the surrounding line, which sits next to logged absolute
    // paths, is discarded.
    const match = /→ (\d+) item\(s\) copied/.exec(captured);
    return {
      settledBy,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      copiedCount: match ? Number(match[1]) : null,
      stdoutBytes,
      stdoutLines,
      stderrBytes,
      stderrLines,
      handleError: handleError ? "present" : "none",
    };
  } finally {
    await joinOwnedChild(child);
  }
}

/**
 * Join an owned child by HANDLE. SIGTERM, then SIGKILL, then a hard deadline
 * that REFUSES to report the child as joined — because the owned root must not
 * be removed while the process may still be alive. Shaped after
 * `joinOwnedChild` (`__tests__/helpers/cli-discovery-fixture.js`).
 */
function joinOwnedChild(child, { timeoutMs = 2000, deadlineMs = 5000 } = {}) {
  if (!child) return Promise.resolve();
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    let killTimer = null;
    let deadlineTimer = null;

    const dispose = () => {
      if (killTimer !== null) { clearTimeout(killTimer); killTimer = null; }
      if (deadlineTimer !== null) { clearTimeout(deadlineTimer); deadlineTimer = null; }
      child.removeListener("exit", onExit);
    };
    function onExit() {
      if (settled) return;
      settled = true;
      dispose();
      resolve();
    }
    child.on("exit", onExit);
    if (exited()) { onExit(); return; }

    killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* handle already reaped */ }
      if (!settled && exited()) onExit();
    }, timeoutMs);
    deadlineTimer = setTimeout(() => {
      if (settled) return;
      if (exited()) { onExit(); return; }
      settled = true;
      dispose();
      reject(new Error(
        "ic1172cx: owned child reported no observed exit within "
        + diagInt(deadlineMs) + "ms; refusing to report it as joined"
      ));
    }, deadlineMs);

    try { child.kill("SIGTERM"); } catch { /* handle already reaped */ }
    if (!settled && exited()) onExit();
  });
}

// ── Fixture materialisation ──────────────────────────────────────────────────

/**
 * Write the owned payload, plus a byte-identical copy of the release
 * `install.js`, under `sourceRoot`.
 *
 * The installer copy is `readFileSync` + `writeFileSync`, NOT `copyFileSync`:
 * `copyFileSync` is the primitive under test, and a fixture that used it could
 * not distinguish "the installer copied correctly" from "the fixture and the
 * installer share a defect". Its sha256 is returned so byte identity with the
 * release file is asserted, not assumed.
 */
function materializeOwnedSource(sourceRoot) {
  fs.mkdirSync(sourceRoot, { recursive: true });
  for (const dir of OWNED_NESTED_DIRS) {
    fs.mkdirSync(path.join(sourceRoot, ...dir.split("/")), { recursive: true });
  }
  for (const file of OWNED_NESTED_FILES) {
    fs.writeFileSync(path.join(sourceRoot, ...file.rel.split("/")), file.body);
  }
  for (const file of OWNED_FLAT_FILES) {
    fs.writeFileSync(path.join(sourceRoot, file.name), file.body);
  }
  const installerBytes = fs.readFileSync(RELEASE_INSTALL_JS);
  const stagedInstaller = path.join(sourceRoot, "install.js");
  fs.writeFileSync(stagedInstaller, installerBytes);
  return {
    releaseHash: sha256(installerBytes),
    stagedHash: sha256(fs.readFileSync(stagedInstaller)),
  };
}

/**
 * A second, independently written copy of the nested payload, then one
 * mutation. Used ONLY to prove the comparator can fail. This tree is never read
 * by, merged into, or substituted for any installer destination.
 */
function materializeMutatedTree(root, mutation) {
  fs.mkdirSync(root, { recursive: true });
  for (const dir of OWNED_NESTED_DIRS) {
    fs.mkdirSync(path.join(root, ...dir.split("/")), { recursive: true });
  }
  const victim = "lib/라이브러리 100%/#1 이름.bin";
  for (const file of OWNED_NESTED_FILES) {
    const abs = path.join(root, ...file.rel.split("/"));
    if (file.rel === victim) {
      if (mutation === "missing") continue;
      if (mutation === "partial") {
        fs.writeFileSync(abs, file.body.subarray(0, file.body.length - 1));
        continue;
      }
      if (mutation === "corrupt") {
        const flipped = Buffer.from(file.body);
        flipped[0] = flipped[0] ^ 0xff;
        fs.writeFileSync(abs, flipped);
        continue;
      }
    }
    fs.writeFileSync(abs, file.body);
  }
}

// ── Collected state ──────────────────────────────────────────────────────────

let tmpRoot = null;
let setupError = null;
let releaseSourceText = null;
let releaseHashBefore = null;
let releaseHashAfter = null;
/** caseKey -> collected facts */
const observed = Object.create(null);
/** mutation -> observed subtree lines for the negative-control scratch trees */
const controlTrees = Object.create(null);

/**
 * Cross-case summary, printed alongside every failing assertion so a failing
 * case cannot suppress the evidence from the others. Closed tokens only.
 */
function caseSummary() {
  const rows = [];
  for (const c of CASES) {
    const rec = observed[c.key];
    rows.push(
      [
        "case=" + diagEnum(c.key, CASE_KEY_ENUM),
        "nonAscii=" + diagBool(c.nonAscii),
        "settledBy=" + diagEnum(rec ? rec.child.settledBy : null, SETTLED_BY_ENUM),
        "exit=" + diagInt(rec ? rec.child.exitCode : null),
        "signal=" + diagEnum(rec ? rec.child.signalCode : null, SIGNAL_ENUM),
        "copied=" + diagInt(rec ? rec.child.copiedCount : null),
        "calls=" + diagInt(rec ? rec.report.calls.length : null),
        "rejected=" + diagInt(rec ? rec.report.rejected.length : null),
        "stdoutBytes=" + diagInt(rec ? rec.child.stdoutBytes : null),
        "stderrBytes=" + diagInt(rec ? rec.child.stderrBytes : null),
      ].join(" ")
    );
  }
  return "ic1172cx cases\n" + rows.join("\n");
}

beforeAll(async () => {
  try {
    releaseSourceText = fs.readFileSync(RELEASE_INSTALL_JS, "utf-8");
    releaseHashBefore = sha256(fs.readFileSync(RELEASE_INSTALL_JS));

    tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), TMP_PREFIX));

    // Negative controls first: if the comparator cannot fail, nothing below is
    // worth reading, and these cost one small tree each.
    for (const mutation of MUTATION_ENUM) {
      const root = path.join(tmpRoot, "control", mutation);
      materializeMutatedTree(root, mutation);
      controlTrees[mutation] = Object.create(null);
      for (const top of DIRS_TO_COPY) {
        controlTrees[mutation][top] = observeOwnedTree(path.join(root, top), top);
      }
    }

    for (const c of CASES) {
      const caseRoot = path.join(tmpRoot, "case", c.key);
      // BOTH sides carry the case segment: the payload SOURCE the installer
      // reads from, and the HOME the installer derives its DESTINATION from.
      const sourceRoot = path.join(caseRoot, "src", c.segment);
      const homeRoot = path.join(caseRoot, "home", c.segment);
      fs.mkdirSync(homeRoot, { recursive: true });

      const hashes = materializeOwnedSource(sourceRoot);
      const sourceBefore = Object.create(null);
      for (const top of DIRS_TO_COPY) {
        sourceBefore[top] = observeOwnedTree(path.join(sourceRoot, top), top);
      }
      const sourceFlatBefore = OWNED_FLAT_FILES.map((f) =>
        observeOwnedFile(path.join(sourceRoot, f.name), f.name)
      );

      const env = isolatedEnv(homeRoot);
      const installDir = installDirFor(env);
      const bootstrapPath = path.join(caseRoot, BOOTSTRAP_NAME);
      const reportPath = path.join(caseRoot, "bootstrap-report.json");
      fs.writeFileSync(bootstrapPath, BOOTSTRAP_SOURCE);

      const child = await runOwnedInstaller({
        bootstrapPath,
        cwd: caseRoot,
        env: {
          ...env,
          IC1172CX_INSTALL_JS: path.join(sourceRoot, "install.js"),
          IC1172CX_REPORT: reportPath,
          IC1172CX_EXPECTED_ENTRY: serverEntryFor(env),
        },
      });

      let report = { calls: [], rejected: [], installError: null, seamIntact: null, allowlistSize: null, platform: null, nodeMajor: null };
      let reportReadError = "none";
      try {
        report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
      } catch (err) {
        reportReadError = diagErrno(err) === "none" ? "other" : diagErrno(err);
      }

      // Observe the DESTINATION: the recursive DIRS_TO_COPY subtrees and every
      // flat FILES_TO_COPY entry, plus the source again so a copy that mutated
      // its own source is caught.
      const destDirs = Object.create(null);
      for (const top of DIRS_TO_COPY) {
        destDirs[top] = observeOwnedTree(path.join(installDir, top), top);
      }
      const destFlat = OWNED_FLAT_FILES.map((f) =>
        observeOwnedFile(path.join(installDir, f.name), f.name)
      );
      const sourceAfter = Object.create(null);
      for (const top of DIRS_TO_COPY) {
        sourceAfter[top] = observeOwnedTree(path.join(sourceRoot, top), top);
      }
      const sourceFlatAfter = OWNED_FLAT_FILES.map((f) =>
        observeOwnedFile(path.join(sourceRoot, f.name), f.name)
      );

      observed[c.key] = {
        child,
        report,
        reportReadError,
        hashes,
        stagedHashAfter: sha256(fs.readFileSync(path.join(sourceRoot, "install.js"))),
        sourceBefore,
        sourceAfter,
        sourceFlatBefore,
        sourceFlatAfter,
        destDirs,
        destFlat,
        // The installed skill file, the third real `copyFileSync` caller.
        installedSkill: observeOwnedFile(
          path.join(homeRoot, ".claude", "skills", "deliberation-gate", "SKILL.md"),
          SKILL_REL.join("/")
        ),
        // Containment: the destination the installer derived must sit inside the
        // owned home. Reported as a boolean, never as a path.
        destInsideOwnedHome:
          installDir === homeRoot || installDir.startsWith(homeRoot + path.sep),
      };
    }

    releaseHashAfter = sha256(fs.readFileSync(RELEASE_INSTALL_JS));
  } catch (err) {
    // Setup itself failed. Record it as a closed token and let the assertions
    // report it; never swallow it into a pass.
    setupError = diagErrno(err) === "none" ? "other" : diagErrno(err);
  }
}, 180000);

afterAll(() => {
  // Remove only the root this file created, identified by its own prefix.
  //
  // A cleanup failure IS a result, not housekeeping: the surviving root holds
  // the very Unicode-named directories under test, so swallowing the error would
  // let the run go green while leaving them on the runner, and would hide
  // exactly the class of fs behaviour this file exists to measure.
  let reason = "ok";
  if (!tmpRoot) {
    reason = "no-root";
  } else if (!path.basename(tmpRoot).startsWith(TMP_PREFIX)) {
    reason = "unowned-root";
  } else {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      reason = "rm(" + diagErrno(err) + ")";
    }
    if (reason === "ok") {
      // `rmSync` returning is not proof the root is gone.
      const residual = entryTypeOf(tmpRoot);
      if (residual !== "absent") reason = "residual(" + residual + ")";
    }
  }
  if (reason !== "ok") {
    throw new Error(
      "ic1172cx owned-root cleanup failed (reason="
      + diagEnum(reason, CLEANUP_REASON_ENUM) + ")"
    );
  }
});

describe("ic1172cx installer Unicode copy — preconditions and seam audit", () => {
  it("locates a release install.js and collects every case", () => {
    expect(setupError, caseSummary()).toBe(null);
    expect(entryTypeOf(RELEASE_INSTALL_JS)).toBe("file");
    for (const c of CASES) {
      expect(observed[c.key], "missing case " + diagEnum(c.key, CASE_KEY_ENUM)).toBeTruthy();
    }
    // Every case ran on this platform. No arm is skipped, branched away or
    // tolerated as absent.
    expect(Object.keys(observed).sort()).toEqual([...CASE_KEY_ENUM].sort());
  });

  it("tracks the product's own copy lists rather than a stale duplicate", () => {
    // If the installer's lists change, this file must be updated with them — a
    // silent divergence would leave the payload under test out of date while the
    // suite still went green.
    const flat = /const FILES_TO_COPY = \[([\s\S]*?)\];/.exec(releaseSourceText);
    const dirs = /const DIRS_TO_COPY = \[([\s\S]*?)\];/.exec(releaseSourceText);
    expect(flat, "install.js FILES_TO_COPY not found").toBeTruthy();
    expect(dirs, "install.js DIRS_TO_COPY not found").toBeTruthy();
    const parseNames = (body) => (body.match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1));
    expect(parseNames(flat[1])).toEqual([...FILES_TO_COPY]);
    expect(parseNames(dirs[1])).toEqual([...DIRS_TO_COPY]);
  });

  it("audits the seam: node:child_process is imported once, binding execSync only", () => {
    // SEAM AUDIT ONLY. This establishes that replacing `execSync` covers the
    // installer's ENTIRE external surface, which is what makes the stub safe.
    // It is never used as evidence about the copy — that is asserted from bytes
    // on disk in the sections below.
    const imports = releaseSourceText.match(/import[^;]*from\s+"node:child_process";/g) || [];
    expect(imports).toEqual(['import { execSync } from "node:child_process";']);
    expect(/require\(\s*["']node:child_process["']\s*\)/.test(releaseSourceText)).toBe(false);
    expect(/from\s+"child_process"/.test(releaseSourceText)).toBe(false);
  });

  it("uses copyFileSync / copyDirRecursive and never fs.cpSync", () => {
    // The caller boundary this file exists to cover. Recorded so that a future
    // change to `fs.cpSync` in the installer is caught here rather than shipping
    // behind a test that no longer matches the caller it claims to exercise.
    expect(/fs\.cpSync/.test(releaseSourceText)).toBe(false);
    expect(releaseSourceText).toContain("function copyDirRecursive(src, dest) {");
    expect(releaseSourceText).toContain("fs.copyFileSync(srcPath, destPath);");
  });

  it("keeps the release install.js byte-identical, and stages it byte-identically", () => {
    expect(releaseHashBefore, caseSummary()).toBe(releaseHashAfter);
    for (const c of CASES) {
      const rec = observed[c.key];
      // The staged installer is the release installer, before and after the run.
      expect(rec.hashes.releaseHash, diagEnum(c.key, CASE_KEY_ENUM)).toBe(releaseHashBefore);
      expect(rec.hashes.stagedHash, diagEnum(c.key, CASE_KEY_ENUM)).toBe(releaseHashBefore);
      expect(rec.stagedHashAfter, diagEnum(c.key, CASE_KEY_ENUM)).toBe(releaseHashBefore);
    }
  });
});

describe("ic1172cx installer Unicode copy — the owned child and its seam", () => {
  it("runs the real installer to completion in every case", () => {
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      const rec = observed[c.key];
      actual[c.key] = [
        "settledBy=" + diagEnum(rec.child.settledBy, SETTLED_BY_ENUM),
        "exit=" + diagInt(rec.child.exitCode),
        "signal=" + diagEnum(rec.child.signalCode, SIGNAL_ENUM),
        "handleError=" + rec.child.handleError,
        "reportRead=" + rec.reportReadError,
        "installError=" + (rec.report.installError ? "present" : "none"),
      ].join(" ");
      expected[c.key] =
        "settledBy=child-closed exit=0 signal=none handleError=none reportRead=none installError=none";
    }
    expect(actual, caseSummary()).toEqual(expected);
  });

  it("copies exactly the 12 files and 3 directories the installer counts", () => {
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      actual[c.key] = diagInt(observed[c.key].child.copiedCount);
      expected[c.key] = diagInt(FILES_TO_COPY.length + DIRS_TO_COPY.length);
    }
    expect(actual, caseSummary()).toEqual(expected);
  });

  it("intercepts every external command, exercising the whole exact allowlist", () => {
    // Positive proof the seam was REACHED: all four allowlisted commands were
    // issued by the installer and recorded by the interceptor. A seam that
    // stopped intercepting would record nothing and fail here.
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      const rec = observed[c.key];
      actual[c.key] = [...new Set(rec.report.calls.map((l) => diagEnum(l, COMMAND_LABEL_ENUM)))].sort();
      expected[c.key] = [...COMMAND_LABEL_ENUM].sort();
    }
    expect(actual, caseSummary()).toEqual(expected);
  });

  it("rejects every unknown external command, and none was issued", () => {
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      const rec = observed[c.key];
      actual[c.key] = rec.report.rejected.map((t) => diagEnum(t, REJECT_TOKEN_ENUM));
      expected[c.key] = [];
    }
    expect(actual, caseSummary()).toEqual(expected);
  });

  it("holds the seam for the whole run, on this platform and Node major", () => {
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      const rec = observed[c.key];
      actual[c.key] = [
        "seamIntact=" + diagBool(rec.report.seamIntact),
        "allowlistSize=" + diagInt(rec.report.allowlistSize),
        "platformMatches=" + diagBool(rec.report.platform === process.platform),
        "nodeMajorMatches=" +
          diagBool(rec.report.nodeMajor === Number(process.versions.node.split(".")[0])),
      ].join(" ");
      expected[c.key] =
        "seamIntact=true allowlistSize=4 platformMatches=true nodeMajorMatches=true";
    }
    expect(actual, caseSummary()).toEqual(expected);
  });

  it("derives a destination inside the owned home in every case", () => {
    // If this fails, the installer resolved an install dir outside the isolated
    // home and the rest of the run says nothing about a contained install.
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      actual[c.key] = diagBool(observed[c.key].destInsideOwnedHome);
      expected[c.key] = "true";
    }
    expect(actual, caseSummary()).toEqual(expected);
  });
});

describe("ic1172cx installer Unicode copy — byte-exact payload landing", () => {
  it("lands every FILES_TO_COPY entry byte-exact under a non-ASCII destination", () => {
    // The flat `copyFileIfExists` -> `fs.copyFileSync` arm (install.js:105-109).
    // One of the twelve bodies is binary, so this is byte equality and not text
    // equality. Names are compared exactly: no normalisation on either side.
    const expectedLines = OWNED_FLAT_FILES.map((f) => expectedFileLine(f.name, f.body));
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      actual[c.key] = observed[c.key].destFlat;
      expected[c.key] = [...expectedLines];
    }
    expect(actual, caseSummary()).toEqual(expected);
  });

  it("lands the recursive DIRS_TO_COPY payload byte-exact, nested names included", () => {
    // The `copyDirRecursive` arm (install.js:110-116, 80-92). Full subtree
    // equality, so a MISSING leaf, an EXTRA entry, a PARTIAL body and a CORRUPT
    // byte all fail here — and nested non-ASCII directory and file names must be
    // preserved exactly for the `rel` keys to line up at all.
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      for (const top of DIRS_TO_COPY) {
        actual[c.key + "/" + top] = observed[c.key].destDirs[top];
        expected[c.key + "/" + top] = [...expectedSubtreeLines(top)];
      }
    }
    expect(actual, caseSummary()).toEqual(expected);
  });

  it("lands the installed skill file byte-exact under a non-ASCII HOME", () => {
    // The third real `copyFileSync` caller (install.js:258), writing into the
    // isolated HOME rather than into INSTALL_DIR.
    const skillRel = SKILL_REL.join("/");
    const skillBody = OWNED_NESTED_FILES.find((f) => f.rel === skillRel).body;
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      actual[c.key] = observed[c.key].installedSkill;
      expected[c.key] = expectedFileLine(skillRel, skillBody);
    }
    expect(actual, caseSummary()).toEqual(expected);
  });

  it("leaves the owned source tree byte-identical after the installer ran", () => {
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      const rec = observed[c.key];
      for (const top of DIRS_TO_COPY) {
        actual[c.key + "/" + top] = rec.sourceAfter[top];
        expected[c.key + "/" + top] = [...expectedSubtreeLines(top)];
      }
      actual[c.key + "/flat"] = rec.sourceFlatAfter;
      expected[c.key + "/flat"] = OWNED_FLAT_FILES.map((f) => expectedFileLine(f.name, f.body));
    }
    expect(actual, caseSummary()).toEqual(expected);
  });

  it("observed the same source before the installer ran", () => {
    // Before/after are both compared to the same literal expectation, so a
    // fixture that failed to materialise cannot be mistaken for a copy that
    // damaged its source.
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      const rec = observed[c.key];
      for (const top of DIRS_TO_COPY) {
        actual[c.key + "/" + top] = rec.sourceBefore[top];
        expected[c.key + "/" + top] = [...expectedSubtreeLines(top)];
      }
      actual[c.key + "/flat"] = rec.sourceFlatBefore;
      expected[c.key + "/flat"] = OWNED_FLAT_FILES.map((f) => expectedFileLine(f.name, f.body));
    }
    expect(actual, caseSummary()).toEqual(expected);
  });
});

describe("ic1172cx installer Unicode copy — negative controls", () => {
  // These four trees are written by this file, in a separate owned scratch
  // directory. They are never read by, merged into or substituted for any
  // installer destination, and they never repair a failed arm. Their only job is
  // to prove the comparator above can fail — a comparator that cannot fail would
  // make every assertion in this file vacuous.

  it("accepts a pristine tree, so the comparator is not trivially unequal", () => {
    for (const top of DIRS_TO_COPY) {
      expect(controlTrees.pristine[top], "pristine/" + top).toEqual([...expectedSubtreeLines(top)]);
    }
  });

  it("fails a MISSING file", () => {
    expect(controlTrees.missing.lib).not.toEqual([...expectedSubtreeLines("lib")]);
    // And specifically because the leaf is absent, not for some unrelated reason.
    const rels = controlTrees.missing.lib.filter((l) => l.includes("type=file")).length;
    expect(rels).toBe(expectedSubtreeLines("lib").filter((l) => l.includes("type=file")).length - 1);
  });

  it("fails a PARTIAL (truncated) file", () => {
    expect(controlTrees.partial.lib).not.toEqual([...expectedSubtreeLines("lib")]);
    // Same entry count, so the difference is the body, not the listing.
    expect(controlTrees.partial.lib.length).toBe(expectedSubtreeLines("lib").length);
  });

  it("fails a CORRUPT (single flipped byte) file", () => {
    expect(controlTrees.corrupt.lib).not.toEqual([...expectedSubtreeLines("lib")]);
    // Same entry count AND the same byte count: only the digest differs, which
    // is what makes this a byte-exactness check rather than a size check.
    expect(controlTrees.corrupt.lib.length).toBe(expectedSubtreeLines("lib").length);
    const byteCounts = (lines) => lines.filter((l) => l.includes("type=file")).map((l) => /bytes=(\S+)/.exec(l)[1]);
    expect(byteCounts(controlTrees.corrupt.lib)).toEqual(byteCounts(expectedSubtreeLines("lib")));
  });

  it("covers both a non-ASCII and an ASCII control arm, and skips neither", () => {
    // The ASCII control arm exists so that a non-ASCII failure is attributable
    // to the segment rather than to the installer or the harness. Both classes
    // must be present, and both are asserted by every section above.
    expect(CASES.filter((c) => c.nonAscii).length).toBeGreaterThanOrEqual(2);
    expect(CASES.filter((c) => !c.nonAscii).length).toBeGreaterThanOrEqual(1);
    expect(CASES.some((c) => c.key === "ordinary" && !c.nonAscii)).toBe(true);
  });
});
