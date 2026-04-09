# Basic Deliberation

A complete walkthrough of starting a deliberation session from scratch.

**Topic:** Should we use REST or GraphQL for our new API?

---

## Step 1 — Discover Available Speakers

```json
// Tool: deliberation_speaker_candidates
{}
```

**Response (example):**
```json
{
  "candidates": [
    { "id": "claude-opus", "name": "Claude Opus", "transport": "cli_respond" },
    { "id": "gemini-pro", "name": "Gemini Pro", "transport": "cli_respond" }
  ]
}
```

---

## Step 2 — Confirm Speakers

```json
// Tool: deliberation_confirm_speakers
{
  "speaker_ids": ["claude-opus", "gemini-pro"]
}
```

---

## Step 3 — Start the Session

```json
// Tool: deliberation_start
{
  "topic": "Should we use REST or GraphQL for our new API?",
  "context": "We are building a mobile app with complex nested data requirements and 3 client types.",
  "max_turns": 4
}
```

**Response:**
```json
{ "deliberation_id": "delib-a1b2c3", "status": "active", "turn": 0 }
```

---

## Step 4 — Collect Turns (2 speakers)

```json
// Tool: deliberation_respond  (speaker: claude-opus)
{
  "deliberation_id": "delib-a1b2c3",
  "speaker_id": "claude-opus",
  "content": "GraphQL is the stronger choice here. With 3 client types each needing different fields, GraphQL eliminates over-fetching and lets clients declare exactly what they need. The nested data model maps naturally to GraphQL resolvers."
}
```

```json
// Tool: deliberation_respond  (speaker: gemini-pro)
{
  "deliberation_id": "delib-a1b2c3",
  "speaker_id": "gemini-pro",
  "content": "REST is simpler to cache and easier for teams already familiar with HTTP conventions. For a mobile app, HTTP/2 with REST and sparse fieldsets can achieve similar efficiency. Consider GraphQL only if query flexibility is genuinely required at launch."
}
```

---

## Step 5 — Synthesize the Decision

```json
// Tool: deliberation_synthesize
{
  "deliberation_id": "delib-a1b2c3"
}
```

**Response:**
```json
{
  "verdict": "GraphQL recommended with phased rollout",
  "confidence": 0.82,
  "actionable_tasks": [
    { "id": 1, "task": "Set up Apollo Server with schema-first design", "priority": "high" },
    { "id": 2, "task": "Define GraphQL types for core entities", "priority": "high" },
    { "id": 3, "task": "Add REST compatibility layer for legacy clients", "priority": "medium" }
  ]
}
```
