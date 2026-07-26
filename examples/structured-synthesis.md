# Structured Synthesis & ExecutionContractV2

`deliberation_synthesize` returns an `ExecutionContractV2` — a machine-readable handoff
that downstream automation (brain inbox, CI pipelines, executor agents) can consume directly.

---

## Triggering Synthesis

```json
// Tool: deliberation_synthesize
{
  "deliberation_id": "delib-a1b2c3"
}
```

---

## Full ExecutionContractV2 Schema

```json
{
  "schema_version": 2,
  "source_session_id": "aigentry-orchestrator-claude",
  "deliberation_id": "delib-a1b2c3",
  "summary": "GraphQL chosen over REST for the new API due to multi-client flexibility and nested data requirements.",
  "decisions": [
    "Use GraphQL with Apollo Server",
    "Schema-first design with code generation",
    "Maintain REST shim for legacy mobile clients during 90-day transition"
  ],
  "actionable_tasks": [
    {
      "id": 1,
      "task": "Set up Apollo Server with schema-first design",
      "priority": "high",
      "files": ["src/server.js", "src/schema/index.graphql"]
    },
    {
      "id": 2,
      "task": "Define GraphQL types for User, Order, and Product entities",
      "priority": "high",
      "files": ["src/schema/types.graphql"]
    },
    {
      "id": 3,
      "task": "Add REST compatibility shim for /api/v1 routes",
      "priority": "medium",
      "files": ["src/routes/v1.js"]
    }
  ],
  "experiment_outcome": {
    "verdict": "keep",
    "confidence": 0.82
  },
  "generated_from": "deliberation_synthesize"
}
```

---

## Brain Inbox Handoff

The contract is automatically written to:

```
~/.aigentry/inbox/handoff-{deliberation_id}.json
```

An executor agent picks it up and starts implementation.

---

## Consuming the Contract in Code

```javascript
import { readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

const contract = JSON.parse(
  readFileSync(path.join(homedir(), '.aigentry/inbox/handoff-delib-a1b2c3.json'), 'utf8')
);

for (const task of contract.actionable_tasks) {
  if (task.priority === 'high') {
    console.log(`[HIGH] ${task.task} → files: ${task.files.join(', ')}`);
  }
}
```
