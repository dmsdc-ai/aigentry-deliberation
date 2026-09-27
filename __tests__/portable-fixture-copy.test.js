/**
 * aw1172bs — regressions for `helpers/portable-fixture-copy.js`.
 *
 * MEASURES: that `copyFixtureEntry` reproduces a declared source payload
 * EXACTLY — same relative paths, same bytes, same shape including empty
 * directories, same executable bit where that is meaningful — under destination
 * segments carrying a space, non-ASCII characters, a literal percent sign, a hash
 * and all of those at once; and that every case its contract refuses is refused
 * loudly, before any write, with the source left untouched.
 *
 * DOES NOT MEASURE: `fs.cpSync`. A green run here says the FIXTURE copy is
 * portable. It says nothing about the native recursive copy, which is measured
 * only by `native-unicode-copy.test.js`, and it does not make a release ready.
 *
 * OWNED AND SELF-CONTAINED: every byte copied here was written here, inside one
 * temp root this file creates and removes. No product file, no host data, no
 * network, no child process. Source bodies are ASCII plus one deliberately
 * byte-hostile blob (CR, LF, NUL, high bytes); only PATH segments carry
 * non-ASCII, so a content-encoding effect can never be mistaken for a
 * path-encoding effect.
 *
 * BOUNDED OUTPUT: assertions compare manifests of relative paths this file
 * created, byte counts and sha256 digests over content it authored. No absolute
 * path and no fs error message reaches an assertion; a caught error is reduced to
 * its closed-set `reason` or its `code`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  copyFixtureEntry,
  FixtureCopyError,
  FIXTURE_COPY_REASONS,
} from "./helpers/portable-fixture-copy.js";

const IS_WIN = process.platform === "win32";
const LINK_TYPE = IS_WIN ? "junction" : "dir";
const TMP_PREFIX = "aw1172bs-portable-fixture-copy-";

// The six segment literals are duplicated from `ENCODED_PATH_CASES` in
// `helpers/encoded-install-fixture.js` ON PURPOSE, byte for byte, so a pass here
// and a failure there cannot be explained by a different string. They are not
// imported: that helper would drag a spawned child and a node_modules
// requirement into a test that needs neither.
const SEGMENTS = Object.freeze([
  { key: "ordinary", segment: "plain-ascii-install" },
  { key: "spaces", segment: "install dir with spaces" },
  { key: "non-ascii", segment: "설치경로-한글" },
  { key: "literal-percent", segment: "install-100%-done" },
  { key: "hash", segment: "install#1-hash" },
  { key: "combined", segment: "en coded 한글 100%tested #1" },
]);

// Byte-hostile on purpose: CRLF that must not be rewritten, a NUL, and bytes
// that are not valid UTF-8 on their own.
const BINARY_BODY = Buffer.from([
  0x00, 0x0d, 0x0a, 0x41, 0xff, 0xfe, 0x0d, 0x0a, 0x00, 0x80, 0x7f,
]);

// Same nesting shape as the product payload the fixtures copy (a flat `lib/` and
// a `selectors/` with a nested `roles/`), plus the two things a recursive copy
// gets wrong most quietly: an empty directory, and a leaf whose NAME is
// non-ASCII.
const FIXTURE_FILES = Object.freeze([
  { rel: "lib/session.js", body: Buffer.from('export const KIND = "aw1172bs";\n') },
  { rel: "lib/speaker-discovery.js", body: Buffer.from('export const SPEAKERS = ["critic"];\n') },
  { rel: "lib/한글-이름.md", body: Buffer.from("# aw1172bs non-ascii leaf name\n") },
  { rel: "lib/blob.bin", body: BINARY_BODY },
  { rel: "selectors/role-presets.json", body: Buffer.from('{\n  "presets": {}\n}\n') },
  { rel: "selectors/roles/critic.md", body: Buffer.from("# critic\n") },
  { rel: "session-monitor.sh", body: Buffer.from("#!/bin/sh\nexit 0\n"), exec: true },
]);
const FIXTURE_DIRS = Object.freeze([
  "lib",
  "selectors",
  "selectors/roles",
  "empty",
  "selectors/empty-nested",
]);

const FS_ERROR_ENUM = Object.freeze([
  "ENOENT", "EACCES", "EPERM", "EEXIST", "EISDIR", "ENOTDIR", "EBUSY",
  "ENOSPC", "ENAMETOOLONG", "EINVAL", "ELOOP", "EXDEV",
]);

let tmpRoot = null;
let sourceRoot = null;

// ── Fixture construction and observation ─────────────────────────────────────

function abs(root, rel) {
  return rel === "" ? root : path.join(root, ...rel.split("/"));
}

/** Materialise the declared tree under `root`. Owned, fixed content. */
function writeSourceTree(root) {
  for (const dir of FIXTURE_DIRS) fs.mkdirSync(abs(root, dir), { recursive: true });
  for (const file of FIXTURE_FILES) {
    const target = abs(root, file.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.body);
    if (file.exec && !IS_WIN) fs.chmodSync(target, 0o755);
  }
}

/**
 * One sorted manifest line per entry under `root`: relative path (always with
 * `/`, so win32 and POSIX manifests compare), entry type, byte count, sha256 of
 * the content, and the executable bit where it is meaningful. Read-only
 * (`readdirSync` + `lstatSync` + `readFileSync`); a symlink is recorded as `link`
 * and never followed, so observation cannot leave `root`.
 */
function manifestOf(root) {
  const lines = [];
  const pending = [""];
  while (pending.length > 0) {
    const rel = pending.shift();
    const dirents = fs.readdirSync(abs(root, rel), { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      const childRel = rel === "" ? dirent.name : rel + "/" + dirent.name;
      const childAbs = abs(root, childRel);
      if (dirent.isSymbolicLink()) {
        lines.push(`rel=${childRel} type=link`);
        continue;
      }
      if (dirent.isDirectory()) {
        lines.push(`rel=${childRel} type=dir`);
        pending.push(childRel);
        continue;
      }
      if (!dirent.isFile()) {
        lines.push(`rel=${childRel} type=other`);
        continue;
      }
      const stats = fs.lstatSync(childAbs);
      const buf = fs.readFileSync(childAbs);
      lines.push(
        `rel=${childRel} type=file bytes=${buf.length}`
        + ` sha256=${crypto.createHash("sha256").update(buf).digest("hex")}`
        + ` exec=${execBitOf(stats)}`
      );
    }
  }
  return lines.sort();
}

/**
 * The executable bit, or `n/a` on win32 where a fixture's permission bits are not
 * meaningful and the helper deliberately leaves them to the platform.
 */
function execBitOf(stats) {
  if (IS_WIN) return "n/a";
  return (stats.mode & 0o111) !== 0 ? "true" : "false";
}

/** The manifest the source tree must produce, computed from its declaration. */
function expectedManifest() {
  const lines = [
    ...FIXTURE_DIRS.map((rel) => `rel=${rel} type=dir`),
    ...FIXTURE_FILES.map(
      (file) =>
        `rel=${file.rel} type=file bytes=${file.body.length}`
        + ` sha256=${crypto.createHash("sha256").update(file.body).digest("hex")}`
        + ` exec=${IS_WIN ? "n/a" : file.exec ? "true" : "false"}`
    ),
  ];
  return lines.sort();
}

/** A fresh owned directory under the temp root, named by the caller. */
function ownedDir(...parts) {
  const dir = path.join(tmpRoot, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The refusal reason of a caught error, as a closed token. */
function reasonOf(err) {
  if (!(err instanceof FixtureCopyError)) return "not-a-refusal";
  return FIXTURE_COPY_REASONS.includes(err.reason) ? err.reason : "other";
}

/** Run `fn`, return the thrown error, or `null` if it returned. */
function caught(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

beforeAll(() => {
  // The temp root is canonicalised so that the containment rules under test are
  // exercised against real paths rather than against a platform temp link.
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), TMP_PREFIX));
  sourceRoot = path.join(tmpRoot, "source");
  writeSourceTree(sourceRoot);
});

afterAll(() => {
  // Remove only the root this file created, identified by its own prefix, and
  // report a cleanup failure rather than swallowing it: the roots under test
  // carry the very non-ASCII directory names this file exercises.
  if (!tmpRoot) throw new Error("aw1172bs cleanup: no owned root was recorded");
  if (!path.basename(tmpRoot).startsWith(TMP_PREFIX)) {
    throw new Error("aw1172bs cleanup: refusing to remove a root it cannot prove it owns");
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (fs.existsSync(tmpRoot)) throw new Error("aw1172bs cleanup: owned root survived removal");
});

// ── Apparatus ────────────────────────────────────────────────────────────────

describe("aw1172bs apparatus", () => {
  it("materialises the declared source tree exactly", () => {
    expect(manifestOf(sourceRoot)).toEqual(expectedManifest());
  });

  it("declares an empty directory and a non-ASCII leaf name, so the copy must carry both", () => {
    expect(fs.readdirSync(path.join(sourceRoot, "empty"))).toEqual([]);
    expect(FIXTURE_FILES.some((f) => /[^\u0000-\u007f]/.test(f.rel))).toBe(true);
  });
});

// ── The regression: exact content under every destination segment ────────────

describe("copyFixtureEntry lands the exact tree under every destination segment", () => {
  for (const { key, segment } of SEGMENTS) {
    it(`${key}: manifest and hashes match the source`, () => {
      const dest = path.join(ownedDir("dest", segment), "payload");
      const summary = copyFixtureEntry(sourceRoot, dest);

      expect(manifestOf(dest)).toEqual(expectedManifest());
      expect(manifestOf(dest)).toEqual(manifestOf(sourceRoot));
      expect(summary.files).toBe(FIXTURE_FILES.length);
      // Every declared directory plus the destination root itself.
      expect(summary.dirs).toBe(FIXTURE_DIRS.length + 1);
      expect(summary.entries).toBe(summary.files + summary.dirs);
      // The empty directories are directories at the destination, not absences.
      expect(fs.lstatSync(path.join(dest, "empty")).isDirectory()).toBe(true);
      expect(fs.readdirSync(path.join(dest, "empty"))).toEqual([]);
    });

    it(`${key}: copies a single declared file under the same segment`, () => {
      const dest = path.join(ownedDir("dest-leaf", segment), "nested", "blob.bin");
      const summary = copyFixtureEntry(path.join(sourceRoot, "lib", "blob.bin"), dest);

      expect(summary).toEqual({ files: 1, dirs: 0, entries: 1 });
      expect(fs.readFileSync(dest).equals(BINARY_BODY)).toBe(true);
    });
  }

  it("leaves the source byte-identical after every copy above", () => {
    expect(manifestOf(sourceRoot)).toEqual(expectedManifest());
  });

  it("is deterministic: a second copy of the same source produces the same manifest", () => {
    const first = path.join(ownedDir("determinism"), "a");
    const second = path.join(ownedDir("determinism"), "b");
    copyFixtureEntry(sourceRoot, first);
    copyFixtureEntry(sourceRoot, second);
    expect(manifestOf(first)).toEqual(manifestOf(second));
  });

  it("carries the executable bit where it is meaningful", () => {
    const dest = path.join(ownedDir("modes"), "payload");
    copyFixtureEntry(sourceRoot, dest);
    const script = fs.lstatSync(path.join(dest, "session-monitor.sh"));
    const plain = fs.lstatSync(path.join(dest, "lib", "session.js"));
    if (IS_WIN) {
      // Permission bits are not meaningful for a fixture on win32; the helper
      // says so and leaves them alone. Only the landing is asserted here.
      expect(script.isFile()).toBe(true);
      expect(plain.isFile()).toBe(true);
    } else {
      expect((script.mode & 0o111) !== 0).toBe(true);
      expect((plain.mode & 0o111) !== 0).toBe(false);
    }
  });
});

// ── Bounds are validated before anything is written ─────────────────────────

describe("copyFixtureEntry validates its bounds before any side effect", () => {
  const BAD_BOUNDS = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
    ["zero", 0],
    ["fractional", 1.5],
    ["string", "8"],
  ];

  for (const [label, value] of BAD_BOUNDS) {
    it(`refuses maxEntries=${label} without creating a destination`, () => {
      const dest = path.join(ownedDir("bad-entries", label), "payload");
      const err = caught(() => copyFixtureEntry(sourceRoot, dest, { maxEntries: value }));
      expect(reasonOf(err)).toBe("bad-bounds");
      expect(fs.existsSync(dest)).toBe(false);
    });

    it(`refuses maxDepth=${label} without creating a destination`, () => {
      const dest = path.join(ownedDir("bad-depth", label), "payload");
      const err = caught(() => copyFixtureEntry(sourceRoot, dest, { maxDepth: value }));
      expect(reasonOf(err)).toBe("bad-bounds");
      expect(fs.existsSync(dest)).toBe(false);
    });
  }

  it("counts the root directory against the entry budget", () => {
    // Budget 1 is spent by the destination root itself, so the first child is
    // refused — the root is not free.
    const dest = path.join(ownedDir("budget-root-dir"), "payload");
    const err = caught(() => copyFixtureEntry(sourceRoot, dest, { maxEntries: 1 }));
    expect(reasonOf(err)).toBe("entry-budget-exceeded");
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  it("counts a root file against the entry budget, and one entry is enough for it", () => {
    const okDest = path.join(ownedDir("budget-root-file"), "blob-ok.bin");
    const summary = copyFixtureEntry(path.join(sourceRoot, "lib", "blob.bin"), okDest, {
      maxEntries: 1,
    });
    expect(summary).toEqual({ files: 1, dirs: 0, entries: 1 });
    expect(fs.readFileSync(okDest).equals(BINARY_BODY)).toBe(true);
  });

  it("refuses a traversal past its declared depth", () => {
    const dest = path.join(ownedDir("depth"), "payload");
    const err = caught(() => copyFixtureEntry(sourceRoot, dest, { maxDepth: 1 }));
    expect(reasonOf(err)).toBe("depth-exceeded");
  });

  it("refuses a traversal past its declared entry budget", () => {
    const dest = path.join(ownedDir("budget"), "payload");
    const err = caught(() => copyFixtureEntry(sourceRoot, dest, { maxEntries: 2 }));
    expect(reasonOf(err)).toBe("entry-budget-exceeded");
  });
});

// ── Refusals: nothing silent, nothing partial-but-successful ─────────────────

describe("copyFixtureEntry refuses what its contract excludes", () => {
  it("refuses a missing source instead of skipping it", () => {
    const dest = path.join(ownedDir("missing"), "payload");
    const err = caught(() => copyFixtureEntry(path.join(sourceRoot, "no-such-entry"), dest));
    expect(reasonOf(err)).toBe("missing-source");
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("refuses a destination that is the source", () => {
    const err = caught(() => copyFixtureEntry(sourceRoot, sourceRoot));
    expect(reasonOf(err)).toBe("dest-aliases-source");
    expect(manifestOf(sourceRoot)).toEqual(expectedManifest());
  });

  it("refuses a destination that is the source under a different spelling", () => {
    // Same location, different strings. A plain `===` would miss all of these.
    const spellings = [
      sourceRoot + path.sep,
      sourceRoot + path.sep + "lib" + path.sep + "..",
      sourceRoot + path.sep + "." + path.sep,
    ];
    for (const dest of spellings) {
      expect(reasonOf(caught(() => copyFixtureEntry(sourceRoot, dest)))).toBe(
        "dest-aliases-source"
      );
    }
    expect(manifestOf(sourceRoot)).toEqual(expectedManifest());
  });

  it("refuses a destination nested inside the source", () => {
    const err = caught(() => copyFixtureEntry(sourceRoot, path.join(sourceRoot, "empty", "self")));
    expect(reasonOf(err)).toBe("dest-inside-source");
    expect(manifestOf(sourceRoot)).toEqual(expectedManifest());
  });

  it("refuses a destination that contains the source", () => {
    const err = caught(() => copyFixtureEntry(path.join(sourceRoot, "lib"), sourceRoot));
    expect(reasonOf(err)).toBe("source-inside-dest");
    expect(manifestOf(sourceRoot)).toEqual(expectedManifest());
  });

  it("refuses a relative path on either side, so it never reads the current directory", () => {
    const dest = path.join(ownedDir("relative"), "payload");
    expect(reasonOf(caught(() => copyFixtureEntry("source", dest)))).toBe("not-absolute");
    expect(reasonOf(caught(() => copyFixtureEntry(sourceRoot, "dest")))).toBe("not-absolute");
  });

  it("refuses a link as the source root, and does not follow it", () => {
    const outside = ownedDir("outside");
    fs.writeFileSync(path.join(outside, "outside-marker.txt"), "aw1172bs outside\n");
    const linkRoot = ownedDir("link-source");
    const link = path.join(linkRoot, "link-to-outside");
    fs.symlinkSync(outside, link, LINK_TYPE);

    const dest = path.join(ownedDir("link-source-dest"), "payload");
    const err = caught(() => copyFixtureEntry(link, dest));

    expect(reasonOf(err)).toBe("unsupported-source-entry");
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("refuses a link nested in the source, and never copies what it points at", () => {
    const outside = ownedDir("outside-nested");
    fs.writeFileSync(path.join(outside, "outside-marker.txt"), "aw1172bs outside\n");

    const linked = ownedDir("linked-source");
    fs.writeFileSync(path.join(linked, "plain.txt"), "aw1172bs plain\n");
    fs.symlinkSync(outside, path.join(linked, "zz-link"), LINK_TYPE);

    const dest = path.join(ownedDir("linked-dest"), "payload");
    const err = caught(() => copyFixtureEntry(linked, dest));

    expect(reasonOf(err)).toBe("unsupported-source-entry");
    expect(err.rel).toBe("zz-link");
    // The call threw, so it did not succeed — and what the link pointed at was
    // never reached: no marker from outside the source root landed anywhere.
    expect(manifestOf(dest).some((line) => line.includes("outside-marker.txt"))).toBe(false);
    expect(manifestOf(dest).some((line) => line.includes("type=link"))).toBe(false);
  });
});

// ── Destination aliasing: refused before any write ───────────────────────────

describe("copyFixtureEntry never writes through an existing destination entry", () => {
  it("refuses a destination that is already a plain file, leaving it untouched", () => {
    const dest = path.join(ownedDir("dest-exists-file"), "payload");
    fs.writeFileSync(dest, "aw1172bs pre-existing\n");
    const before = fs.readFileSync(dest);

    const err = caught(() => copyFixtureEntry(sourceRoot, dest));

    expect(reasonOf(err)).toBe("dest-exists");
    expect(fs.readFileSync(dest).equals(before)).toBe(true);
  });

  it("refuses a destination that is already a directory, leaving it untouched", () => {
    const dest = ownedDir("dest-exists-dir", "payload");
    const err = caught(() => copyFixtureEntry(sourceRoot, dest));
    expect(reasonOf(err)).toBe("dest-exists");
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  it("refuses a destination that is a link to the source, without touching the source", () => {
    // The dangerous case: the destination LOOKS fresh to a naive `===` alias
    // test, but writing through it would land inside the source tree.
    const before = manifestOf(sourceRoot);
    const modesBefore = FIXTURE_FILES.map(
      (f) => `${f.rel}:${fs.lstatSync(abs(sourceRoot, f.rel)).mode & 0o777}`
    );

    const dest = path.join(ownedDir("dest-link-to-source"), "payload");
    fs.symlinkSync(sourceRoot, dest, LINK_TYPE);

    const err = caught(() => copyFixtureEntry(sourceRoot, dest));

    expect(reasonOf(err)).toBe("dest-exists");
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(manifestOf(sourceRoot)).toEqual(before);
    expect(
      FIXTURE_FILES.map((f) => `${f.rel}:${fs.lstatSync(abs(sourceRoot, f.rel)).mode & 0o777}`)
    ).toEqual(modesBefore);
  });

  it("refuses a destination that is a link to an outside file, without touching that file", () => {
    const outside = ownedDir("dest-link-outside-target");
    const target = path.join(outside, "outside-marker.txt");
    fs.writeFileSync(target, "aw1172bs outside\n");
    const before = fs.readFileSync(target);
    const modeBefore = fs.lstatSync(target).mode & 0o777;

    const dest = path.join(ownedDir("dest-link-outside"), "blob.bin");
    fs.symlinkSync(target, dest);

    const err = caught(() => copyFixtureEntry(path.join(sourceRoot, "lib", "blob.bin"), dest));

    expect(reasonOf(err)).toBe("dest-exists");
    expect(fs.readFileSync(target).equals(before)).toBe(true);
    expect(fs.lstatSync(target).mode & 0o777).toBe(modeBefore);
  });

  it("refuses a destination placed inside the source through a linked ancestor", () => {
    // The destination path is lexically outside the source; its ancestor is a
    // link INTO the source, so the resolved location is inside it.
    const before = manifestOf(sourceRoot);
    const linkDir = ownedDir("dest-linked-ancestor");
    const ancestor = path.join(linkDir, "into-source");
    fs.symlinkSync(sourceRoot, ancestor, LINK_TYPE);

    const err = caught(() => copyFixtureEntry(sourceRoot, path.join(ancestor, "empty", "payload")));

    expect(reasonOf(err)).toBe("dest-inside-source");
    expect(manifestOf(sourceRoot)).toEqual(before);
  });

  it("refuses a destination that resolves onto the source through a linked ancestor", () => {
    const before = manifestOf(sourceRoot);
    const linkDir = ownedDir("dest-linked-alias");
    const ancestor = path.join(linkDir, "into-parent");
    fs.symlinkSync(path.dirname(sourceRoot), ancestor, LINK_TYPE);

    const err = caught(() =>
      copyFixtureEntry(sourceRoot, path.join(ancestor, path.basename(sourceRoot)))
    );

    expect(reasonOf(err)).toBe("dest-aliases-source");
    expect(manifestOf(sourceRoot)).toEqual(before);
  });

  it("still copies happily when a destination ancestor is merely a link elsewhere", () => {
    // A linked ancestor is RESOLVED, not refused: a platform temp root routinely
    // is one, and refusing it would break the callers rather than protect them.
    const real = ownedDir("linked-ancestor-real");
    const linkDir = ownedDir("linked-ancestor-view");
    const view = path.join(linkDir, "view");
    fs.symlinkSync(real, view, LINK_TYPE);

    const summary = copyFixtureEntry(sourceRoot, path.join(view, "payload"));

    expect(summary.files).toBe(FIXTURE_FILES.length);
    expect(manifestOf(path.join(real, "payload"))).toEqual(expectedManifest());
  });
});

// ── The CI failure shape, and error propagation ──────────────────────────────

describe("copyFixtureEntry does not trust a copy that returned", () => {
  it("never calls fs.cpSync", () => {
    // The whole point of the helper: the recursive builtin is not on its path.
    // `fs.cpSync` is replaced for the duration of ONE call and restored in
    // `finally`; nothing else in the process is touched.
    const dest = path.join(ownedDir("no-cpsync"), "payload");
    const original = fs.cpSync;
    let calls = 0;
    fs.cpSync = (...args) => {
      calls += 1;
      return original(...args);
    };
    try {
      copyFixtureEntry(sourceRoot, dest);
    } finally {
      fs.cpSync = original;
    }
    expect(calls).toBe(0);
    expect(manifestOf(dest)).toEqual(expectedManifest());
  });

  it("reports a copy that returned while nothing landed, instead of passing", () => {
    // The observed CI shape reduced to one call: a copy primitive that RETURNS
    // and writes nothing. The refusal must be `incomplete-copy` — not an errno
    // from some later operation on the file that was never created.
    const dest = path.join(ownedDir("silent-copy"), "payload");
    const original = fs.copyFileSync;
    fs.copyFileSync = () => {};
    let err;
    try {
      err = caught(() => copyFixtureEntry(sourceRoot, dest));
    } finally {
      fs.copyFileSync = original;
    }
    expect(reasonOf(err)).toBe("incomplete-copy");
  });

  it("reports a copy that landed the wrong number of bytes", () => {
    const dest = path.join(ownedDir("short-copy"), "payload");
    const original = fs.copyFileSync;
    fs.copyFileSync = (_src, target) => {
      fs.writeFileSync(target, "");
    };
    let err;
    try {
      err = caught(() => copyFixtureEntry(sourceRoot, dest));
    } finally {
      fs.copyFileSync = original;
    }
    expect(reasonOf(err)).toBe("incomplete-copy");
  });

  it("propagates an fs error unchanged, with its code intact", () => {
    // An intermediate destination segment is a regular file, so creating the
    // destination directory must fail in the platform's own terms. The exact
    // errno differs by platform; that it arrives as an fs error rather than a
    // contract refusal, and keeps its code, is the assertion.
    const blocker = path.join(ownedDir("propagate"), "blocker");
    fs.writeFileSync(blocker, "aw1172bs blocker\n");
    const err = caught(() => copyFixtureEntry(sourceRoot, path.join(blocker, "payload")));

    expect(err).not.toBeNull();
    expect(err instanceof FixtureCopyError).toBe(false);
    expect(FS_ERROR_ENUM.includes(err && err.code)).toBe(true);
  });
});

// ── No global state ─────────────────────────────────────────────────────────

describe("copyFixtureEntry touches no global state", () => {
  it("leaves the current directory and the environment as they were", () => {
    const cwdBefore = process.cwd();
    const envBefore = JSON.stringify(process.env);

    const dest = path.join(ownedDir("no-globals"), "payload");
    copyFixtureEntry(sourceRoot, dest);
    caught(() => copyFixtureEntry(path.join(sourceRoot, "no-such-entry"), dest));

    expect(process.cwd()).toBe(cwdBefore);
    expect(JSON.stringify(process.env)).toBe(envBefore);
  });
});
