# deliberation-gate: Superpowers + Deliberation Integration Design

**Date**: 2026-03-02
**Status**: Approved
**Approach**: Hybrid (single skill + scenario-aware preset mapping)

## Problem

Superpowers skills produce critical artifacts (designs, reviews, debug hypotheses) that benefit from multi-AI validation. Currently these decisions are made by a single AI. Deliberation MCP enables structured multi-AI debate but has no integration with superpowers workflow chains.

## Solution

A single `deliberation-gate` superpowers skill that inserts multi-AI verification gates at key decision points in the superpowers workflow.

## Requirements

1. **Semi-automatic trigger**: Skill recommends deliberation at decision points, user approves before starting
2. **Scenario detection**: Auto-detect brainstorming/code-review/debugging context and select optimal deliberation settings
3. **Seamless chain**: Synthesis feeds back into the originating workflow (design doc updated, review applied, debug reoriented)
4. **Single skill**: One `SKILL.md` covers all scenarios via internal context detection

## Architecture

### Workflow Position

```
brainstorming ──────→ [deliberation-gate] → writing-plans → executing-plans
code-review ────────→ [deliberation-gate] → receiving-code-review
systematic-debugging → [deliberation-gate] → resume debugging with consensus
explicit "토론해줘" → [deliberation-gate] → context-dependent
```

### Scenario Preset Map

| Detected Context | Preset | Rounds | Roles | MCP Tool Path |
|------------------|--------|--------|-------|---------------|
| brainstorming (design doc exists) | brainstorm | 2 | critic, implementer, researcher | deliberation_start → route_turn loop → synthesize |
| code-review (diff/PR context) | review | 1 | critic, implementer | deliberation_request_review (lightweight) |
| debugging (hypothesis failure) | research | 2 | researcher, implementer, critic | deliberation_start → route_turn loop → synthesize |
| other / explicit request | balanced | 3 | user-selected via AskUserQuestion | deliberation_start → route_turn loop → synthesize |

### Context Detection Signals

| Signal | Indicates |
|--------|-----------|
| Recent `docs/plans/*-design.md` written in session | brainstorming |
| `git diff` output or PR number in context | code-review |
| "root cause", "hypothesis", error traces in context | debugging |
| User says "deliberate", "토론", "debate" | explicit |

### Semi-Automatic Flow

```
1. Superpowers skill produces artifact
2. deliberation-gate detects context
3. Recommend: "멀티-AI 검증 추천 — [scenario] 감지. 토론 시작할까요?"
4. User approves → proceed / User declines → skip
5. If approved:
   a. deliberation_speaker_candidates → present available speakers
   b. AskUserQuestion → user selects speakers
   c. deliberation_start(topic=artifact, speakers, preset, rounds, roles)
   d. deliberation_route_turn loop (auto for CLI/browser, self-respond for orchestrator)
   e. deliberation_synthesize → consensus
6. Feed synthesis back:
   - brainstorming: append "멀티-AI 합의" section to design doc
   - code-review: format as severity-rated feedback for receiving-code-review
   - debugging: reorder hypotheses by consensus priority
7. Resume original workflow
```

### Recommendation Message Template

```
🔔 멀티-AI 검증 추천

이 [설계안/코드 리뷰/디버깅 가설]을 다른 AI의 관점으로
검증하면 더 견고해질 수 있습니다.

감지된 시나리오: [brainstorming / code-review / debugging]
추천 설정: preset=[X], rounds=[N], roles=[...]
사용 가능한 스피커: [detected speakers]

멀티-AI 토론을 시작할까요?
  ✅ 시작  |  ⏭️ 건너뛰기
```

### Synthesis Integration Rules

| Scenario | How Synthesis Is Applied |
|----------|------------------------|
| brainstorming | Append "## 멀티-AI 합의" section to design doc with agreed changes, then proceed to writing-plans |
| code-review | Parse synthesis into severity-rated items (Critical/Major/Minor), pass to receiving-code-review skill |
| debugging | Extract consensus hypothesis ranking, update systematic-debugging checklist priorities |

## Skill File Structure

```
~/.claude/skills/deliberation-gate/
  SKILL.md          # Main skill definition with scenario detection + deliberation orchestration
```

### SKILL.md Structure

1. **Frontmatter**: name, description (trigger keywords only per CSO rule)
2. **Overview**: What this skill does
3. **Context Detection**: How to identify brainstorming/review/debug scenarios
4. **Recommendation Protocol**: Semi-automatic prompt format
5. **Deliberation Execution**: Step-by-step MCP tool calls
6. **Synthesis Integration**: Per-scenario rules for feeding results back
7. **Anti-patterns**: Don't skip user approval, don't fabricate responses, don't use cli_auto_turn for self-speaker

## Constraints

- No modification to existing superpowers skills (purely additive)
- No modification to deliberation MCP server (uses existing 16 tools)
- Respects self-speaker detection (orchestrator uses deliberation_respond directly)
- Speaker selection always goes through user via AskUserQuestion
- Deliberation is optional — declining skips gate without penalty

## Success Criteria

1. brainstorming → deliberation-gate → writing-plans chain works end-to-end
2. code-review → deliberation-gate → receiving-code-review chain works
3. debugging → deliberation-gate → resume with consensus works
4. User can decline deliberation and workflow continues normally
5. Self-speaker (Claude as orchestrator+speaker) handles correctly without timeout
