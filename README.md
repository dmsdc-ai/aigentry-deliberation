# @dmsdc-ai/aigentry-deliberation

Part of aigentry — the open-source engine that makes AI decisions auditable.

**The only tool that lets multiple AIs debate before deciding.**

MCP Deliberation Server — Multi-session AI deliberation with smart speaker ordering and persona roles. No competitor has this: aigentry-deliberation is the killer feature of the aigentry platform, enabling structured multi-AI debate with full audit trails before any decision is committed.

## Features

- **Multi-session** parallel deliberation support
- **Smart speaker ordering**: cyclic, random, weighted-random strategies
- **Persona roles**: critic, implementer, mediator, researcher, free — with prompt templates
- **Vote parsing**: [AGREE] / [DISAGREE] / [CONDITIONAL] extraction
- **Browser LLM integration**: CDP-based auto-turn for ChatGPT, Claude, Gemini browser tabs
- **Chrome Extension support**: Side panel detection via title-based matching
- **Cross-platform**: macOS (tmux + Terminal.app), Windows (Windows Terminal), Linux
- **Telepty bus transport**: structured `turn_request` delivery for telepty-managed sessions
- **User-confirmed speaker selection**: candidates must be confirmed before a session can start
- **Obsidian archiving**: Auto-archive deliberation results to Obsidian vault
- **Session monitoring**: Real-time tmux/terminal monitoring
- **Vote enforcement**: Automatic [AGREE]/[DISAGREE]/[CONDITIONAL] vote marker requirement
- **Dynamic CLI timeout**: Smart cold-start handling (180s first turn, 120s subsequent)
- **Split telepty timeouts**: 5s transport ack + 60s semantic response tracking
- **Typed synthesis envelopes**: validated structured payloads for downstream automation
- **Runtime logging**: Session lifecycle event logging for observability
- **Resilient browser automation**: 5-stage degradation state machine with 60s SLO
- **Model routing**: Dynamic per-provider model selection based on prompt analysis
- **Role drift detection**: Structural heading markers + keyword analysis for accurate role inference

## Installation

원클릭 설치 — 어떤 프로젝트 환경에서든 동작합니다:

```bash
npx @dmsdc-ai/aigentry-deliberation install
```

이 명령은:
1. `~/.local/lib/mcp-deliberation/`에 서버 파일 설치 (Windows: `%LOCALAPPDATA%/mcp-deliberation/`)
2. npm 의존성 설치
3. `~/.claude/.mcp.json`에 MCP 서버 자동 등록
4. Claude Code 재시작하면 바로 사용 가능
5. Gemini CLI MCP 서버 자동 등록 (`~/.gemini/settings.json`)
6. deliberation-gate 스킬 자동 설치 (`~/.claude/skills/deliberation-gate/`)

### 기타 설치 방법

```bash
# 글로벌 설치
npm install -g @dmsdc-ai/aigentry-deliberation
deliberation-install

# aigentry-devkit 통합 설치
npx @dmsdc-ai/aigentry-devkit setup

# 소스에서 직접 설치
git clone https://github.com/dmsdc-ai/aigentry-deliberation.git
cd aigentry-deliberation && npm install && node install.js
```

### 제거

```bash
npx @dmsdc-ai/aigentry-deliberation uninstall
```

MCP 서버 등록 해제 + 설치 파일 삭제 + 스킬 파일 정리까지 자동 처리됩니다.

## Forum Demo

Deliberation이 완료되면 결과를 시각화하는 Forum View를 생성합니다.

> **Deliberation = 프로세스, Forum = 출력물.**
> Deliberation이 끝나면 Forum이 생성되고, 그게 끝입니다.

![Forum Demo](demo/forum/assets/hero.png)

정적 데모를 브라우저에서 확인하려면:

```bash
open demo/forum/index.html
```

## Diagnostics

MCP 연결 문제 자동 진단:

```bash
npx @dmsdc-ai/aigentry-deliberation doctor
```

Claude Code, Codex CLI, Gemini CLI의 MCP 설정을 자동 점검하고 문제를 진단합니다.

## MCP Tools

| Tool | Description |
|------|-------------|
| `deliberation_start` | Start a new deliberation session |
| `deliberation_respond` | Submit a speaker's response |
| `deliberation_synthesize` | Generate synthesis report |
| `deliberation_status` | Check session status |
| `deliberation_context` | Load project context |
| `deliberation_history` | View discussion history |
| `deliberation_list_active` | List active sessions |
| `deliberation_list` | List archived sessions |
| `deliberation_reset` | Reset session(s) |
| `deliberation_speaker_candidates` | List available speakers |
| `deliberation_confirm_speakers` | Confirm the exact user-selected speaker set |
| `deliberation_browser_llm_tabs` | List browser LLM tabs |
| `deliberation_browser_auto_turn` | Auto-send turn to browser LLM |
| `deliberation_route_turn` | Route turn to appropriate transport |
| `deliberation_request_review` | Request code review |
| `deliberation_cli_auto_turn` | Auto-send turn to CLI speaker |
| `deliberation_cli_config` | Configure CLI settings |

## Start Flow

Manual participant selection is enforced for both CLI speakers and telepty sessions.

```text
1. deliberation_speaker_candidates(...)
2. User picks speakers in the TUI
3. deliberation_confirm_speakers(selection_token: "<candidate-token>", speakers: [...])
4. deliberation_start(selection_token: "<confirmed-token>", speakers: [...])
```

Raw candidate tokens cannot start a deliberation.

## Telepty Transport

Telepty-managed sessions are now routed through the telepty bus instead of raw PTY inject guidance.

- `deliberation_route_turn` publishes a typed `turn_request` envelope on `ws://localhost:3848/api/bus`
- transport delivery is tracked with a 5-second `inject_written` ack window
- semantic completion is tracked with a 60-second self-submit window
- `session_health` bus events are cached for operator visibility
- `deliberation_synthesize` validates and emits typed `deliberation_completed` envelopes for downstream automation

## Speaker Ordering Strategies

| Strategy | Description |
|----------|-------------|
| `cyclic` | Sequential round-robin (default) |
| `random` | Random selection each turn |
| `weighted-random` | Less-spoken speakers prioritized |

## Persona Roles

| Role | Focus |
|------|-------|
| `critic` | Risk analysis, weaknesses, counterarguments |
| `implementer` | Technical feasibility, code design |
| `mediator` | Consensus building, synthesis |
| `researcher` | Data, benchmarks, references |
| `free` | No role constraint (default) |

### Supported CLI Speakers

| CLI | Command | Status |
|-----|---------|--------|
| Claude Code | `claude` | ✅ Tested |
| Codex CLI | `codex` | ✅ Tested |
| Gemini CLI | `gemini` | ✅ Tested |
| Aider | `aider` | 🔧 Supported |
| Cursor Agent | `cursor` | 🔧 Supported |
| OpenCode | `opencode` | 🔧 Supported |
| Continue | `continue` | 🔧 Supported |

### Supported Browser LLMs

| Provider | Transport | Status |
|----------|-----------|--------|
| ChatGPT | CDP / Clipboard | ✅ Tested |
| Claude Web | CDP / Clipboard | ✅ Tested |
| Gemini Web | CDP / Clipboard | ✅ Tested |
| DeepSeek | CDP / Clipboard | ✅ Tested |
| Qwen | CDP / Clipboard | ✅ Tested |
| Poe | CDP / Clipboard | ✅ Tested |
| Copilot | CDP / Clipboard | 🔧 Supported |
| Perplexity | CDP / Clipboard | 🔧 Supported |
| Mistral | CDP / Clipboard | 🔧 Supported |
| Grok | CDP / Clipboard | 🔧 Supported |
| HuggingChat | CDP / Clipboard | 🔧 Supported |

### deliberation-gate (Superpowers Integration)

Inserts multi-AI verification gates at key [superpowers](https://github.com/obra/superpowers) workflow decision points.

**Scenarios:**
- **brainstorming** → multi-AI design validation before writing plans
- **code-review** → multi-AI review via `deliberation_request_review`
- **debugging** → multi-AI hypothesis verification when stuck

**Trigger:** Semi-automatic — skill recommends deliberation, user approves.

**Fallback:** MCP 미설치 시 self-criticism 기반 자가 검증으로 대체 (Silver 등급). MCP 설치 시 멀티-AI 토론 (Gold 등급).

**Install:** `npx @dmsdc-ai/aigentry-deliberation install` 실행 시 자동 설치됩니다.

수동 설치:
```bash
cp skills/deliberation-gate/SKILL.md ~/.claude/skills/deliberation-gate/SKILL.md
```

**RFC:** [Prerequisites header for tool-dependent skills](https://github.com/obra/superpowers/issues/589)

## What's New

### v0.0.35
- **Manual selection enforcement**: `deliberation_confirm_speakers` binds a fresh candidate snapshot to the exact user-picked speaker set before `deliberation_start`
- **Telepty session candidates**: active telepty sessions appear in speaker discovery with lightweight host/pid locators
- **Cross-project sessions**: session lookup/load/save now resolves active deliberations across project state directories
- **Telepty bus routing**: telepty speakers route via typed `turn_request` envelopes with 5s transport and 60s semantic timeout tracking
- **Structured synthesis envelopes**: `deliberation_synthesize` validates typed payloads before telepty bus publication
- **Codex CLI hardening**: reduced prompt budgets, lower-friction exec profile, and clearer timeout diagnostics
- **Packaging**: install path now preserves default config and includes required runtime modules (`clipboard.js`, `decision-engine.js`, `i18n.js`)

### v0.0.24
- **Role inference**: Heading marker weight increased from +5 to +8, added critic(검증/평가/Review) and researcher(데이터/Data) patterns to reduce false positives
- **Logging payload**: TURN log includes `suggested_role`, `role_drift`; CLI_TURN log includes `prior_turns`, `effective_timeout`
- **Vote marker warning**: WARN-level `INVALID_TURN` logged when response lacks [AGREE]/[DISAGREE]/[CONDITIONAL] markers
- **Auto-deploy**: `postversion` hook auto-installs to MCP server path after `npm version`

### v0.0.23
- **Vote enforcement**: Turn prompts now require [AGREE]/[DISAGREE]/[CONDITIONAL] markers for reliable consensus measurement
- **Dynamic CLI timeout**: First CLI invocation gets 180s (cold-start buffer), subsequent turns use default 120s
- **Runtime logging**: INFO-level lifecycle logging (SESSION_CREATED, TURN, CLI_TURN, SYNTHESIZED) to `runtime.log`
- **Role inference improvement**: Structural heading markers (e.g., `## 조사 결과` → researcher) with +5 weight prevent false role drift detection

### v0.0.22
- **Security**: CDP `--remote-allow-origins` restricted to `127.0.0.1:9222` (was `*`)
- **Security**: Observer CORS restricted to localhost allowlist, server bound to `127.0.0.1`
- **Performance**: Async sleep for Chrome CDP initialization (was blocking event loop)
- **Bug fix**: Fabrication guard uses `detectCallerSpeaker()` instead of hardcoded `"claude"`
- **Bug fix**: CLI reviewer uses per-CLI invocation flags via `CLI_INVOCATION_HINTS`
- **Bug fix**: Windows monitor state directory path corrected
- **Memory**: SSE client Map cleanup on disconnect prevents memory leak
- **Code quality**: Removed unreachable dead code in browser-control-port

## aigentry Ecosystem

aigentry-deliberation is one component of the unified aigentry platform. All packages work together to make AI decisions transparent and auditable.

| Package | Description |
|---------|-------------|
| [`@dmsdc-ai/aigentry-brain`](https://github.com/dmsdc-ai/aigentry-brain) | Cross-LLM memory OS |
| [`@dmsdc-ai/aigentry-devkit`](https://github.com/dmsdc-ai/aigentry-devkit) | Developer tools and hooks |
| [`aigentry-registry`](https://github.com/dmsdc-ai/aigentry-registry) | AI agent evaluation (Python) |
| [`aigentry-ssot`](https://github.com/dmsdc-ai/aigentry-ssot) | MCP contract schemas |

## License

MIT
