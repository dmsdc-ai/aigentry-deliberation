// dh1172ao — PERMANENT, MAINTAINED test fixture for CLI speaker discovery.
//
// WHY THIS EXISTS
// ---------------
// `deliberation-e2e.test.js` exercises the real selection chain
// (`deliberation_speaker_candidates` -> `_select_speakers` /
// `_confirm_speakers` -> `_start`). That chain can only mint a token for
// speakers that discovery actually finds. Before this fixture the suite
// inherited the host `PATH`, so it silently depended on real `claude` /
// `codex` binaries being installed on the developer's machine. On a
// sanitised PATH the delegated cases failed with
// `deliberation_select_speakers did not mint a delegated token:
//  expected null to be truthy` (228/230).
//
// That was an UNDECLARED PRECONDITION, not a product defect. This module
// declares it: every harness is handed its own inert stub bin directory and
// a PATH that contains nothing else but trusted OS primitives.
//
// WHAT IS REAL vs SYNTHETIC
// -------------------------
// Real (never stubbed, never mocked): `discoverLocalCliSpeakers`,
// `resolveCliCandidates`, `commandExistsInPath`, `checkCliLiveness`, the
// selection-token validator, session state, archive writing. The product
// runs unmodified over real MCP stdio.
//
// Synthetic: the *binaries on PATH*. They are inert — `exit 0`, no stdout,
// no network, no provider, no browser, no telepty. A discovery probe
// (`--version` / `--help`) succeeds; nothing else happens.
//
// DECLARED LIMITS (do not let these drift into over-claims)
// ---------------------------------------------------------
//   * The fixture materialises |DEFAULT_CLI_CANDIDATES| = 11 names. This is
//     a FIXTURE CEILING, not the product's worker-count cap. The product's
//     MAX_AUTO_DISCOVERED_SPEAKERS = 12 is deliberately NOT reached, so
//     these tests say nothing about the auto-discovery ceiling or about any
//     standard-mode participant cap.
//   * Stub liveness is unconditionally true, so "found but not executable"
//     warning paths are NOT exercised here.
//   * Only the POSIX generation path is exercised by CI. The win32 path
//     below is written to be correct (`.cmd` shims, `PATHEXT`, `;`
//     delimiter) but is UNVERIFIED — no Windows runtime is claimed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';

// Mirrors DEFAULT_CLI_CANDIDATES in lib/speaker-discovery.js (frozen baseline
// b009549c67482dcad57a2ed2159f92c6ac4bd67f). Kept as an explicit literal so a
// product-side change to that list surfaces as a fixture-control failure
// rather than silently resizing the synthetic snapshot.
export const FIXTURE_CLI_CANDIDATES = [
  'claude', 'codex', 'gemini', 'qwen', 'chatgpt', 'aider',
  'llm', 'opencode', 'cursor-agent', 'cursor', 'continue',
];

export const FIXTURE_SEAM_CEILING = FIXTURE_CLI_CANDIDATES.length; // 11
export const PRODUCT_AUTO_DISCOVERY_CEILING = 12; // MAX_AUTO_DISCOVERED_SPEAKERS

// Trusted OS primitives only. Deliberately excludes every location a real
// agent CLI could live (nvm, homebrew, ~/.local, cmux shims). Verified free
// of FIXTURE_CLI_CANDIDATES collisions by the fixture controls.
// Exported so a suite asserting "no host PATH fallback" compares against the
// dirs this fixture actually built on this platform, instead of restating the
// POSIX pair as a literal (which is simply wrong on win32).
export const TRUSTED_OS_PATH_DIRS = IS_WINDOWS
  ? [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
      process.env.SystemRoot || 'C:\\Windows',
    ]
  : ['/usr/bin', '/bin'];

/**
 * The `LOCALAPPDATA` an owned fixture HOME implies. Pinned INSIDE the owned
 * home on purpose: the ambient host `LOCALAPPDATA` on a Windows runner points
 * at the real user profile, so a harness that spreads `process.env` (or a
 * product that reads `LOCALAPPDATA` first) would resolve its install dir
 * OUTSIDE the owned tree. Every fixture path below derives from the owned home
 * only, so nothing escapes it.
 *
 * The value equals the product's own documented fallback
 * (`index.js:296-299`: `LOCALAPPDATA || path.join(HOME, "AppData", "Local")`),
 * so pinning it changes no resolution — it only removes the ambient one.
 */
export function fixtureLocalAppData(homeDir) {
  return path.join(homeDir, 'AppData', 'Local');
}

/**
 * The install directory the PRODUCT resolves for an owned fixture HOME.
 *
 * Mirrors `index.js:296-299` on `process.platform`. Four fixtures previously
 * hardcoded the POSIX branch, so on win32 the tests read
 * `<home>/.local/lib/...` while the server wrote
 * `<home>/AppData/Local/...` — two disjoint trees. Kept here so the next
 * platform branch has exactly one home.
 */
export function getFixtureInstallDir(homeDir) {
  if (!homeDir) throw new Error('getFixtureInstallDir requires an owned homeDir');
  return IS_WINDOWS
    ? path.join(fixtureLocalAppData(homeDir), 'mcp-deliberation')
    : path.join(homeDir, '.local', 'lib', 'mcp-deliberation');
}

/**
 * Body of an inert stub: succeeds for any argv, prints nothing, exits 0.
 * Discovery only ever probes `--version` / `--help`.
 */
function inertStubBody(name) {
  return IS_WINDOWS
    ? `@echo off\r\nrem dh1172ao inert discovery stub: ${name}\r\nexit /b 0\r\n`
    : `#!/bin/sh\n# dh1172ao inert discovery stub: ${name}\nexit 0\n`;
}

/** Filename discovery will resolve for `name` on this platform. */
export function stubFileName(name) {
  return IS_WINDOWS ? `${name}.cmd` : name;
}

/**
 * Materialise an inert CLI stub inside an already-owned directory.
 * Exported so a harness can overlay a *behaviour-bearing* stub (one that
 * emits a response) over the inert baseline in the same owned directory —
 * one directory, no PATH-shadowing ambiguity.
 */
export function writeStub(dir, name, body = inertStubBody(name)) {
  const file = path.join(dir, stubFileName(name));
  fs.writeFileSync(file, body, { mode: 0o755 });
  if (!IS_WINDOWS) fs.chmodSync(file, 0o755);
  return file;
}

/**
 * Create the owned stub bin directory for one isolated harness.
 *
 * @param {object} opts
 * @param {string} opts.root  harness-owned root (its temp HOME). The bin dir
 *   is created INSIDE it so harness cleanup removes exactly one owned tree.
 * @param {number} [opts.count]  how many of FIXTURE_CLI_CANDIDATES to create.
 * @returns {{dir: string, speakers: string[], files: string[]}}
 */
export function createCliDiscoveryStubs({ root, count = FIXTURE_SEAM_CEILING } = {}) {
  if (!root) throw new Error('createCliDiscoveryStubs requires an owned root');
  if (count > FIXTURE_SEAM_CEILING) {
    throw new Error(
      `fixture seam ceiling is ${FIXTURE_SEAM_CEILING} (DEFAULT_CLI_CANDIDATES); asked for ${count}`
    );
  }
  const dir = path.join(root, 'dh1172ao-stub-bin');
  fs.mkdirSync(dir, { recursive: true });
  const speakers = FIXTURE_CLI_CANDIDATES.slice(0, count);
  const files = speakers.map(name => writeStub(dir, name));
  return { dir, speakers, files };
}

// The boundary switch PATH sanitisation cannot enforce. Merged AFTER `extra`,
// never before, so a caller cannot re-enable a real CDP fetch, a real browser
// auto-launch or an absolute-path browser spawn by passing the key itself.
//
// DECLARED LIMIT — this does not say "the browser is off". It says the knob the
// product reads is SET to off here and cannot be re-opened by a caller.
// Whether `off` closes every browser path is a PRODUCT fact, verified product
// side, not here. Nothing about `include_browser` metadata is changed.
const FORCED_BOUNDARY_SWITCHES = Object.freeze({
  DELIBERATION_BROWSER_SCAN_MODE: 'off',
});

/**
 * Is `entry` a PATH element this fixture may hand a child?
 *
 * Same rule as `isTrustedPathEntry` in `stub-cli-bin.mjs`, restated here rather
 * than imported: that module already imports THIS one, so importing it back
 * would close a cycle. Both read the same `TRUSTED_OS_PATH_DIRS` shape, and
 * this one is checked against the caller's own owned stub dir.
 */
function isOwnedOrTrustedPathEntry(entry, stubDir) {
  return entry === stubDir || TRUSTED_OS_PATH_DIRS.includes(entry);
}

/**
 * Refuse to RETURN a PATH that is not the owned containment boundary.
 *
 * `assertInertPath` (mcp-harness.mjs) covers only the one caller that goes
 * through `inertEnv`; the direct `buildFixtureEnv` callers reached no PATH
 * guard at all, so an `extra.PATH` could reintroduce a host PATH fallback —
 * and with it a real provider CLI — into a child. Validating the RESULT here
 * covers every caller, before any child exists.
 *
 * Empty segments are NOT filtered away. An empty PATH element means the
 * CURRENT DIRECTORY, which is precisely the host-relative lookup this fixture
 * exists to remove, so it is untrusted like any other foreign entry. It is
 * named as `<empty segment>` because it has no printable form of its own.
 *
 * The override is REJECTED, never silently dropped: a caller that passed a
 * PATH must not be left believing it took effect. The wording keeps the
 * `host PATH fallback` phrasing and names every refused entry, so the existing
 * harness-cleanup negative still reads the same diagnostic.
 */
function assertOwnedFixturePath(pathValue, stubDir) {
  const entries = String(pathValue === undefined || pathValue === null ? '' : pathValue)
    .split(path.delimiter);
  const foreign = entries.filter(entry => !isOwnedOrTrustedPathEntry(entry, stubDir));
  if (foreign.length > 0) {
    throw new Error(
      'buildFixtureEnv: refusing to return a host PATH fallback. Untrusted PATH '
      + `entries: ${foreign.map(e => (e === '' ? '<empty segment>' : e)).join(', ')}`
    );
  }
  if (entries[0] !== stubDir) {
    throw new Error(
      `buildFixtureEnv: owned stub dir must lead PATH, got ${entries[0]}`
    );
  }
}

/**
 * Build the COMPLETE environment for a harness child.
 *
 * This never spreads `process.env`. Inheriting the ambient environment is
 * exactly what made the prior suite host-dependent: it carried the real
 * PATH (and therefore real agent CLIs) into the child. Everything the
 * product legitimately needs is named here explicitly.
 *
 * External boundaries are left UNREACHABLE rather than mocked: with only
 * the stub dir plus trusted OS primitives on PATH there is no `telepty`, no
 * browser driver and no provider CLI to actuate. Tests that assert a
 * *blocked* transport therefore observe a genuine unavailability, not a
 * simulated one.
 *
 * PATH sanitisation alone did NOT cover the browser boundary, and the claim
 * above was false for it. `lib/speaker-discovery.js` reads
 * `DELIBERATION_BROWSER_SCAN_MODE`, defaults it to `"auto"` when unset, and
 * then runs `ensureCdpAvailable()`: an outbound `fetchJson` against each CDP
 * endpoint, followed by an auto-launch of a real browser located by ABSOLUTE
 * PATH (`/Applications/Google Chrome.app/...`, `C:\Program Files\...`). A
 * sanitised PATH cannot stop either one. The knob is therefore forced to
 * `off` below, matching `helpers/mcp-harness.mjs`, which already did so — the
 * two harnesses used to disagree and the `buildFixtureEnv` callers took the
 * unguarded path.
 *
 * @param {object} opts
 * @param {string} opts.homeDir   owned HOME (and USERPROFILE on win32)
 * @param {string} opts.stubDir   owned stub bin dir, placed first on PATH
 * @param {object} [opts.extra]   harness-specific additions (e.g.
 *   DELIBERATION_CALLER_SPEAKER). Applied over the named defaults, but NOT
 *   over the forced boundary switches, which are merged after it.
 */
export function buildFixtureEnv({ homeDir, stubDir, extra = {} } = {}) {
  if (!homeDir) throw new Error('buildFixtureEnv requires an owned homeDir');
  if (!stubDir) throw new Error('buildFixtureEnv requires an owned stubDir');

  const env = {
    PATH: [stubDir, ...TRUSTED_OS_PATH_DIRS].join(path.delimiter),
    HOME: homeDir,
    TMPDIR: path.join(homeDir, 'tmp'),
    AIGENTRY_TIER: 'pro',
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true });

  if (IS_WINDOWS) {
    // Windows resolves executables via PATHEXT and reads USERPROFILE/TEMP.
    env.USERPROFILE = homeDir;
    env.TEMP = env.TMPDIR;
    env.TMP = env.TMPDIR;
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    env.SystemRoot = process.env.SystemRoot || 'C:\\Windows';
    env.ComSpec = process.env.ComSpec || path.join(env.SystemRoot, 'System32', 'cmd.exe');
  }

  // Forced LAST, after `extra`. The owned LOCALAPPDATA is a containment
  // boundary in exactly the way the browser switch is: it is never the ambient
  // host value (see fixtureLocalAppData), and a caller must not be able to
  // relocate the install dir outside the owned HOME by passing the key itself.
  // Its value equals the product's own documented fallback, so nothing about
  // path resolution changes — only the escape does.
  //
  // PATH is deliberately NOT forced here — forcing it would silently DISCARD a
  // caller's override, which is the one outcome worse than honouring it. The
  // resulting PATH is validated instead, and an unsafe one is refused below.
  const forced = { ...FORCED_BOUNDARY_SWITCHES };
  if (IS_WINDOWS) forced.LOCALAPPDATA = fixtureLocalAppData(homeDir);

  const merged = { ...env, ...extra, ...forced };
  assertOwnedFixturePath(merged.PATH, stubDir);
  return merged;
}

/**
 * Absolute entry points. `process.execPath` is already an absolute Node
 * binary path; the server entry is resolved from this module's own location
 * rather than from `process.cwd()`, so the harness does not depend on where
 * the runner happened to be invoked.
 *
 * The conversion uses `fileURLToPath`, NOT `new URL(...).pathname`. A file URL
 * percent-encodes every character that is not URL-path-safe, so `.pathname`
 * hands back the ENCODED form: a checkout under `/Users/x/my repo/` yields
 * `/Users/x/my%20repo/` and a non-ASCII segment yields its UTF-8 percent
 * escapes. `path.resolve` treats `%20` as three ordinary characters, so
 * FIXTURE_REPO_ROOT silently became a path that does not exist and every
 * spawn of FIXTURE_SERVER_ENTRY failed with ENOENT. `fileURLToPath` performs
 * the decoding (and the win32 drive/UNC handling) that `.pathname` does not.
 * For a checkout whose path needs no encoding the two agree exactly, so the
 * ordinary case is unchanged. The win32 branch of `fileURLToPath` is exercised
 * by no runtime here — native Windows behaviour remains UNMEASURED.
 */
export const FIXTURE_NODE_BIN = process.execPath;
export const FIXTURE_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..'
);
export const FIXTURE_SERVER_ENTRY = path.join(FIXTURE_REPO_ROOT, 'index.js');

/**
 * Positive-fact test: has the runtime actually OBSERVED this handle finish?
 * `exitCode` is non-null once an exit status was reaped; `signalCode` is
 * non-null once the child was reaped as signal-terminated. Anything else —
 * an `error` event, a `kill()` that threw — is an absence of information, not
 * an observation of death.
 */
function hasObservedExit(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Join an owned child process: signal it, then WAIT for an OBSERVED exit
 * before the caller removes the owned roots. Without the join, `rmSync(homeDir)`
 * can race a still-writing server and leak both a child handle and a temp
 * tree. Only ever called with a handle the harness itself spawned — this
 * function never scans the process table and never signals anything but the
 * handle it is given.
 *
 * SETTLEMENT RULE (this is the whole point of the function)
 * --------------------------------------------------------
 * Resolve ONLY on a positive observed-exit fact: an `exit` event, or a handle
 * that already reports `exitCode`/`signalCode`. Everything else rejects.
 *
 * The previous revision resolved on `error` and on a `kill()` that threw. Both
 * are states in which the child may still be RUNNING and still holding the
 * owned root open, and the caller's very next statement is
 * `fs.rmSync(homeDir, { recursive: true, force: true })` — so a resolve there
 * authorised deleting a live server's root out from under it. It also had no
 * bound after SIGKILL: a handle that reported neither exit nor error simply
 * left the promise pending forever and hung the suite.
 *
 * Escalation is exact and bounded:
 *   t=0            SIGTERM to the owned handle
 *   t=timeoutMs    SIGKILL to the owned handle
 *   t=deadlineMs   hard deadline — REJECT, because no exit was observed
 *
 * Rejecting propagates out of the harness `cleanup()` and fails the test
 * rather than silently deleting a root under a live process. A `kill()` that
 * throws is recorded and re-checked against the positive facts (a throw
 * because the child was already reaped is accompanied by a non-null
 * `exitCode`/`signalCode`, and resolves); a throw with no such fact does NOT
 * permit root removal and runs out to the deadline.
 *
 * Every timer and listener this function installs is disposed exactly once,
 * on whichever settlement happens first, so repeated calls cannot accumulate
 * handles on the child.
 *
 * @param {object} child  an owned child handle
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]   SIGTERM -> SIGKILL escalation delay
 * @param {number} [opts.deadlineMs]  hard deadline; clamped to strictly after
 *   the SIGKILL so the escalation always gets a chance to be observed.
 */
export function joinOwnedChild(child, { timeoutMs = 5000, deadlineMs } = {}) {
  if (!child) return Promise.resolve();
  if (hasObservedExit(child)) return Promise.resolve();

  const hardDeadlineMs = Math.max(
    typeof deadlineMs === 'number' ? deadlineMs : timeoutMs * 2,
    timeoutMs + 1
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let killTimer = null;
    let deadlineTimer = null;
    let lastError = null;

    const dispose = () => {
      if (killTimer !== null) { clearTimeout(killTimer); killTimer = null; }
      if (deadlineTimer !== null) { clearTimeout(deadlineTimer); deadlineTimer = null; }
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };

    // The ONLY resolve path.
    function onExit() {
      if (settled) return;
      settled = true;
      dispose();
      resolve();
    }

    // An `error` is not an exit. Record it for the deadline message only; if
    // the handle really did finish, `exit` fires (or the positive facts are
    // already set) and `onExit` settles instead.
    function onError(err) {
      lastError = err;
      if (!settled && hasObservedExit(child)) onExit();
    }

    child.on('exit', onExit);
    child.on('error', onError);

    // The handle may have been reaped between the entry check and the listen.
    if (hasObservedExit(child)) { onExit(); return; }

    killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (err) { lastError = err; }
      if (!settled && hasObservedExit(child)) onExit();
    }, timeoutMs);

    deadlineTimer = setTimeout(() => {
      if (settled) return;
      if (hasObservedExit(child)) { onExit(); return; }
      settled = true;
      dispose();
      reject(new Error(
        `joinOwnedChild: owned child (pid=${child.pid}) reported no observed exit within ` +
        `${hardDeadlineMs}ms (SIGTERM at 0ms, SIGKILL at ${timeoutMs}ms)` +
        `${lastError ? `; last handle error: ${lastError.message}` : ''}. ` +
        'Refusing to report the child as joined: the owned root must not be ' +
        'removed while the process may still be alive.'
      ));
    }, hardDeadlineMs);

    try {
      child.kill('SIGTERM');
    } catch (err) {
      // A throw here is NOT permission to delete the root. If the throw was
      // because the child had already been reaped, the positive facts say so.
      lastError = err;
      if (!settled && hasObservedExit(child)) onExit();
    }
  });
}
