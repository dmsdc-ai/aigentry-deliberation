import { describe, it, expect } from 'vitest';
import { parseVotes } from '../index.js';

describe('parseVotes', () => {
  it('should parse AGREE votes', () => {
    const text = 'I think this is good [AGREE]\nAnother point';
    const votes = parseVotes(text);
    expect(votes).toHaveLength(1);
    expect(votes[0].vote).toBe('agree');
  });

  it('should parse DISAGREE votes', () => {
    const text = '[DISAGREE] This approach is wrong';
    const votes = parseVotes(text);
    expect(votes).toHaveLength(1);
    expect(votes[0].vote).toBe('disagree');
  });

  it('should parse CONDITIONAL votes', () => {
    const text = '[CONDITIONAL: Only if we add tests] This could work';
    const votes = parseVotes(text);
    expect(votes).toHaveLength(1);
    expect(votes[0].vote).toBe('conditional');
    expect(votes[0].condition).toBe('Only if we add tests');
  });

  it('should parse multiple votes', () => {
    const text = '[AGREE] Point one\n[DISAGREE] Point two\n[CONDITIONAL: Maybe] Point three';
    const votes = parseVotes(text);
    expect(votes).toHaveLength(3);
    expect(votes[0].vote).toBe('agree');
    expect(votes[1].vote).toBe('disagree');
    expect(votes[2].vote).toBe('conditional');
  });

  it('should return empty array for no votes', () => {
    const text = 'Just a normal response without any votes';
    const votes = parseVotes(text);
    expect(votes).toHaveLength(0);
  });

  it('should be case insensitive', () => {
    const text = '[agree] lowercase\n[Agree] mixed case';
    const votes = parseVotes(text);
    expect(votes).toHaveLength(2);
  });
});
