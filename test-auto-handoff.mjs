#!/usr/bin/env node
// test-auto-handoff.mjs — E2E test for the auto-handoff orchestrator
// Tests that deliberation_start(auto_execute: true) drives the full pipeline:
// auto CLI turns → auto synthesis → telepty event emission.
// Inbox creation is now handled by dustcraw, not deliberation.

import { spawn, execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const RUNTIME_LOG = join(homedir(), '.local', 'lib', 'mcp-deliberation', 'runtime.log');
const SESSION_ID = `auto-e2e-${Date.now()}`;

// MCP JSON-RPC client
const server = spawn('node', ['index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DELIBERATION_MODE: 'stdio' },
});

let buf = '';
const responses = new Map();

server.stdout.on('data', d => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.set(msg.id, msg);
    } catch {}
  }
});
server.stderr.on('data', () => {});

function send(id, method, params) {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}

function waitFor(id, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (responses.has(id)) { clearInterval(check); resolve(responses.get(id)); }
    }, 100);
    setTimeout(() => { clearInterval(check); reject(new Error(`timeout id=${id}`)); }, timeout);
  });
}

function getText(resp) {
  return resp?.result?.content?.map(c => c.text).join('') || resp?.error?.message || '(no text)';
}

// Watch runtime.log for orchestrator progress
function tailLog(prefix) {
  let lastSize = 0;
  try { lastSize = readFileSync(RUNTIME_LOG, 'utf-8').length; } catch {}

  return setInterval(() => {
    try {
      const content = readFileSync(RUNTIME_LOG, 'utf-8');
      const newContent = content.slice(lastSize);
      lastSize = content.length;
      if (newContent) {
        const lines = newContent.split('\n').filter(l => l.includes('AUTO_HANDOFF'));
        for (const line of lines) {
          console.log(`  ${prefix} ${line.trim()}`);
        }
      }
    } catch {}
  }, 500);
}

// Wait for a specific log entry to appear in runtime.log
function waitForLogEntry(pattern, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      try {
        const log = readFileSync(RUNTIME_LOG, 'utf-8');
        if (log.includes(pattern)) {
          clearInterval(check);
          clearTimeout(timer);
          resolve(log);
        }
      } catch {}
    }, 1000);

    const timer = setTimeout(() => {
      clearInterval(check);
      reject(new Error(`Log entry "${pattern}" not found within ${timeoutMs/1000}s`));
    }, timeoutMs);
  });
}

const results = [];
function assert(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
  console.log(`  ${condition ? '\u2705' : '\u274C'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
}

(async () => {
  console.log('\n\u2501\u2501\u2501 Auto-Handoff Orchestrator E2E Test \u2501\u2501\u2501\n');

  // Check available speakers
  const hasClaude = (() => { try { execSync('which claude', { stdio: 'ignore' }); return true; } catch { return false; } })();
  const hasCodex = (() => { try { execSync('which codex', { stdio: 'ignore' }); return true; } catch { return false; } })();
  const hasGemini = (() => { try { execSync('which gemini', { stdio: 'ignore' }); return true; } catch { return false; } })();

  console.log(`  Available CLIs: claude=${hasClaude} codex=${hasCodex} gemini=${hasGemini}\n`);

  const speakers = [];
  if (hasClaude) speakers.push('claude');
  if (hasCodex) speakers.push('codex');
  if (hasGemini) speakers.push('gemini');

  if (speakers.length < 2) {
    console.log('  \u26A0\uFE0F Need at least 2 CLI speakers for full test. Running partial test.\n');
    if (speakers.length === 1) speakers.push(speakers[0]);
    if (speakers.length === 0) {
      console.log('  \u274C No CLI speakers available. Cannot run auto-handoff test.\n');
      server.kill();
      process.exit(1);
    }
  }

  // Initialize MCP
  send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
  await waitFor(1);
  send(2, 'notifications/initialized', {});
  await new Promise(r => setTimeout(r, 500));

  // Start log tail
  const logTail = tailLog('\uD83D\uDCDD');

  // Step 1: Start deliberation with auto_execute
  console.log('\uD83D\uDCCC Step 1: deliberation_start(auto_execute: true, 1 round)\n');
  send(10, 'tools/call', {
    name: 'deliberation_start',
    arguments: {
      topic: 'Auto-E2E: Should we add a health-check endpoint to the API?',
      session_id: SESSION_ID,
      rounds: 1,
      speakers: speakers.slice(0, 2),
      auto_execute: true,
      require_manual_speakers: false,
      auto_discover_speakers: false,
    }
  });

  const r1 = await waitFor(10, 20000);
  const t1 = getText(r1);
  assert('Deliberation started', t1.includes('Deliberation started'), SESSION_ID);
  assert('auto_execute acknowledged', t1.includes('auto_execute') || r1.result !== undefined);

  console.log(`\n  Speakers: ${speakers.slice(0, 2).join(', ')}`);
  console.log('  Orchestrator running in background...\n');

  // Step 2: Wait for orchestrator to complete via runtime log
  console.log('\uD83D\uDCCC Step 2: Waiting for orchestrator to complete (max 5 min)\n');

  try {
    const log = await waitForLogEntry(`AUTO_HANDOFF_COMPLETE: ${SESSION_ID}`, 300000);

    clearInterval(logTail);
    console.log('');

    // Verify all log entries
    assert('Log has AUTO_HANDOFF_START', log.includes(`AUTO_HANDOFF_START: ${SESSION_ID}`));
    assert('Log has AUTO_HANDOFF_SYNTHESIZE', log.includes(`AUTO_HANDOFF_SYNTHESIZE: ${SESSION_ID}`));
    assert('Log has AUTO_HANDOFF_COMPLETE', log.includes(`AUTO_HANDOFF_COMPLETE: ${SESSION_ID}`));

    // Check for synthesis in log
    const hasNotified = log.includes(`AUTO_HANDOFF_NOTIFIED: ${SESSION_ID}`);
    assert('Telepty notification sent', hasNotified);

    // Check for turn completions
    const turnOkPattern = new RegExp(`AUTO_HANDOFF_TURN_OK: ${SESSION_ID}`, 'g');
    const turnOkCount = (log.match(turnOkPattern) || []).length;
    assert('All turns completed', turnOkCount >= 2, `${turnOkCount} turns`);

    // Check synthesis was generated (not fallback)
    const hasSynthesized = log.includes(`AUTO_HANDOFF_SYNTHESIZED: ${SESSION_ID}`);
    const hasFallback = log.includes(`AUTO_HANDOFF_SYNTH_FALLBACK: ${SESSION_ID}`);
    assert('Synthesis generated', hasSynthesized, hasFallback ? 'used fallback' : 'primary synthesis');

  } catch (err) {
    clearInterval(logTail);
    console.log(`\n  \u274C ${err.message}\n`);

    // Check runtime log for clues
    try {
      const log = readFileSync(RUNTIME_LOG, 'utf-8');
      const handoffLines = log.split('\n').filter(l => l.includes(SESSION_ID));
      if (handoffLines.length > 0) {
        console.log('  Runtime log entries for this session:');
        handoffLines.slice(-10).forEach(l => console.log(`    ${l.trim()}`));
      }
    } catch {}

    assert('Auto-handoff completed', false, err.message);
  }

  // Summary
  console.log('\n\u2501\u2501\u2501 Summary \u2501\u2501\u2501\n');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`  Total: ${results.length} | \u2705 Passed: ${passed} | \u274C Failed: ${failed}\n`);

  if (failed > 0) {
    console.log('  Failed:');
    results.filter(r => !r.pass).forEach(r => console.log(`    \u274C ${r.name}: ${r.detail}`));
  }

  server.kill();
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  console.error('Fatal:', e);
  server.kill();
  process.exit(1);
});
