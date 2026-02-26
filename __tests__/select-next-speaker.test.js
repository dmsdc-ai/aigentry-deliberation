import { describe, it, expect } from 'vitest';
import { selectNextSpeaker } from '../index.js';

describe('selectNextSpeaker', () => {
  const baseSpeakers = ['alice', 'bob', 'charlie'];

  describe('cyclic strategy', () => {
    it('should return next speaker in order', () => {
      const session = {
        speakers: baseSpeakers,
        current_speaker: 'alice',
        log: [],
        ordering_strategy: 'cyclic',
      };
      expect(selectNextSpeaker(session)).toBe('bob');
    });

    it('should wrap around to first speaker', () => {
      const session = {
        speakers: baseSpeakers,
        current_speaker: 'charlie',
        log: [],
        ordering_strategy: 'cyclic',
      };
      expect(selectNextSpeaker(session)).toBe('alice');
    });

    it('should default to cyclic when no strategy specified', () => {
      const session = {
        speakers: baseSpeakers,
        current_speaker: 'alice',
        log: [],
      };
      expect(selectNextSpeaker(session)).toBe('bob');
    });
  });

  describe('random strategy', () => {
    it('should return a valid speaker', () => {
      const session = {
        speakers: baseSpeakers,
        current_speaker: 'alice',
        log: [],
        ordering_strategy: 'random',
      };
      const result = selectNextSpeaker(session);
      expect(baseSpeakers).toContain(result);
    });
  });

  describe('weighted-random strategy', () => {
    it('should return a valid speaker', () => {
      const session = {
        speakers: baseSpeakers,
        current_speaker: 'alice',
        log: [],
        ordering_strategy: 'weighted-random',
      };
      const result = selectNextSpeaker(session);
      expect(baseSpeakers).toContain(result);
    });

    it('should favor less-spoken speakers', () => {
      const log = [
        { speaker: 'alice' }, { speaker: 'alice' },
        { speaker: 'alice' }, { speaker: 'alice' },
        { speaker: 'bob' }, { speaker: 'bob' },
      ];
      const session = {
        speakers: baseSpeakers,
        current_speaker: 'alice',
        log,
        ordering_strategy: 'weighted-random',
      };
      // Run multiple times to verify charlie (least spoken) appears more often
      const counts = { alice: 0, bob: 0, charlie: 0 };
      for (let i = 0; i < 100; i++) {
        counts[selectNextSpeaker(session)]++;
      }
      // charlie should appear most often (never spoken in window)
      expect(counts.charlie).toBeGreaterThan(counts.alice);
    });
  });
});
