import { describe, it, expect } from 'vitest';
import {
  confirmSpeakerSelectionToken,
  validateSpeakerSelectionRequest,
  resolveSelectionOrigin,
  selectSpeakersByDelegation,
  normalizeDelegationMetadata,
  SELECTION_ORIGIN_USER,
  SELECTION_ORIGIN_CONTROLLER_DELEGATED,
  SELECTION_ORIGIN_LEGACY_UNLABELED,
} from '../index.js';

describe('validateSpeakerSelectionRequest', () => {
  const nowMs = Date.parse('2026-03-11T00:10:00.000Z');
  const candidateState = {
    token: 'sel-abc123',
    phase: 'candidates',
    created_at: '2026-03-11T00:05:00.000Z',
    include_browser: false,
    candidate_speakers: ['claude', 'codex', 'gemini'],
  };
  const confirmedState = {
    token: 'sel-confirmed',
    phase: 'confirmed',
    created_at: '2026-03-11T00:06:00.000Z',
    include_browser: false,
    candidate_speakers: ['claude', 'codex', 'gemini'],
    selected_speakers: ['claude', 'codex'],
  };

  it('accepts a fresh confirmed token for the exact selected speakers', () => {
    expect(validateSpeakerSelectionRequest({
      selectionState: confirmedState,
      selection_token: 'sel-confirmed',
      speakers: ['claude', 'codex'],
      includeBrowserSpeakers: false,
      nowMs,
    })).toEqual({ ok: true });
  });

  it('rejects missing token', () => {
    expect(validateSpeakerSelectionRequest({
      selectionState: confirmedState,
      speakers: ['claude', 'codex'],
      includeBrowserSpeakers: false,
      nowMs,
    })).toMatchObject({ ok: false, code: 'missing_token' });
  });

  it('rejects expired token', () => {
    expect(validateSpeakerSelectionRequest({
      selectionState: confirmedState,
      selection_token: 'sel-confirmed',
      speakers: ['claude', 'codex'],
      includeBrowserSpeakers: false,
      nowMs: Date.parse('2026-03-11T00:16:00.001Z'),
    })).toMatchObject({ ok: false, code: 'expired_token' });
  });

  it('rejects browser mode mismatch', () => {
    expect(validateSpeakerSelectionRequest({
      selectionState: confirmedState,
      selection_token: 'sel-confirmed',
      speakers: ['claude', 'codex'],
      includeBrowserSpeakers: true,
      nowMs,
    })).toMatchObject({ ok: false, code: 'mode_mismatch' });
  });

  it('rejects speakers not in the latest snapshot', () => {
    expect(validateSpeakerSelectionRequest({
      selectionState: confirmedState,
      selection_token: 'sel-confirmed',
      speakers: ['claude', 'web-chatgpt-1'],
      includeBrowserSpeakers: false,
      nowMs,
    })).toMatchObject({
      ok: false,
      code: 'speaker_mismatch',
      missing_speakers: ['web-chatgpt-1'],
    });
  });

  it('rejects an unconfirmed candidate token', () => {
    expect(validateSpeakerSelectionRequest({
      selectionState: candidateState,
      selection_token: 'sel-abc123',
      speakers: ['claude', 'codex'],
      includeBrowserSpeakers: false,
      nowMs,
    })).toMatchObject({ ok: false, code: 'selection_not_confirmed' });
  });

  it('rejects a confirmed token when the start speakers differ from the user-confirmed set', () => {
    expect(validateSpeakerSelectionRequest({
      selectionState: confirmedState,
      selection_token: 'sel-confirmed',
      speakers: ['claude', 'gemini'],
      includeBrowserSpeakers: false,
      nowMs,
    })).toMatchObject({
      ok: false,
      code: 'selected_speakers_mismatch',
      expected_speakers: ['claude', 'codex'],
      requested_speakers: ['claude', 'gemini'],
    });
  });
});

describe('confirmSpeakerSelectionToken', () => {
  const candidateState = {
    token: 'sel-abc123',
    phase: 'candidates',
    created_at: '2026-03-11T00:05:00.000Z',
    include_browser: false,
    candidate_speakers: ['claude', 'codex', 'gemini'],
  };

  it('mints a confirmed token for the exact user-picked speakers', () => {
    const result = confirmSpeakerSelectionToken({
      selectionState: candidateState,
      selection_token: 'sel-abc123',
      speakers: ['codex', 'claude'],
      includeBrowserSpeakers: false,
      nowMs: Date.parse('2026-03-11T00:10:00.000Z'),
      persist: false,
    });

    expect(result.ok).toBe(true);
    expect(result.selectionState).toMatchObject({
      phase: 'confirmed',
      include_browser: false,
      candidate_speakers: ['claude', 'codex', 'gemini'],
      selected_speakers: ['codex', 'claude'],
    });
    expect(result.selectionState.token).not.toBe('sel-abc123');
  });

  it('rejects confirmation when speakers are outside the candidate snapshot', () => {
    expect(confirmSpeakerSelectionToken({
      selectionState: candidateState,
      selection_token: 'sel-abc123',
      speakers: ['claude', 'web-chatgpt-1'],
      includeBrowserSpeakers: false,
      nowMs: Date.parse('2026-03-11T00:10:00.000Z'),
      persist: false,
    })).toMatchObject({
      ok: false,
      code: 'speaker_mismatch',
      missing_speakers: ['web-chatgpt-1'],
    });
  });
});

// ── Task #1172 — selection_origin at the validator boundary ──────
//
// These exercise the EXISTING exported signature of
// validateSpeakerSelectionRequest against the contract's named state field
// (`selection_origin`). The delegated-token *minting* helper is covered only
// as it.todo below: its final name and signature were not supplied with the
// contract, and inventing one here would bake a guess into the suite.
describe('validateSpeakerSelectionRequest — selection origin', () => {
  const nowMs = Date.parse('2026-03-11T00:10:00.000Z');

  const base = {
    token: 'sel-delegated',
    phase: 'confirmed',
    created_at: '2026-03-11T00:06:00.000Z',
    include_browser: false,
    candidate_speakers: ['claude', 'codex', 'gemini'],
    selected_speakers: ['claude', 'codex'],
  };
  const delegatedState = {
    ...base,
    selection_origin: 'controller-delegated',
    delegation: { task_id: '1172', reference: 'dv1172ad/release1171' },
  };
  // Fresh unbound snapshot, for the mint-boundary cases below.
  const candidateState = {
    token: 'sel-abc123',
    phase: 'candidates',
    created_at: '2026-03-11T00:05:00.000Z',
    include_browser: false,
    candidate_speakers: ['claude', 'codex', 'gemini'],
  };

  const call = (selectionState, overrides = {}) => validateSpeakerSelectionRequest({
    selectionState,
    selection_token: selectionState.token,
    speakers: ['claude', 'codex'],
    includeBrowserSpeakers: false,
    nowMs,
    ...overrides,
  });

  // dv1172ae — REPRESENTATION ADAPTER ONLY. dv1172ad expected the origin to
  // ride back on the validation result. The candidate keeps
  // validateSpeakerSelectionRequest's return shape unchanged and exposes
  // provenance through a separate exported resolver, which the start path
  // calls (index.js:1112). The requirement — "the start path must be able to
  // read the origin, otherwise it cannot avoid labelling the start
  // user-selected" — is unchanged; only where it is read from is adapted.
  it('accepts a delegated token and surfaces its origin to the caller', () => {
    expect(call(delegatedState).ok).toBe(true);

    const resolved = resolveSelectionOrigin(delegatedState);
    expect(resolved.ok).toBe(true);
    expect(resolved.origin).toBe(SELECTION_ORIGIN_CONTROLLER_DELEGATED);
    expect(resolved.legacy).toBe(false);
    expect(resolved.delegation).toMatchObject({ task_id: '1172' });
  });

  it('does not report a legacy human-confirmed token as controller-delegated', () => {
    const legacy = { ...base, token: 'sel-legacy' };
    expect(call(legacy).ok).toBe(true);

    const resolved = resolveSelectionOrigin(legacy);
    expect(resolved.origin).not.toBe(SELECTION_ORIGIN_CONTROLLER_DELEGATED);
    // ...and, per contract, a pre-origin token is not positive human proof
    // either. It must land on the explicit unlabeled marker, not user-selected.
    expect(resolved.origin).not.toBe(SELECTION_ORIGIN_USER);
    expect(resolved.origin).toBe(SELECTION_ORIGIN_LEGACY_UNLABELED);
    expect(resolved.legacy).toBe(true);
    expect(resolved.delegation).toBeFalsy();
  });

  it('fails closed on an unrecognised selection_origin', () => {
    expect(call({ ...delegatedState, selection_origin: 'self-asserted' }))
      .toMatchObject({ ok: false });
  });

  // dv1172ae — RE-TARGETED (aim corrected, gate kept).
  //
  // dv1172ad aimed these at validateSpeakerSelectionRequest, i.e. demanded that
  // stored delegation metadata be re-validated at start. Measured, the
  // candidate validates delegation at MINT and not again at start. Re-validation
  // at start buys nothing against the only actor who can reach that state: an
  // actor with write access to speaker-selection.json can simply write
  // `selection_origin: "user-selected"` and obtain a full human claim, which is
  // strictly stronger than anything a damaged delegation block yields. So the
  // refusal dv1172ad demanded is not a safety gate.
  //
  // The gate that IS real is the one the contract states — bounded nonempty
  // strings, audit CLAIM not authority — enforced where the claim enters the
  // system. These cases therefore assert the mint boundary, which is exactly
  // where the contract puts the requirement. The separate question of whether
  // an unbounded stored claim can propagate outward is pinned below.
  it('refuses to mint when no delegation metadata is supplied', () => {
    expect(normalizeDelegationMetadata(undefined)).toMatchObject({ ok: false });
    expect(selectSpeakersByDelegation({
      selectionState: candidateState,
      selection_token: 'sel-abc123',
      speakers: ['claude', 'codex'],
      includeBrowserSpeakers: false,
      nowMs,
      persist: false,
    })).toMatchObject({ ok: false });
  });

  it.each([
    ['blank task_id', { task_id: '  ', reference: 'dv1172ad' }],
    ['blank reference', { task_id: '1172', reference: '' }],
    ['missing reference', { task_id: '1172' }],
    ['non-string task_id', { task_id: 1172, reference: 'dv1172ad' }],
    ['oversized reference', { task_id: '1172', reference: 'x'.repeat(100_000) }],
    ['oversized task_id', { task_id: 'x'.repeat(100_000), reference: 'dv1172ad' }],
    ['array, not an object', [['task_id', '1172']]],
  ])('refuses to mint on delegation metadata: %s', (_label, delegation) => {
    expect(normalizeDelegationMetadata(delegation)).toMatchObject({ ok: false });
    expect(selectSpeakersByDelegation({
      selectionState: candidateState,
      selection_token: 'sel-abc123',
      speakers: ['claude', 'codex'],
      includeBrowserSpeakers: false,
      delegation,
      nowMs,
      persist: false,
    })).toMatchObject({ ok: false });
  });

  // dv1172ae — NEW. The bound exists so a delegated token "cannot become an
  // arbitrary payload carrier" (lib/speaker-discovery.js:367). A bound applied
  // only on write is not a bound on what downstream readers receive: state,
  // history and archive all echo whatever the file holds.
  // dv1172ah — CORRECTED to the ratified oracle, and made STRICTER.
  //
  // dv1172ae wrote this before the authoritative matrix existed and guessed
  // that an over-bound stored claim would be accepted with the reference cut
  // down to 200 (`ok === true` plus a length ceiling). The ratified oracle
  // forbids exactly that: an over-bound claim must REFUSE, and must "never
  // truncate, downgrade or accept absent metadata" — a truncated claim is a
  // value that looks like it passed the bound when it never did.
  it.each([
    ['at the 100000-char repro length', 'x'.repeat(100_000)],
    ['one char over the bound', 'x'.repeat(201)],
  ])('REFUSES an over-bound delegation claim read from state, %s', (_label, reference) => {
    const oversized = { ...delegatedState, delegation: { task_id: '1172', reference } };
    const resolved = resolveSelectionOrigin(oversized);

    expect(resolved.ok, 'an over-bound stored claim was accepted at the read boundary').toBe(false);
    // Refused, not silently shortened into an apparently valid value.
    expect(resolved.delegation, 'a refusal still handed back a delegation claim').toBeFalsy();
  });

  it('accepts a stored delegation claim exactly at the mint bound', () => {
    const atBound = { ...delegatedState, delegation: { task_id: '1172', reference: 'x'.repeat(200) } };
    const resolved = resolveSelectionOrigin(atBound);

    expect(resolved.ok, 'a claim exactly at the bound was refused').toBe(true);
    expect(resolved.delegation.reference.length, 'the at-bound reference was altered').toBe(200);
    // Canonical claim only — claim restated as unverified audit metadata.
    expect(Object.keys(resolved.delegation).sort()).toEqual(['claim', 'reference', 'task_id']);
    expect(resolved.delegation.claim).toBe(true);
  });

  // dv1172ah — the stored file must not be able to disclaim the audit flag or
  // park extra fields that ride into the start path as though they were part
  // of the contract. `claim: true` is an UNVERIFIED audit claim, restated by
  // the normalizer, never read back from the tampered file.
  it('returns only the canonical claim, ignoring tampered and extra stored fields', () => {
    const tampered = {
      ...delegatedState,
      delegation: {
        task_id: '1172',
        reference: 'dv1172ah/release1171',
        claim: false,
        human_selection_confirmed: true,
        approved_by: 'a-human',
      },
    };
    const resolved = resolveSelectionOrigin(tampered);

    expect(resolved.ok).toBe(true);
    expect(Object.keys(resolved.delegation).sort(), 'non-canonical stored fields survived')
      .toEqual(['claim', 'reference', 'task_id']);
    expect(resolved.delegation.claim, 'a stored claim:false was honoured instead of restated')
      .toBe(true);
    expect(resolved.origin).toBe('controller-delegated');
  });

  // dv1172ah — the non-object and absent shapes, refused at the same boundary.
  it.each([
    ['deleted', (s) => { const c = { ...s }; delete c.delegation; return c; }],
    ['null', (s) => ({ ...s, delegation: null })],
    ['array', (s) => ({ ...s, delegation: [] })],
    ['non-empty array', (s) => ({ ...s, delegation: [{ task_id: '1172', reference: 'r' }] })],
    ['string', (s) => ({ ...s, delegation: 'dv1172ah' })],
    ['number', (s) => ({ ...s, delegation: 1172 })],
    ['blank fields', (s) => ({ ...s, delegation: { task_id: '   ', reference: '' } })],
    ['non-string task_id', (s) => ({ ...s, delegation: { task_id: 1172, reference: 'r' } })],
    ['missing reference', (s) => ({ ...s, delegation: { task_id: '1172' } })],
  ])('REFUSES a delegated stored selection whose claim is %s', (_label, tamper) => {
    const resolved = resolveSelectionOrigin(tamper(delegatedState));

    expect(resolved.ok, 'a damaged stored claim was accepted at the read boundary').toBe(false);
    // Must not silently downgrade a delegated origin into the legacy label,
    // which would launder a damaged delegated token into an accepted start.
    expect(resolved.origin, 'a damaged delegated claim was downgraded to legacy')
      .not.toBe('legacy-unlabeled');
  });

  it('still rejects a delegated token for the wrong speaker set', () => {
    expect(call(delegatedState, { speakers: ['claude', 'gemini'] }))
      .toMatchObject({ ok: false, code: 'selected_speakers_mismatch' });
  });

  it('still rejects a consumed delegated token', () => {
    expect(call({ ...delegatedState, consumed_at: '2026-03-11T00:08:00.000Z' }))
      .toMatchObject({ ok: false, code: 'token_already_consumed' });
  });

  // dv1172ae — the two cases dv1172ad parked as `todo` pending a signature.
  // The candidate exports `selectSpeakersByDelegation({ selectionState,
  // selection_token, speakers, includeBrowserSpeakers, delegation, nowMs,
  // persist })` (index.js:3117), so they are now written for real. This closes
  // the "unit mint helper" gate dv1172ad left open.
  const mint = (overrides = {}) => selectSpeakersByDelegation({
    selectionState: candidateState,
    selection_token: 'sel-abc123',
    speakers: ['codex', 'claude'],
    includeBrowserSpeakers: false,
    delegation: { task_id: '1172', reference: 'dv1172ad/release1171' },
    nowMs,
    persist: false,
    ...overrides,
  });

  it('mints a delegated token stamped controller-delegated', () => {
    const result = mint();
    expect(result.ok).toBe(true);
    expect(result.selectionState).toMatchObject({
      phase: 'confirmed',
      selection_origin: SELECTION_ORIGIN_CONTROLLER_DELEGATED,
      selected_speakers: ['codex', 'claude'],
      include_browser: false,
    });
    // Fresh token, never the candidate token it consumed.
    expect(result.selectionState.token).not.toBe('sel-abc123');
    // Not pre-consumed, and the claim is recorded as a claim.
    expect(result.selectionState.consumed_at).toBeFalsy();
    expect(result.selectionState.delegation).toEqual({
      task_id: '1172', reference: 'dv1172ad/release1171', claim: true,
    });

    // The human route over the same snapshot must stay distinguishable.
    const human = confirmSpeakerSelectionToken({
      selectionState: candidateState,
      selection_token: 'sel-abc123',
      speakers: ['codex', 'claude'],
      includeBrowserSpeakers: false,
      nowMs,
      persist: false,
    });
    expect(human.selectionState.selection_origin).toBe(SELECTION_ORIGIN_USER);
    expect(human.selectionState.delegation).toBeUndefined();
  });

  it('mint helper refuses speakers outside the snapshot', () => {
    expect(mint({ speakers: ['claude', 'web-chatgpt-1'] })).toMatchObject({
      ok: false,
      code: 'speaker_mismatch',
      missing_speakers: ['web-chatgpt-1'],
    });
  });

  it('mint helper refuses an empty speaker set', () => {
    expect(mint({ speakers: [] })).toMatchObject({ ok: false });
  });

  it('mint helper enforces the same freshness rules as the human route', () => {
    // stale snapshot
    expect(mint({ nowMs: Date.parse('2026-03-11T00:21:00.001Z') }))
      .toMatchObject({ ok: false, code: 'expired_token' });
    // wrong token
    expect(mint({ selection_token: 'sel-not-this-one' }))
      .toMatchObject({ ok: false, code: 'token_mismatch' });
    // already consumed
    expect(mint({ selectionState: { ...candidateState, consumed_at: '2026-03-11T00:08:00.000Z' } }))
      .toMatchObject({ ok: false, code: 'token_already_consumed' });
    // browser-mode mismatch against the snapshot
    expect(mint({ includeBrowserSpeakers: true }))
      .toMatchObject({ ok: false, code: 'mode_mismatch' });
  });
});
