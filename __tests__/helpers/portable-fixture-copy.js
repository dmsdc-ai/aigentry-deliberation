// aw1172bs — test-only portable fixture copy.
//
// PURPOSE
// -------
// Materialise a declared, owned source payload as a fixture by walking it here
// and copying one file at a time, so a fixture does not depend on a recursive
// `fs.cpSync`. (Why that matters is CI history; it lives in the task report, not
// in this file.) Nothing here ships: it is fixture support only.
//
// CONTRACT
// --------
// Accepted source: a plain FILE, or a plain DIRECTORY holding only plain files
// and plain directories, to any depth within `maxDepth`. Empty directories ARE
// copied — they are part of a payload's shape. File data is copied byte for
// byte; on POSIX the mode (so the executable bit) is carried, on win32
// permission bits are left to the platform because they are not meaningful for a
// fixture.
//
// Every destination path this helper writes MUST BE FRESH: `lstat` must report
// it absent. Nothing is ever overwritten, merged into, or written through an
// existing entry — which is how an existing destination symlink is refused
// before any copy or chmod touches it, rather than by sniffing its type. The
// destination's ancestors may be links (a platform temp directory routinely is);
// they are RESOLVED, and the containment rules below are then re-checked against
// the resolved path, so a link cannot smuggle the destination into the source.
//
// Refused, explicitly, by throwing `FixtureCopyError` with a `reason` from
// `FIXTURE_COPY_REASONS`, BEFORE any side effect where the check allows it:
//   * `bad-bounds`           — a bound that is not a safe integer >= 1
//   * `not-absolute`         — either path is relative
//   * `dest-aliases-source`  — same path, any spelling, lexically or resolved
//   * `dest-inside-source`, `source-inside-dest`
//   * `dest-ancestor-unresolvable` — the destination's existing prefix does not
//                              resolve (dangling or looping link)
//   * `dest-exists`          — a destination path is already present, in any form
//   * `missing-source`       — never a silent skip
//   * `unsupported-source-entry` — a symlink, socket, fifo, device or anything
//                              that is not a plain file or plain directory, at
//                              the root or at any depth. REFUSED, never
//                              followed, so the walk cannot leave the source.
//   * `depth-exceeded`, `entry-budget-exceeded` — bounds, counting the root
//   * `incomplete-copy`      — a copy returned but the destination file is
//                              absent or a different byte length
//   * `unsupported-dest-entry` — what landed is not the plain kind it must be
//
// Deliberate NON-behaviours, each of which would hide a defect:
//   * No `fs.cpSync`, recursive or otherwise.
//   * No retry; no second attempt at an entry that failed.
//   * No path normalisation, re-spelling or encoding substitution — not
//     `path.normalize`, not `String.prototype.normalize`. Names arrive from
//     `readdirSync` and are joined as they came. (`realpath` is used ONLY to
//     compare source and destination for containment, never to spell a path
//     that is read, created or copied.)
//   * No swallowed error: an fs error is rethrown UNCHANGED, `code` intact.
//   * No partial success: any refusal or fs failure throws, so a caller can
//     never read "copied" from a call that did not copy everything it walked.
//   * No global state: no `process.chdir`, no `process.env` write. Both paths
//     must be ABSOLUTE, so nothing depends on the current directory.
//
// DECLARED LIMITS
// ---------------
// This is a bounded helper for OWNED fixture trees, not a hostile-filesystem
// primitive. Its checks are observations taken before the corresponding write;
// it does not claim to be race-proof against a filesystem being mutated
// concurrently by something else, and the fresh-destination rule — not a type
// test — is what keeps a benign pre-existing link from being written through.
import fs from "node:fs";
import path from "node:path";

/** Every reason this module can refuse. A closed set, safe to print. */
export const FIXTURE_COPY_REASONS = Object.freeze([
  "bad-bounds",
  "not-absolute",
  "missing-source",
  "unsupported-source-entry",
  "unsupported-dest-entry",
  "dest-aliases-source",
  "dest-inside-source",
  "source-inside-dest",
  "dest-ancestor-unresolvable",
  "dest-exists",
  "depth-exceeded",
  "entry-budget-exceeded",
  "incomplete-copy",
]);

/** Bounds. A fixture payload is small; these are generous and finite. */
export const DEFAULT_MAX_DEPTH = 32;
export const DEFAULT_MAX_ENTRIES = 4096;

/** How far up the destination is probed for its existing prefix. */
const MAX_ANCESTOR_STEPS = 256;

/**
 * A refusal by this module's own contract, as opposed to an fs failure (which is
 * rethrown unchanged). `rel` is relative to the source root: the absolute roots
 * belong to the caller, are host-shaped, and callers print these messages.
 */
export class FixtureCopyError extends Error {
  constructor(reason, rel) {
    super(`portable fixture copy refused (reason=${reason} rel=${rel === "" ? "." : rel})`);
    this.name = "FixtureCopyError";
    this.reason = reason;
    this.rel = rel;
  }
}

function fail(reason, rel) {
  throw new FixtureCopyError(reason, rel);
}

/** A bound must be a safe integer of at least 1, so the contract cannot be voided. */
function checkBound(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail("bad-bounds", "");
  return value;
}

/** The first segment of `rel` — used to test containment, never to spell a path. */
function firstSegment(rel) {
  return rel.split(path.sep)[0];
}

/** `null`, or the containment reason why `src` and `dest` cannot be copied between. */
function containmentReason(src, dest) {
  const toDest = path.relative(src, dest);
  // "" means the two paths denote the same location, whatever their spelling.
  if (toDest === "") return "dest-aliases-source";
  if (!path.isAbsolute(toDest) && firstSegment(toDest) !== "..") return "dest-inside-source";
  const toSrc = path.relative(dest, src);
  if (toSrc !== "" && !path.isAbsolute(toSrc) && firstSegment(toSrc) !== "..") {
    return "source-inside-dest";
  }
  return null;
}

/** The deepest existing ancestor of `p` (never `p` itself). Bounded probe. */
function existingAncestorOf(p) {
  let current = path.dirname(p);
  for (let step = 0; step < MAX_ANCESTOR_STEPS; step += 1) {
    try {
      fs.lstatSync(current);
      return current;
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * `dest` re-expressed under the resolved form of its existing prefix, so
 * containment can be judged on the location the write would really reach. A
 * destination ancestor is allowed to be a link (platform temp roots are); it is
 * resolved, not refused.
 */
function resolvedDestOf(dest) {
  const anchor = existingAncestorOf(dest);
  let realAnchor;
  try {
    realAnchor = fs.realpathSync(anchor);
  } catch {
    fail("dest-ancestor-unresolvable", "");
  }
  const tail = path.relative(anchor, dest);
  return tail === "" ? realAnchor : path.join(realAnchor, tail);
}

/** `lstatSync(p)`, or `null` when absent. Any other fs error is rethrown. */
function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/** `lstatSync` of a source path; ENOENT is `missing-source`. Never `stat`: a link must read as a link. */
function lstatSource(p, rel) {
  const stats = lstatOrNull(p);
  if (stats === null) fail("missing-source", rel);
  return stats;
}

/** A destination path must be absent before it is written. */
function requireFreshDest(destAbs, rel) {
  if (lstatOrNull(destAbs) !== null) fail("dest-exists", rel);
}

/**
 * Copy one plain file, then prove it landed BEFORE touching its mode: a copy
 * primitive that returns without writing must surface as `incomplete-copy`, not
 * as a raw errno from a later `chmod`.
 */
function copyPlainFile(srcAbs, destAbs, rel, stats) {
  fs.copyFileSync(srcAbs, destAbs);
  const landed = lstatOrNull(destAbs);
  if (landed === null) fail("incomplete-copy", rel);
  if (landed.isSymbolicLink() || !landed.isFile()) fail("unsupported-dest-entry", rel);
  if (landed.size !== stats.size) fail("incomplete-copy", rel);
  // POSIX `copyFileSync` already carries the mode; restating it makes the
  // executable-bit guarantee explicit rather than incidental.
  if (process.platform !== "win32") fs.chmodSync(destAbs, stats.mode & 0o777);
}

/** Create `destAbs` as a fresh directory, then prove that is what it is. */
function makeFreshDir(destAbs, rel) {
  fs.mkdirSync(destAbs);
  const landed = lstatOrNull(destAbs);
  if (landed === null) fail("incomplete-copy", rel);
  if (landed.isSymbolicLink() || !landed.isDirectory()) fail("unsupported-dest-entry", rel);
}

/**
 * Copy the declared source payload entry `src` to `dest`.
 *
 * Deterministic: directory entries are walked in sorted name order, so two runs
 * over the same tree perform the same operations in the same sequence.
 *
 * @param {string} src absolute path to a plain file or plain directory
 * @param {string} dest absolute destination path, which must not exist
 * @param {{maxDepth?: number, maxEntries?: number}} [options]
 * @returns {{files: number, dirs: number, entries: number}} what was copied
 * @throws {FixtureCopyError} on any contract refusal
 */
export function copyFixtureEntry(src, dest, options = {}) {
  // Every check in this block runs BEFORE the first side effect.
  const maxDepth = checkBound(options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxEntries = checkBound(options.maxEntries ?? DEFAULT_MAX_ENTRIES);

  if (!path.isAbsolute(src) || !path.isAbsolute(dest)) fail("not-absolute", "");
  const lexical = containmentReason(src, dest);
  if (lexical) fail(lexical, "");

  const rootStats = lstatSource(src, "");
  if (rootStats.isSymbolicLink() || (!rootStats.isFile() && !rootStats.isDirectory())) {
    fail("unsupported-source-entry", "");
  }

  // Judge containment again on resolved locations, so a different spelling or a
  // linked ancestor cannot place the destination at or inside the source.
  const resolved = containmentReason(fs.realpathSync(src), resolvedDestOf(dest));
  if (resolved) fail(resolved, "");

  requireFreshDest(dest, "");

  // The root itself counts against the budget.
  let files = 0;
  let dirs = 0;
  const budgetFor = (rel) => {
    if (files + dirs >= maxEntries) fail("entry-budget-exceeded", rel);
  };

  if (rootStats.isFile()) {
    budgetFor("");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyPlainFile(src, dest, "", rootStats);
    return { files: 1, dirs: 0, entries: 1 };
  }

  budgetFor("");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  makeFreshDir(dest, "");
  dirs += 1;

  // Explicit stack: depth is a number this module controls, not a property of
  // the call stack.
  const pending = [""];
  while (pending.length > 0) {
    const rel = pending.shift();
    const srcDir = rel === "" ? src : path.join(src, rel);
    const destDir = rel === "" ? dest : path.join(dest, rel);

    const dirents = fs.readdirSync(srcDir, { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const dirent of dirents) {
      // Names are used exactly as `readdirSync` produced them.
      const childRel = rel === "" ? dirent.name : path.join(rel, dirent.name);
      const childSrc = path.join(srcDir, dirent.name);
      const childDest = path.join(destDir, dirent.name);

      budgetFor(childRel);
      if (childRel.split(path.sep).length > maxDepth) fail("depth-exceeded", childRel);
      requireFreshDest(childDest, childRel);

      if (dirent.isSymbolicLink()) fail("unsupported-source-entry", childRel);
      if (dirent.isDirectory()) {
        makeFreshDir(childDest, childRel);
        dirs += 1;
        pending.push(childRel);
        continue;
      }
      if (!dirent.isFile()) fail("unsupported-source-entry", childRel);

      // `lstat` again for size and mode; the dirent carries neither. A link that
      // appeared between the two reads is still refused, not followed.
      const childStats = lstatSource(childSrc, childRel);
      if (childStats.isSymbolicLink() || !childStats.isFile()) {
        fail("unsupported-source-entry", childRel);
      }
      copyPlainFile(childSrc, childDest, childRel, childStats);
      files += 1;
    }
  }

  return { files, dirs, entries: files + dirs };
}
