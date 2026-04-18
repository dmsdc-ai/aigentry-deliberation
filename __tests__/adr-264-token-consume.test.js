// ADR-264 §2.1 — Token Lifecycle Hardening (BUG-001)
// Covers metrics M1a (fresh token accepts), M1b (TTL exceeded — existing), M1c (consume rejects reuse).
// Pure-function level tests on the speaker-discovery token flow.

import { describe, it, expect } from 'vitest';
import {
  validateSpeakerSelectionRequest,
  confirmSpeakerSelectionToken,
} from '../index.js';
import { markSelectionTokenConsumed } from '../lib/speaker-discovery.js';

describe('ADR-264 §2.1 — token consume semantics', () => {
  const nowMs = Date.parse('2026-04-18T00:10:00.000Z');
  const confirmedState = {
    token: 'sel-confirmed-264',
    phase: 'confirmed',
    created_at: '2026-04-18T00:06:00.000Z',
    include_browser: false,
    candidate_speakers: ['claude', 'codex', 'gemini'],
    selected_speakers: ['claude', 'codex'],
  };

  it('M1a: accepts a fresh confirmed token that has not been consumed', () => {
    expect(validateSpeakerSelectionRequest({
      selectionState: confirmedState,
      selection_token: 'sel-confirmed-264',
      speakers: ['claude', 'codex'],
      includeBrowserSpeakers: false,
      nowMs,
    })).toEqual({ ok: true });
  });

  it('M1c: rejects reuse of a token that has been consumed', () => {
    const consumedState = { ...confirmedState, consumed_at: '2026-04-18T00:07:00.000Z' };
    const result = validateSpeakerSelectionRequest({
      selectionState: consumedState,
      selection_token: 'sel-confirmed-264',
      speakers: ['claude', 'codex'],
      includeBrowserSpeakers: false,
      nowMs,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'token_already_consumed',
      consumed_at: '2026-04-18T00:07:00.000Z',
    });
  });

  it('markSelectionTokenConsumed stamps consumed_at on the state object', () => {
    const updated = markSelectionTokenConsumed({
      selectionState: confirmedState,
      nowMs: Date.parse('2026-04-18T00:09:30.000Z'),
      persist: false,
    });
    expect(updated.consumed_at).toBe('2026-04-18T00:09:30.000Z');
    // Additive only — original fields preserved.
    expect(updated.token).toBe(confirmedState.token);
    expect(updated.phase).toBe('confirmed');
    expect(updated.selected_speakers).toEqual(['claude', 'codex']);
  });

  it('consumed_at precedence: checked even when TTL not yet exceeded', () => {
    const consumedState = { ...confirmedState, consumed_at: '2026-04-18T00:07:00.000Z' };
    // nowMs well within 10-min TTL window.
    const result = validateSpeakerSelectionRequest({
      selectionState: consumedState,
      selection_token: 'sel-confirmed-264',
      speakers: ['claude', 'codex'],
      includeBrowserSpeakers: false,
      nowMs: Date.parse('2026-04-18T00:07:30.000Z'),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('token_already_consumed');
  });

  it('confirm mints a fresh token with no consumed_at leak from predecessor', () => {
    const candidateState = {
      token: 'sel-cand-0',
      phase: 'candidates',
      created_at: '2026-04-18T00:05:00.000Z',
      include_browser: false,
      candidate_speakers: ['claude', 'codex', 'gemini'],
    };
    const result = confirmSpeakerSelectionToken({
      selectionState: candidateState,
      selection_token: 'sel-cand-0',
      speakers: ['claude', 'codex'],
      includeBrowserSpeakers: false,
      nowMs,
      persist: false,
    });
    expect(result.ok).toBe(true);
    expect(result.selectionState.consumed_at).toBeUndefined();
  });
});
