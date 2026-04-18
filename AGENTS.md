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

## Project-wide INVARIANTS (모든 role 공통 — HARD RULE)

이 프로젝트는 **에코 critical middleware**. 여러 orchestrator가 동시 사용 → 호환성 파괴 시 **전체 workflow 정지**. 다음은 어느 role(coder/architect/analyst/tester)이 수정하더라도 절대 위반 금지.

### §Inv.1 NO MCP schema breaking change
- **Rule**: 기존 tool의 `inputSchema.required` 필드 제거/타입 변경 금지. additive only.
- **Why**: 여러 orchestrator가 동시 의존 — 호환성 파괴 시 기존 client 모두 크래시.
- **Detection Signal**: 기존 tool 정의에서 `required: [...]` 항목 삭제 또는 필드 타입 변경.
- **Correct**: 신규 기능은 optional 파라미터, default 지정으로 미지정 시 v1 동작 유지.

### §Inv.2 NO state file format breakage
- **Rule**: `~/.local/lib/mcp-deliberation/state/` JSON 파일 schema 파괴 금지. 필드 추가는 OK, 삭제/타입 변경 금지.
- **Why**: in-flight deliberation 세션은 서버 재시작 시 state 파일에서 복원됨. 포맷 깨지면 진행 중 토론 전부 유실.
- **Detection Signal**: 기존 state JSON 구조에서 필수 필드 제거 또는 타입 변경.
- **Correct**: additive 필드, 구버전 파일 read 시 default 주입 (self-healing schema). ADR-76 §2.4, ADR-264 §6.4 패턴.

### §Inv.3 NO new external dependencies (Rule 17 무의존 strict)
- **Rule**: `package.json` dependencies/devDependencies 추가 금지. Node 기본 + 기존 codebase primitive만.
- **Why**: 에코 critical middleware는 의존성 0이 원칙. 외부 lib 추가는 공급망/보안/호환성 리스크 증폭.
- **Detection Signal**: `npm install X` 시도, 또는 ADR/SPEC이 "proper-lockfile / lodash / ..." 같은 lib 도입 제안.
- **Correct**: 기존 primitive 확인 — `withFileLock` / `withProjectLock` / `withSessionLock` / `safeId` (index.js:486-559), `crypto.createHash`, `fs.openSync` 등. ADR-264 iter-2에서 검증된 재사용 패턴.

### §Inv.4 NO breaking transport contract
- **Rule**: 5종 transport (`cli_respond` / `browser_auto` / `clipboard` / `manual` / `telepty_bus`) 인터페이스 breaking 금지. 신규 참가자 타입 추가 시 기존 5종 영향 없음.
- **Why**: 멀티 LLM + 멀티 세션 + 하이브리드 facilitator 역할 핵심. transport breaking = 에코 전체 토론 불능.
- **Detection Signal**: 기존 transport handler 시그니처 변경.
- **Correct**: 신규 transport는 별도 case 추가. 기존 분기 무변경.

### §Inv.5 NO schema version regression
- **Rule**: `ExecutionContractV2` 같은 outgoing schema는 version bump 없이 breaking 변경 금지.
- **Why**: brain inbox handoff 등 downstream consumer가 이 schema 의존.
- **Detection Signal**: `schema_version` 동일한데 필드 의미 변경.
- **Correct**: 필드 추가 (schema_version 유지) 또는 schema_version 증가 + 구버전 parser 유지 (transition window).

### §Inv.6 NO npm publish without version bump + CHANGELOG
- **Rule**: 소스 변경 후 publish 시 `package.json` version 증가 + CHANGELOG.md 업데이트 필수.
- **Why**: 멀티 머신 설치 사용자가 update 받으려면 버전 diff 필요.
- **Detection Signal**: 소스 변경 후 version 동일, CHANGELOG 미변경.
- **Correct**: `npm run release:patch|minor|major` 중 적절 선택. Breaking 변경이면 major (이 프로젝트에서 극도 자제).

## FAILED APPROACHES (반복 금지 — HARD RULE)

구조: Date / What happened / Root Cause / Lesson. 새 실패 발견 시 추가.

### §F.1 v1 TTL 부재 오진단 (ADR-264 iter-0)
- **Date**: 2026-04-18
- **What happened**: architect가 ADR-264 초안에서 "v1에 TTL 없음 → 추가 필요" 라고 단정. 실제로는 `SPEAKER_SELECTION_TTL_MS = 10 * 60 * 1000` 이 `lib/speaker-discovery.js:101-103`에 이미 존재. BUG-001 원인은 TTL 부재가 아니라 race/consumption semantics.
- **Root Cause**: 버그 증상만 보고 v1 상태를 추정. `lib/speaker-discovery.js` + `index.js` 실제 source 검증 없이 ADR 작성.
- **Lesson**: 이 프로젝트 수정 ADR/SPEC 작성 시 반드시 관련 파일의 **실제 현재 코드** 확인. 특히 token / state / locking 같은 primitive는 이미 구축된 경우가 많음. codex 리뷰가 이 오류를 잡아냈음 (`docs/reviews/adr-264-review-codex.md:§Weaknesses-1`).

### §F.2 AsyncLocalStorage in-process mutex for shared file (ADR-264 iter-1)
- **Date**: 2026-04-18
- **What happened**: ADR-264 iter-1에서 `speaker-selection.json` 동시성 보호로 `AsyncLocalStorage` in-process mutex 제안. 리뷰어 (codex + gemini 모두) 지적: MCP는 클라이언트별 프로세스 스폰 가능 → 서로 다른 Node 프로세스에서 shared 파일 접근 시 in-process mutex는 **cross-process 경쟁을 막지 못함**.
- **Root Cause**: MCP 서버를 "single Node process"로 가정. 실제 아키텍처는 orchestrator마다 서버 프로세스 분리 가능.
- **Lesson**: 공용 디스크 파일 동시성 보호는 **file-level lock** 필요. 기존 `withFileLock` / `withProjectLock` (index.js:486-559) 이 이미 `fs.openSync(..., "wx")` + stale detection 으로 cross-process safe. 새 locking 모델 도입 금지, 기존 primitive 재사용.

### §F.3 proper-lockfile 외부 라이브러리 도입 유혹 (ADR-264 검토 중)
- **Date**: 2026-04-18
- **What happened**: gemini 리뷰가 file lock 문제 지적. 해결책으로 `proper-lockfile` NPM 라이브러리 도입 제안. 검토 후 **Rule 17 (무의존) 위반**으로 거절.
- **Root Cause**: 문제 해결 시 익숙한 외부 라이브러리 먼저 고려. 기존 codebase primitive 확인 미실시.
- **Lesson**: Rule 17 strict. 신규 라이브러리 도입 전 **기존 codebase 검색** (grep/ast-grep). 이 프로젝트는 이미 `withFileLock` 등 primitive 보유. ADR-264 iter-2에서 기존 재사용으로 해결됨.

### §F.4 (이후 축적)

새 실패 발견 시 이 섹션에 추가. 구조: Date / What / Root Cause / Lesson. 커밋 메시지에 `docs(agents): add FAILED approach §F.X` 포함.
