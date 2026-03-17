#!/usr/bin/env node

/**
 * inbox-watcher.mjs — Watches the deliberation inbox directory and
 * auto-executes pending tasks via Claude Code CLI.
 *
 * Usage:
 *   node inbox-watcher.mjs              # Watch mode (daemon)
 *   node inbox-watcher.mjs --once       # Process pending tasks and exit
 *   node inbox-watcher.mjs --dry-run    # Log actions without spawning claude
 *   node inbox-watcher.mjs --project-root /path/to/projects
 *
 * Environment:
 *   PROJECT_ROOT  — Override default ~/projects base path
 *
 * No external dependencies — uses only Node.js built-in modules.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync, appendFileSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { request } from 'node:http';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INBOX_DIR = join(homedir(), '.local', 'lib', 'mcp-deliberation', 'inbox');
const RUNTIME_LOG = join(homedir(), '.local', 'lib', 'mcp-deliberation', 'runtime.log');
const POLL_INTERVAL_MS = 5_000;
const LOG_PREFIX = 'INBOX_WATCHER:';
const TELEPTY_URL = 'http://localhost:3848/api/events';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {
    once: false,
    dryRun: false,
    projectRoot: process.env.PROJECT_ROOT || join(homedir(), 'projects'),
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--once':
        flags.once = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--project-root':
        if (i + 1 < args.length) {
          flags.projectRoot = resolve(args[++i]);
        } else {
          log('ERROR', '--project-root requires a path argument');
          process.exit(1);
        }
        break;
      default:
        log('WARN', `Unknown argument: ${args[i]}`);
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${LOG_PREFIX} [${level}] ${message}`;
  console.log(line);

  try {
    appendFileSync(RUNTIME_LOG, line + '\n', 'utf-8');
  } catch {
    // runtime.log directory may not exist yet — silently skip
  }
}

// ---------------------------------------------------------------------------
// Task file I/O (atomic writes)
// ---------------------------------------------------------------------------

function readTask(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    log('ERROR', `Failed to read task file ${filePath}: ${err.message}`);
    return null;
  }
}

function writeTaskAtomic(filePath, task) {
  task.updated_at = new Date().toISOString();
  const tmpPath = filePath + '.tmp';
  try {
    writeFileSync(tmpPath, JSON.stringify(task, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    log('ERROR', `Atomic write failed for ${filePath}: ${err.message}`);
    throw err;
  }
}

function updateTaskStatus(filePath, task, status, logMessage) {
  task.status = status;
  if (!Array.isArray(task.execution_log)) {
    task.execution_log = [];
  }
  task.execution_log.push({
    timestamp: new Date().toISOString(),
    event: logMessage,
  });
  writeTaskAtomic(filePath, task);
  log('INFO', `[${task.task_id}] Status → ${status}: ${logMessage}`);
  notifyTelepty(task.task_id, status);
}

// ---------------------------------------------------------------------------
// Telepty notification (fire-and-forget)
// ---------------------------------------------------------------------------

function notifyTelepty(taskId, status) {
  try {
    const payload = JSON.stringify({
      type: 'inbox_status',
      task_id: taskId,
      status,
      timestamp: new Date().toISOString(),
    });

    const url = new URL(TELEPTY_URL);
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 3000,
      },
      () => {
        // Response received — nothing to do
      },
    );

    req.on('error', () => {
      // Telepty unavailable — silently ignore
    });

    req.write(payload);
    req.end();
  } catch {
    // Never fail the main flow because of telepty
  }
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(task) {
  // Prefer execution_contract (automation canonical) over structured_synthesis (human canonical)
  const ec = task.execution_contract;
  const ss = task.structured_synthesis || {};
  const summary = ec?.summary || ss.summary || task.synthesis || '(no summary)';
  const decisions = (ss.decisions || []).map((d) => `- ${d}`).join('\n');
  const taskList = (ec?.tasks || ss.actionable_tasks || [])
    .map((t) => {
      const files = (t.files || []).join(', ');
      return `${t.id}. [${t.priority || 'medium'}] ${t.task}${files ? `  (files: ${files})` : ''}`;
    })
    .join('\n');
  const contractSource = ec ? 'execution_contract' : 'structured_synthesis';

  return [
    '/deliberation-executor',
    '',
    '다음은 deliberation에서 합의된 구현 태스크입니다. 이 태스크들을 실행해주세요.',
    '',
    `## Session: ${task.session_id}`,
    `> Data source: ${contractSource}${ec?.generated_from?.structured_synthesis_hash ? ` (hash: ${ec.generated_from.structured_synthesis_hash.slice(0, 8)})` : ''}`,
    '',
    '## 합의 요약',
    summary,
    '',
    '## 결정사항',
    decisions || '(없음)',
    '',
    '## 실행할 태스크',
    taskList || '(없음)',
    '',
    '모든 태스크를 구현하고, 테스트를 작성하고, 빌드가 통과하는지 확인해주세요.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Task execution (spawns claude CLI)
// ---------------------------------------------------------------------------

/**
 * Executes a single task. Returns a Promise that resolves when the claude
 * process exits. The currently running child process is stored so that
 * SIGINT/SIGTERM handlers can kill it and roll the task back to pending.
 */
let currentChild = null;
let currentTaskFile = null;
let currentTask = null;

function executeTask(filePath, task, flags) {
  return new Promise((resolvePromise) => {
    const projectDir = join(flags.projectRoot, task.project || 'unknown');

    if (!existsSync(projectDir)) {
      updateTaskStatus(filePath, task, 'failed', `Project directory not found: ${projectDir}`);
      resolvePromise(false);
      return;
    }

    const prompt = buildPrompt(task);

    // --- Dry run ---------------------------------------------------------
    if (flags.dryRun) {
      log('DRY-RUN', `Would execute task ${task.task_id} in ${projectDir}`);
      log('DRY-RUN', `Prompt (${prompt.length} chars):\n${prompt.slice(0, 500)}...`);
      updateTaskStatus(filePath, task, 'implemented', 'Dry-run: skipped execution');
      resolvePromise(true);
      return;
    }

    // --- Real execution --------------------------------------------------
    updateTaskStatus(filePath, task, 'executing', 'Inbox watcher picked up task');

    log('INFO', `Spawning claude for task ${task.task_id} in ${projectDir}`);

    const child = spawn('claude', ['--dangerously-skip-permissions', '-p', prompt], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    currentChild = child;
    currentTaskFile = filePath;
    currentTask = task;

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      currentChild = null;
      currentTaskFile = null;
      currentTask = null;
      updateTaskStatus(filePath, task, 'failed', `Spawn error: ${err.message}`);
      resolvePromise(false);
    });

    child.on('close', (code) => {
      currentChild = null;
      currentTaskFile = null;
      currentTask = null;

      if (code === 0) {
        const summary = stdout.slice(-500) || '(no output)';
        updateTaskStatus(filePath, task, 'implemented', `Claude exited 0. Tail output: ${summary}`);
        resolvePromise(true);
      } else {
        const errTail = (stderr || stdout).slice(-500) || '(no output)';
        updateTaskStatus(filePath, task, 'failed', `Claude exited ${code}. Tail: ${errTail}`);
        resolvePromise(false);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Inbox scanning
// ---------------------------------------------------------------------------

function scanInbox() {
  try {
    return readdirSync(INBOX_DIR)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
      .sort(); // process in alphabetical / chronological order
  } catch (err) {
    log('ERROR', `Failed to scan inbox: ${err.message}`);
    return [];
  }
}

function getPendingTasks() {
  const files = scanInbox();
  const pending = [];

  for (const file of files) {
    const filePath = join(INBOX_DIR, file);
    const task = readTask(filePath);
    if (task && task.status === 'pending') {
      pending.push({ filePath, task });
    }
  }

  return pending;
}

// ---------------------------------------------------------------------------
// Serial task queue
// ---------------------------------------------------------------------------

let processing = false;

async function processQueue(flags) {
  if (processing) return;
  processing = true;

  try {
    const pending = getPendingTasks();
    if (pending.length === 0) return;

    log('INFO', `Found ${pending.length} pending task(s)`);

    for (const { filePath, task } of pending) {
      log('INFO', `Processing task ${task.task_id} (project: ${task.project})`);
      await executeTask(filePath, task, flags);
    }
  } finally {
    processing = false;
  }
}

// ---------------------------------------------------------------------------
// Watcher (fs.watch + poll fallback)
// ---------------------------------------------------------------------------

function startWatcher(flags) {
  log('INFO', `Watching inbox: ${INBOX_DIR}`);
  log('INFO', `Project root: ${flags.projectRoot}`);
  log('INFO', `Dry-run: ${flags.dryRun}`);

  // Track known files for change detection
  let knownFiles = new Set(scanInbox());

  // fs.watch — may not fire on all platforms, so we use it as a fast hint
  let watcher;
  try {
    watcher = watch(INBOX_DIR, (eventType, filename) => {
      if (filename && filename.endsWith('.json') && !filename.endsWith('.tmp')) {
        log('DEBUG', `fs.watch event: ${eventType} ${filename}`);
        processQueue(flags);
      }
    });

    watcher.on('error', (err) => {
      log('WARN', `fs.watch error (poll fallback active): ${err.message}`);
    });
  } catch (err) {
    log('WARN', `fs.watch unavailable (${err.message}), relying on poll`);
  }

  // Poll fallback — reliable on all platforms
  const pollTimer = setInterval(() => {
    const currentFiles = new Set(scanInbox());
    const newFiles = [...currentFiles].filter((f) => !knownFiles.has(f));

    if (newFiles.length > 0) {
      log('INFO', `Poll detected ${newFiles.length} new file(s): ${newFiles.join(', ')}`);
    }

    knownFiles = currentFiles;
    processQueue(flags);
  }, POLL_INTERVAL_MS);

  // Initial scan
  processQueue(flags);

  return { watcher, pollTimer };
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupShutdownHandlers() {
  const shutdown = (signal) => {
    log('INFO', `Received ${signal}, shutting down...`);

    if (currentChild) {
      log('INFO', `Killing running claude process (pid ${currentChild.pid})`);
      currentChild.kill('SIGTERM');

      // Roll the task back to pending so it can be retried
      if (currentTaskFile && currentTask) {
        try {
          // Re-read the file to get the latest state (may have been updated by log entries)
          const freshTask = readTask(currentTaskFile);
          if (freshTask) {
            updateTaskStatus(currentTaskFile, freshTask, 'pending', `Rolled back due to ${signal} — will retry`);
          }
        } catch {
          log('WARN', 'Failed to roll back task status');
        }
      }
    }

    // Give a moment for cleanup, then exit
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseArgs(process.argv);

  // Ensure inbox directory exists
  mkdirSync(INBOX_DIR, { recursive: true });

  setupShutdownHandlers();

  log('INFO', '=== Inbox Watcher starting ===');

  if (flags.once) {
    log('INFO', 'Mode: --once (process pending and exit)');
    await processQueue(flags);
    log('INFO', '=== Inbox Watcher finished (--once) ===');
    process.exit(0);
  }

  // Daemon mode
  log('INFO', 'Mode: watch (daemon)');
  startWatcher(flags);
}

main().catch((err) => {
  log('FATAL', `Unhandled error: ${err.message}`);
  process.exit(1);
});
