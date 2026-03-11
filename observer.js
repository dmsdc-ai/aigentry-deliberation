#!/usr/bin/env node
/**
 * Deliberation Observer — SSE + Minimal Dashboard
 *
 * Usage:
 *   node observer.js [--port 3847]
 *   npx aigentry-deliberation --dashboard
 *
 * Provides:
 *   GET /                          → HTML dashboard
 *   GET /api/sessions              → JSON list of active sessions
 *   GET /api/sessions/:id          → JSON session detail
 *   GET /api/sessions/:id/stream   → SSE real-time log stream
 */

import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(os.homedir(), ".local", "lib", "mcp-deliberation", "state");
const INBOX_DIR = path.join(path.dirname(STATE_DIR), "inbox");
const CONFIG_PATH = path.join(os.homedir(), ".local", "lib", "mcp-deliberation", "config.json");
const DEFAULT_CLI_CANDIDATES = ["claude", "codex", "gemini", "qwen", "chatgpt", "aider", "llm", "opencode", "cursor", "continue"];
const CLI_LABELS = {
  claude: "Claude", codex: "Codex", gemini: "Gemini", qwen: "Qwen",
  chatgpt: "ChatGPT", aider: "Aider", llm: "LLM (Simon)",
  opencode: "OpenCode", cursor: "Cursor", continue: "Continue"
};
const DEFAULT_PORT = 3847;
const DEFAULT_HOST = process.env.HOST || "0.0.0.0";

function getProjectSlug() {
  const cwd = process.cwd();
  return path.basename(cwd).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function listSessions(projectSlug) {
  const sessionsDir = path.join(STATE_DIR, projectSlug || "", "sessions");
  try {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".json"));
    return files.map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf-8"));
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function findSession(sessionId) {
  // Search all project slugs
  try {
    const slugs = fs.readdirSync(STATE_DIR).filter(f => {
      const stat = fs.statSync(path.join(STATE_DIR, f));
      return stat.isDirectory();
    });
    for (const slug of slugs) {
      const sessionsDir = path.join(STATE_DIR, slug, "sessions");
      const filePath = path.join(sessionsDir, `${sessionId}.json`);
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch { continue; }
    }
  } catch {}
  return null;
}

function saveSession(session) {
  const slugs = fs.readdirSync(STATE_DIR).filter(f => {
    try { return fs.statSync(path.join(STATE_DIR, f)).isDirectory(); } catch { return false; }
  });
  for (const slug of slugs) {
    const sessionsDir = path.join(STATE_DIR, slug, "sessions");
    const filePath = path.join(sessionsDir, `${session.id}.json`);
    if (fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
      return true;
    }
  }
  return false;
}

function getAllActiveSessions() {
  const all = [];
  try {
    const slugs = fs.readdirSync(STATE_DIR).filter(f => {
      try { return fs.statSync(path.join(STATE_DIR, f)).isDirectory(); } catch { return false; }
    });
    for (const slug of slugs) {
      const sessions = listSessions(slug);
      all.push(...sessions.filter(s => s.status === "active"));
    }
  } catch {}
  return all;
}

// SSE connections per session
const sseClients = new Map();

function broadcastSessionUpdate(sessionId, event, data) {
  const clients = sseClients.get(sessionId) || [];
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch {}
  });
}

// Inbox handoff task tracking
const inboxSnapshots = new Map();
const inboxSseClients = [];

function broadcastInboxUpdate(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  inboxSseClients.forEach(res => {
    try { res.write(payload); } catch {}
  });
}

function pollInbox() {
  if (inboxSseClients.length === 0) return;
  if (!fs.existsSync(INBOX_DIR)) return;

  const files = fs.readdirSync(INBOX_DIR).filter(f => f.endsWith(".json"));
  const currentIds = new Set();

  for (const file of files) {
    try {
      const task = JSON.parse(fs.readFileSync(path.join(INBOX_DIR, file), "utf-8"));
      currentIds.add(task.id);
      const prev = inboxSnapshots.get(task.id);

      if (!prev) {
        // New task
        broadcastInboxUpdate("inbox_new", task);
        inboxSnapshots.set(task.id, { status: task.status, logLength: task.execution_log?.length || 0 });
      } else if (prev.status !== task.status) {
        // Status changed
        broadcastInboxUpdate("inbox_status", { id: task.id, status: task.status, project: task.project, topic: task.topic });
        inboxSnapshots.set(task.id, { status: task.status, logLength: task.execution_log?.length || 0 });
      } else if ((task.execution_log?.length || 0) > prev.logLength) {
        // New log entries
        const newEntries = task.execution_log.slice(prev.logLength);
        broadcastInboxUpdate("inbox_log", { id: task.id, entries: newEntries });
        inboxSnapshots.set(task.id, { status: task.status, logLength: task.execution_log.length });
      }
    } catch {}
  }

  // Detect removed tasks
  for (const [id] of inboxSnapshots) {
    if (!currentIds.has(id)) {
      broadcastInboxUpdate("inbox_removed", { id });
      inboxSnapshots.delete(id);
    }
  }
}

// Poll for session changes
const sessionSnapshots = new Map();
function pollSessions() {
  for (const [sessionId, clients] of sseClients.entries()) {
    if (clients.length === 0) continue;
    const session = findSession(sessionId);
    if (!session) continue;
    const prev = sessionSnapshots.get(sessionId);
    const currentLogLen = session.log?.length || 0;
    const prevLogLen = prev?.logLength || 0;

    if (currentLogLen > prevLogLen) {
      // New log entries
      const newEntries = session.log.slice(prevLogLen);
      for (const entry of newEntries) {
        broadcastSessionUpdate(sessionId, "turn", entry);
      }
    }

    if (prev?.status !== session.status) {
      broadcastSessionUpdate(sessionId, "status", {
        status: session.status,
        current_speaker: session.current_speaker,
        current_round: session.current_round,
      });
    }

    sessionSnapshots.set(sessionId, {
      logLength: currentLogLen,
      status: session.status,
    });
  }
}

// HTML dashboard
function getDashboardHtml() {
  const htmlPath = path.join(__dirname, "public", "index.html");
  try {
    return fs.readFileSync(htmlPath, "utf-8");
  } catch {
    return `<!DOCTYPE html><html><body><h1>Dashboard file not found</h1><p>Expected: ${htmlPath}</p></body></html>`;
  }
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function checkCliInstalled(name) {
  try {
    execSync(`which ${name}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function fetchCdpTargets() {
  return new Promise((resolve) => {
    const req = http.get("http://localhost:9222/json", (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const targets = JSON.parse(data);
          const llmPatterns = /claude|chatgpt|openai|gemini|bard|copilot|perplexity|deepseek|qwen/i;
          const llmTabs = targets
            .filter(t => t.type === "page" && (llmPatterns.test(t.url) || llmPatterns.test(t.title)))
            .map(t => ({ title: t.title, url: t.url, id: t.id }));
          resolve({ cdp_available: true, tabs: llmTabs });
        } catch { resolve({ cdp_available: true, tabs: [] }); }
      });
    });
    req.on("error", () => resolve({ cdp_available: false, tabs: [], message: "CDP not available. Launch Chrome with --remote-debugging-port=9222" }));
    req.setTimeout(2000, () => { req.destroy(); resolve({ cdp_available: false, tabs: [], message: "CDP connection timeout" }); });
  });
}

function createSession(topic, speakers, maxRounds) {
  const id = `obs-${Date.now().toString(36)}`;
  const projectSlug = getProjectSlug();
  const sessionsDir = path.join(STATE_DIR, projectSlug, "sessions");

  fs.mkdirSync(sessionsDir, { recursive: true });

  const session = {
    id,
    topic: topic || "Untitled Discussion",
    speakers: speakers || ["claude", "gemini"],
    status: "active",
    current_round: 1,
    max_rounds: maxRounds || 3,
    current_speaker: speakers?.[0] || "claude",
    ordering_strategy: "cyclic",
    log: [],
    created_at: new Date().toISOString(),
    created_by: "observer",
  };

  fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(session, null, 2));
  return session;
}

function computeStats() {
  const stats = {
    total_sessions: 0,
    total_turns: 0,
    speakers: {},
  };

  try {
    const slugs = fs.readdirSync(STATE_DIR).filter(f => {
      try { return fs.statSync(path.join(STATE_DIR, f)).isDirectory(); } catch { return false; }
    });

    for (const slug of slugs) {
      const sessionsDir = path.join(STATE_DIR, slug, "sessions");
      let files;
      try { files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".json")); } catch { continue; }

      for (const file of files) {
        try {
          const session = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), "utf-8"));
          stats.total_sessions++;

          for (const entry of (session.log || [])) {
            stats.total_turns++;
            const sp = entry.speaker;
            if (!sp) continue;

            if (!stats.speakers[sp]) {
              stats.speakers[sp] = { turns: 0, votes: { agree: 0, disagree: 0, conditional: 0 }, total_length: 0 };
            }
            stats.speakers[sp].turns++;
            stats.speakers[sp].total_length += (entry.content || "").length;

            for (const v of (entry.votes || [])) {
              const key = v.toLowerCase();
              if (key in stats.speakers[sp].votes) stats.speakers[sp].votes[key]++;
            }
          }
        } catch { continue; }
      }
    }

    for (const sp of Object.keys(stats.speakers)) {
      const s = stats.speakers[sp];
      s.avg_length = s.turns > 0 ? Math.round(s.total_length / s.turns) : 0;
      delete s.total_length;
    }
  } catch {}

  return stats;
}

// HTTP Server
function createServer(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;

    // CORS
    const origin = req.headers.origin || "";
    // Allow all origins for Tailscale use cases, or restrict if needed.
    // For now, allow all to ensure Tailscale cross-machine injection works easily.
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    // OPTIONS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Routes
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHtml());
      return;
    }

    if (pathname === "/api/sessions") {
      const sessions = getAllActiveSessions();
      const summary = sessions.map(s => ({
        id: s.id,
        topic: s.topic,
        status: s.status,
        current_round: s.current_round,
        max_rounds: s.max_rounds,
        current_speaker: s.current_speaker,
        speakers: s.speakers,
        log_count: s.log?.length || 0,
        created: s.created,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(summary));
      return;
    }

    if (pathname === "/api/sessions/start" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        if (!parsed.topic) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "topic is required" }));
          return;
        }
        try {
          const session = createSession(parsed.topic, parsed.speakers, parsed.max_rounds);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify(session));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      if (req.method === "POST" && pathname.endsWith("/context")) {
        // POST /api/sessions/:id/context
        const sessionId = pathname.match(/^\/api\/sessions\/([^/]+)\/context$/)?.[1];
        if (!sessionId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid session ID" }));
          return;
        }
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          const session = findSession(sessionId);
          if (!session) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          let parsed;
          try { parsed = JSON.parse(body); } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }
          if (!parsed.context) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "context field is required" }));
            return;
          }
          
          session.log.push({
            round: session.current_round,
            speaker: parsed.speaker || "system",
            content: `[Context Injection]\n${parsed.context}`,
            timestamp: new Date().toISOString(),
            event: "context_injection"
          });
          
          saveSession(session);
          
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, message: `Context injected into ${sessionId}` }));
        });
        return;
      }

      if (req.method === "GET") {
        const session = findSession(sessionMatch[1]);
        if (!session) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(session));
        return;
      }
    }

    const streamMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
    if (streamMatch) {
      const sessionId = streamMatch[1];
      const session = findSession(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      // SSE setup
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ session_id: sessionId })}\n\n`);

      // Send current state
      res.write(`event: snapshot\ndata: ${JSON.stringify({
        status: session.status,
        current_speaker: session.current_speaker,
        current_round: session.current_round,
        max_rounds: session.max_rounds,
        speakers: session.speakers,
        log: session.log,
      })}\n\n`);

      // Register client
      if (!sseClients.has(sessionId)) sseClients.set(sessionId, []);
      sseClients.get(sessionId).push(res);
      sessionSnapshots.set(sessionId, {
        logLength: session.log?.length || 0,
        status: session.status,
      });

      req.on("close", () => {
        const clients = sseClients.get(sessionId) || [];
        const remaining = clients.filter(c => c !== res);
        if (remaining.length === 0) {
          sseClients.delete(sessionId);
          sessionSnapshots.delete(sessionId);
        } else {
          sseClients.set(sessionId, remaining);
        }
      });
      return;
    }

    if (pathname === "/api/config" && req.method === "GET") {
      const config = loadConfig();
      const enabledClis = Array.isArray(config.enabled_clis) ? config.enabled_clis : [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        mode: enabledClis.length === 0 ? "auto-detect" : "config",
        enabled_clis: enabledClis,
        all_clis: DEFAULT_CLI_CANDIDATES,
        updated: config.updated || null,
      }));
      return;
    }

    if (pathname === "/api/config" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const enabledClis = Array.isArray(parsed.enabled_clis) ? parsed.enabled_clis : [];
        const config = {
          enabled_clis: enabledClis,
          updated: new Date().toISOString(),
        };
        saveConfig(config);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          mode: enabledClis.length === 0 ? "auto-detect" : "config",
          enabled_clis: enabledClis,
          all_clis: DEFAULT_CLI_CANDIDATES,
          updated: config.updated,
        }));
      });
      return;
    }

    if (pathname === "/api/cli-status" && req.method === "GET") {
      const clis = DEFAULT_CLI_CANDIDATES.map(name => ({
        name,
        label: CLI_LABELS[name] || name,
        installed: checkCliInstalled(name),
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clis }));
      return;
    }

    if (pathname === "/api/browser-tabs" && req.method === "GET") {
      (async () => {
        const tabs = await fetchCdpTargets();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tabs));
      })().catch(err => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      });
      return;
    }

    if (pathname === "/api/stats" && req.method === "GET") {
      const stats = computeStats();
      stats.inbox_pending = fs.existsSync(INBOX_DIR) ? fs.readdirSync(INBOX_DIR).filter(f => f.endsWith(".json")).length : 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stats));
      return;
    }

    if (pathname === "/api/inbox" && req.method === "GET") {
      if (!fs.existsSync(INBOX_DIR)) return res.end(JSON.stringify([]));
      const tasks = fs.readdirSync(INBOX_DIR)
        .filter(f => f.endsWith(".json"))
        .map(f => {
          try { return JSON.parse(fs.readFileSync(path.join(INBOX_DIR, f), "utf-8")); }
          catch { return null; }
        })
        .filter(Boolean);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(tasks));
      return;
    }

    if (pathname === "/api/inbox/stream" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ type: "inbox" })}\n\n`);

      // Send current inbox snapshot
      if (fs.existsSync(INBOX_DIR)) {
        const tasks = fs.readdirSync(INBOX_DIR)
          .filter(f => f.endsWith(".json"))
          .map(f => { try { return JSON.parse(fs.readFileSync(path.join(INBOX_DIR, f), "utf-8")); } catch { return null; } })
          .filter(Boolean);
        res.write(`event: snapshot\ndata: ${JSON.stringify(tasks)}\n\n`);
      }

      inboxSseClients.push(res);
      req.on("close", () => {
        const idx = inboxSseClients.indexOf(res);
        if (idx >= 0) inboxSseClients.splice(idx, 1);
        if (inboxSseClients.length === 0) inboxSnapshots.clear();
      });
      return;
    }

    const inboxIdMatch = pathname.match(/^\/api\/inbox\/([^/]+)$/);
    if (inboxIdMatch && req.method === "GET") {
      const safeId = String(inboxIdMatch[1]).replace(/[^a-zA-Z0-9._-]/g, "_");
      const file = path.join(INBOX_DIR, `${safeId}.json`);
      if (!fs.existsSync(file)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Task not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(fs.readFileSync(file, "utf-8"));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return server;
}

// Main
const port = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") || DEFAULT_PORT);
const server = createServer(port);

// Poll every 1 second
const pollInterval = setInterval(pollSessions, 1000);
setInterval(pollInbox, 2000);

server.listen(port, DEFAULT_HOST, () => {
  console.log(`Deliberation Observer running at http://${DEFAULT_HOST === "0.0.0.0" ? "localhost" : DEFAULT_HOST}:${port}`);
  console.log(`   Dashboard: http://localhost:${port}/`);
  console.log(`   API: http://localhost:${port}/api/sessions`);
  console.log(`   SSE: http://localhost:${port}/api/sessions/{id}/stream`);
  console.log(`   Tailscale: http://<your-tailscale-ip>:${port}/`);
  console.log(`\n   Press Ctrl+C to stop.`);
});

process.on("SIGINT", () => {
  clearInterval(pollInterval);
  server.close();
  process.exit(0);
});
