#!/usr/bin/env node
"use strict";

// Usage: node session-monitor-win.js <sessionId> <project>
const fs = require("fs");
const path = require("path");

const sessionId = process.argv[2];
const project = process.argv[3] || "default";

if (!sessionId) {
  console.error("Usage: node session-monitor-win.js <sessionId> <project>");
  process.exit(1);
}

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const stateDir = path.join(HOME, ".local", "state", "mcp-deliberation", project);
const stateFile = path.join(stateDir, `${sessionId}.json`);

const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

let prevData = "";

function render() {
  let raw;
  try {
    raw = fs.readFileSync(stateFile, "utf-8");
  } catch {
    return; // file not ready yet
  }
  if (raw === prevData) return;
  prevData = raw;

  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return;
  }

  console.clear();
  console.log(`${BOLD}${CYAN}╔═══════════════════════════════════════╗${NC}`);
  console.log(`${BOLD}${CYAN}║     Deliberation Monitor              ║${NC}`);
  console.log(`${BOLD}${CYAN}╚═══════════════════════════════════════╝${NC}`);
  console.log();
  console.log(`${BOLD}Topic:${NC}   ${state.topic || "(none)"}`);
  console.log(`${BOLD}Round:${NC}   ${state.current_round || "?"}/${state.max_rounds || "?"}`);
  console.log(`${BOLD}Speaker:${NC} ${YELLOW}${state.current_speaker || "(waiting)"}${NC}`);
  console.log(`${BOLD}Speakers:${NC} ${(state.speakers || []).join(", ")}`);
  console.log();
  console.log(`${DIM}${"─".repeat(50)}${NC}`);
  console.log();

  const log = Array.isArray(state.log) ? state.log : [];
  const recent = log.slice(-10);
  for (const entry of recent) {
    const speaker = entry.speaker || "unknown";
    const content = String(entry.content || "").slice(0, 300);
    const round = entry.round != null ? ` (R${entry.round})` : "";
    console.log(`${GREEN}[${speaker}]${NC}${DIM}${round}${NC}`);
    console.log(content);
    console.log();
  }

  if (recent.length === 0) {
    console.log(`${DIM}(No messages yet. Waiting for first turn...)${NC}`);
  }

  console.log(`${DIM}${"─".repeat(50)}${NC}`);
  console.log(`${DIM}Auto-refresh every 2s | Session: ${sessionId} | Ctrl+C to close${NC}`);
}

// Initial render
render();

// Poll every 2 seconds
const interval = setInterval(render, 2000);

// Graceful shutdown
process.on("SIGINT", () => {
  clearInterval(interval);
  console.log(`\n${DIM}Monitor closed.${NC}`);
  process.exit(0);
});

process.on("SIGTERM", () => {
  clearInterval(interval);
  process.exit(0);
});
