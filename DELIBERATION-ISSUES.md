# aigentry-deliberation 수정 필요사항

> 이 세션에서 발견된 모든 이슈를 정리. 한번에 수정할 것.

## 1. model-router.js 설치 누락 (Critical)

**증상**: `ERR_MODULE_NOT_FOUND: Cannot find module 'model-router.js'`
**원인**: `install.js`에서 `model-router.js`를 `~/.local/lib/mcp-deliberation/`로 복사하지 않음
**수정**: `install.js`의 파일 복사 목록에 `model-router.js` 추가

```
// install.js에서 복사 대상 파일 목록에 추가
'model-router.js'
```

## 2. web-deepseek, web-qwen이 manual로 라우팅됨 (High)

**증상**: `deliberation_start` 시 `⚠️ 현재 환경에서 즉시 검출되지 않은 speaker: web-deepseek, web-qwen`
**기대값**: `browser_auto` (CDP 탭이 실제로 열려있음)
**원인**: CDP 탭 매칭 시 `deepseek.com`, `chat.qwen.ai` 도메인이 감지되지 않음
**현상**:
  - `route_turn` → `web-deepseek: manual`, `web-qwen: manual`
  - `curl http://localhost:9222/json/list`로 확인하면 두 탭 모두 정상 존재
  - `selectors/deepseek.json`, `selectors/qwen.json`은 이미 존재하지만 탭 매칭에 활용 안 됨

**수정 방향**: `inferLlmProvider()` 또는 CDP 탭→speaker 매칭 로직에서 deepseek.com, chat.qwen.ai 도메인 확인

## 3. web-huggingchat browser_auto 실행 실패 (High)

**증상**: `⚠️ 자동 실행 실패 (port.switchModel is not a function)`
**원인**: `browser-control-port.js`에서 `switchModel` 메서드 호출 시 해당 함수가 존재하지 않음
**수정**: `browser-control-port.js`의 `switchModel` 관련 로직 점검. HuggingChat에는 모델 전환이 필요 없을 수 있음 — provider별 분기 처리 필요

## 4. MCP client wrapper stdin 타이밍 이슈 (Medium)

**증상**: 이전 버전의 `/tmp/mcp-delib-client.mjs`에서 3초 후 `stdin.end()` → 서버가 응답 전에 연결 끊김 → `undefined` 반환
**수정**: stdin을 닫지 않고 timeout(60초)으로 관리. 현재 세션에서 수정 완료했으나 `auto-deliberate.sh`에서도 동일 패턴 확인 필요

## 5. deliberation_start speakers가 object 배열 불가 (Low)

**증상**: `speakers`에 `{name, role, instructions}` 객체 전달 시 validation error
**현재 동작**: `speakers`는 `string[]`만 허용
**제안**: 역할/지시사항을 speaker별로 지정할 수 있도록 `speakers` 스키마 확장 또는 별도 `roles` 파라미터 추가

```typescript
// 제안: 두 형태 모두 지원
speakers: ["claude", "codex"]  // 기존
speakers: [{name: "claude", role: "marketer", instructions: "..."}, ...]  // 확장
```

## 6. Qwen 페이지 DOM 구조 CDP 추출 불가 (Medium)

**증상**: Qwen chat (chat.qwen.ai) 응답 텍스트가 일반 DOM 셀렉터로 추출 안 됨
**현상**: `document.body.innerText` 길이가 70자뿐. "생각이 끝났습니다" 표시만 보임
**원인 추정**: Shadow DOM 또는 React Virtual DOM 내부에 응답 렌더링
**수정**: `selectors/qwen.json`에 shadow DOM 탐색 로직 추가 또는 Qwen 전용 CDP 응답 추출 함수 구현

## 7. Claude Code 중첩 세션 방지 (Info)

**증상**: `claude -p` 실행 시 `Error: Claude Code cannot be launched inside another Claude Code session`
**우회**: `CLAUDECODE= claude -p --output-format text "prompt"` (환경변수 해제)
**수정**: `auto-deliberate.sh`에서 claude CLI 호출 시 `CLAUDECODE=` 환경변수 해제 적용 필요

---

*Last updated: 2026-03-01*
*Session: aigentry 통합 마케팅 GTM 딜리버레이션*
