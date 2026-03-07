# Decision → Action Engine Redesign

**Date**: 2026-03-04
**Status**: Approved (3/3 CONDITIONAL consensus from Claude/Codex/Gemini)
**Session**: aigentry-deliberatio-mmazi2mo5vcy

---

## Problem Statement

aigentry-deliberation은 현재 순차적 턴 기반 토론 도구로, superpowers 같은 단일 AI 에이전트 시스템 대비 차별화가 약하다. 핵심 차별점인 "크로스-LLM 오케스트레이션"을 극대화하고, 사용자 인터렉션을 중심에 놓는 "Decision → Action Engine"으로 리디자인한다.

## Architecture

### Stage Pipeline

```
intake → parallel_opinions → conflict_map → user_probe → synthesis → action_export → done
```

### Stage Details

#### 1. intake
- 사용자로부터 문제 정의 수집
- 옵션, 평가 기준 구조화
- Micro-decision 템플릿 매칭 (해당 시)

#### 2. parallel_opinions
- 모든 참여 LLM에 동일 입력 전달
- **독립성 보장**: 각 LLM은 다른 LLM의 응답을 볼 수 없음
- CLI auto-turn 병렬 실행
- MCDA 프레임워크: 공통 지표(비용, 확장성, 유지보수성 등)에 대한 점수 산출 요청

#### 3. conflict_map
- 의견 간 모순점 자동 추출
- 합의점 vs 논쟁점 분류
- "모델 A와 B가 이 지점에서 왜 의견이 갈리는가?" 가시화
- 각 갈등에 대한 근거(evidence) 매핑

#### 4. user_probe
- 갈등 지점을 사용자에게 구조화하여 제시
- 사용자 입력 대기 (pause/resume via state persistence)
- MCP 제약 우회: 세션 상태 저장 후 재개

#### 5. synthesis
- 사용자 입력 + 모델 의견 + 갈등 해소를 종합
- 1줄 결론 + 펼치기 가능한 상세 근거
- 신뢰도/합의율 메트릭 포함

#### 6. action_export
- 결정 결과를 실행 가능한 형태로 변환
- 출력: 체크리스트, GitHub Issue, PRD, Notion 페이지
- 결정 근거 구조화 저장 (사후 학습용)

### State Machine

```typescript
type DecisionStage =
  | "intake"
  | "parallel_opinions"
  | "conflict_map"
  | "user_probe"
  | "synthesis"
  | "action_export"
  | "done";

interface DecisionSession {
  id: string;
  stage: DecisionStage;
  problem: string;
  options: string[];
  criteria: string[];
  opinions: Record<string, ModelOpinion>;
  conflicts: ConflictItem[];
  userProbeResponses: UserResponse[];
  synthesis: SynthesisResult | null;
  actionPlan: ActionPlan | null;
  metadata: {
    created: string;
    updated: string;
    participants: string[];
    template?: string;
  };
}
```

### Pause/Resume Protocol

기존 MCP는 세션 시작→완료의 단방향 흐름. Decision Engine은:

1. `user_probe` 단계에서 세션 상태를 디스크에 저장
2. 갈등 지점을 MCP tool result로 반환
3. 사용자가 `decision_respond` tool로 입력 제출
4. 세션 재개, `synthesis` 단계로 진행

이는 기존 `deliberation_respond` 패턴과 유사하나, 구조화된 갈등 데이터를 함께 제공.

## New MCP Tools

| Tool | Purpose |
|------|---------|
| `decision_start` | 새 의사결정 세션 시작 (템플릿 선택 가능) |
| `decision_status` | 현재 단계 및 진행 상황 조회 |
| `decision_respond` | user_probe에 대한 사용자 응답 제출 |
| `decision_resume` | pause된 세션 재개 |
| `decision_history` | 과거 의사결정 기록 조회 |
| `decision_templates` | 사용 가능한 Micro-Decision 템플릿 목록 |

## Micro-Decision Templates

사용 빈도 확보를 위한 일상 템플릿:

| Template | Use Case | Criteria |
|----------|----------|----------|
| `lib-compare` | 라이브러리 선택 | 성능, 번들크기, 커뮤니티, 타입지원 |
| `arch-decision` | 아키텍처 결정 | 확장성, 복잡도, 유지보수성, 비용 |
| `pr-priority` | PR 우선순위 | 긴급도, 영향범위, 의존성, 리스크 |
| `naming-convention` | API/코드 네이밍 | 일관성, 가독성, 표준준수 |
| `tradeoff` | 일반 트레이드오프 | 사용자 정의 기준 |
| `risk-approval` | 리스크 승인 | 발생확률, 영향도, 완화방안 |

## Backward Compatibility

기존 deliberation 기능은 그대로 유지. Decision Engine은 **추가** 기능:

- 기존 tools: `deliberation_start`, `deliberation_respond`, etc. → 유지
- 신규 tools: `decision_start`, `decision_respond`, etc. → 추가
- 내부적으로 기존 세션 인프라 재활용 (state 저장, CLI auto-turn 등)

## Implementation Plan

### P0 (이번 릴리스)
1. DecisionSession state machine (`decision-engine.js`)
2. `decision_start` / `decision_status` / `decision_respond` / `decision_resume` MCP tools
3. Parallel independent opinion extraction (기존 cli_auto_turn 활용, 독립성 보장)
4. Conflict mapping algorithm (의견 비교 + 모순점 추출)
5. User probe with pause/resume
6. Basic synthesis (기존 synthesize 확장)

### P1 (다음 릴리스)
7. Micro-decision template system
8. MCDA scoring framework
9. Action export (GitHub Issues, checklist)
10. Obsidian archive integration

### P2 (이후)
11. Notion/Jira connectors
12. 사후 학습 피드백 루프
13. Decision analytics dashboard

## Estimated Scope
- P0: ~2,000-3,000 LOC (새 모듈 + MCP tool 등록)
- P1: ~1,000-1,500 LOC (템플릿 + 스코어링)
- P2: ~500-1,000 LOC (커넥터)
