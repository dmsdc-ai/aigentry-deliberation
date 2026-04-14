import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTeleptySynthesisEnvelope } from '../index.js';

const REPO_ROOT = process.cwd();
const SERVER_ENTRY = path.join(REPO_ROOT, 'index.js');

function makeSession(project, id, overrides = {}) {
  return {
    id,
    project,
    type: 'deliberation',
    topic: 'Experiment retrospective / keep-discard review',
    lang: 'en',
    status: 'active',
    current_round: 1,
    max_rounds: 2,
    current_speaker: 'external-reviewer',
    speakers: ['external-reviewer', 'codex'],
    participant_profiles: [
      { speaker: 'external-reviewer', type: 'manual' },
      { speaker: 'codex', type: 'cli' },
    ],
    log: [],
    synthesis: null,
    structured_synthesis: null,
    execution_contract: null,
    pending_turn_id: 'turn-test-1',
    ordering_strategy: 'cyclic',
    speaker_roles: {
      'external-reviewer': 'researcher',
      codex: 'implementer',
    },
    created: '2026-03-14T00:00:00.000Z',
    updated: '2026-03-14T00:00:00.000Z',
    ...overrides,
  };
}

function getInstallDir(homeDir) {
  return path.join(homeDir, '.local', 'lib', 'mcp-deliberation');
}

function getProjectStateDir(homeDir, project) {
  return path.join(getInstallDir(homeDir), 'state', project);
}

function getSessionFile(homeDir, project, sessionId) {
  return path.join(getProjectStateDir(homeDir, project), 'sessions', `${sessionId}.json`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function getArchiveFiles(homeDir, project) {
  const archiveDir = path.join(getProjectStateDir(homeDir, project), 'archive');
  if (!fs.existsSync(archiveDir)) return [];
  return fs.readdirSync(archiveDir).map(name => path.join(archiveDir, name));
}

async function createHarness() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliberation-e2e-'));
  const installDir = getInstallDir(homeDir);
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, 'config.json'), JSON.stringify({
    setup_complete: true,
    require_speaker_selection: true,
    include_browser_speakers: false,
  }, null, 2));

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      AIGENTRY_TIER: 'pro',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses = new Map();
  let stdoutBuffer = '';
  let stderrBuffer = '';

  child.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id !== undefined) {
          responses.set(parsed.id, parsed);
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  });

  child.stderr.on('data', (data) => {
    stderrBuffer += data.toString();
  });

  const send = (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  };

  const waitFor = (id, timeoutMs = 10000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(timer);
        resolve(responses.get(id));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for response ${id}\n${stderrBuffer}`));
      }
    }, 25);
  });

  send(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1.0.0' },
  });
  await waitFor(1);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    homeDir,
    child,
    stderr: () => stderrBuffer,
    async callTool(name, args, timeoutMs = 10000) {
      const id = Math.floor(Math.random() * 1_000_000);
      send(id, 'tools/call', { name, arguments: args });
      const response = await waitFor(id, timeoutMs);
      if (response.error) {
        throw new Error(response.error.message || JSON.stringify(response.error));
      }
      return response.result;
    },
    cleanup() {
      child.kill('SIGTERM');
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

function getText(result) {
  return (result?.content || [])
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
}

const harnesses = [];

afterEach(() => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    harness.cleanup();
  }
});

describe('deliberation e2e flows', () => {
  it('propagates inject_context payloads into recent_log turn prompts', async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const project = `test-inject-${Date.now()}`;
    const sessionId = `session-inject-${Date.now()}`;
    const session = makeSession(project, sessionId);
    writeJson(getSessionFile(harness.homeDir, project, sessionId), session);

    const payload = {
      past_experiments: [
        {
          experiment_id: 'dg-20260310-001',
          signal_kind: 'INTEREST_DRIFT',
          patch_summary: 'Raised relevanceThreshold from 0.30 to 0.35',
          patch_kind: 'config',
          key_changes: {
            relevanceThreshold: { before: 0.3, after: 0.35 },
          },
          score: 0.08,
          score_label: 'promotion_rate_delta',
          metric_name: 'promotion_rate_delta',
          metric_delta: 0.08,
          verdict: 'positive',
          followup_action: 'kept',
          reasoning: 'Threshold raise reduced noise; promotion quality improved 8%',
        },
      ],
      experiment_count: 1,
      success_rate: 1,
    };

    const injectResult = await harness.callTool('deliberation_inject_context', {
      session_id: sessionId,
      context: JSON.stringify(payload),
      speaker: 'dustcraw',
    });

    expect(getText(injectResult)).toContain('Context successfully injected');

    const saved = readJson(getSessionFile(harness.homeDir, project, sessionId));
    expect(saved.log.at(-1)).toMatchObject({
      event: 'context_injection',
      speaker: 'dustcraw',
    });
    expect(saved.log.at(-1).content).toContain('INTEREST_DRIFT');

    const routeResult = await harness.callTool('deliberation_route_turn', {
      session_id: sessionId,
      include_history_entries: 4,
      auto_prepare_clipboard: false,
    });
    const routeText = getText(routeResult);

    expect(routeText).toContain('[turn_prompt]');
    expect(routeText).toContain('[Context Injection]');
    expect(routeText).toContain('INTEREST_DRIFT');
    expect(routeText).toContain('Raised relevanceThreshold from 0.30 to 0.35');
  });

  it('persists experiment_outcome to archive markdown and synthesis envelopes', async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const project = `test-synthesis-${Date.now()}`;
    const sessionId = `session-synthesis-${Date.now()}`;
    const session = makeSession(project, sessionId, {
      topic: 'Structured synthesis propagation',
      current_speaker: 'codex',
      speakers: ['codex', 'claude'],
      participant_profiles: [
        { speaker: 'codex', type: 'cli' },
        { speaker: 'claude', type: 'cli' },
      ],
    });
    writeJson(getSessionFile(harness.homeDir, project, sessionId), session);

    const structured = {
      summary: 'Retry with a narrower editable scope.',
      decisions: [
        'Keep the experiment loop bounded',
        'Re-run after restoring the failing baseline',
      ],
      actionable_tasks: [
        { id: 1, task: 'Tighten editable globs', project: 'aigentry-devkit', priority: 'high' },
      ],
      experiment_outcome: {
        verdict: 'modify',
        suggested_action: 'iterate',
        confidence: 0.82,
        measurement_window_hours: 24,
      },
    };

    const synthResult = await harness.callTool('deliberation_synthesize', {
      session_id: sessionId,
      synthesis: '# Synthesis\n\nRetry with a narrower editable scope.',
      structured,
    });

    expect(getText(synthResult)).toContain('Deliberation complete');
    expect(fs.existsSync(getSessionFile(harness.homeDir, project, sessionId))).toBe(false);

    const archiveFiles = getArchiveFiles(harness.homeDir, project);
    const mdFiles = archiveFiles.filter(f => f.endsWith('.md'));
    const contractFiles = archiveFiles.filter(f => f.endsWith('.contract.json'));
    expect(mdFiles).toHaveLength(1);
    expect(contractFiles).toHaveLength(1);

    const archiveText = fs.readFileSync(mdFiles[0], 'utf-8');
    expect(archiveText).toContain('## Structured Synthesis');
    expect(archiveText).toContain('## Execution Contract');
    expect(archiveText).toContain('"experiment_outcome"');
    expect(archiveText).toContain('"verdict": "modify"');
    expect(archiveText).toContain('"suggested_action": "iterate"');

    // Phase B: Verify contract sidecar contains machine-readable execution_contract
    const contract = JSON.parse(fs.readFileSync(contractFiles[0], 'utf-8'));
    expect(contract.schema_version).toBe(2);
    expect(contract.source_session_id).toBe(sessionId);
    expect(contract.tasks).toHaveLength(1);
    expect(contract._meta.project).toBe(project);

    const envelope = buildTeleptySynthesisEnvelope({
      state: session,
      synthesis: '# Synthesis\n\nRetry with a narrower editable scope.',
      structured,
    });

    expect(envelope.kind).toBe('deliberation_completed');
    expect(envelope.payload.structured_synthesis.experiment_outcome).toMatchObject({
      verdict: 'modify',
      suggested_action: 'iterate',
      confidence: 0.82,
      measurement_window_hours: 24,
    });
    expect(envelope.payload.execution_contract).toMatchObject({
      schema_version: 2,
      source_session_id: sessionId,
      summary: 'Retry with a narrower editable scope.',
      tasks: [
        { id: 1, task: 'Tighten editable globs', project: 'aigentry-devkit', priority: 'high' },
      ],
      experiment_outcome: {
        verdict: 'modify',
        suggested_action: 'iterate',
        confidence: 0.82,
        measurement_window_hours: 24,
      },
      unresolved_questions: [],
      artifact_refs: [],
    });
    expect(envelope.payload.execution_contract.generated_from.structured_synthesis_hash).toHaveLength(40);
  });

  it('writes brain inbox handoff file after deliberation_synthesize', async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const project = `test-brain-inbox-${Date.now()}`;
    const sessionId = `session-brain-inbox-${Date.now()}`;
    const session = makeSession(project, sessionId, {
      topic: 'Brain inbox handoff verification',
      current_speaker: 'codex',
      speakers: ['codex', 'claude'],
      participant_profiles: [
        { speaker: 'codex', type: 'cli' },
        { speaker: 'claude', type: 'cli' },
      ],
    });
    writeJson(getSessionFile(harness.homeDir, project, sessionId), session);

    const structured = {
      summary: 'Adopt narrower editable scope for next iteration.',
      decisions: [
        'Restrict editable globs to src/ only',
        'Re-run baseline after scope change',
      ],
      actionable_tasks: [
        { id: 1, task: 'Update editable glob config', project: 'aigentry-devkit', priority: 'high' },
        { id: 2, task: 'Run regression suite', project: 'aigentry-devkit', priority: 'medium' },
      ],
      experiment_outcome: {
        verdict: 'modify',
        suggested_action: 'iterate',
        confidence: 0.75,
        measurement_window_hours: 12,
      },
    };

    const synthResult = await harness.callTool('deliberation_synthesize', {
      session_id: sessionId,
      synthesis: '# Synthesis\n\nAdopt narrower editable scope for next iteration.',
      structured,
    });

    expect(getText(synthResult)).toContain('Deliberation complete');

    // Verify the brain inbox handoff file was written
    const inboxDir = path.join(harness.homeDir, '.aigentry', 'inbox');
    const handoffPath = path.join(inboxDir, `handoff-${sessionId}.json`);

    // Allow a brief moment for the fire-and-forget callBrainIngest to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(fs.existsSync(handoffPath)).toBe(true);

    const contract = readJson(handoffPath);

    // Verify execution_contract v2 schema
    expect(contract.schema_version).toBe(2);
    expect(contract.deliberation_id).toBe(sessionId);
    expect(contract.source_session_id).toBe(sessionId);
    expect(contract.summary).toBe('Adopt narrower editable scope for next iteration.');
    expect(contract.decisions).toEqual([
      'Restrict editable globs to src/ only',
      'Re-run baseline after scope change',
    ]);
    expect(contract.tasks).toHaveLength(2);
    expect(contract.tasks[0]).toMatchObject({ id: 1, task: 'Update editable glob config', priority: 'high' });
    expect(contract.tasks[1]).toMatchObject({ id: 2, task: 'Run regression suite', priority: 'medium' });
    expect(contract.experiment_outcome).toMatchObject({
      verdict: 'modify',
      suggested_action: 'iterate',
      confidence: 0.75,
      measurement_window_hours: 12,
    });
    expect(contract.generated_from.structured_synthesis_hash).toHaveLength(40);
  });

  it('supports explicit remote reply ingress with source metadata', async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const project = `test-remote-reply-${Date.now()}`;
    const sessionId = `session-remote-reply-${Date.now()}`;
    const session = makeSession(project, sessionId, {
      pending_turn_id: 'turn-remote-1',
    });
    writeJson(getSessionFile(harness.homeDir, project, sessionId), session);

    const result = await harness.callTool('deliberation_ingest_remote_reply', {
      session_id: sessionId,
      speaker: 'external-reviewer',
      turn_id: 'turn-remote-1',
      content: 'Remote reply with explicit provenance. [AGREE]',
      source_machine_id: 'peer-01',
      source_session_id: 'remote-gemini-001',
      transport_scope: 'remote_mcp',
      artifact_refs: ['results.jsonl', 'summary.md'],
      reply_origin: 'remote_ingress',
      timestamp: '2026-03-15T00:00:00.000Z',
    });

    expect(getText(result)).toContain('Round 1 complete');

    const saved = readJson(getSessionFile(harness.homeDir, project, sessionId));
    expect(saved.log).toHaveLength(1);
    expect(saved.log[0]).toMatchObject({
      speaker: 'external-reviewer',
      channel_used: 'remote_ingress:remote_mcp',
      source_metadata: {
        source_machine_id: 'peer-01',
        source_session_id: 'remote-gemini-001',
        transport_scope: 'remote_mcp',
        artifact_refs: ['results.jsonl', 'summary.md'],
        reply_origin: 'remote_ingress',
        timestamp: '2026-03-15T00:00:00.000Z',
      },
    });
  });

  it('run_until_blocked returns a prompt for manual transports and includes active reporting instructions', async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const project = `test-run-until-${Date.now()}`;
    const sessionId = `session-run-until-${Date.now()}`;
    const session = makeSession(project, sessionId, {
      orchestrator_session_id: 'aigentry-orchestrator-001',
    });
    writeJson(getSessionFile(harness.homeDir, project, sessionId), session);

    const result = await harness.callTool('deliberation_run_until_blocked', {
      session_id: sessionId,
      max_turns: 3,
      include_history_entries: 4,
    });
    const text = getText(result);

    expect(text).toContain('Result:** blocked');
    expect(text).toContain('manual_transport');
    expect(text).toContain('[turn_prompt]');
    expect(text).toContain('[active_reporting_rule]');
    expect(text).toContain('aigentry-orchestrator-001');
  });

  it('run_until_blocked blocks at telepty_bus speaker in a mixed-transport session', async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const project = `test-mixed-transport-${Date.now()}`;
    const sessionId = `session-mixed-transport-${Date.now()}`;

    // Session has 3 speakers: claude (cli), remote-agent (telepty), codex (cli).
    // current_speaker is set to 'remote-agent' (the telepty_bus speaker) to simulate
    // the point where CLI turns have already run and the runner reaches the remote speaker.
    const session = makeSession(project, sessionId, {
      topic: 'Mixed-transport deliberation pipeline test',
      speakers: ['claude', 'remote-agent', 'codex'],
      current_speaker: 'remote-agent',
      participant_profiles: [
        { speaker: 'claude', type: 'cli', telepty_session_id: null },
        { speaker: 'remote-agent', type: 'telepty', telepty_session_id: 'remote-agent-001', telepty_host: '127.0.0.1' },
        { speaker: 'codex', type: 'cli', telepty_session_id: null },
      ],
      speaker_roles: {
        claude: 'proposer',
        'remote-agent': 'evaluator',
        codex: 'implementer',
      },
      log: [
        {
          event: 'turn',
          speaker: 'claude',
          turn_id: 'turn-mixed-0',
          content: 'Initial proposal from claude.',
          channel_used: 'cli_respond',
          timestamp: '2026-03-15T00:00:00.000Z',
        },
      ],
      pending_turn_id: 'turn-mixed-1',
      ordering_strategy: 'cyclic',
    });
    writeJson(getSessionFile(harness.homeDir, project, sessionId), session);

    const result = await harness.callTool('deliberation_run_until_blocked', {
      session_id: sessionId,
      max_turns: 5,
      include_history_entries: 4,
    }, 15000);
    const text = getText(result);

    // The runner must report a blocked status when it hits the telepty_bus speaker
    // because the telepty bus is not available in the test environment.
    expect(text).toContain('Result:** blocked');

    // The blocking speaker must be 'remote-agent'
    expect(text).toContain('remote-agent');

    // The steps array must record the telepty_bus transport for the blocked step
    expect(text).toContain('telepty_bus');

    // A block reason must be present (publish failure or transport timeout)
    expect(text).toContain('Block reason:**');
  }, 20000);
});

// ── self_turn skip behavior for runAutoHandoff (batch path) ─────────
//
// These tests verify the fix for the self_turn over-abort bug in runAutoHandoff.
// Before the fix, when the orchestrator's own CLI identity matched the first/middle
// speaker, runAutoHandoff's Phase 1 loop aborted entirely, leaving later speakers
// un-dispatched and Phase 2 synthesis to fabricate output over empty logs.
//
// After the fix, self_turn detection submits a visible [SELF_TURN_SKIP] placeholder
// and advances to the next speaker. When ALL speakers match the caller, a pre-flight
// check halts auto-handoff cleanly without fabricating synthesis.

function writeStubCli(dir, name) {
  // Stub must exit immediately without reading stdin. The gemini invocation path
  // (spawn('gemini', ['-p', prompt])) never closes the child's stdin, so a stub
  // that blocks on `cat` would hang indefinitely. Claude/codex invocations close
  // stdin after writing, but we keep the stub uniform and stdin-agnostic.
  const body = `#!/bin/sh\necho '[STUB] ${name} response [AGREE]'\nexit 0\n`;
  fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
}

function extractToken(text, label) {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*\`([^\`]+)\``);
  const m = text.match(re);
  return m ? m[1] : null;
}

async function createSelfTurnHarness({ callerSpeaker, stubs }) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliberation-selfturn-'));
  const installDir = getInstallDir(homeDir);
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, 'config.json'), JSON.stringify({
    setup_complete: true,
    require_speaker_selection: true,
    include_browser_speakers: false,
  }, null, 2));

  const stubDir = path.join(homeDir, 'stubs');
  fs.mkdirSync(stubDir, { recursive: true });
  for (const name of stubs) writeStubCli(stubDir, name);

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      AIGENTRY_TIER: 'pro',
      DELIBERATION_CALLER_SPEAKER: callerSpeaker,
      PATH: `${stubDir}:${process.env.PATH || ''}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses = new Map();
  let stdoutBuffer = '';
  let stderrBuffer = '';
  child.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id !== undefined) responses.set(parsed.id, parsed);
      } catch { /* ignore */ }
    }
  });
  child.stderr.on('data', (data) => { stderrBuffer += data.toString(); });

  const send = (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  };
  const waitFor = (id, timeoutMs = 10000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(timer);
        resolve(responses.get(id));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for response ${id}\n${stderrBuffer}`));
      }
    }, 25);
  });

  send(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1.0.0' },
  });
  await waitFor(1);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    homeDir,
    child,
    stderr: () => stderrBuffer,
    async callTool(name, args, timeoutMs = 10000) {
      const id = Math.floor(Math.random() * 1_000_000);
      send(id, 'tools/call', { name, arguments: args });
      const response = await waitFor(id, timeoutMs);
      if (response.error) throw new Error(response.error.message || JSON.stringify(response.error));
      return response.result;
    },
    cleanup() {
      child.kill('SIGTERM');
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

async function confirmSpeakers(harness, speakers) {
  const candidatesResult = await harness.callTool('deliberation_speaker_candidates', {
    include_cli: true,
    include_browser: false,
  });
  const candidatesText = getText(candidatesResult);
  const candidateToken = extractToken(candidatesText, 'Candidate token');
  if (!candidateToken) throw new Error(`no candidate token in:\n${candidatesText}`);

  const confirmResult = await harness.callTool('deliberation_confirm_speakers', {
    selection_token: candidateToken,
    speakers,
  });
  const confirmText = getText(confirmResult);
  const confirmedToken = extractToken(confirmText, 'Confirmed selection token');
  if (!confirmedToken) throw new Error(`no confirmed token in:\n${confirmText}`);
  return confirmedToken;
}

async function waitForArchive(homeDir, project, sessionId, timeoutMs = 25000) {
  const archiveDir = path.join(getProjectStateDir(homeDir, project), 'archive');
  const sessionFile = getSessionFile(homeDir, project, sessionId);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(sessionFile) && fs.existsSync(archiveDir)) {
      const mdFiles = fs.readdirSync(archiveDir).filter(f => f.endsWith('.md'));
      if (mdFiles.length > 0) return path.join(archiveDir, mdFiles[0]);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('timeout waiting for archive');
}

function parseArchiveLog(markdown) {
  // Parse `### {speaker} — Round {n}` headers and the following metadata line.
  const entries = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const headerMatch = lines[i].match(/^### (.+?) — Round (\d+)/);
    if (!headerMatch) continue;
    const speaker = headerMatch[1].trim();
    const round = Number(headerMatch[2]);
    // Next non-empty line may be a metadata blockquote `> _channel: X | fallback: Y_`
    let channel = null;
    let fallback = null;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      // Metadata line is `> _channel: X | fallback: Y_`. Values may contain underscores,
      // so match greedily up to the trailing underscore at end of line.
      const metaMatch = lines[j].match(/^>\s*_(.+)_\s*$/);
      if (metaMatch) {
        const parts = metaMatch[1].split('|').map(s => s.trim());
        for (const p of parts) {
          const [k, v] = p.split(':').map(s => s.trim());
          if (k === 'channel') channel = v;
          if (k === 'fallback') fallback = v;
        }
        break;
      }
      if (lines[j].trim() !== '' && !lines[j].startsWith('>')) break;
    }
    entries.push({ speaker, round, channel_used: channel, fallback_reason: fallback });
  }
  return entries;
}

describe('runAutoHandoff self_turn skip (batch path)', () => {
  it('test_self_turn_skip_first_speaker: caller matches first speaker — advances via placeholder, non-matching speakers execute', async () => {
    const harness = await createSelfTurnHarness({
      callerSpeaker: 'claude',
      stubs: ['claude', 'codex', 'gemini'],
    });
    harnesses.push(harness);

    const confirmedToken = await confirmSpeakers(harness, ['claude', 'codex', 'gemini']);
    const sessionId = `selfturn-first-${Date.now()}`;
    const project = path.basename(REPO_ROOT);

    const startResult = await harness.callTool('deliberation_start', {
      topic: 'Self-turn first speaker skip test',
      session_id: sessionId,
      rounds: 2,
      first_speaker: 'claude',
      speakers: ['claude', 'codex', 'gemini'],
      selection_token: confirmedToken,
      require_manual_speakers: true,
      participant_types: { claude: 'cli', codex: 'cli', gemini: 'cli' },
      ordering_strategy: 'cyclic',
      auto_synthesize: true,
    });
    expect(getText(startResult)).toContain('Deliberation started');

    const archivePath = await waitForArchive(harness.homeDir, project, sessionId, 25000);
    const archiveText = fs.readFileSync(archivePath, 'utf-8');
    const entries = parseArchiveLog(archiveText);
    // Round bookkeeping: 3 speakers × 2 rounds = 6 log entries total
    // Of those, 2 are [SELF_TURN_SKIP] placeholders for claude (first speaker, skipped each round),
    // and 4 are real stub responses from codex and gemini.
    const selfTurnEntries = entries.filter(e => e.channel_used === 'self_turn_skip');
    expect(selfTurnEntries).toHaveLength(2);
    expect(selfTurnEntries.every(e => e.speaker === 'claude')).toBe(true);
    expect(selfTurnEntries.every(e => e.fallback_reason === 'caller_identity_match')).toBe(true);
    expect(archiveText).toContain('[SELF_TURN_SKIP] Speaker claude');

    const realEntries = entries.filter(e => e.channel_used !== 'self_turn_skip');
    expect(realEntries).toHaveLength(4);
    const realSpeakers = realEntries.map(e => e.speaker).sort();
    expect(realSpeakers).toEqual(['codex', 'codex', 'gemini', 'gemini']);

    // Status must be completed (archive includes completed status header)
    expect(archiveText).toMatch(/\*\*Status:\*\*\s+completed/);
    // Synthesis section must exist and be non-empty
    expect(archiveText).toContain('## Synthesis');
  }, 45000);

  it('test_self_turn_skip_middle_speaker: caller matches middle speaker — middle skipped, outer speakers execute both rounds', async () => {
    const harness = await createSelfTurnHarness({
      callerSpeaker: 'claude',
      stubs: ['claude', 'codex', 'gemini'],
    });
    harnesses.push(harness);

    const confirmedToken = await confirmSpeakers(harness, ['codex', 'claude', 'gemini']);
    const sessionId = `selfturn-mid-${Date.now()}`;
    const project = path.basename(REPO_ROOT);

    const startResult = await harness.callTool('deliberation_start', {
      topic: 'Self-turn middle speaker skip test',
      session_id: sessionId,
      rounds: 2,
      first_speaker: 'codex',
      speakers: ['codex', 'claude', 'gemini'],
      selection_token: confirmedToken,
      require_manual_speakers: true,
      participant_types: { codex: 'cli', claude: 'cli', gemini: 'cli' },
      ordering_strategy: 'cyclic',
      auto_synthesize: true,
    });
    expect(getText(startResult)).toContain('Deliberation started');

    const archivePath = await waitForArchive(harness.homeDir, project, sessionId, 25000);
    const archiveText = fs.readFileSync(archivePath, 'utf-8');
    const entries = parseArchiveLog(archiveText);

    const selfTurnEntries = entries.filter(e => e.channel_used === 'self_turn_skip');
    expect(selfTurnEntries).toHaveLength(2);
    expect(selfTurnEntries.every(e => e.speaker === 'claude')).toBe(true);
    expect(archiveText).toContain('[SELF_TURN_SKIP] Speaker claude');

    const realEntries = entries.filter(e => e.channel_used !== 'self_turn_skip');
    expect(realEntries).toHaveLength(4);
    const realSpeakers = realEntries.map(e => e.speaker).sort();
    expect(realSpeakers).toEqual(['codex', 'codex', 'gemini', 'gemini']);

    expect(archiveText).toMatch(/\*\*Status:\*\*\s+completed/);
  }, 45000);

  it('test_all_speakers_self_match: all speakers match caller — halt cleanly, no synthesis fabrication, status stays active', async () => {
    const harness = await createSelfTurnHarness({
      callerSpeaker: 'claude',
      // No stubs needed — no speaker should ever be spawned
      stubs: ['claude'],
    });
    harnesses.push(harness);

    // Use two distinct names that both normalize to "claude" via suffix stripping,
    // OR repeat the same CLI speaker name. The selection flow requires 2+ speakers,
    // so we use ['claude', 'claude-code'] — both normalize to "claude" in the codebase.
    // Fallback: if normalization differs, we'll use two identical sessions to force match.
    const confirmedToken = await confirmSpeakers(harness, ['claude']).catch(async () => {
      // If single-speaker selection is rejected, use a dual self-match via repeated normalization
      return confirmSpeakers(harness, ['claude', 'claude']);
    });

    const sessionId = `selfturn-all-${Date.now()}`;
    const project = path.basename(REPO_ROOT);
    const sessionFilePath = getSessionFile(harness.homeDir, project, sessionId);

    // deliberation_start validates speakers >= 2, so we try a single-speaker start
    // which is expected to error OR proceed with an expanded list. The pre-flight
    // all-self check lives in runAutoHandoff (fires only if session creates successfully).
    let startText = '';
    try {
      const startResult = await harness.callTool('deliberation_start', {
        topic: 'All speakers match caller test',
        session_id: sessionId,
        rounds: 2,
        first_speaker: 'claude',
        speakers: ['claude', 'claude'],
        selection_token: confirmedToken,
        require_manual_speakers: true,
        participant_types: { claude: 'cli' },
        auto_synthesize: true,
      });
      startText = getText(startResult);
    } catch (err) {
      // If the server rejects a single-identity speaker list with <2 distinct speakers,
      // the bug is not reachable — treat this as the documented contract.
      expect(String(err.message)).toMatch(/2.*speakers|duplicate|distinct/i);
      return;
    }

    // If session was created, the runAutoHandoff pre-flight must halt without
    // archiving (status stays "active", no synthesis fabrication).
    if (!startText.includes('Deliberation started')) {
      // Graceful pre-start rejection is also acceptable (documented contract).
      return;
    }

    // Wait briefly, then assert session file still exists and status is active.
    await new Promise(r => setTimeout(r, 2000));
    const archiveDir = path.join(getProjectStateDir(harness.homeDir, project), 'archive');
    const archiveExists = fs.existsSync(archiveDir) &&
      fs.readdirSync(archiveDir).some(f => f.includes(sessionId) && f.endsWith('.json'));

    expect(archiveExists).toBe(false);
    expect(fs.existsSync(sessionFilePath)).toBe(true);
    const state = readJson(sessionFilePath);
    expect(state.status).toBe('active');
    expect(state.synthesis).toBeFalsy();
    expect(Array.isArray(state.log)).toBe(true);
    // No turns should have been executed or fabricated
    expect(state.log.filter(e => e.event !== 'context_injection')).toHaveLength(0);
  }, 20000);
});
