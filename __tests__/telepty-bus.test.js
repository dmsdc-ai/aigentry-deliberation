import { describe, expect, it } from 'vitest';
import {
  buildTeleptyTurnRequestEnvelope,
  buildTeleptySynthesisEnvelope,
  registerPendingTeleptyTurnRequest,
  handleTeleptyBusMessage,
  completePendingTeleptySemantic,
  cleanupPendingTeleptyTurn,
  getTeleptySessionHealth,
  TELEPTY_TRANSPORT_TIMEOUT_MS,
  TELEPTY_SEMANTIC_TIMEOUT_MS,
} from '../index.js';

function makeState() {
  return {
    id: 'delib-1',
    project: 'aigentry-telepty',
    topic: 'Cross-session routing',
    current_round: 2,
    max_rounds: 3,
    speaker_roles: {
      'aigentry-telepty-001': 'implementer',
    },
  };
}

describe('telepty bus envelopes', () => {
  it('builds a typed turn_request envelope with split timeouts', () => {
    const envelope = buildTeleptyTurnRequestEnvelope({
      state: makeState(),
      speaker: 'aigentry-telepty-001',
      turnId: 'turn-1',
      turnPrompt: 'Respond to this turn.',
      includeHistoryEntries: 4,
      profile: {
        telepty_session_id: 'aigentry-telepty-001',
        telepty_host: '127.0.0.1',
      },
    });

    expect(envelope.kind).toBe('turn_request');
    expect(envelope.target).toBe('aigentry-telepty-001');
    expect(envelope.payload).toMatchObject({
      turn_id: 'turn-1',
      speaker: 'aigentry-telepty-001',
      history_entries: 4,
      transport_timeout_ms: TELEPTY_TRANSPORT_TIMEOUT_MS,
      semantic_timeout_ms: TELEPTY_SEMANTIC_TIMEOUT_MS,
    });
    expect(envelope.payload.prompt_sha1).toHaveLength(40);
  });

  it('builds a typed deliberation_completed envelope', () => {
    const envelope = buildTeleptySynthesisEnvelope({
      state: makeState(),
      synthesis: '# summary',
      structured: {
        summary: 'done',
        decisions: ['keep bus routing'],
        actionable_tasks: [{ id: 1, task: 'ship it', priority: 'high' }],
      },
    });

    expect(envelope.kind).toBe('deliberation_completed');
    expect(envelope.payload.structured_synthesis.summary).toBe('done');
    expect(envelope.payload.structured_synthesis.actionable_tasks).toHaveLength(1);
  });
});

describe('telepty bus tracking', () => {
  it('matches inject_written ack and semantic completion to a pending telepty turn', async () => {
    const prompt = 'Respond to this turn.';
    const envelope = buildTeleptyTurnRequestEnvelope({
      state: makeState(),
      speaker: 'aigentry-telepty-001',
      turnId: 'turn-2',
      turnPrompt: prompt,
      includeHistoryEntries: 2,
      profile: {
        telepty_session_id: 'aigentry-telepty-001',
        telepty_host: '127.0.0.1',
      },
    });
    const entry = registerPendingTeleptyTurnRequest({
      envelope,
      profile: {
        telepty_session_id: 'aigentry-telepty-001',
        telepty_host: '127.0.0.1',
      },
      speaker: 'aigentry-telepty-001',
    });

    handleTeleptyBusMessage(JSON.stringify({
      type: 'inject_written',
      inject_id: 'inj-1',
      target_agent: 'aigentry-telepty-001',
      content: prompt,
      timestamp: new Date().toISOString(),
    }));

    await expect(entry.transportPromise).resolves.toMatchObject({
      ok: true,
      code: 'inject_written',
      inject_id: 'inj-1',
    });

    completePendingTeleptySemantic({
      sessionId: 'delib-1',
      speaker: 'aigentry-telepty-001',
      turnId: 'turn-2',
    });

    await expect(entry.semanticPromise).resolves.toMatchObject({
      ok: true,
      code: 'responded',
    });

    cleanupPendingTeleptyTurn(entry.message_id);
  });

  it('stores telepty session_health updates from the bus subscriber', () => {
    handleTeleptyBusMessage(JSON.stringify({
      type: 'session_health',
      session_id: 'aigentry-telepty-001',
      payload: {
        alive: true,
        pid: 12345,
        clients: 1,
      },
      timestamp: new Date().toISOString(),
    }));

    expect(getTeleptySessionHealth('aigentry-telepty-001')).toMatchObject({
      session_id: 'aigentry-telepty-001',
      payload: expect.objectContaining({
        alive: true,
        pid: 12345,
      }),
      stale: false,
    });
  });
});
