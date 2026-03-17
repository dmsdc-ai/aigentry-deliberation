#!/usr/bin/env node
import { spawn } from 'child_process';
import { readFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const INBOX_DIR = join(homedir(), '.local', 'lib', 'mcp-deliberation', 'inbox');
const taskFile = join(INBOX_DIR, 'task-demo-handoff-test.json');

// Clean previous demo
if (existsSync(INBOX_DIR)) {
  for (const f of readdirSync(INBOX_DIR)) {
    if (f.includes('demo')) unlinkSync(join(INBOX_DIR, f));
  }
}

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

function waitFor(id, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (responses.has(id)) { clearInterval(check); resolve(responses.get(id)); }
    }, 100);
    setTimeout(() => { clearInterval(check); reject(new Error('timeout id=' + id)); }, timeout);
  });
}

function getText(resp) {
  return resp?.result?.content?.map(c => c.text).join('') || resp?.error?.message || '(no text)';
}

try {
  console.log('\n━━━ Autonomous Deliberation Handoff 시연 ━━━\n');

  // Initialize
  send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo', version: '1.0' } });
  await waitFor(1);
  send(2, 'notifications/initialized', {});
  await new Promise(r => setTimeout(r, 500));

  // Step 1: Start deliberation
  console.log('📌 Step 1: deliberation_start (auto_execute: true)\n');
  send(10, 'tools/call', {
    name: 'deliberation_start',
    arguments: {
      topic: 'Demo: Brain EntrySchema에 tags 필드 추가 여부',
      session_id: 'demo-handoff-test',
      rounds: 1,
      speakers: ['claude', 'codex'],
      auto_execute: true,
      require_manual_speakers: false,
      auto_discover_speakers: false,
    }
  });
  const r1 = await waitFor(10, 15000);
  console.log(getText(r1).substring(0, 400));
  console.log('\n---\n');

  // Step 2: Submit a turn
  console.log('📌 Step 2: deliberation_respond (토론 턴)\n');
  send(20, 'tools/call', {
    name: 'deliberation_respond',
    arguments: {
      session_id: 'demo-handoff-test',
      speaker: 'claude',
      message: 'tags: string[] 필드 추가에 동의합니다. 검색 정확도 향상 + EntityGraph 연동 + cross-project 공유 가능.',
    }
  });
  const r2 = await waitFor(20);
  console.log(getText(r2).substring(0, 300));
  console.log('\n---\n');

  // Step 3: Synthesize with structured output
  console.log('📌 Step 3: deliberation_synthesize (구조화된 합의안)\n');
  send(30, 'tools/call', {
    name: 'deliberation_synthesize',
    arguments: {
      session_id: 'demo-handoff-test',
      synthesis: '# 합의: tags 필드 추가\n\n- EntrySchema에 optional tags 추가\n- brain_query에 tag 필터 추가\n- EntityGraph 태그 연결 강화',
      structured: JSON.stringify({
        summary: 'EntrySchema에 tags 필드 추가하여 태그 기반 검색 지원',
        decisions: [
          'EntrySchema에 optional tags: string[] 추가',
          'brain_query에 tag 필터 추가',
          'EntityGraph 태그 연결 강화'
        ],
        actionable_tasks: [
          { id: 1, task: 'EntrySchema에 tags 필드 추가', files: ['src/core/EntrySchema.ts'], project: 'aigentry-brain', priority: 'high' },
          { id: 2, task: 'brain_query에 tags 필터 추가', files: ['src/mcp/BrainMcpServer.ts'], project: 'aigentry-brain', priority: 'high' },
          { id: 3, task: 'EntityGraph 태그 엣지 생성', files: ['src/core/EntityGraph.ts'], project: 'aigentry-brain', priority: 'medium' },
          { id: 4, task: '테스트 케이스 추가', files: ['tests/'], project: 'aigentry-brain', priority: 'medium' },
        ]
      })
    }
  });
  const r3 = await waitFor(30, 15000);
  console.log(getText(r3));
  console.log('\n---\n');

  // Step 4: Inbox list
  console.log('📌 Step 4: deliberation_inbox_list\n');
  send(40, 'tools/call', { name: 'deliberation_inbox_list', arguments: {} });
  const r4 = await waitFor(40);
  console.log(getText(r4));
  console.log('\n---\n');

  // Step 5: Handoff status (read)
  console.log('📌 Step 5: deliberation_handoff_status (상세 조회)\n');
  send(50, 'tools/call', { name: 'deliberation_handoff_status', arguments: { task_id: 'task-demo-handoff-test' } });
  const r5 = await waitFor(50);
  console.log(getText(r5));
  console.log('\n---\n');

  // Step 6: Status -> executing
  console.log('📌 Step 6: pending → executing\n');
  send(60, 'tools/call', { name: 'deliberation_handoff_status', arguments: { task_id: 'task-demo-handoff-test', status: 'executing', log_entry: 'Executor agent started' } });
  const r6 = await waitFor(60);
  console.log(getText(r6));
  console.log('\n---\n');

  // Step 7: Status -> implemented
  console.log('📌 Step 7: executing → implemented\n');
  send(70, 'tools/call', { name: 'deliberation_handoff_status', arguments: { task_id: 'task-demo-handoff-test', status: 'implemented', log_entry: 'All 4 tasks done, tests passing' } });
  const r7 = await waitFor(70);
  console.log(getText(r7));
  console.log('\n---\n');

  // Step 8: Final state
  console.log('📌 Step 8: 최종 인박스 파일 확인\n');
  if (existsSync(taskFile)) {
    const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
    console.log(`  Status: ${task.status}`);
    console.log(`  Project: ${task.project}`);
    console.log(`  Tasks: ${task.structured_synthesis.actionable_tasks.length}개`);
    console.log(`  Execution log:`);
    task.execution_log.forEach(e => console.log(`    [${e.timestamp}] ${e.message}`));
  } else {
    console.log('  (inbox file not found)');
  }

  console.log('\n━━━ 시연 완료: 전체 핸드오프 파이프라인 동작 확인 ━━━\n');

  // Cleanup
  try { if (existsSync(taskFile)) unlinkSync(taskFile); } catch {}
} catch (e) {
  console.error('Error:', e.message);
} finally {
  server.kill();
  process.exit(0);
}
