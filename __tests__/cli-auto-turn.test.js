import { describe, it, expect } from 'vitest';
import {
  truncatePromptText,
  getPromptBudgetForSpeaker,
  formatRecentLogForPrompt,
  getCliAutoTurnTimeoutSec,
  getCliExecArgs,
  buildCliAutoTurnFailureText,
  buildClipboardTurnPrompt,
} from '../index.js';

describe('cli auto-turn helpers', () => {
  it('truncates prompt text with an explicit marker', () => {
    const value = truncatePromptText('abcdefghij', 5);
    expect(value).toContain('abcde');
    expect(value).toContain('truncated 5 chars');
  });

  it('uses a tighter prompt budget for codex', () => {
    expect(getPromptBudgetForSpeaker('codex', 5)).toEqual({
      maxEntries: 3,
      maxCharsPerEntry: 1200,
      maxTotalChars: 3600,
      maxTopicChars: 2200,
    });
  });

  it('truncates long recent log entries', () => {
    const state = {
      log: [
        { speaker: 'claude', round: 1, content: 'A'.repeat(5000) },
        { speaker: 'gemini', round: 1, content: 'B'.repeat(5000) },
      ],
    };
    const rendered = formatRecentLogForPrompt(state, 2, {
      maxCharsPerEntry: 500,
      maxTotalChars: 900,
    });
    expect(rendered).toContain('claude');
    expect(rendered).toContain('gemini');
    expect(rendered).toContain('truncated');
    expect(rendered.length).toBeLessThan(1200);
  });

  it('gives codex more time on long follow-up turns', () => {
    expect(getCliAutoTurnTimeoutSec({
      speaker: 'codex',
      requestedTimeoutSec: 300,
      promptLength: 12000,
      priorTurns: 1,
    })).toBe(420);
  });

  it('formats timeout failures as diagnosis instead of generic failure', () => {
    const text = buildCliAutoTurnFailureText({
      state: { id: 's1', current_round: 2, lang: 'en' },
      speaker: 'codex',
      hint: { cmd: 'codex' },
      err: new Error('CLI timeout (180s)'),
      effectiveTimeout: 180,
      promptLength: 9000,
      priorTurns: 0,
    });
    expect(text).toContain('CLI auto-turn timed out');
    expect(text).toContain('This usually means the CLI stayed busy longer than the timeout');
    expect(text).toContain('timeout_sec: 420');
  });

  it('forces codex exec into a lower-friction profile', () => {
    expect(getCliExecArgs('codex')).toEqual([
      'exec',
      '--ephemeral',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="read-only"',
      '-c', 'model_reasoning_effort="low"',
      '-',
    ]);
  });

  it('adds a no-tool rule to codex deliberation prompts', () => {
    const prompt = buildClipboardTurnPrompt({
      id: 's1',
      project: 'proj',
      topic: 'Discuss architecture tradeoffs.',
      current_round: 1,
      max_rounds: 2,
      current_speaker: 'codex',
      speaker_roles: {},
      log: [],
    }, 'codex', null, 3);
    expect(prompt).toContain('Do not inspect files, run shell commands, browse, or call tools');
  });
});
