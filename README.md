# @dmsdc-ai/aigentry-deliberation

MCP Deliberation Server — Multi-session AI deliberation with smart speaker ordering and persona roles.

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

### As standalone MCP server

```bash
npm install -g @dmsdc-ai/aigentry-deliberation
```

### Via aigentry-devkit

```bash
npx @dmsdc-ai/aigentry-devkit setup
```

### Manual

```bash
git clone https://github.com/dmsdc-ai/aigentry-deliberation.git
cd aigentry-deliberation
npm install
```

## MCP Configuration

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "deliberation": {
      "command": "node",
      "args": ["/path/to/aigentry-deliberation/index.js"]
    }
  }
}
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

## License

MIT
