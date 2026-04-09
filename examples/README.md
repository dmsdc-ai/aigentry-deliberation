# Examples

Practical examples for using the aigentry-deliberation MCP server.

## Files

| File | Description |
|------|-------------|
| `basic-deliberation.md` | Start a session, collect turns, and synthesize a decision |
| `code-review.md` | Multi-AI code review using `deliberation_request_review` |
| `structured-synthesis.md` | Structured JSON output (ExecutionContractV2) for automation |
| `browser-automation.md` | Include ChatGPT / Gemini via CDP browser automation |

## Prerequisites

- aigentry-deliberation MCP server registered (`node install.js`)
- At least one speaker available (CLI session, browser tab, or telepty session)

## Quick Start

1. Call `deliberation_speaker_candidates` to discover available speakers.
2. Confirm speakers with `deliberation_confirm_speakers`.
3. Start the session with `deliberation_start`.
4. Route turns with `deliberation_route_turn` or `deliberation_run_until_blocked`.
5. Call `deliberation_synthesize` to get a structured decision.
