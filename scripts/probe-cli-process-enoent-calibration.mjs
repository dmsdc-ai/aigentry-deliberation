#!/usr/bin/env node
// np1172jc PROBE — native win32 ENOENT-shape calibration, OUTSIDE any test runner.
//
// WHY THIS FILE EXISTS
// --------------------
// `input/review-r2.md` §4 leaves exactly one question undecidable from source:
// whether `GetFileAttributesW` returns `INVALID_FILE_ATTRIBUTES` for a final path
// component containing `|`. libuv is agnostic to *why* that call fails
// (`uvproc-v22.c:231-239`), so every downstream claim — no `CreateProcessW`,
// `UV_ENOENT`, `pid 0`, and a shape indistinguishable from a genuinely
// unresolvable command — is conditional on it. Nothing in `input/` can settle it;
// only a real Windows kernel can.
//
// This file asks that one question and nothing else. It compares two `spawnSync`
// calls on the SAME runtime:
//
//   A = the approved fixed non-executable literal (a bare `|` in the final
//       component; there is no such path and `|` is not a legal filename char).
//   B = a genuinely absent absolute path inside a private temp directory this
//       file creates and owns, whose non-existence is VERIFIED before measuring.
//
// If A's observed shape is identical to B's, the literal behaves as an
// unresolvable command on native Windows. If it is not, it does not, and no
// product change may assume it does.
//
// SCOPE — PROBE ONLY, per the approval of 2026-09-27T06:26:01.456Z
// ---------------------------------------------------------------
// It MEASURES. It decides no contract, adopts nothing, and patches nothing.
// `lib/cli-process.js` stays byte-unchanged (`f29f71b3…`). Product adoption is
// gated on this evidence and is NOT in this revision.
//
// BOUNDS
// ------
//   * Node builtins only. No product import, no `cross-spawn`, no Vitest, no
//     dependency of any kind — nothing that could patch `child_process`.
//   * `win32` ONLY. On any other platform this exits NON-ZERO with a distinct
//     message, so a POSIX green can never be misread as calibration evidence.
//   * No shell, no `PATH` reliance, no `NUL`, no user-supplied command, no
//     arbitrary argument or path input. Both operands are fixed by this file:
//     `A` is the approved literal verbatim, `B` is derived from `mkdtempSync`.
//   * `B` is proven absent before it is measured: the leaf and its `.com`/`.exe`
//     siblings — the only suffixes libuv appends
//     (`path_search_walk_ext`, `uvproc-v22.c:246-283`) — must each be `ENOENT`.
//     If any one of them exists, nothing is measured and this exits non-zero.
//   * Identical bounded options on both sides, ONE attempt each, NO retry.
//   * Typed serialization only: a `typeof` plus a closed shape tag. No raw
//     stream bytes, no error message, no path, no env, no host listing is ever
//     printed — `err.path` and `err.message` carry the operand, so neither is
//     emitted, and `spawnargs` is empty by construction.
//   * The ENOENT errno is read from the RUNNING runtime's
//     `util.getSystemErrorMap()`. The `-4058` literal is never written here.
//   * Both calls are made and recorded BEFORE any verdict, so the first
//     discrepancy cannot suppress the second observation.
//   * The owned temp directory is removed in `finally`. Cleanup is narrow — it
//     refuses to remove anything whose basename lacks this file's own prefix —
//     and a cleanup failure is itself a non-zero result.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";

// ── The approved operand, verbatim ───────────────────────────────────────────
// `C:\aigentry-cli-process-calibration|target` — the exact human-approved
// literal. Written as a JS escape of the single backslash and nothing else.
const APPROVED_LITERAL = "C:\\aigentry-cli-process-calibration|target";

const TMP_PREFIX = "np1172jc-cli-process-enoent-calibration-";
// Extension-free on purpose: libuv then appends `.com` and `.exe` only, and both
// are checked below. It is a fixed constant, never derived from input.
const ABSENT_LEAF = "np1172jc-absent-target";
// The only suffixes `path_search_walk_ext` appends (`uvproc-v22.c:266-282`),
// plus the exact name itself.
const LIBUV_SUFFIXES = Object.freeze(["", ".com", ".exe"]);

const SPAWN_OPTIONS = Object.freeze({
  env: {},
  stdio: "ignore",
  shell: false,
  windowsHide: true,
  timeout: 1000,
});

const TYPEOF_ENUM = Object.freeze([
  "undefined", "object", "boolean", "number", "bigint", "string", "symbol", "function",
]);
const SHAPE_ENUM = Object.freeze(["null", "undefined", "buffer", "string", "array", "other"]);
const OPERAND_ENUM = Object.freeze(["A", "B"]);

const out = [];
function say(line) {
  out.push(line);
}

const failures = [];
function fail(token) {
  failures.push(token);
}

// ── Closed-token diagnostics. Never a raw value. ─────────────────────────────

function diagEnum(value, allowed) {
  if (value === null || value === undefined || value === "") return "none";
  return allowed.includes(value) ? value : "other";
}

function diagInt(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return Number.isInteger(value) ? String(value) : "other";
}

/** `typeof v`, from the closed set. */
function typeTag(value) {
  return diagEnum(typeof value, TYPEOF_ENUM);
}

/**
 * A closed shape tag for a stream-ish field. Deliberately does NOT reveal
 * length or content — only which of the four shapes the runtime produced.
 */
function shapeTag(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Buffer.isBuffer(value)) return "buffer";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  return "other";
}

function fieldLine(field, value) {
  return (
    "field=" + field +
    " typeof=" + typeTag(value) +
    " shape=" + diagEnum(shapeTag(value), SHAPE_ENUM)
  );
}

// ── The numeric UV_ENOENT of the RUNNING runtime, never a literal ────────────

function runtimeEnoentErrno() {
  for (const [errno, entry] of util.getSystemErrorMap()) {
    if (Array.isArray(entry) && entry[0] === "ENOENT") return errno;
  }
  return null;
}

// ── Measurement ──────────────────────────────────────────────────────────────

/**
 * One `spawnSync` against `target`, with the bounded options above. One attempt.
 * No retry, no fallback, no second shape. Returns only typed observations plus
 * the four identity-bearing values the comparison needs.
 */
function measure(target) {
  let result = null;
  let threw = false;
  try {
    result = spawnSync(target, [], SPAWN_OPTIONS);
  } catch {
    // The message and `path` of a throw carry the operand, so neither is read.
    threw = true;
  }
  if (threw || result === null || typeof result !== "object") {
    return { threw: true };
  }
  const err = result.error;
  return {
    threw: false,
    // Identity-bearing, compared but never printed as values.
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.output,
    status: result.status,
    signal: result.signal,
    pid: result.pid,
    errCode: err && typeof err.code === "string" ? err.code : null,
    errErrno: err && typeof err.errno === "number" ? err.errno : null,
    hasError: Boolean(err),
  };
}

/**
 * Prove `dir/ABSENT_LEAF` and its `.com`/`.exe` siblings are absent. Returns the
 * leaf path on success, or `null` — in which case nothing is measured.
 */
function verifiedAbsentLeaf(dir) {
  const leaf = path.join(dir, ABSENT_LEAF);
  for (const suffix of LIBUV_SUFFIXES) {
    const candidate = leaf + suffix;
    let present = true;
    try {
      fs.lstatSync(candidate);
    } catch (err) {
      present = !(err && err.code === "ENOENT");
    }
    if (present) {
      fail("operand-B-not-absent(suffix=" + (suffix === "" ? "none" : suffix.slice(1)) + ")");
      return null;
    }
  }
  return leaf;
}

/** Remove only the directory this file created, identified by its own prefix. */
function cleanup(dir) {
  if (!dir) return "no-dir";
  if (!path.basename(dir).startsWith(TMP_PREFIX)) return "unowned-dir";
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    return "rm(" + (err && typeof err.code === "string" ? err.code : "other") + ")";
  }
  try {
    fs.lstatSync(dir);
  } catch (err) {
    return err && err.code === "ENOENT" ? "ok" : "residual(other)";
  }
  return "residual(present)";
}

// ── Run ──────────────────────────────────────────────────────────────────────

say("np1172jc probe-cli-process-enoent-calibration");
say("imports=node-builtins-only product-import=none retries=0 attempts-per-operand=1");
say("node=" + process.versions.node + " platform=" + process.platform + " arch=" + process.arch);
say("operandA=approved-fixed-literal operandB=verified-absent-owned-temp-leaf");
say(
  "options=" +
    ["env-empty", "stdio-ignore", "shell-false", "windowsHide-true", "timeout-" + SPAWN_OPTIONS.timeout].join(",")
);

const ENOENT_ERRNO = runtimeEnoentErrno();
say("enoentErrnoSource=util.getSystemErrorMap enoentErrnoResolved=" + (ENOENT_ERRNO === null ? "none" : "yes"));

let tmpDir = null;
let observed = null;

try {
  // Platform gate FIRST. A POSIX run measures nothing and is never green.
  if (process.platform !== "win32") {
    fail("not-win32");
    say("");
    say("np1172jc: REFUSED — this probe calibrates a win32 native path resolution");
    say("np1172jc: and measures nothing on any other platform. No result is produced,");
    say("np1172jc: and a non-win32 run must never be read as calibration evidence.");
  } else if (ENOENT_ERRNO === null) {
    fail("enoent-errno-unresolved");
    say("");
    say("np1172jc: REFUSED — the running runtime's util.getSystemErrorMap() has no");
    say("np1172jc: ENOENT entry, so the numeric errno cannot be obtained without a");
    say("np1172jc: hard-coded literal. None is written here. Nothing was measured.");
  } else {
    tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), TMP_PREFIX));
    const absentLeaf = verifiedAbsentLeaf(tmpDir);
    if (absentLeaf === null) {
      say("");
      say("np1172jc: REFUSED — operand B's leaf, or one of its .com/.exe siblings,");
      say("np1172jc: already exists in the owned temp directory. B would then be");
      say("np1172jc: resolvable and the comparison meaningless. Nothing was measured.");
    } else {
      say("operandB-absence-verified=leaf,.com,.exe");
      // BOTH calls complete before any verdict is computed.
      const a = measure(APPROVED_LITERAL);
      const b = measure(absentLeaf);
      observed = { A: a, B: b };
    }
  }

  if (observed !== null) {
    // ── Typed per-operand record ─────────────────────────────────────────────
    for (const key of OPERAND_ENUM) {
      const o = observed[key];
      say("");
      say("operand=" + key + " threw=" + (o.threw ? "true" : "false"));
      if (o.threw) {
        fail("spawnSync-threw(operand=" + key + ")");
        continue;
      }
      say("  " + fieldLine("stdout", o.stdout));
      say("  " + fieldLine("stderr", o.stderr));
      say("  " + fieldLine("output", o.output));
      say("  status=" + diagInt(o.status));
      say("  signal=" + (o.signal === null ? "null" : typeTag(o.signal)));
      say("  pid=" + diagInt(o.pid));
      say("  error=" + (o.hasError ? "present" : "absent"));
      say("  error.code=" + diagEnum(o.errCode, ["ENOENT"]));
      say("  error.errnoIsRuntimeEnoent=" + (o.errErrno === ENOENT_ERRNO ? "true" : "false"));
    }

    const a = observed.A;
    const b = observed.B;

    // ── Load-bearing checks. Each is a separate, named failure token. ────────
    if (!a.threw && !b.threw) {
      // Both operands must produce the FULL unresolvable-command shape.
      for (const key of OPERAND_ENUM) {
        const o = observed[key];
        if (o.output !== null) fail("output-not-null(operand=" + key + ")");
        if (o.status !== null) fail("status-not-null(operand=" + key + ")");
        if (o.signal !== null) fail("signal-not-null(operand=" + key + ")");
        if (o.pid !== 0) fail("pid-not-zero(operand=" + key + ")");
        if (!o.hasError) fail("error-absent(operand=" + key + ")");
        if (o.errCode !== "ENOENT") fail("error-code-not-enoent(operand=" + key + ")");
        if (o.errErrno !== ENOENT_ERRNO) fail("error-errno-not-runtime-enoent(operand=" + key + ")");
      }
      // Stream identity — `Object.is`, so `null` and `undefined` never conflate.
      if (!Object.is(a.stdout, b.stdout)) fail("stdout-identity-mismatch");
      if (!Object.is(a.stderr, b.stderr)) fail("stderr-identity-mismatch");
      if (typeTag(a.stdout) !== typeTag(b.stdout)) fail("stdout-typeof-mismatch");
      if (typeTag(a.stderr) !== typeTag(b.stderr)) fail("stderr-typeof-mismatch");
      if (shapeTag(a.stdout) !== shapeTag(b.stdout)) fail("stdout-shape-mismatch");
      if (shapeTag(a.stderr) !== shapeTag(b.stderr)) fail("stderr-shape-mismatch");
      // Cross-operand identity on the remaining fields.
      if (!Object.is(a.output, b.output)) fail("output-identity-mismatch");
      if (!Object.is(a.status, b.status)) fail("status-identity-mismatch");
      if (!Object.is(a.signal, b.signal)) fail("signal-identity-mismatch");
      if (a.pid !== b.pid) fail("pid-mismatch");
      if (a.errCode !== b.errCode) fail("error-code-mismatch");
      if (a.errErrno !== b.errErrno) fail("error-errno-mismatch");
    }
  }
} catch (err) {
  // Any unexpected throw is a non-zero result, recorded as a bare token. The
  // message is not read: it can contain an operand path.
  fail("unexpected-throw(" + (err && typeof err.code === "string" ? err.code : "other") + ")");
} finally {
  const reason = cleanup(tmpDir);
  say("");
  say("cleanup=" + reason);
  if (reason !== "ok" && reason !== "no-dir") fail("cleanup(" + reason + ")");
}

say("");
say("measured=" + (observed === null ? "false" : "true"));
say("verdict=" + (failures.length === 0 ? "calibrated" : "not-calibrated") + " failures=" + diagInt(failures.length));
for (const f of failures) say("  failure=" + f);
say(
  failures.length === 0
    ? "np1172jc: on this native runtime the approved literal produced the SAME full shape as a genuinely absent absolute path."
    : "np1172jc: NOT calibrated on this runtime. No product change may assume the approved literal's shape."
);
say("np1172jc: this measures WHAT happened only. It decides no contract and adopts nothing.");

process.stdout.write(out.join("\n") + "\n");
process.exitCode = failures.length === 0 ? 0 : 1;
