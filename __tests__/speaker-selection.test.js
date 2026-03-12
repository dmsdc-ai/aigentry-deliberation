import { describe, it, expect } from 'vitest';
import { confirmSpeakerSelectionToken, validateSpeakerSelectionRequest } from '../index.js';

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
