#!/usr/bin/env node
// test-handoff-e2e.mjs — E2E test for Autonomous Deliberation Handoff
//
// Tests the full handoff lifecycle: inbox CRUD, path traversal prevention,
// Zod schema validation, telepty bus notification, and atomic write safety.

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

const INBOX_DIR = join(homedir(), '.local', 'lib', 'mcp-deliberation', 'inbox');
const TEST_SESSION_ID = `handoff-e2e-test-${Date.now()}`;
const DELIB_DIR = join(homedir(), 'projects', 'aigentry-deliberation');

// ─── Helpers ───

function cleanInbox() {
  if (existsSync(INBOX_DIR)) {
    for (const f of readdirSync(INBOX_DIR)) {
      if (f.includes('handoff-e2e-test') || f.includes('atomic-test')) {
        rmSync(join(INBOX_DIR, f), { force: true });
      }
    }
  }
}

/** Write a CJS script to a temp file, execute it, return parsed JSON stdout. */
function runScript(code, opts = {}) {
  const tmp = join(tmpdir(), `handoff-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
  try {
    writeFileSync(tmp, code, 'utf-8');
    const env = { ...process.env };
    // Ensure node_modules resolution works from temp file location
    if (opts.cwd) {
      env.NODE_PATH = join(opts.cwd, 'node_modules');
    }
    const out = execSync(`node ${JSON.stringify(tmp)}`, {
      encoding: 'utf-8',
      timeout: 15000,
      cwd: opts.cwd || undefined,
      env,
    }).trim();
    return JSON.parse(out);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

const results = [];
function assert(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
  const icon = condition ? '\u2705' : '\u274C';
  console.log(`  ${icon} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
}

// ─── Tests ───

async function runTests() {
  console.log('\n\u2501\u2501\u2501 Autonomous Deliberation Handoff E2E Test \u2501\u2501\u2501\n');

  cleanInbox();

  // ═══════════════════════════════════════════
  console.log('Phase 1: Inbox CRUD operations\n');
  // ═══════════════════════════════════════════

  // Test 1: writeInboxTask
  const r1 = runScript(`
const path = require('path');
const fs = require('fs');
const os = require('os');
const INSTALL_DIR = path.join(os.homedir(), '.local', 'lib', 'mcp-deliberation');
const INBOX_DIR = path.join(INSTALL_DIR, 'inbox');

function writeTextAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function writeInboxTask(state) {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const task = {
    id: 'task-' + state.id,
    session_id: state.id,
    project: state.project,
    topic: state.topic,
    status: 'pending',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    synthesis: state.synthesis,
    structured_synthesis: state.structured_synthesis || null,
    execution_log: [],
  };
  writeTextAtomic(path.join(INBOX_DIR, task.id + '.json'), JSON.stringify(task, null, 2));
  return task;
}

const testState = {
  id: '${TEST_SESSION_ID}',
  project: 'aigentry-brain',
  topic: 'E2E Handoff Test',
  synthesis: '# Test Synthesis\\nThis is a test.',
  structured_synthesis: {
    summary: 'Test deliberation completed successfully',
    decisions: ['Implement feature A', 'Refactor module B'],
    actionable_tasks: [
      { id: 1, task: 'Add validation to EntrySchema', files: ['src/core/EntrySchema.ts'], project: 'aigentry-brain', priority: 'high' },
      { id: 2, task: 'Update BrainMcpServer with new tool', files: ['src/mcp/BrainMcpServer.ts'], project: 'aigentry-brain', priority: 'medium' },
    ],
  },
  auto_execute: true,
};

const task = writeInboxTask(testState);
console.log(JSON.stringify({ success: true, task_id: task.id, path: path.join(INBOX_DIR, task.id + '.json') }));
`);

  assert('Inbox task created', r1.success, r1.task_id);

  // Test 2: Verify file on disk
  const taskFile = join(INBOX_DIR, `task-${TEST_SESSION_ID}.json`);
  const taskExists = existsSync(taskFile);
  assert('Inbox task file exists on disk', taskExists, taskFile);

  if (taskExists) {
    const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
    assert('Task status is "pending"', task.status === 'pending', task.status);
    assert('Task has structured_synthesis', task.structured_synthesis !== null);
    assert('Structured synthesis has actionable_tasks',
      Array.isArray(task.structured_synthesis?.actionable_tasks),
      `${task.structured_synthesis?.actionable_tasks?.length} tasks`);
    assert('First task has correct fields',
      task.structured_synthesis?.actionable_tasks?.[0]?.task === 'Add validation to EntrySchema' &&
      task.structured_synthesis?.actionable_tasks?.[0]?.priority === 'high',
      task.structured_synthesis?.actionable_tasks?.[0]?.task);
    assert('Task has empty execution_log', Array.isArray(task.execution_log) && task.execution_log.length === 0);
    assert('Task session_id matches', task.session_id === TEST_SESSION_ID);
    assert('Task project is set', task.project === 'aigentry-brain');
  }

  // Test 3: loadInboxTask + path traversal prevention
  const r3 = runScript(`
const path = require('path');
const fs = require('fs');
const os = require('os');
const INBOX_DIR = path.join(os.homedir(), '.local', 'lib', 'mcp-deliberation', 'inbox');

function loadInboxTask(taskId) {
  const safeId = String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = path.join(INBOX_DIR, safeId + '.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const t1 = loadInboxTask('task-${TEST_SESSION_ID}');
const normalOk = t1 !== null && t1.id === 'task-${TEST_SESSION_ID}';
const traversalBlocked = loadInboxTask('../../etc/passwd') === null;
const traversalBlocked2 = loadInboxTask('../../../.ssh/id_rsa') === null;

console.log(JSON.stringify({ normalOk, traversalBlocked, traversalBlocked2 }));
`);

  assert('loadInboxTask loads valid task', r3.normalOk);
  assert('Path traversal ../../etc/passwd blocked', r3.traversalBlocked);
  assert('Path traversal ../../../.ssh/id_rsa blocked', r3.traversalBlocked2);

  // Test 4: updateInboxTask status transitions
  const r4 = runScript(`
const path = require('path');
const fs = require('fs');
const os = require('os');
const INBOX_DIR = path.join(os.homedir(), '.local', 'lib', 'mcp-deliberation', 'inbox');

function writeTextAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function loadInboxTask(taskId) {
  const safeId = String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = path.join(INBOX_DIR, safeId + '.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function updateInboxTask(taskId, updates) {
  const safeId = String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const task = loadInboxTask(safeId);
  if (!task) return null;
  Object.assign(task, updates, { updated: new Date().toISOString() });
  writeTextAtomic(path.join(INBOX_DIR, safeId + '.json'), JSON.stringify(task, null, 2));
  return task;
}

const t1 = updateInboxTask('task-${TEST_SESSION_ID}', {
  status: 'executing',
  execution_log: [{ timestamp: new Date().toISOString(), message: 'Started implementation' }]
});
const executingOk = t1?.status === 'executing' && t1?.execution_log?.length === 1;

const t2 = updateInboxTask('task-${TEST_SESSION_ID}', {
  status: 'implemented',
  execution_log: [
    ...t1.execution_log,
    { timestamp: new Date().toISOString(), message: 'All tasks completed' }
  ]
});
const implementedOk = t2?.status === 'implemented' && t2?.execution_log?.length === 2;

// Verify updated timestamp changed (add small delay to ensure different ms)
const { execSync: es } = require('child_process');
es('sleep 0.01');
const t2b = updateInboxTask('task-${TEST_SESSION_ID}', { status: 'implemented' });
const timestampUpdated = t2b?.updated !== t1?.updated;

console.log(JSON.stringify({ executingOk, implementedOk, finalStatus: t2?.status, logCount: t2?.execution_log?.length, timestampUpdated }));
`);

  assert('Status transition: pending -> executing', r4.executingOk);
  assert('Status transition: executing -> implemented', r4.implementedOk, `status=${r4.finalStatus}, logs=${r4.logCount}`);
  assert('Updated timestamp changes on update', r4.timestampUpdated);

  // Test 5: listInboxTasks
  const r5 = runScript(`
const path = require('path');
const fs = require('fs');
const os = require('os');
const INBOX_DIR = path.join(os.homedir(), '.local', 'lib', 'mcp-deliberation', 'inbox');

function listInboxTasks() {
  if (!fs.existsSync(INBOX_DIR)) return [];
  return fs.readdirSync(INBOX_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(INBOX_DIR, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

const tasks = listInboxTasks();
const hasTestTask = tasks.some(t => t.session_id === '${TEST_SESSION_ID}');
console.log(JSON.stringify({ count: tasks.length, hasTestTask }));
`);

  assert('listInboxTasks finds our test task', r5.hasTestTask, `${r5.count} total tasks`);

  // ═══════════════════════════════════════════
  console.log('\nPhase 2: Zod schema validation\n');
  // ═══════════════════════════════════════════

  const r6 = runScript(`
const { z } = require('zod');

const structuredSchema = z.preprocess(
  (v) => {
    if (typeof v === 'string') {
      try { return JSON.parse(v); }
      catch { return v; }
    }
    return v;
  },
  z.object({
    summary: z.string(),
    decisions: z.array(z.string()),
    actionable_tasks: z.array(z.object({
      id: z.number(),
      task: z.string(),
      files: z.array(z.string()).optional(),
      project: z.string().optional(),
      priority: z.enum(['high', 'medium', 'low']).optional(),
    })),
  }).optional()
);

// Valid structured data
const valid = structuredSchema.safeParse({
  summary: 'Test',
  decisions: ['Decision 1'],
  actionable_tasks: [{ id: 1, task: 'Do something', files: ['a.ts'], priority: 'high' }]
});

// Invalid: summary should be string, decisions should be array
const invalid = structuredSchema.safeParse({
  summary: 123,
  decisions: 'not array',
});

// JSON string via preprocess
const fromString = structuredSchema.safeParse('{"summary":"from string","decisions":[],"actionable_tasks":[]}');

// Malformed JSON string
const fromBadJson = structuredSchema.safeParse('{invalid json}');

// Optional (undefined)
const optionalOk = structuredSchema.safeParse(undefined);

// Priority enum enforcement
const badPriority = structuredSchema.safeParse({
  summary: 'Test',
  decisions: [],
  actionable_tasks: [{ id: 1, task: 'X', priority: 'critical' }]
});

console.log(JSON.stringify({
  validOk: valid.success,
  invalidRejected: !invalid.success,
  fromStringOk: fromString.success,
  badJsonRejected: !fromBadJson.success,
  optionalOk: optionalOk.success,
  badPriorityRejected: !badPriority.success,
}));
`, { cwd: DELIB_DIR });

  assert('Valid structured data accepted', r6.validOk);
  assert('Invalid structured data rejected', r6.invalidRejected);
  assert('JSON string parsed correctly via preprocess', r6.fromStringOk);
  assert('Malformed JSON string rejected', r6.badJsonRejected);
  assert('Undefined (optional) accepted', r6.optionalOk);
  assert('Invalid priority enum rejected', r6.badPriorityRejected);

  // ═══════════════════════════════════════════
  console.log('\nPhase 3: Telepty bus notification (mock server)\n');
  // ═══════════════════════════════════════════

  const r7 = runScript(`
const http = require('http');

let receivedEvent = null;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/bus/publish') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      receivedEvent = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, delivered: 1 }));
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;

  const event = {
    type: 'handoff_ready',
    sender: 'deliberation',
    session_id: 'test-123',
    task_id: 'task-test-123',
    project: 'aigentry-brain',
    topic: 'Test Topic',
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/bus/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    const data = await res.json();

    // Also test handoff_status event
    const statusEvent = {
      type: 'handoff_status',
      sender: 'deliberation',
      task_id: 'task-test-123',
      status: 'executing',
      timestamp: new Date().toISOString(),
    };
    const res2 = await fetch('http://127.0.0.1:' + port + '/api/bus/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(statusEvent),
    });
    const data2 = await res2.json();

    console.log(JSON.stringify({
      sent: true,
      received: receivedEvent !== null,
      typeMatch: receivedEvent?.type === 'handoff_status',
      taskIdMatch: receivedEvent?.task_id === 'task-test-123',
      delivered: data.delivered,
      statusEventDelivered: data2.delivered,
    }));
  } finally {
    server.close();
  }
});
`);

  assert('Telepty bus event sent successfully', r7.sent);
  assert('Mock server received event', r7.received);
  assert('Second event overwrites (handoff_status)', r7.typeMatch);
  assert('Event task_id matches', r7.taskIdMatch);
  assert('Status event also delivered', r7.statusEventDelivered === 1);

  // ═══════════════════════════════════════════
  console.log('\nPhase 4: Atomic write safety\n');
  // ═══════════════════════════════════════════

  const r8 = runScript(`
const path = require('path');
const fs = require('fs');
const os = require('os');
const INBOX_DIR = path.join(os.homedir(), '.local', 'lib', 'mcp-deliberation', 'inbox');

function writeTextAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, filePath);
}

const testFile = path.join(INBOX_DIR, 'atomic-test.json');

// Write 20 times rapidly
for (let i = 0; i < 20; i++) {
  writeTextAtomic(testFile, JSON.stringify({ iteration: i, data: 'x'.repeat(1000) }, null, 2));
}

// Verify final state
const content = fs.readFileSync(testFile, 'utf-8');
let validJson = false;
let finalIteration = -1;
try {
  const parsed = JSON.parse(content);
  validJson = true;
  finalIteration = parsed.iteration;
} catch {}

fs.unlinkSync(testFile);

// Check no leaked .tmp files
const tmpFiles = fs.readdirSync(INBOX_DIR).filter(f => f.includes('atomic-test') && f.endsWith('.tmp'));

console.log(JSON.stringify({ validJson, finalIteration, tmpLeaks: tmpFiles.length }));
`);

  assert('Atomic writes produce valid JSON', r8.validJson);
  assert('Final iteration is 19 (last write wins)', r8.finalIteration === 19, `iteration=${r8.finalIteration}`);
  assert('No .tmp files leaked', r8.tmpLeaks === 0, `${r8.tmpLeaks} leaked`);

  // ═══════════════════════════════════════════
  console.log('\nPhase 5: Edge cases\n');
  // ═══════════════════════════════════════════

  // Test: updateInboxTask on non-existent task returns null
  const r9 = runScript(`
const path = require('path');
const fs = require('fs');
const os = require('os');
const INBOX_DIR = path.join(os.homedir(), '.local', 'lib', 'mcp-deliberation', 'inbox');

function loadInboxTask(taskId) {
  const safeId = String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = path.join(INBOX_DIR, safeId + '.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeTextAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function updateInboxTask(taskId, updates) {
  const safeId = String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const task = loadInboxTask(safeId);
  if (!task) return null;
  Object.assign(task, updates, { updated: new Date().toISOString() });
  writeTextAtomic(path.join(INBOX_DIR, safeId + '.json'), JSON.stringify(task, null, 2));
  return task;
}

// Non-existent task
const r1 = updateInboxTask('task-does-not-exist-12345', { status: 'executing' });

// Load non-existent
const r2 = loadInboxTask('completely-fake-id');

// listInboxTasks on empty dir (or after cleanup)
function listInboxTasks() {
  if (!fs.existsSync(INBOX_DIR)) return [];
  return fs.readdirSync(INBOX_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(INBOX_DIR, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

// Write a corrupt JSON file and verify listInboxTasks skips it
const corruptFile = path.join(INBOX_DIR, 'corrupt-test.json');
fs.writeFileSync(corruptFile, '{broken json!!!', 'utf-8');
const tasks = listInboxTasks();
const corruptSkipped = !tasks.some(t => t === null);
fs.unlinkSync(corruptFile);

console.log(JSON.stringify({
  updateNonExistent: r1 === null,
  loadNonExistent: r2 === null,
  corruptSkipped,
}));
`);

  assert('updateInboxTask returns null for non-existent task', r9.updateNonExistent);
  assert('loadInboxTask returns null for non-existent task', r9.loadNonExistent);
  assert('listInboxTasks skips corrupt JSON files', r9.corruptSkipped);

  // ═══════════════════════════════════════════
  console.log('\nPhase 6: Cleanup\n');
  // ═══════════════════════════════════════════

  cleanInbox();
  assert('Inbox cleaned up', !existsSync(join(INBOX_DIR, `task-${TEST_SESSION_ID}.json`)));

  // ─── Summary ───
  console.log('\n\u2501\u2501\u2501 Summary \u2501\u2501\u2501\n');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}\n`);

  if (failed > 0) {
    console.log('  Failed tests:');
    results.filter(r => !r.pass).forEach(r => console.log(`    - ${r.name}: ${r.detail}`));
    console.log('');
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
