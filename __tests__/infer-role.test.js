import { describe, it, expect } from 'vitest';
import { inferSuggestedRole, ROLE_KEYWORDS } from '../index.js';

describe('inferSuggestedRole', () => {
  it('should return critic for risk-related text', () => {
    const text = '이 접근방식의 문제점은 보안 위험이 있다는 것입니다. 실패할 가능성도 높습니다.';
    expect(inferSuggestedRole(text)).toBe('critic');
  });

  it('should return implementer for code-related text', () => {
    const text = '구현 방법은 함수를 모듈로 분리하고 파일 구조를 설계하는 것입니다.';
    expect(inferSuggestedRole(text)).toBe('implementer');
  });

  it('should return mediator for consensus-related text', () => {
    const text = '양쪽 의견을 종합하면 합의점을 찾을 수 있습니다. 결론을 정리하겠습니다.';
    expect(inferSuggestedRole(text)).toBe('mediator');
  });

  it('should return researcher for data-related text', () => {
    const text = '벤치마크 데이터에 따르면 연구 사례를 비교해볼 필요가 있습니다.';
    expect(inferSuggestedRole(text)).toBe('researcher');
  });

  it('should return free for neutral text', () => {
    const text = 'Hello world, this is a simple test message in English.';
    expect(inferSuggestedRole(text)).toBe('free');
  });

  it('should pick the role with most keyword matches', () => {
    // Multiple critic keywords should win over single implementer keyword
    const text = '문제가 많고 위험하며 실패 가능성이 높다. 구현은 가능하다.';
    expect(inferSuggestedRole(text)).toBe('critic');
  });
});

describe('ROLE_KEYWORDS', () => {
  it('should have all expected roles', () => {
    expect(Object.keys(ROLE_KEYWORDS)).toEqual(
      expect.arrayContaining(['critic', 'implementer', 'mediator', 'researcher'])
    );
  });

  it('should have RegExp values', () => {
    for (const pattern of Object.values(ROLE_KEYWORDS)) {
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });
});
