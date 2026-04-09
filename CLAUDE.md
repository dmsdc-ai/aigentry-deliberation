@AGENTS.md

# Claude Code — aigentry-deliberation

## Claude 전용 설정

- 세션 ID: `aigentry-deliberation-claude`
- 보고: `telepty inject --ref --from aigentry-deliberation-claude aigentry-orchestrator-claude "보고 내용"`
- 3회 실패 시 위임: `telepty allow --id aigentry-deliberation-codex codex resume`
- 헌법: `~/projects/aigentry/docs/CONSTITUTION.md`
- 공통 가이드라인: `/Users/duckyoungkim/projects/CLAUDE.md`

## 자율 재귀적 오케스트레이션

작업 복잡도가 높거나, 독립 도메인이 식별되거나, 컨텍스트 분리가 필요하면 자율적으로:

1. 하위 폴더 + CLAUDE.md 생성
2. telepty allow로 하위 세션 생성
3. telepty inject로 태스크 주입
4. 결과 수신 → 통합

판단 기준:
- 2개 이상 독립 도메인
- 컨텍스트 윈도우 30% 이상 단일 하위 작업
- 반복적 전문 작업 식별

원칙: YAGNI, 하위 세션 완료 시 오케스트레이터에 보고, 결과물 상위 프로젝트에 통합.
