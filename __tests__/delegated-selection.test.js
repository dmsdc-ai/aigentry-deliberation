// Task #1172 / release 1171 — controller-delegated speaker selection.
//
// Covers the additive contract end to end over the REAL MCP stdio transport:
//   API surface -> snapshot validation -> persisted delegated token
//   -> deliberation_start -> persisted selection_origin.
//
// Deliberately NOT regex checks over index.js: every assertion below observes
// tool responses or persisted state produced by the running server.
//
// Synthetic seams are confined to helpers/stub-cli-bin.mjs (PATH-level CLI
// stubs, declared ceiling 11) and the harness's inert env. The selection
// validator itself is never stubbed.
//
// dm1172av MAINTENANCE — two changes, no behavioural assertion touched:
//   1. The harness and stub helpers were imported from `../../../helpers`,
//      two directories ABOVE the repository. That path only existed inside a
//      validation packet, so the file could not resolve from a checkout. They
//      now live in `__tests__/helpers/`, beside the ratified discovery
//      fixture, and are imported relatively.
//   2. The three packet-immutability cases were replaced (see the final
//      describe for the exact old -> new mapping and its declared limits).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  getText,
  findSelectionState,
  findSessions,
  writeSelectionState,
} from './helpers/mcp-harness.mjs';
import { createStubCliBin, STUB_SEAM_CEILING } from './helpers/stub-cli-bin.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVER_ENTRY = path.join(REPO_ROOT, 'index.js');

const DELEGATION = { task_id: '1172', reference: 'dv1172ad/release1171' };
const DELEGATED_ORIGIN = 'controller-delegated';
const LEGACY_ORIGIN = 'legacy-unlabeled';
const USER_ORIGIN = 'user-selected';

// dv1172ae — REPRESENTATION ADAPTER ONLY.
//
// dv1172ad authored these assertions against a guessed top-level
// `session.selection_origin`, because the baseline persisted no origin field at
// all and the contract named none. The candidate persists provenance as a
// structured `session.speaker_selection` block. Only the *read path* is adapted
// here; every substantive gate below is unchanged.
const sessionOrigin = (session) => session?.speaker_selection?.origin;
const sessionDelegation = (session) => session?.speaker_selection?.delegation;

const openHarnesses = [];
const openStubs = [];

afterEach(async () => {
  while (openHarnesses.length > 0) await openHarnesses.pop().cleanup();
  while (openStubs.length > 0) openStubs.pop().cleanup();
});

// dv1172ae CORRECTION — persist the measured reject/session/token matrix so the
// malformed-start outcomes are ratifiable evidence rather than an assertion
// that quietly passed on an empty loop.
afterAll(() => {
  const dest = process.env.DV1172AE_MATRIX_OUT;
  if (!dest || MATRIX.length === 0) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify({
    candidate: 'ds1172ac',
    note: 'MEASURED outcomes, not ratified expectations. Reject-vs-accept per '
      + 'shape awaits the authoritative matrix from prior clarification.',
    columns: ['case', 'rejected', 'sessions', 'token_present', 'token_consumed',
      'session_origin', 'human_selection_confirmed', 'delegation_reference_length',
      'claims_human_in_text'],
    rows: MATRIX.slice().sort((a, b) => a.case.localeCompare(b.case)),
  }, null, 2));
});

/** Boot a server whose discovery sees exactly `speakerCount` inert CLI stubs. */
async function bootWithSpeakers(speakerCount, { config = {} } = {}) {
  const stub = createStubCliBin(speakerCount);
  openStubs.push(stub);
  const harness = await createHarness({
    serverEntry: SERVER_ENTRY,
    repoRoot: REPO_ROOT,
    // dm1172av: the owned stub dir is named explicitly so the harness can
    // ASSERT that nothing but it and the trusted OS dirs reach the child PATH.
    stubDir: stub.dir,
    config,
    env: { PATH: stub.pathValue },
  });
  openHarnesses.push(harness);
  return { harness, stub };
}

/** Mint a fresh candidate snapshot token via the real tool. */
async function freshCandidateToken(harness, { include_browser = false } = {}) {
  const result = await harness.callTool('deliberation_speaker_candidates', {
    include_cli: true,
    include_browser,
  });
  const text = getText(result);
  const token = (text.match(/\*\*Candidate token:\*\*\s*`([^`]+)`/) || [])[1];
  expect(token, `no candidate token in snapshot report:\n${text}`).toBeTruthy();
  return { token, text };
}

function startedOk(text) {
  return /Deliberation started/.test(text);
}

// dv1172ae correction — the outcome matrix probe.
//
// Cases that asserted inside `for (const session of findSessions(...))` pass
// VACUOUSLY when the start is refused: zero sessions means the loop body never
// runs and nothing is checked. That is the same vacuous-negative trap the
// dispatch flagged in dv1172ad's 12 missing-tool cases, and it is why the
// malformed-start rows must not be read as passes.
//
// This records the three outcomes that together pin a start — did it REJECT,
// how many SESSIONS exist, what happened to the TOKEN — so an assertion can be
// made against a determinate tuple instead of an empty loop.
const MATRIX = [];

async function startOutcome(harness, label, args) {
  const text = getText(await harness.callTool('deliberation_start', args));
  const sessions = findSessions(harness.homeDir);
  const token = findSelectionState(harness.homeDir);
  const session = sessions[0] || null;

  const outcome = {
    case: label,
    rejected: !startedOk(text),
    sessions: sessions.length,
    token_present: Boolean(token?.token),
    token_consumed: Boolean(token?.consumed_at),
    session_origin: session ? (sessionOrigin(session) ?? null) : null,
    human_selection_confirmed: session
      ? (session.speaker_selection?.human_selection_confirmed ?? null)
      : null,
    delegation_reference_length: session
      ? (sessionDelegation(session)?.reference || '').length
      : null,
    claims_human_in_text: /user-selected/.test(text)
      || /user (confirmed|approved|selected)/i.test(text)
      || /human (confirmed|approved|verified)/i.test(text),
  };
  MATRIX.push(outcome);
  return { ...outcome, text };
}

/**
 * The invariants that hold on BOTH branches, so neither branch is vacuous.
 * Deliberately does NOT pin reject-vs-accept: which malformed shapes must be
 * refused outright is the matrix awaiting ratification (see REPORT §2), and
 * asserting the measured value would bake the candidate's current behaviour in
 * as the expectation.
 */
function expectDeterminateOutcome(outcome) {
  // Truthfulness, asserted unconditionally rather than inside a loop.
  expect(outcome.claims_human_in_text, `start text claims a human:\n${outcome.text}`).toBe(false);

  if (outcome.rejected) {
    expect(outcome.sessions, 'a refused start still created a session').toBe(0);
  } else {
    expect(outcome.sessions, 'an accepted start did not create exactly one session').toBe(1);
    expect(outcome.session_origin, 'accepted start recorded no origin').toBeTruthy();
    expect(outcome.session_origin).not.toBe(USER_ORIGIN);
    expect(
      outcome.human_selection_confirmed,
      'accepted start recorded a positive human-selection claim'
    ).toBe(false);
    expect(outcome.token_consumed, 'accepted start left the single-use token unconsumed').toBe(true);
  }
}

// dv1172ah — RATIFIED ORACLE.
//
// dv1172ae deliberately did not pin reject-vs-accept, because the authoritative
// matrix had not arrived. It has now, so these two helpers replace the
// either-branch acceptance with an exact expectation per shape. Neither helper
// contains a conditional on the measured outcome: the branch is the assertion.

/**
 * Ratified REFUSE. An explicitly controller-delegated stored selection whose
 * delegation claim or bounded metadata is damaged must be refused outright:
 * zero sessions, and the token RETAINED and NOT consumed, so the refusal costs
 * the caller nothing and cannot be used to burn a token. No provider, browser
 * or telepty actuation is reachable — those seams are inert in the harness.
 */
function expectRatifiedRefusal(outcome) {
  expect(outcome.rejected, `expected REFUSE, got a start:\n${outcome.text}`).toBe(true);
  expect(outcome.sessions, 'a refused start created a session').toBe(0);
  expect(outcome.token_present, 'a refusal discarded the token instead of retaining it').toBe(true);
  expect(outcome.token_consumed, 'a refusal consumed the single-use token').toBe(false);
  expect(outcome.claims_human_in_text, `refusal text claims a human:\n${outcome.text}`).toBe(false);
  // Nothing was created, so there is no origin/claim to record.
  expect(outcome.session_origin, 'a refused start recorded an origin').toBe(null);
  expect(outcome.human_selection_confirmed, 'a refused start recorded a human flag').toBe(null);
}

/**
 * Ratified LEGACY ACCEPT. A genuinely origin-less stored selection
 * (missing/null/empty) stays accepted for backward compatibility, but only as
 * `legacy-unlabeled`: never human, and any orphaned delegation claim is dropped
 * rather than resurrected into authority. Exactly one session, token consumed
 * exactly once.
 */
function expectRatifiedLegacyAccept(outcome) {
  expect(outcome.rejected, `expected legacy ACCEPT, got a refusal:\n${outcome.text}`).toBe(false);
  expect(outcome.sessions, 'legacy accept did not create exactly one session').toBe(1);
  expect(outcome.token_consumed, 'legacy accept left the single-use token unconsumed').toBe(true);
  expect(outcome.session_origin, 'legacy accept recorded the wrong origin').toBe(LEGACY_ORIGIN);
  expect(outcome.session_origin).not.toBe(DELEGATED_ORIGIN);
  expect(outcome.session_origin).not.toBe(USER_ORIGIN);
  expect(outcome.human_selection_confirmed, 'legacy accept claimed human selection').toBe(false);
  expect(
    outcome.delegation_reference_length,
    'an orphaned delegation claim survived into a legacy-unlabeled session'
  ).toBe(0);
  expect(outcome.claims_human_in_text, `legacy start text claims a human:\n${outcome.text}`).toBe(false);
}

/**
 * Fail-closed assertion. A refusal must (a) not start a deliberation and
 * (b) not leave a delegated token behind for a later call to pick up.
 * Intentionally does not assert a specific error-code string: the contract
 * names the failure conditions, not the product's error vocabulary.
 */
function expectFailedClosed(harness, text) {
  expect(startedOk(text), `expected refusal, got a start:\n${text}`).toBe(false);
  const state = findSelectionState(harness.homeDir);
  if (state && state.selection_origin === DELEGATED_ORIGIN) {
    expect(
      Boolean(state.consumed_at),
      `refusal left a live delegated token behind:\n${JSON.stringify(state, null, 2)}`
    ).toBe(true);
  }
}

describe('deliberation_select_speakers — tool surface', () => {
  it('registers the delegated-selection tool without replacing the human TUI route', async () => {
    const { harness } = await bootWithSpeakers(3);
    const names = ((await harness.listTools()).tools || []).map(t => t.name);

    expect(names).toContain('deliberation_select_speakers');
    // confirm_speakers stays the human route — it must not be removed or aliased away.
    expect(names).toContain('deliberation_confirm_speakers');
    expect(names).toContain('deliberation_speaker_candidates');
  });

  it('declares selection_token, speakers and delegation as required arguments', async () => {
    const { harness } = await bootWithSpeakers(3);
    const tool = ((await harness.listTools()).tools || [])
      .find(t => t.name === 'deliberation_select_speakers');
    expect(tool, 'deliberation_select_speakers is not registered').toBeTruthy();

    const props = tool.inputSchema?.properties || {};
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['selection_token', 'speakers', 'delegation'])
    );
  });
});

describe('deliberation_select_speakers — minting', () => {
  it('mints a single-use token stamped selection_origin=controller-delegated', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const { token } = await freshCandidateToken(harness);
    const speakers = stub.speakers.slice(0, 3);

    const text = getText(await harness.callTool('deliberation_select_speakers', {
      selection_token: token,
      speakers,
      delegation: DELEGATION,
    }));

    const state = findSelectionState(harness.homeDir);
    expect(state, `no selection state persisted:\n${text}`).toBeTruthy();
    expect(state.selection_origin).toBe(DELEGATED_ORIGIN);
    expect(state.selected_speakers.slice().sort()).toEqual(speakers.slice().sort());
    expect(state.token).not.toBe(token); // a fresh token, not the candidate token
    expect(state.consumed_at, 'a freshly minted token must not be pre-consumed').toBeFalsy();
  });

  it('records the delegation claim as audit metadata, never as authority', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const { token } = await freshCandidateToken(harness);

    const text = getText(await harness.callTool('deliberation_select_speakers', {
      selection_token: token,
      speakers: stub.speakers.slice(0, 3),
      delegation: DELEGATION,
    }));

    // The claim is retained for audit...
    const state = findSelectionState(harness.homeDir);
    expect(state.delegation).toMatchObject(DELEGATION);
    // ...flagged as a caller-supplied claim, not a verified fact...
    expect(state.delegation.claim).toBe(true);
    // ...but the response must not present it as human approval or identity.
    expect(text).not.toMatch(/user (confirmed|approved|selected)/i);
    expect(text).not.toMatch(/human (confirmed|approved|verified)/i);
    // and it must say out loud that the claim is unverified.
    expect(text).toMatch(/unverified/i);
  });

  it('does not let a delegated token masquerade as the confirmed human phase', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const { token } = await freshCandidateToken(harness);
    await harness.callTool('deliberation_select_speakers', {
      selection_token: token,
      speakers: stub.speakers.slice(0, 3),
      delegation: DELEGATION,
    });

    const state = findSelectionState(harness.homeDir);
    // Whatever phase the product uses, the origin must remain explicit and
    // must not be the legacy human-confirmation marker with no origin at all.
    expect(state.selection_origin).toBe(DELEGATED_ORIGIN);
    expect(
      state.phase === 'confirmed' && state.selection_origin !== DELEGATED_ORIGIN
    ).toBe(false);
  });
});

describe('deliberation_select_speakers — fails closed', () => {
  it('refuses speakers outside the fresh snapshot', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const { token } = await freshCandidateToken(harness);

    const text = getText(await harness.callTool('deliberation_select_speakers', {
      selection_token: token,
      speakers: [...stub.speakers.slice(0, 2), 'not-a-discovered-speaker'],
      delegation: DELEGATION,
    }));
    expectFailedClosed(harness, text);
  });

  it('refuses a missing delegation block', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const { token } = await freshCandidateToken(harness);

    const text = getText(await harness.callTool('deliberation_select_speakers', {
      selection_token: token,
      speakers: stub.speakers.slice(0, 3),
    }));
    expectFailedClosed(harness, text);
  });

  it.each([
    ['blank task_id', { task_id: '   ', reference: 'dv1172ad' }],
    ['blank reference', { task_id: '1172', reference: '' }],
    ['missing reference', { task_id: '1172' }],
    ['non-string task_id', { task_id: 1172, reference: 'dv1172ad' }],
  ])('refuses delegation metadata: %s', async (_label, delegation) => {
    const { harness, stub } = await bootWithSpeakers(3);
    const { token } = await freshCandidateToken(harness);

    const text = getText(await harness.callTool('deliberation_select_speakers', {
      selection_token: token,
      speakers: stub.speakers.slice(0, 3),
      delegation,
    }));
    expectFailedClosed(harness, text);
  });

  it('refuses oversized delegation metadata', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const { token } = await freshCandidateToken(harness);

    const text = getText(await harness.callTool('deliberation_select_speakers', {
      selection_token: token,
      speakers: stub.speakers.slice(0, 3),
      delegation: { task_id: '1172', reference: 'x'.repeat(100_000) },
    }));
    expectFailedClosed(harness, text);
  });

  it('refuses a stale (unknown) selection token', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    await freshCandidateToken(harness);

    const text = getText(await harness.callTool('deliberation_select_speakers', {
      selection_token: 'sel-stale-does-not-exist',
      speakers: stub.speakers.slice(0, 3),
      delegation: DELEGATION,
    }));
    expectFailedClosed(harness, text);
  });

  it('refuses reuse of a candidate token that already produced a delegated token', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const { token } = await freshCandidateToken(harness);
    const speakers = stub.speakers.slice(0, 3);

    await harness.callTool('deliberation_select_speakers', {
      selection_token: token, speakers, delegation: DELEGATION,
    });
    const second = getText(await harness.callTool('deliberation_select_speakers', {
      selection_token: token, speakers, delegation: DELEGATION,
    }));

    expect(startedOk(second)).toBe(false);
    // The first delegated token must not have been silently replaced.
    const state = findSelectionState(harness.homeDir);
    expect(state.selection_origin).toBe(DELEGATED_ORIGIN);
  });

  // dv1172ae — RE-TARGETED (aim corrected, gate unchanged).
  //
  // dv1172ad aimed the browser-mode gate at mint time. Measured against the
  // candidate, neither selection route checks mode at mint: both
  // deliberation_confirm_speakers (index.js:1441) and
  // deliberation_select_speakers (index.js:1496) derive
  // includeBrowserSpeakers from the snapshot being bound, so
  // validateSpeakerSelectionSnapshot's `mode_mismatch` branch is unreachable
  // there — for the HUMAN route too. The gate lives at deliberation_start,
  // where the mode comes from config/args instead. Asserting a refusal the
  // human path never made would have held the delegated path to an invented
  // standard. The requirement that survives is the one the contract states:
  // the delegated path must be no weaker than the human path. Both halves are
  // asserted below.
  it('binds browser mode from the snapshot exactly as the human route does', async () => {
    const { harness, stub } = await bootWithSpeakers(3, {
      config: { include_browser_speakers: false },
    });
    const speakers = stub.speakers.slice(0, 3);

    const { token: delegatedSnapshot } = await freshCandidateToken(harness, { include_browser: true });
    await harness.callTool('deliberation_select_speakers', {
      selection_token: delegatedSnapshot, speakers, delegation: DELEGATION,
    });
    const delegatedState = findSelectionState(harness.homeDir);

    const { token: humanSnapshot } = await freshCandidateToken(harness, { include_browser: true });
    await harness.callTool('deliberation_confirm_speakers', {
      selection_token: humanSnapshot, speakers,
    });
    const humanState = findSelectionState(harness.homeDir);

    // Same binding, same strictness — the delegated route grants no extra reach.
    expect(delegatedState.include_browser).toBe(humanState.include_browser);
    expect(delegatedState.candidate_speakers).toEqual(humanState.candidate_speakers);
  });

  it('refuses at start when the delegated token mode differs from the start mode', async () => {
    const { harness, stub } = await bootWithSpeakers(3, {
      config: { include_browser_speakers: false },
    });
    const speakers = stub.speakers.slice(0, 3);
    const { token } = await freshCandidateToken(harness, { include_browser: true });

    await harness.callTool('deliberation_select_speakers', {
      selection_token: token, speakers, delegation: DELEGATION,
    });
    const delegatedToken = findSelectionState(harness.homeDir).token;
    expect(delegatedToken, 'delegated token was not minted').toBeTruthy();

    // Token is bound to include_browser=true; this start runs browser-off.
    const text = getText(await harness.callTool('deliberation_start', {
      topic: 'delegated token bound to a different browser mode',
      selection_token: delegatedToken,
      speakers,
    }));
    expect(startedOk(text), `mode-mismatched delegated token started a session:\n${text}`).toBe(false);
    expect(findSessions(harness.homeDir)).toHaveLength(0);
  });
});

describe('deliberation_start — delegated selection', () => {
  async function mintDelegated(harness, speakers) {
    const { token } = await freshCandidateToken(harness);
    await harness.callTool('deliberation_select_speakers', {
      selection_token: token, speakers, delegation: DELEGATION,
    });
    const state = findSelectionState(harness.homeDir);
    expect(state?.token, 'delegated token was not minted').toBeTruthy();
    return state.token;
  }

  it('accepts the exact delegated selection and persists the origin in session state', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    const text = getText(await harness.callTool('deliberation_start', {
      topic: 'delegated start persists origin',
      selection_token: delegatedToken,
      speakers,
    }));
    expect(startedOk(text), text).toBe(true);

    const [session] = findSessions(harness.homeDir);
    expect(session, 'no session persisted').toBeTruthy();
    expect(sessionOrigin(session)).toBe(DELEGATED_ORIGIN);
    expect(session.speaker_selection.human_selection_confirmed).toBe(false);
    expect(sessionDelegation(session)).toMatchObject(DELEGATION);
    expect(session.speakers.slice().sort()).toEqual(speakers.slice().sort());
  });

  it('never labels a delegated start as user-selected, in output or state', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    // dv1172ae: the topic is echoed verbatim into the start report, so a topic
    // containing the literal "user-selected" makes the assertion below match
    // its own input. Topic reworded; the assertion is untouched.
    const text = getText(await harness.callTool('deliberation_start', {
      topic: 'delegated start provenance label',
      selection_token: delegatedToken,
      speakers,
    }));

    expect(text).not.toMatch(/user-selected/);
    expect(text).toMatch(/controller-delegated/);
    const [session] = findSessions(harness.homeDir);
    expect(JSON.stringify(session)).not.toMatch(/user-selected/);
  });

  it('consumes the delegated token exactly once', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    const first = getText(await harness.callTool('deliberation_start', {
      topic: 'first delegated start', selection_token: delegatedToken, speakers,
    }));
    expect(startedOk(first), first).toBe(true);

    const second = getText(await harness.callTool('deliberation_start', {
      topic: 'replayed delegated start', selection_token: delegatedToken, speakers,
    }));
    expect(startedOk(second), `replayed delegated token started a session:\n${second}`).toBe(false);
    expect(findSessions(harness.homeDir)).toHaveLength(1);
  });

  it('refuses a start whose speaker set differs from the delegated set', async () => {
    const { harness, stub } = await bootWithSpeakers(4);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    const text = getText(await harness.callTool('deliberation_start', {
      topic: 'mismatched delegated start',
      selection_token: delegatedToken,
      speakers: [...speakers, stub.speakers[3]],
    }));
    expect(startedOk(text), text).toBe(false);
    expect(findSessions(harness.homeDir)).toHaveLength(0);
  });

  it('fails closed on an unknown selection_origin in persisted state', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    // Tamper: a state file claiming an origin the product does not know.
    const state = findSelectionState(harness.homeDir);
    writeSelectionState(harness.homeDir, { ...state, selection_origin: 'totally-unknown-origin' });

    const outcome = await startOutcome(harness, 'unknown explicit origin', {
      topic: 'unknown origin must fail closed',
      selection_token: delegatedToken,
      speakers,
    });

    // dv1172ah — RATIFIED. The refusal must land BEFORE token consumption and
    // before session creation, so the token survives unconsumed.
    expectRatifiedRefusal(outcome);
  });

  // dv1172ae — ADAPTED to the contract's stated gate, assertions kept.
  //
  // dv1172ad additionally threw unconditionally if an origin-less token started
  // at all. That extra clause is not the contract's requirement and cannot be:
  // every token minted before this feature existed carries no origin, so
  // refusing them outright would break the installed base the candidate is
  // required to stay compatible with. The contract's words are "Legacy-
  // unlabeled must NOT become positive human proof" — acceptance is allowed,
  // a human claim is not. The throw is replaced by the stronger form of exactly
  // that gate, asserted unconditionally rather than only on the accept branch.
  it('does not let an origin-stripped delegated token launder into human proof', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    // Tamper: strip the origin marker to make the delegated token look like a
    // legacy human confirmation.
    const state = findSelectionState(harness.homeDir);
    const laundered = { ...state, phase: 'confirmed' };
    delete laundered.selection_origin;
    delete laundered.delegation;
    writeSelectionState(harness.homeDir, laundered);

    const outcome = await startOutcome(harness, 'origin+delegation stripped (launder)', {
      topic: 'laundering attempt',
      selection_token: delegatedToken,
      speakers,
    });

    // dv1172ah — RATIFIED row 8. Legacy compatibility is retained: an
    // origin-less stored selection is accepted, but only as legacy-unlabeled,
    // and laundering it into human authority is the thing that must not happen.
    expectRatifiedLegacyAccept(outcome);
    expect(
      outcome.human_selection_confirmed,
      'a laundered origin-less token was recorded as a confirmed human selection'
    ).toBe(false);
  });

  // dv1172ae — NEW, per contract: "stripping origin while retaining delegation".
  it('drops the delegation claim when the origin that justified it is stripped', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    // Tamper: remove only the origin. The delegation block stays behind.
    const state = findSelectionState(harness.homeDir);
    const stripped = { ...state };
    delete stripped.selection_origin;
    expect(stripped.delegation, 'fixture error: delegation was not retained').toBeTruthy();
    writeSelectionState(harness.homeDir, stripped);

    const outcome = await startOutcome(harness, 'origin stripped, delegation retained', {
      topic: 'origin stripped, delegation retained',
      selection_token: delegatedToken,
      speakers,
    });

    // dv1172ah — RATIFIED row 7. An orphaned delegation block must not
    // resurrect the delegated label, and must be dropped rather than carried
    // into the session as though it were justified. expectRatifiedLegacyAccept
    // pins origin === legacy-unlabeled and reference length === 0 outright.
    expectRatifiedLegacyAccept(outcome);
  });

  // dv1172ae — NEW, per contract: "null/empty/unknown origin".
  it.each([
    ['null origin', null],
    ['empty-string origin', ''],
  ])('treats a %s as unlabeled, never as human proof', async (_label, origin) => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    const state = findSelectionState(harness.homeDir);
    writeSelectionState(harness.homeDir, { ...state, selection_origin: origin });

    const outcome = await startOutcome(harness, `${_label} at start`, {
      topic: 'unlabeled origin start',
      selection_token: delegatedToken,
      speakers,
    });

    // dv1172ah — RATIFIED rows 9-10. Missing/null/empty origin stays accepted
    // as legacy-unlabeled; the delegation is dropped and no human is claimed.
    expectRatifiedLegacyAccept(outcome);
  });

  // dv1172ae — NEW. `legacy-unlabeled` is a label the server applies to absent
  // provenance; it must not be an origin a caller can write into state and have
  // honoured, or "unlabeled" becomes a forgeable value rather than a default.
  it('refuses legacy-unlabeled written explicitly into persisted state', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    const state = findSelectionState(harness.homeDir);
    writeSelectionState(harness.homeDir, { ...state, selection_origin: LEGACY_ORIGIN });

    const text = getText(await harness.callTool('deliberation_start', {
      topic: 'explicitly claimed legacy origin',
      selection_token: delegatedToken,
      speakers,
    }));
    expect(startedOk(text), `an explicitly claimed legacy origin started a session:\n${text}`).toBe(false);
    expect(findSessions(harness.homeDir)).toHaveLength(0);
  });

  // dv1172ae — NEW, per contract: "oversized metadata". The mint boundary
  // bounds the claim at 200 chars so a delegated token "cannot become an
  // arbitrary payload carrier". This measures whether that bound also holds for
  // a claim that reaches the start path from persisted state, which is what
  // ends up in the session record, history and archive.
  it('does not carry an oversized stored delegation claim into session state', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    const state = findSelectionState(harness.homeDir);
    writeSelectionState(harness.homeDir, {
      ...state,
      delegation: { task_id: '1172', reference: 'x'.repeat(100_000), claim: true },
    });

    const outcome = await startOutcome(harness, 'oversized stored delegation claim', {
      topic: 'oversized stored claim',
      selection_token: delegatedToken,
      speakers,
    });

    // dv1172ah — RATIFIED. "Refusing is an acceptable outcome" was the
    // pre-ratification hedge. The authoritative matrix makes refusal the ONLY
    // acceptable outcome: a claim above the mint bound read back from state
    // must be refused, never truncated, downgraded, or absorbed.
    expectRatifiedRefusal(outcome);
    expect(
      outcome.delegation_reference_length,
      'session record absorbed an oversized delegation claim that the mint boundary refuses at 200'
    ).toBe(null);
  });

  // dv1172ae CORRECTION — per contract: "missing or malformed metadata at
  // start". These five rows were previously reported as passes. They were not:
  // every assertion lived inside `for (const session of findSessions(...))`,
  // which is an empty loop whenever the start is refused, so a refusing
  // candidate satisfied them without a single assertion executing.
  //
  // Reject-vs-accept per shape is NOT asserted here — that is the outcome
  // matrix pending ratification (REPORT §2). What IS asserted, on whichever
  // branch actually occurs, is that the outcome is determinate and never a
  // human claim. The measured matrix is written to
  // evidence/malformed-start-matrix.json for ratification.
  // dv1172ah — RATIFIED. The authoritative matrix has arrived, so each shape now
  // asserts its exact outcome instead of accepting either branch. Every shape
  // below is an EXPLICITLY `controller-delegated` stored selection whose claim
  // or bounded metadata is damaged: all must REFUSE, with zero sessions and the
  // token retained unconsumed. dv1172ae's array and non-string cases, absent
  // from the original five, are added here.
  it.each([
    ['delegation deleted', (s) => { const c = { ...s }; delete c.delegation; return c; }],
    ['delegation nulled', (s) => ({ ...s, delegation: null })],
    ['delegation blanked', (s) => ({ ...s, delegation: { task_id: '   ', reference: '' } })],
    ['delegation not an object', (s) => ({ ...s, delegation: 'dv1172ae' })],
    ['delegation oversized', (s) => ({ ...s, delegation: { task_id: '1172', reference: 'x'.repeat(100_000) } })],
    // dv1172ah — NEW: the array and non-string shapes the prior matrix missed.
    ['delegation is an array', (s) => ({ ...s, delegation: [{ task_id: '1172', reference: 'dv1172ah' }] })],
    ['delegation is an empty array', (s) => ({ ...s, delegation: [] })],
    ['delegation is a number', (s) => ({ ...s, delegation: 1172 })],
    ['delegation is a boolean', (s) => ({ ...s, delegation: true })],
    ['task_id missing', (s) => ({ ...s, delegation: { reference: 'dv1172ah/release1171' } })],
    ['task_id blank', (s) => ({ ...s, delegation: { task_id: '   ', reference: 'dv1172ah/release1171' } })],
    ['task_id non-string', (s) => ({ ...s, delegation: { task_id: 1172, reference: 'dv1172ah/release1171' } })],
    ['task_id null', (s) => ({ ...s, delegation: { task_id: null, reference: 'dv1172ah/release1171' } })],
    ['task_id is an array', (s) => ({ ...s, delegation: { task_id: ['1172'], reference: 'dv1172ah/release1171' } })],
    ['reference missing', (s) => ({ ...s, delegation: { task_id: '1172' } })],
    ['reference blank', (s) => ({ ...s, delegation: { task_id: '1172', reference: '   ' } })],
    ['reference non-string', (s) => ({ ...s, delegation: { task_id: '1172', reference: 42 } })],
    ['reference null', (s) => ({ ...s, delegation: { task_id: '1172', reference: null } })],
    ['reference is an object', (s) => ({ ...s, delegation: { task_id: '1172', reference: { v: 'x' } } })],
    // Above the mint bound (200) — must refuse, never truncate or downgrade.
    ['task_id over the mint bound', (s) => ({ ...s, delegation: { task_id: 'x'.repeat(201), reference: 'dv1172ah' } })],
    ['reference over the mint bound', (s) => ({ ...s, delegation: { task_id: '1172', reference: 'x'.repeat(201) } })],
    ['task_id at 100000 chars', (s) => ({ ...s, delegation: { task_id: 'x'.repeat(100_000), reference: 'dv1172ah' } })],
    ['reference at 100000 chars', (s) => ({ ...s, delegation: { task_id: '1172', reference: 'x'.repeat(100_000) } })],
  ])('REFUSES an explicitly delegated start with damaged metadata: %s', async (label, tamper) => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    const state = findSelectionState(harness.homeDir);
    expect(state.selection_origin, 'precondition: stored origin must be delegated')
      .toBe(DELEGATED_ORIGIN);
    writeSelectionState(harness.homeDir, tamper(state));

    const outcome = await startOutcome(harness, `malformed: ${label}`, {
      topic: 'delegated token with damaged audit metadata',
      selection_token: delegatedToken,
      speakers,
    });

    expectRatifiedRefusal(outcome);
    // Never truncated or downgraded into a value that looks accepted.
    expect(outcome.delegation_reference_length, 'a refused claim still reached a session record')
      .toBe(null);
  });

  // dv1172ah — RATIFIED ACCEPT PATH. The refusal rows above only prove the gate
  // closes. This proves it still opens for valid bounded metadata, exactly
  // once, and that what it records is a CANONICAL claim — not whatever the
  // state file happened to contain.
  it.each([
    ['minimal bounded', { task_id: '1', reference: 'r' }],
    ['exactly at the mint bound', { task_id: 'x'.repeat(200), reference: 'y'.repeat(200) }],
  ])('ACCEPTS valid bounded delegated metadata exactly once: %s', async (_label, delegation) => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    const state = findSelectionState(harness.homeDir);
    writeSelectionState(harness.homeDir, { ...state, delegation });

    const outcome = await startOutcome(harness, `valid bounded: ${_label}`, {
      topic: 'valid bounded delegated start',
      selection_token: delegatedToken,
      speakers,
    });

    expect(outcome.rejected, `valid bounded metadata was refused:\n${outcome.text}`).toBe(false);
    expect(outcome.sessions, 'valid delegated start did not create exactly one session').toBe(1);
    expect(outcome.token_consumed, 'valid delegated start left the token unconsumed').toBe(true);
    expect(outcome.session_origin, 'valid delegated start lost its delegated origin')
      .toBe(DELEGATED_ORIGIN);
    expect(
      outcome.human_selection_confirmed,
      'a controller-delegated start claimed human confirmation'
    ).toBe(false);
    expect(outcome.claims_human_in_text, `delegated start text claims a human:\n${outcome.text}`)
      .toBe(false);
    expect(outcome.delegation_reference_length, 'the bounded reference was not recorded verbatim')
      .toBe(delegation.reference.length);

    // Single-use: the same token must not start a second session.
    const second = getText(await harness.callTool('deliberation_start', {
      topic: 'replay of a consumed delegated token',
      selection_token: delegatedToken,
      speakers,
    }));
    expect(startedOk(second), `a consumed delegated token started a second session:\n${second}`)
      .toBe(false);
    expect(findSessions(harness.homeDir), 'token replay created a second session').toHaveLength(1);
  });

  // dv1172ah — "canonical claim only. Claim=true means an unverified audit
  // claim, not authenticated authority." A tampered state file must not be able
  // to park extra fields on the record, nor disclaim the claim flag, nor forge
  // a human/authority field that rides into the session.
  it('records only the canonical claim, dropping tampered and extra fields', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    const state = findSelectionState(harness.homeDir);
    writeSelectionState(harness.homeDir, {
      ...state,
      delegation: {
        task_id: '1172',
        reference: 'dv1172ah/release1171',
        claim: false,                       // must not disclaim
        human_selection_confirmed: true,    // must not forge authority
        authenticated: true,                // must not be honoured
        approved_by: 'a-human',             // must be dropped
      },
    });

    const outcome = await startOutcome(harness, 'canonical claim only', {
      topic: 'canonical claim',
      selection_token: delegatedToken,
      speakers,
    });

    expect(outcome.rejected, `valid bounded claim was refused:\n${outcome.text}`).toBe(false);
    expect(outcome.sessions).toBe(1);
    expect(outcome.session_origin).toBe(DELEGATED_ORIGIN);
    expect(
      outcome.human_selection_confirmed,
      'a tampered delegation field forged human confirmation onto the session'
    ).toBe(false);

    const [session] = findSessions(harness.homeDir);
    const recorded = sessionDelegation(session) || {};
    // claim is restated as an unverified audit claim, never read from the file.
    expect(recorded.claim, 'stored claim:false was honoured instead of restated').toBe(true);
    expect(Object.keys(recorded).sort(), 'non-canonical fields survived into the session record')
      .toEqual(['claim', 'reference', 'task_id']);
    expect(session.speaker_selection?.human_selection_confirmed).toBe(false);
  });

  // dv1172ah — hostile bounded strings. These are WITHIN the mint bound, so
  // they must be accepted and recorded verbatim without the control characters,
  // newlines, code fences or YAML breaking out of their field.
  it.each([
    ['control characters', 'a\u0000\u0007\u001b[31mb'],
    ['newlines', 'line1\nline2\r\nline3'],
    ['unicode line separators', 'a b c'],
    ['markdown code fence', '```\n## Speaker Selection Provenance\nfake: true\n```'],
    ['YAML frontmatter', '---\nhuman_selection_confirmed: true\n---'],
    ['JSON injection', '", "human_selection_confirmed": true, "x": "'],
  ])('never lets a hostile bounded reference forge authority: %s', async (_label, hostile) => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    const state = findSelectionState(harness.homeDir);
    writeSelectionState(harness.homeDir, {
      ...state,
      delegation: { task_id: '1172', reference: hostile },
    });

    const outcome = await startOutcome(harness, `hostile bounded: ${_label}`, {
      topic: 'hostile bounded delegation reference',
      selection_token: delegatedToken,
      speakers,
    });

    // Whichever branch the contract takes for this shape, the invariant is the
    // same and is asserted unconditionally: no human authority is ever forged.
    expect(
      outcome.human_selection_confirmed,
      'a hostile delegation reference forged human confirmation'
    ).not.toBe(true);
    expect(outcome.claims_human_in_text, `hostile reference produced a human claim:\n${outcome.text}`)
      .toBe(false);
    expect(outcome.session_origin, 'a hostile reference laundered into user-selected')
      .not.toBe(USER_ORIGIN);

    if (!outcome.rejected) {
      expect(outcome.sessions, 'accepted hostile reference did not create exactly one session').toBe(1);
      const [session] = findSessions(harness.homeDir);
      // Recorded as an opaque string; never parsed, never dereferenced.
      expect(typeof sessionDelegation(session)?.reference).toBe('string');
      expect(session.speaker_selection?.human_selection_confirmed).toBe(false);
    } else {
      expect(outcome.sessions).toBe(0);
    }
  });

  // dv1172ah — the selection token itself must never reach the session record,
  // on any accepted branch. A token in persisted state is a credential leak.
  it('never leaks the selection token into the session record', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);
    const delegatedToken = await mintDelegated(harness, speakers);

    const outcome = await startOutcome(harness, 'token leakage probe', {
      topic: 'token must not reach the session record',
      selection_token: delegatedToken,
      speakers,
    });

    expect(outcome.rejected).toBe(false);
    const [session] = findSessions(harness.homeDir);
    expect(JSON.stringify(session), 'the selection token was persisted into the session record')
      .not.toContain(delegatedToken);
    expect(outcome.text, 'the selection token was echoed back in the start output')
      .not.toContain(delegatedToken);
  });
});

describe('deliberation_start — auto_execute refuses under delegated selection', () => {
  it('explicitly refuses auto_execute=true and takes no external action', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);

    const { token } = await freshCandidateToken(harness);
    await harness.callTool('deliberation_select_speakers', {
      selection_token: token, speakers, delegation: DELEGATION,
    });
    const delegatedToken = findSelectionState(harness.homeDir).token;

    const text = getText(await harness.callTool('deliberation_start', {
      topic: 'delegated selection must not grant actuation',
      selection_token: delegatedToken,
      speakers,
      auto_execute: true,
    }));

    // Explicit refusal, not a silent downgrade to auto_execute=false.
    expect(text).toMatch(/auto_execute/i);
    expect(startedOk(text) && /auto_execute/i.test(text) === false).toBe(false);

    // No session may be left in a state that would actuate.
    for (const session of findSessions(harness.homeDir)) {
      expect(session.auto_execute, 'delegated session left auto_execute on').toBeFalsy();
      expect(session.log || [], 'delegated+auto_execute produced turns').toHaveLength(0);
    }
  });

  // dv1172ae — NEW, per contract: the refusal must land "before token
  // consumption or external actuation". Burning the single-use token on a
  // refused call would turn a safety refusal into a denial of service that
  // forces a fresh snapshot round-trip.
  it('refuses auto_execute without consuming the delegated token', async () => {
    const { harness, stub } = await bootWithSpeakers(3);
    const speakers = stub.speakers.slice(0, 3);

    const { token } = await freshCandidateToken(harness);
    await harness.callTool('deliberation_select_speakers', {
      selection_token: token, speakers, delegation: DELEGATION,
    });
    const delegatedToken = findSelectionState(harness.homeDir).token;

    const refused = getText(await harness.callTool('deliberation_start', {
      topic: 'auto_execute refusal must not burn the token',
      selection_token: delegatedToken,
      speakers,
      auto_execute: true,
    }));
    expect(startedOk(refused), refused).toBe(false);

    // The token must still be live and unconsumed...
    const afterRefusal = findSelectionState(harness.homeDir);
    expect(
      afterRefusal.consumed_at,
      'a refused auto_execute start consumed the single-use token'
    ).toBeFalsy();
    expect(afterRefusal.token).toBe(delegatedToken);
    expect(afterRefusal.selection_origin).toBe(DELEGATED_ORIGIN);

    // ...and the coordination-only retry the refusal text advertises must work.
    const retry = getText(await harness.callTool('deliberation_start', {
      topic: 'coordination-only retry after refusal',
      selection_token: delegatedToken,
      speakers,
      auto_execute: false,
    }));
    expect(startedOk(retry), `advertised retry did not start:\n${retry}`).toBe(true);
    const [session] = findSessions(harness.homeDir);
    expect(sessionOrigin(session)).toBe(DELEGATED_ORIGIN);
    expect(session.auto_execute).toBeFalsy();
  });
});

describe('standard mode has no fixed participant cap', () => {
  // >2, >4, >8 per the contract. 11 is the stub seam ceiling
  // (DEFAULT_CLI_CANDIDATES); the product's MAX_AUTO_DISCOVERED_SPEAKERS=12
  // auto-discovery ceiling is a different limit and is not under test here.
  it.each([3, 5, 9, STUB_SEAM_CEILING])(
    'starts a delegated standard-mode deliberation with %i speakers',
    async (count) => {
      const { harness, stub } = await bootWithSpeakers(count);
      const speakers = stub.speakers.slice(0, count);

      const { token } = await freshCandidateToken(harness);
      await harness.callTool('deliberation_select_speakers', {
        selection_token: token, speakers, delegation: DELEGATION,
      });
      const delegatedToken = findSelectionState(harness.homeDir).token;

      const text = getText(await harness.callTool('deliberation_start', {
        topic: `delegated standard mode with ${count} speakers`,
        selection_token: delegatedToken,
        speakers,
      }, 30000));
      expect(startedOk(text), text).toBe(true);

      const [session] = findSessions(harness.homeDir);
      expect(session.speakers, `speaker set was truncated to ${session.speakers.length}`)
        .toHaveLength(count);
      expect(session.mode === undefined || session.mode === 'standard').toBe(true);
      expect(sessionOrigin(session)).toBe(DELEGATED_ORIGIN);
    }
  );

  it('keeps the lite-mode discussion limit as a separate, explicit cap', async () => {
    const { harness, stub } = await bootWithSpeakers(9);
    const speakers = stub.speakers.slice(0, 9);

    const { token } = await freshCandidateToken(harness);
    await harness.callTool('deliberation_select_speakers', {
      selection_token: token, speakers, delegation: DELEGATION,
    });
    const delegatedToken = findSelectionState(harness.homeDir).token;

    const text = getText(await harness.callTool('deliberation_start', {
      topic: 'lite mode caps discussion, not worker spawn',
      selection_token: delegatedToken,
      speakers,
      mode: 'lite',
    }, 30000));
    expect(startedOk(text), text).toBe(true);

    const [session] = findSessions(harness.homeDir);
    // Lite deliberately trims the discussion; standard (above) must not.
    expect(session.speakers.length).toBeLessThan(speakers.length);
    expect(session.mode).toBe('lite');
    expect(sessionOrigin(session)).toBe(DELEGATED_ORIGIN);
  });
});

// ===========================================================================
// dm1172av — REPLACES the three `packet immutability under the candidate
// overlay` cases, one for one, same count, none skipped.
//
// WHY THEY HAD TO GO
// ------------------
// Those three cases were not product behaviour. They asserted facts about a
// validation PACKET: they read `frozen-manifest.json` from
// `REPO_ROOT/../../../` (or `$DV1172AE_FROZEN_MANIFEST`), looked up manifest
// keys `input/candidate-ds1172ac/...`, `input/candidate-ds1172ag/artifacts/...`
// and `input/source/...`, and branched on `$DV1172AH_TREE`. None of those
// locations, env vars or keys exist for this track, and none exists in an
// ordinary checkout. The whole block was additionally wrapped in
// `describe.skipIf(!fs.existsSync(MANIFEST_PATH))`, so shipping it as-is would
// have silently SKIPPED three provenance cases in every repository run —
// three green-looking rows that assert nothing.
//
// OLD -> NEW MAPPING (exact)
//   1. 'keeps the overlaid leaves byte-identical to the candidate packet'
//        -> 'keeps the selection leaves byte-identical across the run'
//      Same two files (index.js, lib/speaker-discovery.js), same sha256
//      equality. The reference changes from an external packet entry to the
//      bytes captured in THIS process before any test body ran.
//   2. 'leaves non-overlaid product files byte-identical to the frozen packet'
//        -> 'keeps the non-selection product files byte-identical across the run'
//      Same three files (lib/session.js, lib/transport.js, lib/telepty.js),
//      same sha256 equality, same change of reference.
//   3. 'proves the overlay actually replaced the frozen leaves'
//        -> 'proves the server under test is the repository-local entry these
//           hashes pin'
//      This one is NOT an equality rename. See the limit below.
//
// DECLARED LIMITS — do not let these drift into over-claims
//   * Cases 1 and 2 now prove IN-RUN IMMUTABILITY: the suite spawned real
//     servers, wrote real state and tampered with real selection files, and
//     none of that reached the product files. They say NOTHING about
//     provenance — they cannot tell a pristine checkout from a modified one,
//     because both endpoints of the comparison come from the same disk in the
//     same process. Provenance is a packet-verification duty, not a duty of
//     the product's own test suite.
//   * Case 3 deliberately makes NO baseline-vs-overlay inequality claim. The
//     old assertion was `sha(index.js) !== sha(frozen input/source/index.js)`,
//     which in an ordinary checkout is simply false: there is no overlay, so
//     the file IS the source. Restating it would have manufactured a failure
//     or, worse, invited a forged manifest key. What it asserts instead is
//     EXECUTION IDENTITY: the handle that answered MCP was spawned as
//     `node <REPO_ROOT>/index.js`, and that file is the one cases 1-2 pin.
//     That closes the gap the old case was reaching for — "the hashes above
//     describe the code that actually ran" — without claiming an overlay.
// ===========================================================================
const WATCHED_SELECTION_LEAVES = ['index.js', 'lib/speaker-discovery.js'];
const WATCHED_SUPPORT_FILES = ['lib/session.js', 'lib/transport.js', 'lib/telepty.js'];

const sha256OfRepoFile = (rel) =>
  crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, rel))).digest('hex');

// Captured at module load — before any test body runs, so before any harness
// has spawned a server, written state or tampered with a selection file.
const PRE_RUN_IDENTITY = Object.freeze(Object.fromEntries(
  [...WATCHED_SELECTION_LEAVES, ...WATCHED_SUPPORT_FILES]
    .map(rel => [rel, sha256OfRepoFile(rel)])
));

describe('repository execution identity and in-run immutability', () => {
  it('keeps the selection leaves byte-identical across the run', () => {
    for (const rel of WATCHED_SELECTION_LEAVES) {
      expect(PRE_RUN_IDENTITY[rel], `${rel} was not captured before the run`)
        .toMatch(/^[0-9a-f]{64}$/);
      expect(sha256OfRepoFile(rel), `${rel} changed on disk during the test run`)
        .toBe(PRE_RUN_IDENTITY[rel]);
    }
  });

  it('keeps the non-selection product files byte-identical across the run', () => {
    for (const rel of WATCHED_SUPPORT_FILES) {
      expect(PRE_RUN_IDENTITY[rel], `${rel} was not captured before the run`)
        .toMatch(/^[0-9a-f]{64}$/);
      expect(sha256OfRepoFile(rel), `${rel} changed on disk during the test run`)
        .toBe(PRE_RUN_IDENTITY[rel]);
    }
  });

  it('proves the server under test is the repository-local entry these hashes pin', async () => {
    const { harness } = await bootWithSpeakers(3);

    // What the runtime actually executed, read off the owned handle.
    expect(harness.child.spawnfile, 'the server was not spawned with this Node binary')
      .toBe(process.execPath);
    expect(harness.child.spawnargs, 'the server was not spawned from the repository entry')
      .toContain(SERVER_ENTRY);
    expect(harness.serverEntry).toBe(SERVER_ENTRY);

    // That entry is inside the repository, not an installed copy elsewhere.
    expect(path.relative(REPO_ROOT, SERVER_ENTRY), 'the server entry is outside the repository')
      .toBe('index.js');

    // It really is serving: a live MCP round trip over the same handle.
    const names = ((await harness.listTools()).tools || []).map(t => t.name);
    expect(names, 'the spawned entry did not serve the delegated-selection tool')
      .toContain('deliberation_select_speakers');

    // And it is byte-identical to the file the two cases above pin.
    expect(sha256OfRepoFile('index.js'), 'the executed entry is not the pinned file')
      .toBe(PRE_RUN_IDENTITY['index.js']);
  });
});
