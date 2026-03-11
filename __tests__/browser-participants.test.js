import { describe, it, expect } from 'vitest';
import {
  hasExplicitBrowserParticipantSelection,
  resolveIncludeBrowserSpeakers,
} from '../index.js';

describe('browser participant defaults', () => {
  it('detects explicit browser speakers from speaker list', () => {
    expect(hasExplicitBrowserParticipantSelection({
      speakers: ['claude', 'web-chatgpt-1'],
    })).toBe(true);
  });

  it('detects explicit browser transport overrides', () => {
    expect(hasExplicitBrowserParticipantSelection({
      speakers: ['claude', 'codex'],
      participant_types: { codex: 'cli', 'web-chatgpt-1': 'browser_auto' },
    })).toBe(true);
  });

  it('defaults to cli-only when no config or override is provided', () => {
    expect(resolveIncludeBrowserSpeakers({
      config: {},
      speakers: ['claude', 'codex'],
    })).toBe(false);
  });

  it('uses explicit start override when provided', () => {
    expect(resolveIncludeBrowserSpeakers({
      include_browser_speakers: true,
      config: { include_browser_speakers: false },
      speakers: ['claude', 'codex'],
    })).toBe(true);
  });

  it('uses saved config when start override is omitted', () => {
    expect(resolveIncludeBrowserSpeakers({
      config: { include_browser_speakers: true },
      speakers: ['claude', 'codex'],
    })).toBe(true);
  });
});
