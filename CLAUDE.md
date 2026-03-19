# aigentry-deliberation Project Guide

프로젝트 공통 가이드라인은 `/Users/duckyoungkim/projects/CLAUDE.md` 참고

---

## 프로젝트 개요

**프로젝트명:** MCP Deliberation Server
**npm:** `@dmsdc-ai/aigentry-deliberation`
**현재 버전:** v0.0.39
**용도:** 다수 AI 간 구조화된 토론(deliberation) 세션 관리 + 의사결정

aigentry 에코시스템에서 **합의 도출 담당** — 요구사항 분석 → 아키텍처 결정 → 자동 구현 핸드오프

---

## 아키텍처 개요

| 파일 | 라인 수 | 역할 |
|------|--------|------|
| `index.js` | 6722 | 메인 MCP 서버 — 28개 도구, 상태 머신, synthesis |
| `browser-control-port.js` | 1198 | CDP 브라우저 자동화 (ChatGPT, Claude, Gemini 등) |
| `decision-engine.js` | 1006 | 마이크로 의사결정 세션 (opinion→conflict→synthesis) |
| `model-router.js` | 213 | 모델 선택 로직 |
| `observer.js` | 556 | 세션 모니터링 |
| `doctor.js` | 440 | 설치/진단 |
| `install.js` | 394 | MCP 서버 등록 |
| `clipboard.js` | 178 | 크로스 플랫폼 클립보드 I/O |
| `selectors/` | - | 프로바이더별 DOM 셀렉터 (JSON) |

---

## 상태 머신

```
active → awaiting_synthesis → completed
```

**Transport Types:**
- `cli_respond` — Claude/Gemini CLI 응답 수집
- `browser_auto` — CDP 자동 브라우저 제어
- `clipboard` — 수동 클립보드 입출력
- `manual` — 사용자 수동 입력
- `telepty_bus` — telepty 세션 간 버스 통신

---

## 주요 명령어

```bash
npm test                    # vitest (171 tests, ~6s)
npm run test:watch        # 감시 모드
npm start                 # MCP 서버 실행
npm publish --access public  # npm 배포
node install.js           # MCP 서버 등록
node doctor.js            # 설치/진단
node observer.js          # 세션 모니터링
```

---

## MCP 도구 (28개)

### Deliberation Session 관리 (22개)

**세션 생성/조회:**
- `deliberation_start` — 새 토론 세션 시작
- `deliberation_list_active` — 활성 세션 목록
- `deliberation_status` — 세션 상태 조회
- `deliberation_list` — 과거 세션 아카이브

**스피커 관리:**
- `deliberation_speaker_candidates` — 사용 가능 스피커 후보 조회
- `deliberation_confirm_speakers` — 스피커 선택 확정
- `deliberation_browser_llm_tabs` — 브라우저 LLM 탭 감지

**턴 실행:**
- `deliberation_route_turn` — 현재 턴 스피커 라우팅
- `deliberation_browser_auto_turn` — 브라우저 자동 턴 실행
- `deliberation_cli_auto_turn` — CLI 자동 턴 실행
- `deliberation_run_until_blocked` — 자동 실행 (수동 턴까지)
- `deliberation_respond` — 턴 응답 제출

**컨텍스트 관리:**
- `deliberation_context` — 프로젝트 컨텍스트 로드 (Obsidian/Markdown)
- `deliberation_inject_context` — 세션 중 컨텍스트 주입
- `deliberation_copy_last_turn` — 마지막 턴 응답 복사

**원격 세션:**
- `deliberation_list_remote_sessions` — 원격 머신 세션 목록
- `deliberation_ingest_remote_reply` — 원격 응답 수집

**결과:**
- `deliberation_history` — 세션 히스토리 조회
- `deliberation_synthesize` — 세션 종료 및 synthesis 리포트 생성
- `deliberation_reset` — 세션 초기화

**설정:**
- `deliberation_cli_config` — CLI 스피커 설정

### Decision Micro-Decision 엔진 (6개)

**의사결정 세션:**
- `decision_start` — 마이크로 의사결정 시작 (opinion 수집)
- `decision_status` — 의사결정 상태 조회
- `decision_respond` — conflict 질문 응답
- `decision_resume` — paused 세션 재개
- `decision_history` — 의사결정 히스토리 조회
- `decision_templates` — 템플릿 목록 조회

---

## 핵심 스키마

### StructuredSynthesisSchema
```json
{
  "summary": "string",
  "decisions": ["decision 1", "decision 2"],
  "actionable_tasks": [
    {
      "id": 1,
      "task": "string",
      "priority": "high|medium|low",
      "project": "string",
      "files": ["file1.ts"]
    }
  ],
  "experiment_outcome": {
    "verdict": "keep|discard|modify",
    "suggested_action": "advance|revert|iterate",
    "confidence": 0.0-1.0,
    "patches": []
  }
}
```

### ExecutionContractV2
```json
{
  "schema_version": 2,
  "source_session_id": "session-uuid",
  "deliberation_id": "deliberation-uuid",
  "summary": "string",
  "decisions": ["decision 1"],
  "actionable_tasks": [],
  "experiment_outcome": {},
  "unresolved_questions": [],
  "artifact_refs": [],
  "generated_from": "deliberation_synthesize|decision_start"
}
```

---

## 최근 주요 변경사항

| 버전 | 변경 사항 |
|------|----------|
| v0.0.39 | execution_contract v2 (schema_version:2, decisions[], deliberation_id) |
| v0.0.39 | brain inbox handoff (callBrainIngest → ~/.aigentry/inbox/handoff-{id}.json) |
| v0.0.38 | structured execution contract, telepty schema expansion, e2e tests |
| v0.0.37 | structured execution_contract, telepty_bus transport |

---

## 에코시스템 통합

### Brain Inbox 핸드오프
```javascript
// ~/.aigentry/inbox/handoff-{id}.json
callBrainIngest({
  execution_contract: ExecutionContractV2,
  source: "deliberation|decision"
})
```

### Telepty Bus 통신
```javascript
notifyTeleptyBus({
  type: "deliberation_completed",
  session_id: "session-uuid",
  summary: "string",
  generated_contract: ExecutionContractV2
})
```

### SSOT Contract Registry
- **파일:** `deliberation-tools.yaml` v0.1.0
- **내용:** 28개 도구 정의 (name, description, input_schema, output_schema)

---

## 세션 상태 파일

**위치:** `.omc/state/` (로컬 프로젝트) 또는 `~/.aigentry/state/` (글로벌)

| 상태 파일 | 용도 |
|----------|------|
| `deliberation-sessions.json` | 활성 세션 메타데이터 |
| `deliberation-state.json` | 현재 세션 상태 |
| `decision-sessions.json` | 의사결정 세션 아카이브|

---

## 테스트

```bash
npm test                  # 171개 테스트 (~6초)
npm run test:watch       # 감시 모드
```

**테스트 카테고리:**
- Unit: 모델 라우팅, 클립보드 I/O, 상태 머신
- Integration: MCP 도구, transport 라우팅, synthesis 생성
- E2E: 전체 세션 라이프사이클

---

## 개발 워크플로우

### 새 도구 추가
1. `index.js`에 도구 정의 추가
2. `deliberation-tools.yaml`에 SSOT 등록
3. 테스트 작성 및 검증
4. `npm test` 통과 확인
5. git commit + push

### 스피커 프로바이더 추가
1. `selectors/{provider}.json` 생성 (DOM 셀렉터)
2. `browser-control-port.js`에 transport 핸들러 추가
3. `deliberation_browser_llm_tabs` 스캔 로직 확인
4. E2E 테스트 (실제 브라우저에서 검증)

### Release
```bash
npm run release:patch    # 버그 수정
npm run release:minor    # 기능 추가
npm run release:major    # Breaking changes
```

자동으로 `npm test` 실행 후 npm publish (prepublishOnly hook)

---

## 참고 문서

- **README:** `/Users/duckyoungkim/projects/aigentry-deliberation/README.md`
- **SSOT:** `deliberation-tools.yaml` (MCP 도구 공식 정의)
- **Brain Docs:** https://github.com/dmsdc-ai/aigentry-brain
- **Constitution:** https://github.com/dmsdc-ai/constitution

---

## 주요 설정 파일

| 파일 | 용도 |
|------|------|
| `package.json` | npm 메타데이터, 스크립트 |
| `.npmrc` | npm 인증 (dmsdc-ai global token) |
| `vitest.config.js` | 테스트 설정 |
| `deliberation-tools.yaml` | MCP 도구 SSOT |

## 자율 재귀적 오케스트레이션

이 세션은 작업 복잡도가 높거나, 독립 도메인이 식별되거나, 컨텍스트 분리가 필요하다고 판단되면 — 사용자 지시 없이 자율적으로:

1. 자기 프로젝트 하위에 폴더를 생성한다
2. 해당 폴더에 CLAUDE.md를 작성한다 (역할, 범위, 상위 세션과의 통신 방법)
3. aigentry scaffold 또는 telepty allow로 하위 Claude 세션을 생성한다
4. telepty inject로 하위 세션에 태스크를 주입한다
5. 하위 세션의 결과를 수신하고 통합한다

판단 기준:
- 현재 작업이 2개 이상 독립 도메인을 포함할 때
- 컨텍스트 윈도우의 30% 이상을 단일 하위 작업이 차지할 때
- 반복적 전문 작업이 식별될 때 (SEO, 특정 채널, 특정 데이터 소스 등)

원칙:
- YAGNI: 진짜 필요할 때만 생성. 과잉 분리 금지.
- 하위 세션 완료 시 오케스트레이터(상위)에게 반드시 보고.
- 하위 세션의 결과물은 상위 프로젝트에 통합(커밋).
