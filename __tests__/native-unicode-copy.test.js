// cp1172br — native Unicode destination copy: one reduced decisive reproduction
//
// WHAT THIS MEASURES
// ------------------
// The win22 native CI run (36080334629) recorded, via the encoded-install
// fixture's own bracketing observations, that `fs.cpSync(src, dst,
// {recursive:true})` RETURNED without throwing while three required source
// leaves did not land under the destination. It happened under exactly two of
// the six destination segments — the two whose name contains non-ASCII
// characters — and under no other segment (space, literal percent, hash and
// plain ASCII all landed). The source leaves were observed as `file` both
// before and after the call.
//
// That is a SYMPTOM. It is not, and must not be read as, a Node or libuv root
// cause: nothing here measures why. Every prior CONFIRMED claim about a
// mechanism (codepage, Unicode normalisation, a Node 22 behaviour change) is a
// hypothesis until it is reproduced directly, and none of them is reproduced
// here. No product code is touched by this file.
//
// WHY THIS IS A REDUCTION OF THE CI CASE
// --------------------------------------
// The CI failure travelled through: a real product payload read from
// package.json, a symlinked node_modules graph, a spawned MCP server child, a
// stdio handshake and a resolver probe. None of that is needed to observe the
// copy. This file removes all of it and keeps only `fs.cpSync` against a
// synthetic, owned, fixed-size nested tree, so a failure has exactly one
// candidate cause left: the copy itself against that destination segment.
//
// WHAT IS SYNTHETIC vs OBSERVED
// -----------------------------
// Synthetic: the whole source tree (five small fixed-content files laid out in
// the same `lib/` + `selectors/roles/` nesting shape the product payload has),
// and the owned temporary roots. Observed: what `fs.cpSync` actually does, read
// back with `readdirSync` + `readFileSync` over the owned destination only.
//
// The synthetic file BODIES are deliberately pure ASCII. Only the destination
// directory SEGMENT carries non-ASCII characters, so a content-encoding effect
// can never be mistaken for a path-encoding effect.
//
// DELIBERATE NON-BEHAVIOURS
// -------------------------
//   * No path is normalised, re-encoded or re-spelled — not by `path.normalize`,
//     not by `String.prototype.normalize`. The segment literals below are
//     written out exactly as the CI fixture writes them; normalising either side
//     would destroy the very case under test.
//   * Nothing is retried and no missing file is ever re-copied. A failed arm
//     stays failed.
//   * No OS and no Node version is skipped, and no deadline is raised. This test
//     carries no custom timeout: it is expected to be fast everywhere, and on a
//     platform where the defect is live it must FAIL, not opt out.
//   * The per-file `copyFileSync` arm is a DIAGNOSTIC CONTROL against its own
//     separate destination directory. It never writes into, completes or repairs
//     the `cpSync` destination, so it cannot mask a failed `cpSync` arm.
//   * Every arm is executed and recorded BEFORE any assertion runs, so a failing
//     `cpSync` arm cannot prevent the controls from being collected and shown.
//
// BOUNDED OUTPUT
// --------------
// Everything this file can print on failure is a closed set: a case key, an arm
// name, a tree-relative path resolved against the literal list of entries this
// file created, an entry type, an integer byte count, an allowlisted errno, and
// a 12-hex-character prefix of a sha256 taken over content this file authored.
// No absolute path, no host directory listing and no file body ever reaches an
// assertion message.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Destination cases ────────────────────────────────────────────────────────
//
// These six segment literals are duplicated from the CI fixture's
// ENCODED_PATH_CASES ON PURPOSE. This test must be self-contained (it is run
// standalone by the existing 9-way native CI, with no helper on its import
// path), and importing the fixture would also drag in a spawned child and a
// node_modules requirement that this reduction exists to remove. They are
// copied byte for byte so that a pass here and a failure there cannot be
// explained by a different string.
const CASES = Object.freeze([
  { key: "ordinary", segment: "plain-ascii-install", nonAscii: false },
  { key: "spaces", segment: "install dir with spaces", nonAscii: false },
  { key: "non-ascii", segment: "설치경로-한글", nonAscii: true },
  { key: "literal-percent", segment: "install-100%-done", nonAscii: false },
  { key: "hash", segment: "install#1-hash", nonAscii: false },
  { key: "combined", segment: "en coded 한글 100%tested #1", nonAscii: true },
]);
const CASE_KEY_ENUM = Object.freeze(CASES.map((c) => c.key));

// ── The three arms ───────────────────────────────────────────────────────────
//
//   recursive — the call the CI failure came from: one `cpSync` per payload
//               entry, `{recursive:true}`, source is a DIRECTORY.
//   leaf      — the same call with a single FILE as source. Recursion is the
//               only thing that differs, so this separates "recursive descent
//               under a Unicode destination" from "any write under a Unicode
//               destination".
//   control   — same source, NEW destination, per-file `copyFileSync` after an
//               explicit `mkdirSync`. Diagnostic only.
const ARM_ENUM = Object.freeze(["recursive", "leaf", "control"]);

// ── Synthetic source tree (fixed data) ───────────────────────────────────────
//
// Same nesting shape as the product payload the CI case copied (a flat `lib/`
// and a `selectors/` with a nested `roles/`), and it carries the three leaf
// NAMES the win22 log named — `lib/speaker-discovery.js`,
// `selectors/role-presets.json`, `selectors/roles/critic.md` — so the arms
// below are directly comparable with that log. The contents are this file's
// own invention and resemble the product only in shape.
const FIXTURE_FILES = Object.freeze([
  { rel: "lib/session.js", body: 'export const SESSION_KIND = "cp1172br-fixture";\n' },
  { rel: "lib/speaker-discovery.js", body: 'export const SPEAKERS = ["critic", "analyst"];\n' },
  { rel: "selectors/role-presets.json", body: '{\n  "presets": {\n    "critic": ["critic"]\n  }\n}\n' },
  { rel: "selectors/roles/analyst.md", body: "# analyst\n\ncp1172br synthetic role prompt.\n" },
  { rel: "selectors/roles/critic.md", body: "# critic\n\ncp1172br synthetic role prompt.\n" },
]);
// Directories the tree above implies, innermost last.
const FIXTURE_DIRS = Object.freeze(["lib", "selectors", "selectors/roles"]);
// Top-level entries copied one at a time, exactly as the CI fixture iterates
// its payload.
const PAYLOAD_ENTRIES = Object.freeze(["lib", "selectors"]);
// The single file the `leaf` arm copies, and the basename it lands under.
const LEAF_SOURCE_REL = "lib/speaker-discovery.js";
const LEAF_DEST_NAME = "speaker-discovery.js";

// Every tree-relative name this file can legitimately observe. Anything else
// collapses to `other` rather than being echoed.
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

// A destination tree this file built holds 8 entries; the leaf arm holds 1.
// The cap exists so that an unexpected explosion is reported as a count rather
// than as an unbounded listing.
const MAX_ENTRIES = 64;
// Nothing this file writes is larger than a few hundred bytes. A larger file
// under an owned destination is reported by size and never read.
const MAX_READ_BYTES = 64 * 1024;

const TMP_PREFIX = "cp1172br-native-unicode-copy-";

// Closed by construction: two structural literals, one `rm(<errno>)` token per
// allowlisted errno, and one `residual(<type>)` token per entry type. Anything
// outside this list collapses to `other` before it is printed.
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

/** An integer, else `none` (absent) / `other`. Never a free-form field. */
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

/** The expected line for a file this file authored. */
function expectedFileLine(rel, body) {
  const buf = Buffer.from(body, "utf-8");
  return entryLine({ rel, type: "file", bytes: buf.length, hash: sha12(buf) });
}

/** The expected line for a directory this file authored. */
function expectedDirLine(rel) {
  return entryLine({ rel, type: "dir", bytes: null, hash: null });
}

// Expected content of a full payload destination (`recursive` and `control`),
// and of the single-file destination (`leaf`). Sorted by the same key the
// observer sorts by, so the comparison is order-independent in practice but
// still a plain array equality.
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
// What the SOURCE must still look like after every arm has run.
const EXPECTED_SOURCE_LINES = EXPECTED_PAYLOAD_LINES;

// ── Owned-tree observation ───────────────────────────────────────────────────

/**
 * Enumerate `root`, which this file created, and describe every entry as a
 * closed-token line. Read-only: `readdirSync` + `readFileSync`, never a write,
 * never a copy, never a retry. Descent stays inside `root` by construction (it
 * walks dirents it just read); a symlink is recorded as `link` and NOT
 * followed, so no traversal can leave the owned root.
 *
 * `MAX_ENTRIES` is enforced per ENTRY — inside the dirent loop as well as
 * between directories — because one directory can hold more entries than the
 * cap on its own, and a check that only runs between directories would let it
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
      // The cap is enforced HERE as well as at the top of the outer loop: a
      // single directory can hold more than `MAX_ENTRIES` dirents on its own,
      // and the outer check alone would let one such directory push every one
      // of them before it is ever re-tested. Bounding only between directories
      // is not bounding.
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

// ── Collected state ──────────────────────────────────────────────────────────

let tmpRoot = null;
let sourceRoot = null;
let setupError = null;
/** caseKey -> armName -> { threw, lines, leafTypes } */
const observed = Object.create(null);
let sourceLinesBefore = null;
let sourceLinesAfter = null;

/**
 * Per-arm cross-arm summary, printed alongside every failing assertion so the
 * controls survive in the output of a failing `cpSync` arm. Closed tokens only.
 */
function armSummary() {
  const rows = [];
  for (const c of CASES) {
    for (const arm of ARM_ENUM) {
      const rec = (observed[c.key] || {})[arm];
      rows.push(
        [
          "case=" + diagEnum(c.key, CASE_KEY_ENUM),
          "nonAscii=" + (c.nonAscii ? "true" : "false"),
          "arm=" + diagEnum(arm, ARM_ENUM),
          "threw=" + (rec ? rec.threw : "none"),
          "entries=" + diagInt(rec ? rec.lines.filter((l) => l.startsWith("rel=")).length : null),
          "files=" + diagInt(rec ? rec.lines.filter((l) => l.includes("type=file")).length : null),
        ].join(" ")
      );
    }
  }
  return "cp1172br arms\n" + rows.join("\n");
}

beforeAll(() => {
  try {
    tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), TMP_PREFIX));
    sourceRoot = path.join(tmpRoot, "source");

    // 1. Materialise the synthetic source tree.
    for (const dir of FIXTURE_DIRS) {
      fs.mkdirSync(path.join(sourceRoot, ...dir.split("/")), { recursive: true });
    }
    for (const file of FIXTURE_FILES) {
      fs.writeFileSync(path.join(sourceRoot, ...file.rel.split("/")), file.body);
    }

    // 2. Snapshot the source BEFORE any copy touches it.
    sourceLinesBefore = observeOwnedTree(sourceRoot);

    // 3. Run every arm of every case. Each arm is fully guarded, so a throw in
    //    one arm cannot stop a later arm from being collected, and no arm is
    //    retried or repaired.
    for (const c of CASES) {
      const caseRoot = path.join(tmpRoot, "dest", c.segment);
      observed[c.key] = Object.create(null);

      // ── arm: recursive ──────────────────────────────────────────────────
      // The CI call, unchanged: one cpSync per payload entry, recursive, into
      // a destination whose path contains this case's segment.
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
      };

      // ── arm: leaf ───────────────────────────────────────────────────────
      // Same call, single FILE source. Isolates recursion.
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

      // ── arm: control (DIAGNOSTIC) ───────────────────────────────────────
      // Same source, a DIFFERENT destination directory under the same segment,
      // written per file with mkdirSync + copyFileSync. This never touches the
      // `recursive` or `leaf` destinations, so it cannot complete or repair a
      // failed arm; it only says whether per-file writes land under a segment
      // where the recursive copy did not.
      const controlRoot = path.join(caseRoot, "control");
      let controlThrew = "none";
      try {
        for (const dir of FIXTURE_DIRS) {
          fs.mkdirSync(path.join(controlRoot, ...dir.split("/")), { recursive: true });
        }
        for (const file of FIXTURE_FILES) {
          const parts = file.rel.split("/");
          fs.copyFileSync(
            path.join(sourceRoot, ...parts),
            path.join(controlRoot, ...parts)
          );
        }
      } catch (err) {
        controlThrew = diagErrno(err);
      }
      observed[c.key].control = { threw: controlThrew, lines: observeOwnedTree(controlRoot) };
    }

    // 4. Snapshot the source AFTER every arm has run.
    sourceLinesAfter = observeOwnedTree(sourceRoot);
  } catch (err) {
    // Setup itself failed. Record it as a closed token and let the assertions
    // report it; never swallow it into a pass.
    setupError = diagErrno(err) === "none" ? "other" : diagErrno(err);
  }
});

afterAll(() => {
  // Remove only the root this file created, identified by its own prefix.
  //
  // A cleanup failure IS a result, not housekeeping. The root that survives is
  // the one holding the very Unicode-named directories under test, so
  // swallowing the error would let the run go green while leaving them on the
  // runner — and would hide exactly the class of fs behaviour this file exists
  // to measure. The reason is a closed token (`CLEANUP_REASON_ENUM`): two
  // structural literals, an allowlisted errno, or an entry type. No absolute
  // path and no fs error message escapes.
  let reason = "ok";
  if (!tmpRoot) {
    reason = "no-root";
  } else if (!path.basename(tmpRoot).startsWith(TMP_PREFIX)) {
    // Still refuse to delete a root this file cannot prove it owns — but say
    // so, rather than returning quietly as before.
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
      "cp1172br owned-root cleanup failed (reason="
      + diagEnum(reason, CLEANUP_REASON_ENUM) + ")"
    );
  }
});

describe("cp1172br native Unicode destination copy", () => {
  it("collects every arm before asserting", () => {
    expect(setupError, armSummary()).toBe(null);
    for (const c of CASES) {
      for (const arm of ARM_ENUM) {
        expect(
          observed[c.key] && observed[c.key][arm],
          "missing arm " + diagEnum(c.key, CASE_KEY_ENUM) + "/" + diagEnum(arm, ARM_ENUM)
        ).toBeTruthy();
      }
    }
  });

  it("leaves the source tree byte-identical after every copy", () => {
    expect(sourceLinesBefore, armSummary()).toEqual(EXPECTED_SOURCE_LINES);
    expect(sourceLinesAfter, armSummary()).toEqual(EXPECTED_SOURCE_LINES);
  });

  it("lands the exact recursive cpSync tree under every destination segment", () => {
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      actual[c.key] = observed[c.key].recursive.lines;
      expected[c.key] = [...EXPECTED_PAYLOAD_LINES];
    }
    expect(actual, armSummary()).toEqual(expected);
  });

  it("reports no throw from the recursive cpSync arm", () => {
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      actual[c.key] = observed[c.key].recursive.threw;
      expected[c.key] = "none";
    }
    expect(actual, armSummary()).toEqual(expected);
  });

  it("lands the single-file cpSync arm under every destination segment", () => {
    // Separates "recursive descent under this segment" from "any cpSync write
    // under this segment": if this arm lands where the recursive arm did not,
    // recursion is implicated; if both fail, the segment is.
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      actual[c.key] = observed[c.key].leaf.lines;
      expected[c.key] = [...EXPECTED_LEAF_LINES];
    }
    expect(actual, armSummary()).toEqual(expected);
  });

  it("DIAGNOSTIC control: per-file copyFileSync to a separate destination", () => {
    // Reported, not relied upon. This destination is never read by, merged
    // into, or substituted for the cpSync destinations above.
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      actual[c.key] = observed[c.key].control.lines;
      expected[c.key] = [...EXPECTED_PAYLOAD_LINES];
    }
    expect(actual, armSummary()).toEqual(expected);
  });

  it("observes each named leaf as a file under every recursive destination", () => {
    // The three leaf names the win22 log reported, asserted by name so a
    // failure here lines up one-to-one with those log lines.
    const named = [
      "lib/speaker-discovery.js",
      "selectors/role-presets.json",
      "selectors/roles/critic.md",
    ];
    const actual = Object.create(null);
    const expected = Object.create(null);
    for (const c of CASES) {
      const recursiveRoot = path.join(tmpRoot, "dest", c.segment, "recursive");
      actual[c.key] = named.map(
        (leaf) =>
          "leaf=" + diagEnum(leaf, TREE_REL_ENUM) +
          " src=" + diagEnum(entryTypeOf(path.join(sourceRoot, ...leaf.split("/"))), ENTRY_TYPE_ENUM) +
          " dst=" + diagEnum(entryTypeOf(path.join(recursiveRoot, ...leaf.split("/"))), ENTRY_TYPE_ENUM)
      );
      expected[c.key] = named.map(
        (leaf) => "leaf=" + diagEnum(leaf, TREE_REL_ENUM) + " src=file dst=file"
      );
    }
    expect(actual, armSummary()).toEqual(expected);
  });
});
