// dm1172av tester helper — NAMED SYNTHETIC SEAM for speaker discovery.
//
// RELOCATED (dm1172av). This file replaces the out-of-repository
// `../../../helpers/stub-cli-bin.mjs` that `delegated-selection.test.js`
// used to import. It now lives inside the repository, beside the ratified
// `cli-discovery-fixture.js`, so the suite resolves from a plain checkout
// with no sibling validation tree on disk.
//
// What is real: `discoverLocalCliSpeakers` / `commandExistsInPath` /
// `checkCliLiveness` in lib/speaker-discovery.js run unmodified. The source
// validator is NOT stubbed.
//
// What is synthetic: PATH is built from a temp bin dir holding inert
// executables named after DEFAULT_CLI_CANDIDATES, plus trusted OS
// primitives. Each stub exits 0 for `--version`/`--help` and does nothing
// else — no provider call, no network.
//
// Declared limits of this seam:
//   - Ceiling is |DEFAULT_CLI_CANDIDATES| = 11 CLI speakers. The product's
//     MAX_AUTO_DISCOVERED_SPEAKERS = 12 is therefore NOT reached by this seam;
//     these tests assert the absence of a *standard-mode participant cap*, not
//     the absence of the auto-discovery ceiling, which is a separate limit.
//   - Stub liveness is unconditionally true, so "not executable" warning paths
//     are not exercised here.
//   - Only the POSIX generation path is exercised. `stubFileName` /
//     `writeStub` carry the win32 `.cmd` branch of the ratified fixture, but
//     no Windows runtime is claimed and none was measured.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reused verbatim from the ratified discovery fixture rather than duplicated:
// the candidate list, the inert stub body and the platform filename rule are
// that module's, and it is never edited from here.
import {
  FIXTURE_CLI_CANDIDATES,
  FIXTURE_SEAM_CEILING,
  PRODUCT_AUTO_DISCOVERY_CEILING,
  stubFileName,
  writeStub,
} from './cli-discovery-fixture.js';

const IS_WINDOWS = process.platform === 'win32';

export const STUB_CLI_CANDIDATES = FIXTURE_CLI_CANDIDATES;
export const STUB_SEAM_CEILING = FIXTURE_SEAM_CEILING; // 11
export { PRODUCT_AUTO_DISCOVERY_CEILING, stubFileName };

// Trusted OS primitives only — the same set the ratified fixture uses.
// Deliberately excludes every location a real agent CLI could live (nvm,
// homebrew, ~/.local, cmux shims).
//
// dm1172av CORRECTION. The prior revision of this helper built
// `pathValue` as `${dir}${delimiter}${process.env.PATH || ''}`. Prepending
// the stub dir shadows a real CLI of the SAME name, but every other
// DEFAULT_CLI_CANDIDATE still installed on the host stayed reachable, so
// `bootWithSpeakers(3)` could discover a fourth speaker on one machine and
// three on another. That is the undeclared host precondition
// `cli-discovery-fixture.js` was written to remove. There is no host PATH
// fallback here: the child sees the stub dir and these directories, nothing
// else.
export const TRUSTED_OS_PATH_DIRS = IS_WINDOWS
  ? [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
      process.env.SystemRoot || 'C:\\Windows',
    ]
  : ['/usr/bin', '/bin'];

/**
 * Is `entry` a PATH element this seam is allowed to hand a child?
 * Exported so the harness can ASSERT inertness rather than assert it in prose.
 */
export function isTrustedPathEntry(entry, ownedDir) {
  return entry === ownedDir || TRUSTED_OS_PATH_DIRS.includes(entry);
}

/**
 * Create a temp bin dir of inert CLI stubs.
 * @param {number} count how many of STUB_CLI_CANDIDATES to materialize
 * @returns {{dir: string, speakers: string[], pathValue: string, cleanup: () => void}}
 */
export function createStubCliBin(count = STUB_SEAM_CEILING) {
  if (count > STUB_SEAM_CEILING) {
    throw new Error(
      `stub seam ceiling is ${STUB_SEAM_CEILING} (DEFAULT_CLI_CANDIDATES); asked for ${count}`
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm1172av-stubbin-'));
  let speakers;
  try {
    speakers = STUB_CLI_CANDIDATES.slice(0, count);
    for (const name of speakers) writeStub(dir, name);
  } catch (err) {
    // Initialization failure must not leave the owned dir behind.
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    dir,
    speakers,
    // Owned stub dir first, then trusted OS primitives. No host PATH.
    pathValue: [dir, ...TRUSTED_OS_PATH_DIRS].join(path.delimiter),
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
