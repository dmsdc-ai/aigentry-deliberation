# AGENTS.md — aigentry-deliberation

## Overview

MCP Deliberation Server — 다수 AI 간 구조화된 토론(deliberation) 세션 관리 + 의사결정
npm: `@dmsdc-ai/aigentry-deliberation` | 현재 버전: v0.0.39

aigentry 에코시스템에서 **합의 도출 담당** — 요구사항 분석 → 아키텍처 결정 → 자동 구현 핸드오프

## Architecture

| 파일 | 역할 |
|------|------|
| `index.js` | 메인 MCP 서버 — 28개 도구, 상태 머신, synthesis |
| `lib/session.js` | 세션 저장/로드, 아카이브, 마크다운 동기화 |
| `lib/speaker-discovery.js` | 스피커 탐색, 선택 토큰, transport 라우팅 |
| `lib/telepty.js` | telepty bus 통신, brain inbox 핸드오프 |
| `lib/transport.js` | CLI/브라우저/클립보드 transport 관리 |
| `lib/entitlement.js` | Free/Pro/Team 티어 게이팅 |
| `browser-control-port.js` | CDP 브라우저 자동화 |
| `decision-engine.js` | 마이크로 의사결정 (opinion→conflict→synthesis) |
| `model-router.js` | 모델 선택 로직 |
| `observer.js` | 세션 모니터링 |
| `doctor.js` | 설치/진단 |
| `install.js` | MCP 서버 등록 (Claude + Gemini + Codex) |

## State Machine

```
active → awaiting_synthesis → completed
```

**Transport Types:**
- `cli_respond` — CLI 응답 수집
- `browser_auto` — CDP 자동 브라우저 제어
- `clipboard` — 수동 클립보드 입출력
- `manual` — 사용자 수동 입력
- `telepty_bus` — telepty 세션 간 버스 통신

## Commands

```bash
npm test                    # vitest (172 tests, ~6s)
npm run test:watch          # 감시 모드
npm start                   # MCP 서버 실행
node install.js             # MCP 서버 등록
node doctor.js              # 설치/진단
node observer.js            # 세션 모니터링
```

## MCP Tools (28)

### Deliberation Session (22)

**세션:** `deliberation_start`, `deliberation_list_active`, `deliberation_status`, `deliberation_list`
**스피커:** `deliberation_speaker_candidates`, `deliberation_confirm_speakers`, `deliberation_browser_llm_tabs`
**턴:** `deliberation_route_turn`, `deliberation_browser_auto_turn`, `deliberation_cli_auto_turn`, `deliberation_run_until_blocked`, `deliberation_respond`
**컨텍스트:** `deliberation_context`, `deliberation_inject_context`, `deliberation_copy_last_turn`
**원격:** `deliberation_list_remote_sessions`, `deliberation_ingest_remote_reply`
**결과:** `deliberation_history`, `deliberation_synthesize`, `deliberation_reset`
**설정:** `deliberation_cli_config`
**리뷰:** `deliberation_request_review`

### Decision Engine (6)

`decision_start`, `decision_status`, `decision_respond`, `decision_resume`, `decision_history`, `decision_templates`

## Key Schemas

### ExecutionContractV2
```json
{
  "schema_version": 2,
  "source_session_id": "session-uuid",
  "deliberation_id": "deliberation-uuid",
  "summary": "string",
  "decisions": ["decision 1"],
  "actionable_tasks": [{"id": 1, "task": "string", "priority": "high|medium|low", "files": ["file.js"]}],
  "experiment_outcome": {"verdict": "keep|discard|modify", "confidence": 0.0-1.0},
  "generated_from": "deliberation_synthesize|decision_start"
}
```

## Ecosystem Integration

### Brain Inbox Handoff
`~/.aigentry/inbox/handoff-{id}.json` — ExecutionContractV2 전달

### Telepty Bus
`deliberation_completed` 이벤트 + ExecutionContractV2

### SSOT
`deliberation-tools.yaml` — 28개 도구 정의 (name, description, input_schema, output_schema)

## MCP Registration Paths

| CLI | Config Path |
|-----|-------------|
| Claude Code | `claude mcp add` (user scope) |
| Gemini CLI | `~/.gemini/settings.json` |
| Codex | `~/.codex/config.toml` |

## Development Workflow

### 새 도구 추가
1. `index.js`에 도구 정의 추가
2. `deliberation-tools.yaml`에 SSOT 등록
3. 테스트 작성 → `npm test` 통과
4. git commit + push

### Release
```bash
npm run release:patch    # 버그 수정
npm run release:minor    # 기능 추가
npm run release:major    # Breaking changes
```

## Key Config Files

| 파일 | 용도 |
|------|------|
| `package.json` | npm 메타데이터, 스크립트 |
| `vitest.config.js` | 테스트 설정 |
| `deliberation-tools.yaml` | MCP 도구 SSOT |
