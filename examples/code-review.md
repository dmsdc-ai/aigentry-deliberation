# Multi-AI Code Review

Use `deliberation_request_review` to route a code snippet to multiple AI speakers for parallel review.

---

## Scenario

You have a new authentication middleware and want independent review from Claude and Gemini before merging.

---

## Step 1 — Start a Review Session

```json
// Tool: deliberation_request_review
{
  "topic": "Security review: JWT authentication middleware",
  "code": "function authMiddleware(req, res, next) {\n  const token = req.headers['authorization']?.split(' ')[1];\n  if (!token) return res.status(401).json({ error: 'No token' });\n  try {\n    const payload = jwt.verify(token, process.env.JWT_SECRET);\n    req.user = payload;\n    next();\n  } catch (err) {\n    res.status(403).json({ error: 'Invalid token' });\n  }\n}",
  "language": "javascript",
  "focus": ["security", "error handling", "edge cases"]
}
```

**Response:**
```json
{
  "deliberation_id": "delib-review-x9z1",
  "status": "active",
  "assigned_speakers": ["claude-opus", "gemini-pro"]
}
```

---

## Step 2 — Collect Reviews

```json
// Tool: deliberation_respond  (speaker: claude-opus)
{
  "deliberation_id": "delib-review-x9z1",
  "speaker_id": "claude-opus",
  "content": "Issues found:\n1. JWT_SECRET missing guard — if env var is undefined, jwt.verify accepts any token signed with 'undefined'.\n2. No token expiry enforcement beyond jwt.verify defaults.\n3. Leaking error type in 403 response could aid attackers.\nRecommend: validate JWT_SECRET at startup, use a dedicated error logger, return generic 403 message."
}
```

```json
// Tool: deliberation_respond  (speaker: gemini-pro)
{
  "deliberation_id": "delib-review-x9z1",
  "speaker_id": "gemini-pro",
  "content": "Concur on the JWT_SECRET risk. Additional concern: no algorithm pinning — `jwt.verify` without `algorithms` option is vulnerable to algorithm confusion (e.g., HS256 vs RS256 swap). Add `{ algorithms: ['HS256'] }` as third argument."
}
```

---

## Step 3 — Synthesize Review Findings

```json
// Tool: deliberation_synthesize
{
  "deliberation_id": "delib-review-x9z1"
}
```

**Response:**
```json
{
  "verdict": "Block merge — 2 critical security issues",
  "confidence": 0.95,
  "actionable_tasks": [
    { "id": 1, "task": "Guard JWT_SECRET at startup with process.exit on missing value", "priority": "high" },
    { "id": 2, "task": "Pin algorithm: jwt.verify(token, secret, { algorithms: ['HS256'] })", "priority": "high" },
    { "id": 3, "task": "Replace detailed error message in 403 with generic 'Forbidden'", "priority": "medium" }
  ]
}
```
