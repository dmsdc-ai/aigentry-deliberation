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
| `deliberation_context` | 프로젝트 컨텍스트 로드 | 불필요 |
| `deliberation_browser_llm_tabs` | 브라우저 LLM 탭 목록 (웹 기반 LLM 참여용) | 불필요 |
| `deliberation_route_turn` | 현재 차례 speaker의 transport(CLI/browser_auto/manual)를 자동 라우팅 | 선택적* |
| `deliberation_respond` | 현재 차례의 응답 제출 | 선택적* |
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

## 워크플로우

### A. 사용자 선택형 진행 (권장)
1. `deliberation_speaker_candidates` → 참가 가능한 CLI/브라우저 speaker 확인
2. **AskUserQuestion으로 참가자 선택** — 감지된 CLI/브라우저 speaker 목록을 `multiSelect: true`로 제시하여 사용자가 원하는 참가자만 체크. 예:
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
3. `deliberation_start` (선택된 speakers 전달) → session_id 획득
4. `deliberation_route_turn` → 현재 차례 speaker transport 자동 결정
   - CLI speaker → 자동 응답
   - browser_auto → CDP로 자동 전송/수집
5. 반복 후 `deliberation_synthesize(session_id)` → 합성 완료
6. 구현이 필요하면 `deliberation-executor` 스킬로 handoff
   예: "session_id {id} 합의안 구현해줘"

### B. 병렬 세션 운영
1. `deliberation_start` (topic: "주제A") → session_id_A
2. `deliberation_start` (topic: "주제B") → session_id_B
3. `deliberation_list_active` → 진행 중 세션 확인
4. 각 세션을 `session_id`로 명시해 독립 진행
5. 각각 `deliberation_synthesize`로 개별 종료

### C. 자동 진행 (스크립트)
```bash
# 새 토론
bash auto-deliberate.sh "저장소 전략"

# 5라운드로 진행
bash auto-deliberate.sh "API 설계" 5

# 기존 세션 재개
bash auto-deliberate.sh --resume <session_id>
```

### D. 모니터링
```bash
# 모든 활성 세션 모니터링
bash deliberation-monitor.sh

# 특정 세션만
bash deliberation-monitor.sh <session_id>

# tmux에서
bash deliberation-monitor.sh --tmux
```

### E. 브라우저 LLM 자동 연결 (CDP Auto-Activation)
- 브라우저 LLM speaker가 선택되면 CDP(Chrome DevTools Protocol)가 자동으로 활성화됩니다.
- macOS에서는 Chrome이 실행되지 않은 경우 `--remote-debugging-port=9222`로 자동 실행을 시도합니다.
- **Chrome이 이미 CDP 없이 실행 중인 경우**: Chrome을 완전히 종료한 후 다시 시도해야 합니다. (최초 1회만 필요)
- CDP 연결 성공 시 모든 브라우저 speaker는 ⚡자동 모드로 동작합니다.
- Windows/Linux에서는 사용자가 직접 Chrome을 `--remote-debugging-port=9222`로 실행해야 합니다.

### F. Chrome 확장 프로그램 사이드패널 지원
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
3. 토론 결과는 Obsidian vault에 자동 아카이브 (프로젝트 폴더 존재 시)
4. 실시간 sync 파일은 state 디렉토리에 저장되며 완료 시 자동 삭제됨 (프로젝트 루트 오염 없음)
5. `Transport closed` 발생 시 현재 CLI 세션 재시작 후 재시도 (stdio 연결은 세션 바인딩)
6. 멀티 세션 운영 중 `pkill -f mcp-deliberation` 사용 금지 (다른 세션 연결까지 끊길 수 있음)
