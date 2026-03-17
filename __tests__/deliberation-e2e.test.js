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
