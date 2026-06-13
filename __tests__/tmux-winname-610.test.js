import { describe, expect, it } from 'vitest';
import {
  tmuxWindowName,
  parseTmuxWindowIndex,
  buildTmuxAttachTarget,
  buildTmuxAttachCommand,
  TMUX_SESSION,
} from '../lib/transport.js';

// tq#610 — deliberation tmux monitor board fails to surface for Korean topics.
//
// Root cause: tmuxWindowName() permitted Hangul (가-힣) in the tmux window name,
// and the select-window target string was injected through the
// osascript -> Terminal.app -> zsh -> tmux path, where the non-ASCII bytes get
// corrupted, so `select-window -t "deliberation:<corrupted-korean>"` never
// matched and the grouped session stuck on an empty shell.
//
// Fix: resolve the select-window target by window INDEX (pure ASCII digits),
// which survives that path intact. node reads the window names back correctly
// (no osascript layer), so we map name -> index and emit the index.

const LIST_OUTPUT = [
  '0\t608-터미널-어댑터-계약-adr-적-mqbu',
  '1\tcambrian-수익화-abcd',
  '2\tascii-topic-1234',
].join('\n');

describe('parseTmuxWindowIndex (#610)', () => {
  it('finds the index for a Hangul window name', () => {
    expect(parseTmuxWindowIndex(LIST_OUTPUT, '608-터미널-어댑터-계약-adr-적-mqbu')).toBe(0);
    expect(parseTmuxWindowIndex(LIST_OUTPUT, 'cambrian-수익화-abcd')).toBe(1);
  });

  it('finds the index for an ASCII window name (regression)', () => {
    expect(parseTmuxWindowIndex(LIST_OUTPUT, 'ascii-topic-1234')).toBe(2);
  });

  it('returns null when the window name is absent', () => {
    expect(parseTmuxWindowIndex(LIST_OUTPUT, 'no-such-window')).toBe(null);
  });

  it('returns null on empty / malformed output', () => {
    expect(parseTmuxWindowIndex('', 'anything')).toBe(null);
    expect(parseTmuxWindowIndex('garbage-without-tab', 'anything')).toBe(null);
  });
});

describe('buildTmuxAttachTarget (#610)', () => {
  it('targets the window INDEX for a Hangul session id (no Hangul in target)', () => {
    const sessionId = '608-터미널-어댑터-계약-adr-적-mqbu';
    const winName = tmuxWindowName(sessionId);
    const list = `0\t${winName}\n1\tother-window`;
    const target = buildTmuxAttachTarget(sessionId, list);
    expect(target).toBe(`${TMUX_SESSION}:0`);
    // Hard invariant for #610: the osascript-bound target must be pure ASCII.
    expect(/[^\x00-\x7f]/.test(target)).toBe(false);
  });

  it('targets the window INDEX for an ASCII session id (regression)', () => {
    const sessionId = 'ascii-topic-1234';
    const winName = tmuxWindowName(sessionId);
    const list = `0\tsomething\n3\t${winName}`;
    expect(buildTmuxAttachTarget(sessionId, list)).toBe(`${TMUX_SESSION}:3`);
  });

  it('falls back to the window name when the window is not yet listed', () => {
    const sessionId = 'ascii-topic-1234';
    const winName = tmuxWindowName(sessionId);
    expect(buildTmuxAttachTarget(sessionId, '')).toBe(`${TMUX_SESSION}:${winName}`);
  });
});

describe('buildTmuxAttachCommand (#610)', () => {
  it('produces a valid grouped-session attach command string', () => {
    // Smoke check that the public builder still returns a tmux command string.
    const cmd = buildTmuxAttachCommand('ascii-topic-1234');
    expect(cmd).toMatch(/^tmux new-session -t /);
    expect(cmd).toMatch(/select-window -t /);
  });
});
