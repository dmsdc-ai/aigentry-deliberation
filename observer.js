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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(os.homedir(), ".local", "lib", "mcp-deliberation", "state");
const CONFIG_PATH = path.join(os.homedir(), ".local", "lib", "mcp-deliberation", "config.json");
const DEFAULT_CLI_CANDIDATES = ["claude", "codex", "gemini", "qwen", "chatgpt", "aider", "llm", "opencode", "cursor", "continue"];
const DEFAULT_PORT = 3847;

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

// HTTP Server
function createServer(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
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

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
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
        sseClients.set(sessionId, clients.filter(c => c !== res));
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

server.listen(port, () => {
  console.log(`Deliberation Observer running at http://localhost:${port}`);
  console.log(`   Dashboard: http://localhost:${port}/`);
  console.log(`   API: http://localhost:${port}/api/sessions`);
  console.log(`   SSE: http://localhost:${port}/api/sessions/{id}/stream`);
  console.log(`\n   Press Ctrl+C to stop.`);
});

process.on("SIGINT", () => {
  clearInterval(pollInterval);
  server.close();
  process.exit(0);
});
