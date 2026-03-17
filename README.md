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
npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-install
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
npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-install --uninstall
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
npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-doctor
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
| `deliberation_inject_context` | Inject structured context or external experiment history into an active session |
| `deliberation_history` | View discussion history |
| `deliberation_list_active` | List active sessions |
| `deliberation_list` | List archived sessions |
| `deliberation_reset` | Reset session(s) |
| `deliberation_speaker_candidates` | List available speakers |
| `deliberation_confirm_speakers` | Confirm the exact user-selected speaker set |
| `deliberation_browser_llm_tabs` | List browser LLM tabs |
| `deliberation_browser_auto_turn` | Auto-send turn to browser LLM |
| `deliberation_route_turn` | Route turn to appropriate transport |
| `deliberation_run_until_blocked` | Auto-run mixed transports until completion or a manual block |
| `deliberation_request_review` | Request code review |
| `deliberation_cli_auto_turn` | Auto-send turn to CLI speaker |
| `deliberation_ingest_remote_reply` | Canonical semantic ingress for remote replies with explicit source metadata |
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
- `deliberation_run_until_blocked` can continue across `cli_respond`, `browser_auto`, and `telepty_bus` speakers until a manual block is reached
- transport delivery is tracked with a 5-second `inject_written` ack window
- semantic completion is tracked with a 60-second self-submit window
- `session_health` bus events are cached for operator visibility
- `deliberation_synthesize` validates and emits typed `deliberation_completed` envelopes for downstream automation
- telepty envelopes now carry top-level `version: 1` and optional `source_host`

### Cross-Machine Event Catalog

Canonical boundary split with telepty:

- **Guaranteed (daemon-emitted):** `inject_written`, `session_health`, `session_register`, `session.replaced`, `session.idle`, `thread.opened`, `thread.closed`, `handoff.*`, `message_routed`
- **Best-effort (bus relay only):** `turn_request`, `turn_completed`, `deliberation_completed`
- `kind` is the canonical event discriminator
- `target` identifies the telepty session target
- `payload.prompt` is the canonical prompt field for `turn_request`
- `source_host` is optional transport metadata for cross-machine tracing

### Remote Reply Ingress

If a remote participant cannot call local MCP tools directly, do **not** proxy-synthesize a reply. Use the deliberation-owned semantic ingress:

```text
deliberation_ingest_remote_reply(
  session_id: "...",
  speaker: "...",
  turn_id: "...",
  content: "...",
  source_machine_id: "peer-01",
  source_session_id: "remote-gemini-001",
  transport_scope: "remote_mcp",
  artifact_refs: ["results.jsonl"]
)
```

This preserves explicit provenance instead of inferring semantics from raw bus events.

### Gemini Recovery

Canonical repair path today is still installer-based:

```bash
npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-doctor
npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-install
```

Use doctor first; if Gemini MCP registration/path/runtime drift is detected, rerun install and restart Gemini CLI.

## Experiment Retrospectives

For autoresearch-style keep/discard reviews, inject a compact experiment bundle after the session starts instead of bloating `topic`.

Recommended rules:
- keep the injected JSON around `1.5KB` to `2KB`
- include only the last `3-5` relevant experiments
- keep `key_changes` to at most `3` scalar before/after pairs
- reference bulky artifacts (`results.tsv`, full `program.md`, JSONL logs) by path only

Example:

```text
deliberation_start(...)
deliberation_inject_context(
  session_id: "experiment-review-123",
  speaker: "dustcraw",
  context: "{\"past_experiments\":[{\"experiment_id\":\"dg-20260310-001\",\"signal_kind\":\"INTEREST_DRIFT\",\"patch_summary\":\"Raised relevanceThreshold from 0.30 to 0.35\",\"patch_kind\":\"config\",\"key_changes\":{\"relevanceThreshold\":{\"before\":0.3,\"after\":0.35}},\"score\":0.08,\"score_label\":\"promotion_rate_delta\",\"metric_name\":\"promotion_rate_delta\",\"metric_delta\":0.08,\"verdict\":\"positive\",\"followup_action\":\"kept\",\"reasoning\":\"Threshold raise reduced noise; promotion quality improved 8%\"}],\"experiment_count\":1,\"success_rate\":1.0}"
)
```

If your synthesis needs an explicit experiment verdict, `structured` can now include `experiment_outcome`:

```json
{
  "summary": "Lower the blast radius and re-run with stricter constraints.",
  "decisions": [
    "Keep the experiment loop bounded to one editable file",
    "Retry after restoring the failing test baseline"
  ],
  "actionable_tasks": [
    { "id": 1, "task": "Tighten editable globs", "project": "aigentry-devkit", "priority": "high" }
  ],
  "experiment_outcome": {
    "verdict": "modify",
    "suggested_action": "iterate",
    "confidence": 0.78,
    "measurement_window_hours": 24
  }
}
```

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

**Install:** `npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-install` 실행 시 자동 설치됩니다.

수동 설치:
```bash
cp skills/deliberation-gate/SKILL.md ~/.claude/skills/deliberation-gate/SKILL.md
```

**RFC:** [Prerequisites header for tool-dependent skills](https://github.com/obra/superpowers/issues/589)

## What's New

### v0.0.36
- **README refresh**: clarified the mandatory TUI speaker-selection flow and the confirmed-token handoff before `deliberation_start`
- **Telepty candidate docs**: documented active telepty session discovery with lightweight `session_id` + `host/pid` locators instead of heavy persisted process snapshots
- **Cross-project delivery docs**: clarified that active session lookup now resolves across project state directories, which unblocks cross-project `deliberation_respond` flows
- **Operator guidance**: documented telepty bus transport as the automation path and unmanaged/manual sessions as the fallback path

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
