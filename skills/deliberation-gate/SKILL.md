---
name: deliberation-gate
description: |
  Use after brainstorming produces design doc, after code-review produces feedback,
  when debugging hits dead end with failed hypotheses, or when user says
  "deliberate this", "토론해줘", "검증해줘", "멀티-AI 리뷰", "multi-AI verify"
---

# Deliberation Gate — Multi-AI Verification for Superpowers Workflows

Insert multi-AI deliberation gates at key decision points in superpowers workflow chains.
Uses aigentry-deliberation MCP tools to orchestrate structured debate between multiple AI systems.

**Semi-automatic**: Recommends deliberation at decision points. User approves before starting.

## Context Detection

Detect the current workflow context by checking these signals IN ORDER:

| Priority | Signal | Context |
|----------|--------|---------|
| 1 | User says "deliberate", "토론", "debate", "검증", "멀티-AI" | explicit |
| 2 | Design doc recently written in session (docs/plans/*-design.md) | brainstorming |
| 3 | git diff output, PR number, or code review feedback in conversation | code-review |
| 4 | Error traces + failed hypotheses / "root cause" in conversation | debugging |
| 5 | None of above | general |

### Scenario Preset Map

| Context | preset | rounds | roles | MCP path |
|---------|--------|--------|-------|----------|
| brainstorming | brainstorm | 2 | critic, implementer, researcher | deliberation_start → route_turn loop → synthesize |
| code-review | review | 1 | critic, implementer | deliberation_request_review (lightweight) |
| debugging | research | 2 | researcher, implementer, critic | deliberation_start → route_turn loop → synthesize |
| general | balanced | 3 | user-selected via AskUserQuestion | deliberation_start → route_turn loop → synthesize |

## Recommendation Protocol (Semi-Automatic)

When you detect a decision point, recommend deliberation to the user.

### Step 1: Detect and Announce

Announce the detected context:

> 🔔 **멀티-AI 검증 추천** — [context] 시나리오 감지
>
> 이 [설계안/코드 리뷰/디버깅 가설]을 다른 AI의 관점으로 검증하면 더 견고해질 수 있습니다.

### Step 2: Ask User

Use AskUserQuestion to get approval:

```
AskUserQuestion:
  question: "이 [artifact]을 멀티-AI 토론으로 검증할까요?"
  header: "멀티-AI 검증"
  options:
    - label: "시작 (Recommended)"
      description: "[preset] preset, [N]라운드, [roles] 역할로 deliberation 시작"
    - label: "설정 변경 후 시작"
      description: "preset, rounds, roles를 직접 선택"
    - label: "건너뛰기"
      description: "deliberation 없이 원래 워크플로우 계속"
```

### Step 3: On Decline

If user chooses "건너뛰기":
- Do NOT persist or re-ask
- Continue the original workflow immediately
- No penalty, no warning

## Deliberation Execution

When user approves, execute this sequence:

### Standard Path (brainstorming, debugging, general)

1. **Speaker discovery**: `deliberation_speaker_candidates` → get available CLI + browser speakers
2. **Speaker selection**: `AskUserQuestion(multiSelect: true)` → user selects which speakers to include
3. **Start deliberation**: `deliberation_start`
   - `topic`: the artifact being validated (design summary / error description + hypotheses / user's question)
   - `speakers`: user-selected list
   - `speaker_roles`: from scenario preset map above
   - `rounds`: from scenario preset map above
   - `ordering_strategy`: "auto"
   - `role_preset`: from scenario preset map above
4. **Turn loop**: For each turn:
   - Call `deliberation_route_turn` — it auto-detects the correct transport
   - **Self-speaker** (you are the current speaker): Compose your response based on your role, submit via `deliberation_respond(speaker: "claude", content: "...")`
   - **Other CLI speaker**: `deliberation_route_turn` will guide to `deliberation_cli_auto_turn` which spawns the actual CLI
   - **Browser speaker**: `deliberation_route_turn` will auto-execute via CDP
5. **Synthesize**: After all rounds complete, call `deliberation_synthesize` with a summary of the consensus
6. **Apply synthesis**: Follow the Integration Rules below

### Lightweight Path (code-review only)

1. **Speaker discovery**: `deliberation_speaker_candidates` → get available speakers
2. **Reviewer selection**: `AskUserQuestion(multiSelect: true)` → user selects reviewers
3. **Request review**: `deliberation_request_review`
   - `context`: the diff or code under review
   - `question`: "이 코드 변경사항을 리뷰해주세요. 버그, 설계 문제, 보안 취약점을 중심으로."
   - `reviewers`: user-selected list
   - `mode`: "sync"
   - `deadline_ms`: 120000
4. **Apply results**: Follow the Integration Rules below

## Synthesis Integration Rules

### brainstorming → design doc update

After deliberation on a design:
1. Read the synthesis from `deliberation_synthesize`
2. Append a `## 멀티-AI 합의` section to the design doc with:
   - **합의 사항**: Key agreements from all participants
   - **이견**: Dissenting points (if any)
   - **권장 변경**: Concrete changes recommended by consensus
3. Apply the agreed changes to the design document
4. Continue to `writing-plans` skill with the updated design

### code-review → receiving-code-review

After multi-AI code review:
1. Parse review results into severity categories:
   - **Critical**: Must fix before merge
   - **Major**: Should fix
   - **Minor**: Optional improvements
2. Present the categorized feedback to user
3. Continue to `receiving-code-review` skill workflow

### debugging → hypothesis reordering

After deliberation on debugging hypotheses:
1. Extract the consensus hypothesis ranking from synthesis
2. Update the debugging state:
   - Move consensus-top hypothesis to position 1
   - Mark disproven hypotheses as eliminated
   - Add any new hypotheses suggested by other AIs
3. Resume `systematic-debugging` with the new priorities

### general → user-directed

For explicit or general deliberation:
1. Present the synthesis summary to user
2. Ask how to proceed with the consensus
3. Follow user's direction

## Anti-Patterns (NEVER)

1. **NEVER skip user approval** — Always use AskUserQuestion before starting deliberation. This is a HARD GATE.
2. **NEVER fabricate speaker responses** — Use `deliberation_route_turn` for other speakers. Never write responses on behalf of codex, gemini, or any other speaker. The MCP server blocks this.
3. **NEVER use cli_auto_turn for self-speaker** — If you (claude) are the current speaker, compose your response and submit via `deliberation_respond` directly. Using `cli_auto_turn` would recursively spawn yourself and timeout.
4. **NEVER re-ask after decline** — If user chooses "건너뛰기", respect it immediately. Do not ask again.
5. **NEVER block on deliberation failure** — If MCP tools fail (server not running, speaker unavailable), warn the user and continue the original workflow. Deliberation is enhancement, not requirement.
6. **NEVER modify existing superpowers skills** — This skill is purely additive. It works alongside existing skills without changing them.

## Workflow Position

```
brainstorming ──────→ [deliberation-gate] → writing-plans → executing-plans
code-review ────────→ [deliberation-gate] → receiving-code-review
systematic-debugging → [deliberation-gate] → resume with consensus
explicit request ───→ [deliberation-gate] → context-dependent
```

This skill is invoked BETWEEN existing superpowers skills, not within them. It consumes the output of one skill and feeds enhanced output to the next.
