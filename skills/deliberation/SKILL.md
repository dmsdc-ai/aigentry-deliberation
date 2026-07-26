---
name: deliberation
description: |
  AI 간 deliberation(토론) 세션을 관리합니다. 멀티 세션 병렬 토론 지원.
  MCP deliberation 서버를 통해 MCP를 지원하는 모든 CLI가 구조화된 토론을 진행합니다.
  "deliberation", "deliberate", "토론", "토론 시작", "deliberation 시작",
  "저장소 전략 토론", "컨셉 토론", "debate" 키워드 시 자동 트리거됩니다.
---

# AI Deliberation 스킬 (v2.4 — Multi-Session)

Claude/Codex를 포함해 MCP를 지원하는 임의 CLI들이 구조화된 토론을 진행합니다.
**여러 토론을 동시에 병렬 진행할 수 있습니다.**
**이 스킬은 토론/합의 전용이며, 실제 구현은 `deliberation-executor`로 handoff합니다.**

## MCP 서버 위치
- **서버**: `~/.local/lib/mcp-deliberation/index.js` (v2.4.0)
- **상태**: `~/.local/lib/mcp-deliberation/state/{프로젝트명}/sessions/{session_id}.json`
- **등록**: 각 CLI 환경의 MCP 설정에 `deliberation` 서버 등록
- **브라우저 탭 스캔**: macOS 자동화 + CDP(Windows/Linux는 remote-debugging port 권장)

## 사용 가능한 MCP 도구

| 도구 | 설명 | session_id |
|------|------|:---:|
| `deliberation_start` | 새 토론 시작 → **session_id 반환** | 반환 |
| `deliberation_speaker_candidates` | 참가 가능한 speaker 후보 목록 조회 | 불필요 |
| `deliberation_list_active` | 진행 중인 모든 세션 목록 | 불필요 |
| `deliberation_status` | 토론 상태 조회 | 선택적* |
| `deliberation_inject_context` | 외부 실험 결과/추가 컨텍스트 주입 | 선택적 |
| `deliberation_context` | 프로젝트 컨텍스트 로드 | 불필요 |
| `deliberation_browser_llm_tabs` | 브라우저 LLM 탭 목록 (웹 기반 LLM 참여용) | 불필요 |
| `deliberation_route_turn` | 현재 차례 speaker의 transport(CLI/browser_auto/manual)를 자동 라우팅 | 선택적* |
| `deliberation_run_until_blocked` | CLI/browser_auto/telepty_bus를 자동 진행하다 막히는 지점에서 중단 | 선택적 |
| `deliberation_respond` | 현재 차례의 응답 제출 | 선택적* |
| `deliberation_ingest_remote_reply` | 원격 머신 reply를 명시적 source metadata와 함께 semantic ingest | 선택적 |
| `deliberation_history` | 전체 토론 기록 조회 | 선택적* |
| `deliberation_synthesize` | 합성 보고서 생성 및 토론 완료 | 선택적* |
| `deliberation_list` | 과거 토론 아카이브 목록 | 불필요 |
| `deliberation_reset` | 세션 초기화 (지정 시 해당 세션만, 미지정 시 전체) | 선택적 |

*\*선택적: 활성 세션이 1개면 자동 선택. 여러 세션 진행 중이면 필수.*

## session_id 규칙

- `deliberation_start` 호출 시 session_id가 자동 생성되어 반환됨
- 이후 모든 도구 호출에 해당 session_id를 전달
- 활성 세션이 1개뿐이면 session_id 생략 가능 (자동 선택)
- 여러 세션이 동시 진행 중이면 반드시 session_id 지정

## 자동 트리거 키워드
다음 키워드가 감지되면 이 스킬을 자동으로 활성화합니다:
- "deliberation", "deliberate", "토론", "debate"
- "deliberation 시작", "토론 시작", "토론해", "토론하자"
- "deliberation_start", "deliberation_respond", "deliberation_route_turn"
- "speaker candidates", "브라우저 LLM"
- "크롬", "브라우저", "웹 LLM", "chrome", "browser LLM"
- "{주제} 토론", "{주제} deliberation"

## 절대 규칙 (MUST / NEVER)

> **이 규칙은 예외 없이 반드시 지켜야 합니다.**

1. **MUST** — 토론 시작 전 반드시 `deliberation_speaker_candidates`로 후보 조회 후 `AskUserQuestion(multiSelect)`으로 사용자에게 참가자 선택을 받아야 합니다. 후보에는 로컬 CLI, telepty 활성 세션, 브라우저 LLM이 포함될 수 있습니다. 이 호출이 반환한 candidate token은 그대로 시작에 쓰면 안 되고, **반드시** `deliberation_confirm_speakers`로 사용자 선택을 확정한 뒤 그 confirmed `selection_token`만 `deliberation_start`에 전달해야 합니다.
2. **MUST** — 각 턴 진행 시 반드시 `deliberation_route_turn`을 사용해야 합니다. 이 도구가 transport를 자동 감지합니다:
   - CLI speaker → `deliberation_cli_auto_turn`으로 실제 CLI 실행
   - browser_auto → CDP로 자동 전송/수집
   - clipboard/manual → 클립보드 준비 + 사용자 안내
   - 완전 자동으로 여러 턴을 밀고 싶으면 `deliberation_run_until_blocked`를 사용합니다. 이 도구는 `cli_respond`, `browser_auto`, `telepty_bus`를 연속 실행하고, 수동 transport 또는 self-turn에서 멈춥니다.
3. **NEVER** — 오케스트레이터(자기 자신)가 다른 speaker를 대신하여 `deliberation_respond`에 응답을 작성하지 마세요. 이것은 "역할극"이며 실제 deliberation이 아닙니다. MCP 서버가 이를 감지하고 차단합니다.
4. **NEVER** — `deliberation_respond`를 직접 호출하지 마세요 (자기 자신의 응답 제외). 다른 speaker의 턴은 반드시 `deliberation_route_turn` 또는 `deliberation_cli_auto_turn`/`deliberation_browser_auto_turn`을 통해 진행합니다.
5. **MUST** — 자기 자신(오케스트레이터 역할의 claude)이 speaker인 경우에만 직접 `deliberation_respond`로 응답을 제출할 수 있습니다.
6. **MUST** — 원격 머신/세션에서 들어온 응답을 semantic reply로 반영할 때는 raw bus event를 해석하지 말고 `deliberation_ingest_remote_reply`를 사용하세요. transport trace와 semantic ingest를 섞지 마세요.

## 워크플로우

### A. 사용자 선택형 진행 (권장)
1. `deliberation_speaker_candidates` → 참가 가능한 CLI/telepty/브라우저 speaker 확인 + candidate token 획득
2. **AskUserQuestion으로 참가자 선택 (필수)** — 감지된 CLI/브라우저 speaker 목록을 `multiSelect: true`로 제시하여 사용자가 원하는 참가자만 체크. 예:
   ```
   AskUserQuestion({
     questions: [{
       question: "토론에 참여할 speaker를 선택하세요",
       header: "참가자",
       multiSelect: true,
       options: [
         { label: "claude", description: "CLI (자동 응답)" },
         { label: "codex", description: "CLI (자동 응답)" },
         { label: "gemini", description: "CLI (자동 응답)" },
         { label: "web-chatgpt-1", description: "⚡자동 (CDP 자동 연결)" },
         { label: "web-claude-1", description: "⚡자동 (CDP 자동 연결)" },
         { label: "web-gemini-1", description: "⚡자동 (CDP 자동 연결)" }
       ]
     }]
   })
   ```
3. `deliberation_confirm_speakers` (선택된 speakers + candidate token 전달) → confirmed `selection_token` 획득
4. `deliberation_start` (같은 speakers + confirmed `selection_token` 전달) → session_id 획득
5. **`deliberation_route_turn` 호출 (필수)** → 현재 차례 speaker transport 자동 결정 및 실행
   - CLI speaker → `deliberation_cli_auto_turn`이 실제 CLI를 실행하고 응답 수집
   - browser_auto → CDP로 자동 전송/수집
   - telepty_bus → structured `turn_request` publish + remote self-submit 대기
   - 자기 자신(claude)이 speaker → 직접 `deliberation_respond`로 응답 제출
   - 여러 턴을 한 번에 진행하려면 `deliberation_run_until_blocked(session_id)` 사용
6. 반복 후 `deliberation_synthesize(session_id)` → 합성 완료
7. 구현이 필요하면 `deliberation-executor` 스킬로 handoff
   예: "session_id {id} 합의안 구현해줘"

### B. 병렬 세션 운영
1. `deliberation_start` (topic: "주제A") → session_id_A
2. `deliberation_start` (topic: "주제B") → session_id_B
3. `deliberation_list_active` → 진행 중 세션 확인
4. 각 세션을 `session_id`로 명시해 독립 진행
5. 각각 `deliberation_synthesize`로 개별 종료

### C. 실험 회고 / keep-discard review
autoresearch 스타일 실험 루프를 검토할 때는 긴 컨텍스트를 `topic`에 섞지 말고, 시작 후 `deliberation_inject_context`로 compact bundle을 넣습니다.

권장 규칙:
- inject payload는 `1.5KB ~ 2KB` 목표
- 최근 `3~5`개 실험만 포함
- `key_changes`는 최대 `3`개 scalar before/after만 유지
- 전체 `results.tsv` / 전체 `program.md`는 넣지 말고 artifact path만 남김

예:
```text
1. deliberation_start(topic: "experiment retrospective / keep-discard review", ...)
2. deliberation_inject_context(
     session_id: "<session_id>",
     speaker: "dustcraw",
     context: JSON.stringify({
       past_experiments: [{
         experiment_id: "dg-20260310-001",
         signal_kind: "INTEREST_DRIFT",
         patch_summary: "Raised relevanceThreshold from 0.30 to 0.35",
         patch_kind: "config",
         key_changes: {
           relevanceThreshold: { before: 0.30, after: 0.35 }
         },
         score: 0.08,
         score_label: "promotion_rate_delta",
         metric_name: "promotion_rate_delta",
         metric_delta: 0.08,
         verdict: "positive",
         followup_action: "kept",
         reasoning: "Threshold raise reduced noise; promotion quality improved 8%"
       }],
       experiment_count: 1,
       success_rate: 1.0
     })
   )
3. deliberation_route_turn(...) 반복
4. deliberation_synthesize(..., structured: {
     summary: "...",
     decisions: ["..."],
     actionable_tasks: [...],
     experiment_outcome: {
       verdict: "modify",
       suggested_action: "iterate",
       confidence: 0.78,
       measurement_window_hours: 24
     }
   })
```

원격 reply를 semantic turn으로 넣어야 할 때:

```text
deliberation_ingest_remote_reply(
  session_id: "<session_id>",
  speaker: "<speaker>",
  turn_id: "<pending_turn_id>",
  content: "<reply markdown>",
  source_machine_id: "peer-01",
  source_session_id: "remote-gemini-001",
  transport_scope: "remote_mcp"
)
```

### D. 자동 진행 (스크립트)
```bash
# 새 토론
bash auto-deliberate.sh "저장소 전략"

# 5라운드로 진행
bash auto-deliberate.sh "API 설계" 5

# 기존 세션 재개
bash auto-deliberate.sh --resume <session_id>
```

### E. 모니터링
```bash
# 모든 활성 세션 모니터링
bash deliberation-monitor.sh

# 특정 세션만
bash deliberation-monitor.sh <session_id>

# tmux에서
bash deliberation-monitor.sh --tmux
```

### F. 브라우저 LLM 자동 연결 (CDP Auto-Activation)
- 브라우저 LLM speaker가 선택되면 CDP(Chrome DevTools Protocol)가 자동으로 활성화됩니다.
- macOS에서는 Chrome이 실행되지 않은 경우 `--remote-debugging-port=9222`로 자동 실행을 시도합니다.
- **Chrome이 이미 CDP 없이 실행 중인 경우**: Chrome을 완전히 종료한 후 다시 시도해야 합니다. (최초 1회만 필요)
- CDP 연결 성공 시 모든 브라우저 speaker는 ⚡자동 모드로 동작합니다.
- Windows/Linux에서는 사용자가 직접 Chrome을 `--remote-debugging-port=9222`로 실행해야 합니다.

### G. Chrome 확장 프로그램 사이드패널 지원
- **Chrome 확장 프로그램 사이드패널 (chrome-extension:// URL)은 지원됩니다.**
- Claude, ChatGPT, Gemini 등의 Chrome 확장 사이드패널도 CDP를 통해 deliberation 참가자로 사용 가능합니다.
- 사이드패널은 title 기반 매칭으로 감지됩니다 (extension ID가 아닌 탭 제목으로 식별).
- `deliberation_browser_llm_tabs`에서 사이드패널 탭이 `[Extension]` 태그와 함께 표시됩니다.
- **절대로 "사이드패널은 지원 안 됨"이라고 안내하지 마세요.** 사이드패널은 일반 웹 탭과 동일하게 CDP로 자동화됩니다.

## 역할 규칙

### 역할 예시 A: 비판적 분석가
- 제안의 약점을 먼저 찾는다
- 구체적 근거와 수치를 요구한다
- 리스크를 명시하되 대안을 함께 제시한다

### 역할 예시 B: 현실적 실행가
- 실행 가능성을 우선 평가한다
- 구체적 기술 스택과 구현 방안을 제시한다
- 비용/복잡도/일정을 현실적으로 산정한다

## 응답 형식

매 턴의 응답은 다음 구조를 따릅니다:

```markdown
**상대 평가:** (동의/반박/보완)
**핵심 입장:** (구체적 제안)
**근거:** (2-3개)
**리스크/우려:** (약점 1-2개)
**상대에게 질문:** (1-2개)
**합의 가능 포인트:** (동의할 수 있는 것)
**미합의 포인트:** (결론 안 난 것)
```

## 주의사항
1. 여러 deliberation을 동시에 병렬 진행 가능
2. session_id는 `deliberation_start` 응답에서 확인
3. 토론 결과는 state 디렉토리의 archive 폴더에 자동 아카이브
4. 실시간 sync 파일은 state 디렉토리에 저장되며 완료 시 자동 삭제됨 (프로젝트 루트 오염 없음)
5. `Transport closed` 발생 시 현재 CLI 세션 재시작 후 재시도 (stdio 연결은 세션 바인딩)
6. 멀티 세션 운영 중 `pkill -f mcp-deliberation` 사용 금지 (다른 세션 연결까지 끊길 수 있음)

## 관련 스킬

- **deliberation-gate**: superpowers 워크플로우 통합 스킬. brainstorming/code-review/debugging 의사결정 지점에 멀티-AI 검증 게이트를 삽입합니다. `~/.claude/skills/deliberation-gate/SKILL.md`에 설치.
- **deliberation-executor**: deliberation 합의안을 실제 코드 구현으로 전환하는 실행 전용 스킬.

## Data Model: Canonical Roles

Deliberation produces two complementary data artifacts after synthesis:

| Artifact | Role | Consumers |
|----------|------|-----------|
| `structured_synthesis` | **Human + reasoning canonical** | Human reviewers, LLM context, decision history |
| `execution_contract` | **Automation canonical** | devkit, registry, orchestrator agents |

### structured_synthesis (Human Canonical)
Rich context for human review. Contains:
- `summary`: natural language overview
- `decisions`: reasoning and rationale
- `actionable_tasks`: full task descriptions with context
- `experiment_outcome`: optional verdict (keep/discard/modify)

### execution_contract (Automation Canonical)
Minimal, deterministic task list for machines. Contains:
- `version`: contract schema version (currently "v1")
- `source_session_id`: originating deliberation session
- `summary`: brief summary for log context
- `tasks`: flattened actionable task list (same shape as `actionable_tasks`)
- `generated_from.structured_synthesis_hash`: SHA-1 provenance hash

**Rule**: Automation consumers MUST prefer `execution_contract` when present.
Fall back to `structured_synthesis` only when `execution_contract` is `null`.

### Archive Outputs
When a deliberation completes:
1. **Markdown archive**: `~/.local/lib/mcp-deliberation/state/{project}/archive/deliberation-{ts}-{slug}.md`
2. **Contract sidecar**: `~/.local/lib/mcp-deliberation/state/{project}/archive/deliberation-{ts}-{slug}.contract.json`
3. **Telepty envelope**: `deliberation_completed` event with both artifacts in payload
