# Browser Automation — Include ChatGPT / Gemini via CDP

Use `deliberation_browser_llm_tabs` and `deliberation_browser_auto_turn` to pull browser-based
LLMs (ChatGPT, Gemini, Claude.ai) into a deliberation session without manual copy-paste.

---

## Prerequisites

- Chrome / Chromium launched with remote debugging enabled:
  ```bash
  google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/cdp-profile
  ```
- Target LLM tabs open and logged in (e.g., chatgpt.com, gemini.google.com)

---

## Step 1 — Discover Open Browser Tabs

```json
// Tool: deliberation_browser_llm_tabs
{}
```

**Response:**
```json
{
  "tabs": [
    { "id": "tab-001", "url": "https://chatgpt.com", "title": "ChatGPT", "provider": "chatgpt" },
    { "id": "tab-002", "url": "https://gemini.google.com", "title": "Gemini", "provider": "gemini" }
  ]
}
```

---

## Step 2 — Confirm Speakers Including Browser Tabs

```json
// Tool: deliberation_confirm_speakers
{
  "speaker_ids": ["claude-opus", "tab-001", "tab-002"]
}
```

---

## Step 3 — Start the Session

```json
// Tool: deliberation_start
{
  "topic": "Best caching strategy for a high-traffic e-commerce product page",
  "context": "~50k requests/min, product data changes every 15 minutes, personalization per user.",
  "max_turns": 6
}
```

---

## Step 4 — Route a Turn to a Browser Tab

```json
// Tool: deliberation_browser_auto_turn
{
  "deliberation_id": "delib-b7c8d9",
  "tab_id": "tab-001",
  "prompt": "Given the context above, what caching strategy would you recommend and why?"
}
```

**What happens:** The server injects the prompt into the ChatGPT tab via CDP, waits for the
response to stream to completion, then captures the text and stores it as a deliberation turn.

**Response:**
```json
{
  "speaker_id": "tab-001",
  "content": "I recommend a two-layer cache: CDN edge cache (TTL 60s) for the static product shell, plus a Redis read-through cache (TTL 900s) for product data. For personalization, serve a generic cached page and hydrate user-specific sections client-side via a lightweight /api/personalize call.",
  "transport": "browser_auto"
}
```

---

## Step 5 — Run All Remaining Turns Automatically

```json
// Tool: deliberation_run_until_blocked
{
  "deliberation_id": "delib-b7c8d9"
}
```

The server routes each pending turn to its assigned transport (`browser_auto` for tabs,
`cli_respond` for CLI speakers) and blocks only when manual input is required.

---

## Step 6 — Synthesize

```json
// Tool: deliberation_synthesize
{
  "deliberation_id": "delib-b7c8d9"
}
```

**Response:**
```json
{
  "verdict": "Two-layer cache: CDN (60s TTL) + Redis (900s TTL) with client-side personalization hydration",
  "confidence": 0.88,
  "actionable_tasks": [
    { "id": 1, "task": "Configure CDN cache rules with 60s TTL and stale-while-revalidate", "priority": "high" },
    { "id": 2, "task": "Add Redis read-through cache for product data with 15-min TTL", "priority": "high" },
    { "id": 3, "task": "Build /api/personalize endpoint for client-side hydration", "priority": "medium" }
  ]
}
```
