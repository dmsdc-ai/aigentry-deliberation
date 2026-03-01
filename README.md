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
- **Obsidian archiving**: Auto-archive deliberation results to Obsidian vault
- **Session monitoring**: Real-time tmux/terminal monitoring

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

## Forum Demo

Deliberation이 완료되면 결과를 시각화하는 Forum View를 생성합니다.

> **Deliberation = 프로세스, Forum = 출력물.**
> Deliberation이 끝나면 Forum이 생성되고, 그게 끝입니다.

![Forum Demo](demo/forum/assets/hero.png)

정적 데모를 브라우저에서 확인하려면:

```bash
open demo/forum/index.html
```

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
| `deliberation_browser_llm_tabs` | List browser LLM tabs |
| `deliberation_browser_auto_turn` | Auto-send turn to browser LLM |
| `deliberation_route_turn` | Route turn to appropriate transport |
| `deliberation_request_review` | Request code review |
| `deliberation_cli_auto_turn` | Auto-send turn to CLI speaker |
| `deliberation_cli_config` | Configure CLI settings |

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

### deliberation-gate (Superpowers Integration)

Inserts multi-AI verification gates at key [superpowers](https://github.com/anthropics/superpowers) workflow decision points.

**Scenarios:**
- **brainstorming** → multi-AI design validation before writing plans
- **code-review** → multi-AI review via `deliberation_request_review`
- **debugging** → multi-AI hypothesis verification when stuck

**Trigger:** Semi-automatic — skill recommends deliberation, user approves.

**Install:**
```bash
cp skills/deliberation-gate/SKILL.md ~/.claude/skills/deliberation-gate/SKILL.md
```

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
