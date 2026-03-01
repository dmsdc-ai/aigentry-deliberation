# aigentry-deliberation 수정 필요사항

> 이 세션에서 발견된 모든 이슈를 정리.

## 1. model-router.js 설치 누락 (Critical) — ✅ 해결

**수정**: `install.js`의 `FILES_TO_COPY`에 `model-router.js` 추가. (commit a8635a8)

## 2. web-deepseek, web-qwen이 manual로 라우팅됨 (High) — ✅ 해결

**수정**: CDP 탭 매칭 second pass 추가 + DeepSeek URL `chat.deepseek.com`으로 수정. (commit a8635a8)

## 3. web-huggingchat browser_auto 실행 실패 (High) — ✅ 해결

**수정**: `OrchestratedBrowserPort`에 `switchModel()` delegate 누락 → 추가. (이번 커밋)

## 4. MCP client wrapper stdin 타이밍 이슈 (Medium) — ✅ 해결

**수정**: 기존 `/tmp/mcp-delib-client.mjs` 이슈는 해결됨. `auto-deliberate.sh`는 printf 파이핑 방식으로 정상 동작 확인.

## 5. deliberation_start speakers가 object 배열 불가 (Low) — ✅ 해결

**수정**: speakers preprocess에서 `{name, role, instructions}` 객체 배열을 자동 정규화. 별도 `speaker_instructions` 파라미터 추가. (이번 커밋)

## 6. Qwen 페이지 DOM 구조 CDP 추출 불가 (Medium) — ✅ 해결

**수정**: 셀렉터 업데이트 및 React state sync 추가로 Qwen 정상 동작. 7/8 providers 확인. (commit a8635a8)

## 7. Claude Code 중첩 세션 방지 (Info) — ✅ 해결

**수정**: `auto-deliberate.sh`에서 `CLAUDECODE= claude -p --output-format text` 적용. (이번 커밋)

---

*Last updated: 2026-03-01*
*All 7 issues resolved.*
