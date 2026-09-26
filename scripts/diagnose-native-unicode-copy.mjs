#!/usr/bin/env node
// cp1172br diagnostic — native Unicode destination copy, OUTSIDE any test runner.
//
// WHY THIS FILE EXISTS
// --------------------
// `__tests__/native-unicode-copy.test.js` observes, on CI win22, that
// `fs.cpSync(dir, dst, {recursive:true})` returns without throwing while the
// payload does not land, under exactly the two destination segments whose names
// contain non-ASCII characters. That observation is made under Vitest, in a
// process where other test files temporarily replace `fs.copyFileSync` and
// `fs.cpSync`. So "Node/libuv behaviour" and "test-runtime contamination" are
// both still live explanations for it, and the test alone cannot separate them.
//
// This file runs the SAME reduced experiment in a plain `node` process:
//   node scripts/diagnose-native-unicode-copy.mjs
// Only Node builtins are imported. No Vitest, no MCP, no provider, no project
// module, nothing that could patch `fs`. If the discrepancy reproduces here it
// is not the runner; if it does not reproduce here while the test is red, the
// runner is implicated. Either way this script only MEASURES — it establishes no
// mechanism (codepage, normalisation, a Node 22 change) and claims none.
//
// It does NOT replace the test. The reduced `cpSync` gate stays red and stays
// owned by Vitest; this is an independent second observation next to it.
//
// BOUNDS
// ------
//   * Source tree, contents and nesting are fixed, ASCII-only, and authored
//     here — only the destination SEGMENT carries non-ASCII characters, so a
//     content-encoding effect can never be read as a path-encoding effect.
//   * The six destination segments are duplicated byte for byte from the test,
//     unnormalised, so a difference between the two cannot be a different string.
//   * Each arm writes its own destination directory; no arm repairs another.
//   * Every arm of every case is executed and recorded BEFORE any verdict is
//     computed, so the first discrepancy cannot suppress later observations.
//   * Nothing is retried, no copy is re-issued, no platform or Node version is
//     skipped, no failure is downgraded.
//   * Output is a closed token set: case key, arm name, a tree-relative path
//     from the literal list this file created, an entry type, an integer byte
//     count, an allowlisted errno, and a 12-hex sha256 prefix over content this
//     file authored. No absolute path, no host listing, no file body, no fs
//     error message is ever printed.
//   * Exit code is 0 only if every arm landed exactly and the owned temporary
//     root was removed. A real copy discrepancy or a cleanup failure exits 1.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Destination cases (byte-for-byte from the test / CI fixture) ─────────────
const CASES = Object.freeze([
  { key: "ordinary", segment: "plain-ascii-install", nonAscii: false },
  { key: "spaces", segment: "install dir with spaces", nonAscii: false },
  { key: "non-ascii", segment: "설치경로-한글", nonAscii: true },
  { key: "literal-percent", segment: "install-100%-done", nonAscii: false },
  { key: "hash", segment: "install#1-hash", nonAscii: false },
  { key: "combined", segment: "en coded 한글 100%tested #1", nonAscii: true },
]);
const CASE_KEY_ENUM = Object.freeze(CASES.map((c) => c.key));

// recursive — the CI call: one cpSync per payload entry, {recursive:true}, DIR source.
// leaf      — the same call with a single FILE source; isolates recursive descent.
// control   — same source, separate destination, mkdirSync + per-file copyFileSync.
const ARM_ENUM = Object.freeze(["recursive", "leaf", "control"]);

// ── Synthetic source tree (fixed, ASCII, same shape/leaf names as the test) ──
const FIXTURE_FILES = Object.freeze([
  { rel: "lib/session.js", body: 'export const SESSION_KIND = "cp1172br-fixture";\n' },
  { rel: "lib/speaker-discovery.js", body: 'export const SPEAKERS = ["critic", "analyst"];\n' },
  { rel: "selectors/role-presets.json", body: '{\n  "presets": {\n    "critic": ["critic"]\n  }\n}\n' },
  { rel: "selectors/roles/analyst.md", body: "# analyst\n\ncp1172br synthetic role prompt.\n" },
  { rel: "selectors/roles/critic.md", body: "# critic\n\ncp1172br synthetic role prompt.\n" },
]);
const FIXTURE_DIRS = Object.freeze(["lib", "selectors", "selectors/roles"]);
const PAYLOAD_ENTRIES = Object.freeze(["lib", "selectors"]);
const LEAF_SOURCE_REL = "lib/speaker-discovery.js";
const LEAF_DEST_NAME = "speaker-discovery.js";
// The three leaf names the win22 log named, reported one-to-one with it.
const NAMED_LEAVES = Object.freeze([
  "lib/speaker-discovery.js",
  "selectors/role-presets.json",
  "selectors/roles/critic.md",
]);

const TREE_REL_ENUM = Object.freeze([
  ...FIXTURE_DIRS,
  ...FIXTURE_FILES.map((f) => f.rel),
  LEAF_DEST_NAME,
]);
const ENTRY_TYPE_ENUM = Object.freeze(["file", "dir", "link", "other", "absent"]);
const FS_ERROR_ENUM = Object.freeze([
  "ENOENT", "EACCES", "EPERM", "EEXIST", "EISDIR", "ENOTDIR", "EBUSY",
  "ENOSPC", "ENAMETOOLONG", "EINVAL", "ELOOP", "EXDEV", "EMFILE", "ENFILE",
]);

const MAX_ENTRIES = 64;
const MAX_READ_BYTES = 64 * 1024;
const TMP_PREFIX = "cp1172br-diagnose-native-unicode-copy-";

const CLEANUP_REASON_ENUM = Object.freeze([
  "no-root", "unowned-root",
  ...FS_ERROR_ENUM.map((code) => "rm(" + code + ")"),
  "rm(other)", "rm(none)",
  ...ENTRY_TYPE_ENUM.map((type) => "residual(" + type + ")"),
]);

// ── Bounded diagnostics ──────────────────────────────────────────────────────

/** A member of `allowed`, else `none` / `other`. Never the raw value. */
function diagEnum(value, allowed) {
  if (value === null || value === undefined || value === "") return "none";
  return allowed.includes(value) ? value : "other";
}

/** An integer, else `none` (absent) / `other`. */
function diagInt(value) {
  if (value === null || value === undefined) return "none";
  return Number.isInteger(value) ? String(value) : "other";
}

/** The allowlisted errno of a caught fs error, else `other` / `none`. */
function diagErrno(err) {
  if (!err) return "none";
  return diagEnum(err.code, FS_ERROR_ENUM);
}

/** First 12 hex of sha256 over `buf`. Content is this file's own. */
function sha12(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12);
}

/** One closed-token line describing one tree entry. */
function entryLine({ rel, type, bytes, hash }) {
  return [
    "rel=" + diagEnum(rel, TREE_REL_ENUM),
    "type=" + diagEnum(type, ENTRY_TYPE_ENUM),
    "bytes=" + diagInt(bytes),
    "hash=" + (hash || "none"),
  ].join(" ");
}

function expectedFileLine(rel, body) {
  const buf = Buffer.from(body, "utf-8");
  return entryLine({ rel, type: "file", bytes: buf.length, hash: sha12(buf) });
}

function expectedDirLine(rel) {
  return entryLine({ rel, type: "dir", bytes: null, hash: null });
}

const EXPECTED_PAYLOAD_LINES = Object.freeze(
  [
    ...FIXTURE_DIRS.map((d) => ({ rel: d, line: expectedDirLine(d) })),
    ...FIXTURE_FILES.map((f) => ({ rel: f.rel, line: expectedFileLine(f.rel, f.body) })),
  ]
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map((e) => e.line)
);
const EXPECTED_LEAF_LINES = Object.freeze([
  expectedFileLine(
    LEAF_DEST_NAME,
    FIXTURE_FILES.find((f) => f.rel === LEAF_SOURCE_REL).body
  ),
]);
const EXPECTED_SOURCE_LINES = EXPECTED_PAYLOAD_LINES;
const EXPECTED_ARM_LINES = Object.freeze({
  recursive: EXPECTED_PAYLOAD_LINES,
  leaf: EXPECTED_LEAF_LINES,
  control: EXPECTED_PAYLOAD_LINES,
});

// ── Owned-tree observation ───────────────────────────────────────────────────

/**
 * Enumerate `root`, which this file created, as closed-token lines. Read-only:
 * `readdirSync` + `readFileSync`, never a write, never a copy, never a retry.
 * Descent stays inside `root` by construction (it walks dirents it just read);
 * a symlink is recorded as `link` and NOT followed.
 *
 * `MAX_ENTRIES` is enforced per ENTRY — inside the dirent loop as well as
 * between directories — because one directory can hold more entries than the
 * cap on its own, and a check that only ran between directories would let it
 * push every one of them first.
 */
function observeOwnedTree(root) {
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
        entries.push({
          rel: childRel,
          type: "file",
          bytes: null,
          hash: "error(" + diagErrno(err) + ")",
        });
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
        entries.push({
          rel: childRel,
          type: "file",
          bytes: stats.size,
          hash: "error(" + diagErrno(err) + ")",
        });
        continue;
      }
      entries.push({ rel: childRel, type: "file", bytes: buf.length, hash: sha12(buf) });
    }
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const lines = entries.map(entryLine);
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

function sameLines(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((line, i) => line === expected[i])
  );
}

// ── Measure: every arm of every case, before any verdict ─────────────────────

let tmpRoot = null;
let sourceRoot = null;
let setupError = null;
/** caseKey -> armName -> { threw, lines, leaves } */
const observed = Object.create(null);
let sourceLinesBefore = null;
let sourceLinesAfter = null;

function measure() {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), TMP_PREFIX));
  sourceRoot = path.join(tmpRoot, "source");

  // 1. Materialise the synthetic source tree.
  for (const dir of FIXTURE_DIRS) {
    fs.mkdirSync(path.join(sourceRoot, ...dir.split("/")), { recursive: true });
  }
  for (const file of FIXTURE_FILES) {
    fs.writeFileSync(path.join(sourceRoot, ...file.rel.split("/")), file.body);
  }

  // 2. PRE snapshot of the source, before any copy touches it.
  sourceLinesBefore = observeOwnedTree(sourceRoot);

  // 3. Run every arm. Each arm is guarded, so a throw in one cannot stop a
  //    later one from being collected, and no arm is retried or repaired.
  for (const c of CASES) {
    const caseRoot = path.join(tmpRoot, "dest", c.segment);
    observed[c.key] = Object.create(null);

    // ── arm: recursive — the CI call, unchanged ──────────────────────────
    const recursiveRoot = path.join(caseRoot, "recursive");
    let recursiveThrew = "none";
    try {
      fs.mkdirSync(recursiveRoot, { recursive: true });
      for (const entry of PAYLOAD_ENTRIES) {
        fs.cpSync(path.join(sourceRoot, entry), path.join(recursiveRoot, entry), {
          recursive: true,
        });
      }
    } catch (err) {
      recursiveThrew = diagErrno(err);
    }
    observed[c.key].recursive = {
      threw: recursiveThrew,
      lines: observeOwnedTree(recursiveRoot),
      // src/dst type of each win22-named leaf, so this report lines up
      // one-to-one with those log lines.
      leaves: NAMED_LEAVES.map(
        (leaf) =>
          "leaf=" + diagEnum(leaf, TREE_REL_ENUM) +
          " src=" + diagEnum(entryTypeOf(path.join(sourceRoot, ...leaf.split("/"))), ENTRY_TYPE_ENUM) +
          " dst=" + diagEnum(entryTypeOf(path.join(recursiveRoot, ...leaf.split("/"))), ENTRY_TYPE_ENUM)
      ),
    };

    // ── arm: leaf — same call, single FILE source ────────────────────────
    const leafRoot = path.join(caseRoot, "leaf");
    let leafThrew = "none";
    try {
      fs.mkdirSync(leafRoot, { recursive: true });
      fs.cpSync(
        path.join(sourceRoot, ...LEAF_SOURCE_REL.split("/")),
        path.join(leafRoot, LEAF_DEST_NAME),
        { recursive: true }
      );
    } catch (err) {
      leafThrew = diagErrno(err);
    }
    observed[c.key].leaf = { threw: leafThrew, lines: observeOwnedTree(leafRoot) };

    // ── arm: control — per-file copyFileSync, SEPARATE destination ───────
    const controlRoot = path.join(caseRoot, "control");
    let controlThrew = "none";
    try {
      for (const dir of FIXTURE_DIRS) {
        fs.mkdirSync(path.join(controlRoot, ...dir.split("/")), { recursive: true });
      }
      for (const file of FIXTURE_FILES) {
        const parts = file.rel.split("/");
        fs.copyFileSync(path.join(sourceRoot, ...parts), path.join(controlRoot, ...parts));
      }
    } catch (err) {
      controlThrew = diagErrno(err);
    }
    observed[c.key].control = { threw: controlThrew, lines: observeOwnedTree(controlRoot) };
  }

  // 4. POST snapshot: the source must be byte-identical to the PRE snapshot.
  sourceLinesAfter = observeOwnedTree(sourceRoot);
}

/**
 * Remove only the root this file created, identified by its own prefix. A
 * cleanup failure IS a result: the surviving root holds the very Unicode-named
 * directories under test. Returns a `CLEANUP_REASON_ENUM` token, or `ok`.
 */
function cleanup() {
  if (!tmpRoot) return "no-root";
  if (!path.basename(tmpRoot).startsWith(TMP_PREFIX)) return "unowned-root";
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    return "rm(" + diagErrno(err) + ")";
  }
  // `rmSync` returning is not proof the root is gone.
  const residual = entryTypeOf(tmpRoot);
  return residual === "absent" ? "ok" : "residual(" + residual + ")";
}

// ── Report ───────────────────────────────────────────────────────────────────

const out = [];
function say(line) {
  out.push(line);
}

try {
  measure();
} catch (err) {
  setupError = diagErrno(err) === "none" ? "other" : diagErrno(err);
}

const failures = [];

say("cp1172br diagnose-native-unicode-copy");
say("runtime=plain-node runner=none fs-patched=no");
say("node=" + process.versions.node + " platform=" + process.platform + " arch=" + process.arch);
say("setupError=" + (setupError === null ? "none" : setupError));
if (setupError !== null) failures.push("setup(" + setupError + ")");

// Source PRE/POST — the copies must not have touched the source.
say("");
say("source PRE");
for (const line of sourceLinesBefore || ["unmeasured"]) say("  " + line);
say("source POST");
for (const line of sourceLinesAfter || ["unmeasured"]) say("  " + line);
if (!sameLines(sourceLinesBefore, EXPECTED_SOURCE_LINES)) failures.push("source-pre-mismatch");
if (!sameLines(sourceLinesAfter, EXPECTED_SOURCE_LINES)) failures.push("source-post-mismatch");

// Cross-arm summary first, so it survives even a long per-arm listing.
say("");
say("arms");
for (const c of CASES) {
  for (const arm of ARM_ENUM) {
    const rec = (observed[c.key] || {})[arm];
    say(
      "  " +
        [
          "case=" + diagEnum(c.key, CASE_KEY_ENUM),
          "nonAscii=" + (c.nonAscii ? "true" : "false"),
          "arm=" + diagEnum(arm, ARM_ENUM),
          "threw=" + (rec ? rec.threw : "none"),
          "entries=" + diagInt(rec ? rec.lines.filter((l) => l.startsWith("rel=")).length : null),
          "files=" + diagInt(rec ? rec.lines.filter((l) => l.includes("type=file")).length : null),
          "match=" + (rec ? (sameLines(rec.lines, EXPECTED_ARM_LINES[arm]) ? "true" : "false") : "none"),
        ].join(" ")
    );
  }
}

// Per-arm detail, every case, then the verdict. Nothing is skipped because an
// earlier case was red.
for (const c of CASES) {
  say("");
  say("case=" + diagEnum(c.key, CASE_KEY_ENUM) + " nonAscii=" + (c.nonAscii ? "true" : "false"));
  for (const arm of ARM_ENUM) {
    const rec = (observed[c.key] || {})[arm];
    say("  arm=" + diagEnum(arm, ARM_ENUM) + (arm === "control" ? " (DIAGNOSTIC control)" : ""));
    if (!rec) {
      say("    unmeasured");
      failures.push("missing-arm:" + c.key + "/" + arm);
      continue;
    }
    say("    threw=" + rec.threw);
    for (const line of rec.lines) say("    " + line);
    for (const line of rec.leaves || []) say("    " + line);
    if (rec.threw !== "none") failures.push("threw:" + c.key + "/" + arm + "(" + rec.threw + ")");
    if (!sameLines(rec.lines, EXPECTED_ARM_LINES[arm])) {
      failures.push("mismatch:" + c.key + "/" + arm);
    }
  }
}

const cleanupReason = cleanup();
say("");
say("cleanup=" + (cleanupReason === "ok" ? "ok" : diagEnum(cleanupReason, CLEANUP_REASON_ENUM)));
if (cleanupReason !== "ok") failures.push("cleanup(" + cleanupReason + ")");

say("");
say("expected-per-arm entries=" + diagInt(EXPECTED_PAYLOAD_LINES.length) + " leaf-entries=" + diagInt(EXPECTED_LEAF_LINES.length));
say("verdict=" + (failures.length === 0 ? "ok" : "discrepancy") + " failures=" + diagInt(failures.length));
for (const f of failures) say("  failure=" + f);
say(
  failures.length === 0
    ? "cp1172br: every arm landed exactly under every segment in a plain node process."
    : "cp1172br: discrepancy observed in a plain node process (no test runner, fs unpatched)."
);
say("cp1172br: this measures WHAT happened only. No mechanism is established or claimed.");

process.stdout.write(out.join("\n") + "\n");
process.exit(failures.length === 0 ? 0 : 1);
