// fixture-portability.test.js — INERT regression witnesses (fv1172bh-tester)
//
// PURPOSE: preserve two boundary defects found during the fv1172bh combined
// portability acceptance as executable, failing witnesses. These tests assert
// the REQUIRED behaviour, not the current behaviour, so they FAIL today and
// pass only once the confined correction lands. They are witnesses, not a
// green-making change: nothing in the product or in the existing helpers is
// edited to accommodate them.
//
// INERTNESS (why this file cannot actuate anything):
//   * no child process is spawned — every assertion is a pure function call;
//   * no browser, no network, no provider CLI, no telepty, no MCP stdio;
//   * the only side effect is mkdir of an OWNED root under this repo's own
//     output tree, created by `buildFixtureEnv` itself and removed in afterAll;
//   * the sentinel is a literal minted here. It is NOT a real credential, and
//     it never leaves this process.
//
// Baseline boundary negatives use source-controlled inert values only, per the
// dispatch: never an actual browser/network/provider.

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildFixtureEnv,
  FIXTURE_REPO_ROOT,
  TRUSTED_OS_PATH_DIRS,
} from './helpers/cli-discovery-fixture.js';
import { describeOutcome } from './helpers/encoded-install-fixture.js';

// A literal, obviously-fake sentinel. Stands in for anything secret-shaped that
// a child could emit on stderr (a provider key, a token, an absolute profile
// path). Minted here so the witness never needs a real secret to demonstrate
// the leak.
const SENTINEL = 'SENT1172-aabbccddeeff';

// Owned root, under this repo's own tree (which lives under the acceptance
// `output/`), never the host tmp and never the ambient HOME.
//
// mkdtemp, NOT a fixed path: the root must be uniquely OWNED by this run. A
// fixed `.fp-owned` would be indistinguishable from a sibling's directory of
// the same name, and the afterAll below would then delete pre-existing data
// this file never created. mkdtempSync fails if it cannot create a fresh
// directory, so the name it returns is always ours, and the recursive remove
// is scoped to exactly that name.
const OWNED_ROOT = fs.mkdtempSync(path.join(FIXTURE_REPO_ROOT, '.fp-owned-'));

afterAll(() => {
  // Only ever the unique root minted above — never a shared or guessed sibling.
  fs.rmSync(OWNED_ROOT, { recursive: true, force: true });
});

function ownedDirs(name) {
  const homeDir = path.join(OWNED_ROOT, name, 'home');
  const stubDir = path.join(OWNED_ROOT, name, 'stub');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stubDir, { recursive: true });
  return { homeDir, stubDir };
}

// ── Witness 1 ──────────────────────────────────────────────────
//
// REQUIRED: diagnostic output is counts and closed enums only. Arbitrary child
// stderr and arbitrary handle-error text must never be echoed, because a
// diagnostic string is printed to stdout on assertion failure and is therefore
// an egress path.
//
// ACTUAL (defect): `__tests__/helpers/encoded-install-fixture.js:348`
// `describeOutcome` interpolates two free-form fields verbatim —
//   :356  "handleError=" + outcome.handleError
//   :357  "stderr=" + JSON.stringify(String(outcome.stderr).slice(0, 400))
// No redaction exists on that path anywhere in the helper set.
//
// REACHABLE FROM: `__tests__/encoded-install-path.test.js:95`, `:165`, `:183`,
// where the returned string is the assertion message.
//
// CONTRAST: the sibling diagnostic at `__tests__/deliberation-e2e.test.js:703`
// gets this right by construction (DIAG_*_ENUM allowlists + integer counts,
// `diagEnum`/`diagInt`), which is the shape the correction should mirror.
describe('WITNESS fv1172bh-1 — describeOutcome must not echo secret sentinels', () => {
  // A synthetic outcome. No child produced this; the fields are literals, so
  // the witness holds regardless of platform, runner or timing.
  const outcome = Object.freeze({
    answered: false,
    settledBy: 'timeout',
    elapsedMs: 12,
    exitCode: 1,
    signalCode: null,
    handleError: `spawn failed for ${SENTINEL}-HANDLE`,
    stderr: `Error: provider key ${SENTINEL}-STDERR leaked into stderr\n`,
  });

  it('does not echo a sentinel carried in the arbitrary stderr field', () => {
    const line = describeOutcome('ordinary', outcome);
    expect(
      line.includes(`${SENTINEL}-STDERR`),
      'describeOutcome echoed child stderr verbatim '
      + '(encoded-install-fixture.js:357); counts/closed enums only. Got: ' + line,
    ).toBe(false);
  });

  it('does not echo a sentinel carried in the arbitrary handleError field', () => {
    const line = describeOutcome('ordinary', outcome);
    expect(
      line.includes(`${SENTINEL}-HANDLE`),
      'describeOutcome echoed handleError verbatim '
      + '(encoded-install-fixture.js:356); counts/closed enums only. Got: ' + line,
    ).toBe(false);
  });

  it('still reports the closed-enum and integer fields it is allowed to report', () => {
    // Control. This passes today and must keep passing after the correction:
    // the fix is to drop the free-form fields, not to blank the diagnostic.
    const line = describeOutcome('ordinary', outcome);
    expect(line).toContain('case=ordinary');
    expect(line).toContain('settledBy=timeout');
    expect(line).toContain('exit=1');
    expect(line).toContain('elapsedMs=12');
  });
});

// ── Witness 2 ──────────────────────────────────────────────────
//
// REQUIRED: the trusted stub PATH is a containment boundary and must not be
// escapable by a caller passing the key itself — the same guarantee already
// held for the browser scan switch.
//
// The requirement is stated as an OUTCOME, not an implementation. Two results
// are acceptable:
//   A. explicit rejection before any child exists (preferred; matches the
//      existing negative at `__tests__/harness-cleanup.test.js:400-425`), or
//   B. an owned safe PATH — stub dir leading, no foreign entry surviving.
// Only a returned UNSAFE PATH is a failure. This witness must NOT force an
// implementation that silently ignores an unsafe override: quietly dropping
// the caller's PATH would satisfy a naive equality assertion while leaving the
// caller believing a PATH they passed took effect.
//
// ACTUAL (defect): `__tests__/helpers/cli-discovery-fixture.js:200`
// `buildFixtureEnv` builds PATH at :205 but omits it from the forced merge at
// :231-234, so `extra.PATH` wins. The comment at :230 states that
// `assertInertPath` is what catches this — but `assertInertPath` is defined at
// `__tests__/helpers/mcp-harness.mjs:149` and called from exactly one place,
// `mcp-harness.mjs:171`. The three direct `buildFixtureEnv` callers —
// `__tests__/encoded-install-path.test.js:76`,
// `__tests__/deliberation-e2e.test.js:110` and `:615` — never reach it, so on
// those paths there is NO executable PATH guard at all.
//
// SEVERITY: latent, not live. No current caller widens PATH. The witness marks
// the unguarded seam so a future `extra.PATH` cannot silently reintroduce a
// host PATH fallback (and with it a real provider CLI) into a child.
describe('WITNESS fv1172bh-2 — stub PATH must not escape via env override', () => {
  const UNTRUSTED = path.join(path.sep, 'evil', 'bin');

  // Attempt the override and record WHICH of the two acceptable outcomes
  // occurred. `buildFixtureEnv` spawns nothing, so a throw here is by
  // construction "rejected before any child exists" — the same contract the
  // existing negative at `__tests__/harness-cleanup.test.js:400-425` asserts
  // for `assertInertPath` (message /host PATH fallback/, `observedHandle`
  // null, owned root untouched).
  function attemptOverride(name, extra) {
    const { homeDir, stubDir } = ownedDirs(name);
    try {
      return { rejected: false, env: buildFixtureEnv({ homeDir, stubDir, extra }), stubDir };
    } catch (error) {
      return { rejected: true, error, stubDir };
    }
  }

  /** Every entry is the owned stub dir or a trusted OS primitive, stub first. */
  function describePathSafety(pathValue, stubDir) {
    const entries = String(pathValue || '').split(path.delimiter).filter(Boolean);
    const trusted = new Set([stubDir, ...TRUSTED_OS_PATH_DIRS]);
    return {
      entries,
      foreign: entries.filter(e => !trusted.has(e)),
      leads: entries[0] === stubDir,
    };
  }

  it('either rejects a caller-supplied PATH or returns an owned safe PATH', () => {
    const outcome = attemptOverride('path-escape', { PATH: UNTRUSTED });

    // ACCEPTABLE OUTCOME A — explicit rejection. Preferred, and consistent
    // with the existing harness-cleanup negative: a caller that passes an
    // unsafe PATH is told so loudly rather than having it quietly dropped.
    if (outcome.rejected) {
      expect(
        outcome.error.message,
        'rejection must name the untrusted entry so the caller can see what was refused',
      ).toContain(UNTRUSTED);
      return;
    }

    // ACCEPTABLE OUTCOME B — an owned safe PATH: stub dir leads and no foreign
    // entry survived.
    //
    // FAILURE — an unsafe PATH was returned. This is the defect: the override
    // is neither refused nor constrained, so a host PATH fallback (and with it
    // a real provider CLI) reaches the child.
    //
    // Deliberately NOT asserted: that the returned PATH equals the un-overridden
    // default. That would pin one implementation — silently ignoring the
    // override — which this witness must not force.
    const safety = describePathSafety(outcome.env.PATH, outcome.stubDir);
    expect(
      safety.foreign,
      'buildFixtureEnv returned an unsafe PATH instead of rejecting or constraining it '
      + '(cli-discovery-fixture.js:205 built it, :231-234 did not force it); '
      + 'assertInertPath (mcp-harness.mjs:149) does not cover the direct callers '
      + 'at encoded-install-path.test.js:76 and deliberation-e2e.test.js:110,:615. '
      + 'Either refuse the override before any child, or return an owned safe PATH. '
      + 'Got PATH=' + JSON.stringify(outcome.env.PATH),
    ).toEqual([]);
    expect(
      safety.leads,
      'owned stub dir must lead the returned PATH; got ' + JSON.stringify(safety.entries[0]),
    ).toBe(true);
  });

  it('does not silently drop an unsafe override while claiming a guard', () => {
    // The seam the comment at cli-discovery-fixture.js:230 describes: it says a
    // widened PATH is caught by assertInertPath. On the direct-caller paths it
    // is not caught by anything. Whichever way the correction goes, an unsafe
    // entry must not survive into the child env unremarked.
    const outcome = attemptOverride('path-lead', {
      PATH: [UNTRUSTED, ...TRUSTED_OS_PATH_DIRS].join(path.delimiter),
    });
    if (outcome.rejected) {
      expect(outcome.error.message).toContain(UNTRUSTED);
      return;
    }
    const safety = describePathSafety(outcome.env.PATH, outcome.stubDir);
    expect(
      safety.foreign,
      'an untrusted PATH entry survived into the child env with no rejection. '
      + 'Got PATH=' + JSON.stringify(outcome.env.PATH),
    ).toEqual([]);
  });

  it('CONTROL — the browser scan switch already resists the same override', () => {
    // Passes today. Bounds witness 2: the defect is specific to PATH, and the
    // forced-after-extra merge is the pattern the PATH correction should adopt.
    const { homeDir, stubDir } = ownedDirs('scan-control');
    const env = buildFixtureEnv({
      homeDir,
      stubDir,
      extra: { DELIBERATION_BROWSER_SCAN_MODE: 'auto' },
    });
    expect(env.DELIBERATION_BROWSER_SCAN_MODE).toBe('off');
  });

  it('CONTROL — the fixture env never spreads the ambient process.env', () => {
    const { homeDir, stubDir } = ownedDirs('named-keys');
    const env = buildFixtureEnv({ homeDir, stubDir });
    const ALLOWED = new Set([
      'PATH', 'HOME', 'TMPDIR', 'AIGENTRY_TIER',
      'DELIBERATION_BROWSER_SCAN_MODE',
      // win32-only additions, named so this control is cross-OS honest rather
      // than skipped: on win32 these are legitimately present.
      'USERPROFILE', 'TEMP', 'TMP', 'PATHEXT', 'SystemRoot', 'ComSpec',
      'LOCALAPPDATA',
    ]);
    const unexpected = Object.keys(env).filter(k => !ALLOWED.has(k));
    expect(unexpected, 'unexpected keys leaked into the child env').toEqual([]);
  });
});
