# deliberation-gate Skill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a superpowers-compatible `deliberation-gate` skill that inserts semi-automatic multi-AI verification gates at key workflow decision points.

**Architecture:** A single `SKILL.md` file installed as a local Claude skill at `~/.claude/skills/deliberation-gate/SKILL.md`. It detects context (brainstorming/code-review/debugging), recommends deliberation to user, and orchestrates MCP tool calls when approved. No server-side changes needed.

**Tech Stack:** Markdown skill (SKILL.md), aigentry-deliberation MCP tools, AskUserQuestion for semi-automatic flow.

---

### Task 1: Create skill directory and SKILL.md skeleton

**Files:**
- Create: `~/.claude/skills/deliberation-gate/SKILL.md`

**Step 1: Create directory**

```bash
mkdir -p ~/.claude/skills/deliberation-gate
```

**Step 2: Write SKILL.md with frontmatter and overview**

Write the file with:
- `name: deliberation-gate`
- `description:` — trigger keywords only (CSO rule): brainstorming 산출물 검증, code-review 멀티-AI, debugging 교착 시 토론, "deliberate this", "토론해줘", "검증해줘", "멀티-AI 리뷰"
- Overview section explaining the skill's purpose

**Step 3: Verify skill is discoverable**

```bash
ls ~/.claude/skills/deliberation-gate/SKILL.md
```

Expected: file exists

**Step 4: Commit**

```bash
cd ~/projects/aigentry-deliberation
git add -f ~/.claude/skills/deliberation-gate/SKILL.md  # won't work — separate repo
```

Note: This skill lives outside the repo. We'll copy it to `skills/deliberation-gate/` in the aigentry-deliberation project for version control, then symlink or install.

---

### Task 2: Write Context Detection section

**Files:**
- Modify: `~/.claude/skills/deliberation-gate/SKILL.md`

**Step 1: Add context detection rules**

Add a "## Context Detection" section with a clear decision table:

```markdown
## Context Detection

Detect the current workflow context by checking these signals IN ORDER:

| Priority | Signal | Context | Confidence |
|----------|--------|---------|------------|
| 1 | User says "deliberate", "토론", "debate", "검증" | explicit | high |
| 2 | Recent design doc written (docs/plans/*-design.md) | brainstorming | high |
| 3 | git diff output or PR number in conversation | code-review | high |
| 4 | Error traces + "hypothesis" / "root cause" in conversation | debugging | medium |
| 5 | None of above | general | low |
```

**Step 2: Add scenario preset mapping**

```markdown
### Scenario Preset Map

| Context | preset | rounds | roles | MCP path |
|---------|--------|--------|-------|----------|
| brainstorming | brainstorm | 2 | critic, implementer, researcher | deliberation_start → route_turn → synthesize |
| code-review | review | 1 | critic, implementer | deliberation_request_review |
| debugging | research | 2 | researcher, implementer, critic | deliberation_start → route_turn → synthesize |
| general | balanced | 3 | user-selected | deliberation_start → route_turn → synthesize |
```

---

### Task 3: Write Recommendation Protocol section

**Files:**
- Modify: `~/.claude/skills/deliberation-gate/SKILL.md`

**Step 1: Add semi-automatic recommendation protocol**

Add a "## Recommendation Protocol" section:

```markdown
## Recommendation Protocol (Semi-Automatic)

When you detect a decision point, use AskUserQuestion to recommend deliberation:

### Step 1: Detect and Announce

Announce the detected context:
"🔔 멀티-AI 검증 추천 — [context] 시나리오 감지"

### Step 2: Ask User

Use AskUserQuestion:
- question: "이 [설계안/코드 리뷰/디버깅 가설]을 멀티-AI 토론으로 검증할까요?"
- options:
  - "시작" — 추천 설정으로 deliberation 시작
  - "설정 변경 후 시작" — preset/rounds/roles 커스텀
  - "건너뛰기" — deliberation 없이 원래 워크플로우 계속

### Step 3: On Decline

If user chooses "건너뛰기":
- Do NOT persist or re-ask
- Continue the original workflow immediately
- No penalty, no warning
```

---

### Task 4: Write Deliberation Execution section

**Files:**
- Modify: `~/.claude/skills/deliberation-gate/SKILL.md`

**Step 1: Add execution workflow**

Add "## Deliberation Execution" section with step-by-step MCP tool calls:

```markdown
## Deliberation Execution

When user approves, execute this sequence:

### Standard Path (brainstorming, debugging, general)

1. `deliberation_speaker_candidates` → get available speakers
2. `AskUserQuestion(multiSelect: true)` → user selects speakers
3. `deliberation_start`:
   - topic: the artifact being validated (design summary / error + hypotheses)
   - speakers: user-selected list
   - speaker_roles: from scenario preset map
   - rounds: from scenario preset map
   - ordering_strategy: "auto"
4. Loop per turn:
   - `deliberation_route_turn` → auto-routes to correct transport
   - If self-speaker (orchestrator = speaker): compose response directly,
     submit via `deliberation_respond`
   - If other CLI: `deliberation_route_turn` handles via `cli_auto_turn`
   - If browser: `deliberation_route_turn` handles via `browser_auto_turn`
5. After all rounds: `deliberation_synthesize` → get consensus
6. Apply synthesis (see Integration Rules below)

### Lightweight Path (code-review)

1. `deliberation_speaker_candidates` → get available speakers
2. `AskUserQuestion(multiSelect: true)` → user selects reviewers
3. `deliberation_request_review`:
   - context: the diff or code under review
   - question: "이 코드 변경사항을 리뷰해주세요"
   - reviewers: user-selected list
   - mode: "sync"
   - deadline_ms: 120000
4. Apply review results (see Integration Rules below)
```

---

### Task 5: Write Synthesis Integration Rules section

**Files:**
- Modify: `~/.claude/skills/deliberation-gate/SKILL.md`

**Step 1: Add per-scenario integration rules**

```markdown
## Synthesis Integration Rules

### brainstorming → design doc update

1. Read the synthesis from deliberation_synthesize
2. Append a "## 멀티-AI 합의" section to the design doc:
   - Key agreements
   - Dissenting points (if any)
   - Recommended changes
3. Apply agreed changes to the design
4. Continue to writing-plans skill with updated design

### code-review → receiving-code-review

1. Parse review results into severity categories:
   - Critical: must fix before merge
   - Major: should fix
   - Minor: optional improvements
2. Present to user as code review feedback
3. Continue to receiving-code-review skill workflow

### debugging → hypothesis reordering

1. Extract consensus hypothesis ranking from synthesis
2. Update the debugging checklist:
   - Move consensus-top hypothesis to position 1
   - Mark disproven hypotheses as eliminated
3. Resume systematic-debugging with new priorities

### general → user-directed

1. Present synthesis summary to user
2. Ask how to proceed with the consensus
```

---

### Task 6: Write Anti-Patterns and Guards section

**Files:**
- Modify: `~/.claude/skills/deliberation-gate/SKILL.md`

**Step 1: Add anti-patterns**

```markdown
## Anti-Patterns (NEVER)

1. **NEVER skip user approval** — Always ask before starting deliberation
2. **NEVER fabricate speaker responses** — Use route_turn, never write responses for other speakers
3. **NEVER use cli_auto_turn for self-speaker** — If you are the speaker, use deliberation_respond directly
4. **NEVER re-ask after decline** — If user says skip, respect it immediately
5. **NEVER block on deliberation failure** — If MCP tools fail, warn and continue original workflow
6. **NEVER modify existing superpowers skills** — This skill is purely additive
```

---

### Task 7: Assemble final SKILL.md and test

**Files:**
- Create: `~/.claude/skills/deliberation-gate/SKILL.md` (final assembled version)
- Create: `skills/deliberation-gate/SKILL.md` (project copy for version control)

**Step 1: Write the complete assembled SKILL.md**

Combine all sections from Tasks 1-6 into the final file.

**Step 2: Copy to project for version control**

```bash
mkdir -p ~/projects/aigentry-deliberation/skills/deliberation-gate
cp ~/.claude/skills/deliberation-gate/SKILL.md ~/projects/aigentry-deliberation/skills/deliberation-gate/SKILL.md
```

**Step 3: Verify skill is loaded**

Start a new Claude Code session and check that `deliberation-gate` appears in available skills.

**Step 4: Smoke test — brainstorming scenario**

1. In a project, run brainstorming skill and create a design doc
2. Verify deliberation-gate detects the context and recommends deliberation
3. Approve → verify speaker selection → verify deliberation runs
4. Verify synthesis is appended to design doc

**Step 5: Commit**

```bash
cd ~/projects/aigentry-deliberation
git add skills/deliberation-gate/SKILL.md
git commit -m "feat: add deliberation-gate skill for superpowers integration"
```

---

### Task 8: Update project documentation

**Files:**
- Modify: `~/projects/aigentry-deliberation/README.md` (add deliberation-gate section)
- Modify: `~/projects/aigentry-deliberation/skills/deliberation/SKILL.md` (cross-reference)

**Step 1: Add deliberation-gate to README**

Add a section under "Skills" explaining:
- What deliberation-gate does
- How it integrates with superpowers
- Installation: copy to `~/.claude/skills/deliberation-gate/`

**Step 2: Cross-reference in deliberation SKILL.md**

Add a note: "See also: `deliberation-gate` skill for superpowers workflow integration"

**Step 3: Commit**

```bash
git add README.md skills/deliberation/SKILL.md
git commit -m "docs: add deliberation-gate references to README and SKILL.md"
```

**Step 4: Push**

```bash
git push
```
