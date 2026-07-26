// Pins the degradation pipeline after OrchestratedBrowserPort was folded into
// DevToolsMcpAdapter: the per-session machine, its recover wiring, and the
// detach cleanup all used to live in the wrapper class.
import { describe, expect, it } from 'vitest';
import { DevToolsMcpAdapter } from '../browser-control-port.js';

describe('DevToolsMcpAdapter degradation pipeline', () => {
  it('passes a successful send through and tracks state per session', async () => {
    const adapter = new DevToolsMcpAdapter();
    adapter.sendTurn = async () => ({ ok: true, data: { sent: true } });

    const result = await adapter.sendTurnWithDegradation('s1', 't1', 'hello');

    expect(result.ok).toBe(true);
    expect(adapter.getDegradationState('s1')).not.toBeNull();
    expect(adapter.getDegradationState('other')).toBeNull();
  });

  it('wires the recover stages to its own recover(), not a wrapped adapter', async () => {
    const adapter = new DevToolsMcpAdapter();
    const modes = [];
    adapter.recover = async (sessionId, mode) => {
      modes.push([sessionId, mode]);
      return { ok: true, data: null };
    };

    const machine = adapter._getOrCreateMachine('s1');
    await machine._onRebind();
    await machine._onReload();

    expect(modes).toEqual([['s1', 'rebind'], ['s1', 'reload']]);
  });

  it('drops the session machine on detach', async () => {
    const adapter = new DevToolsMcpAdapter();
    adapter.sendTurn = async () => ({ ok: true, data: {} });

    await adapter.sendTurnWithDegradation('s1', 't1', 'hello');
    expect(adapter.getDegradationState('s1')).not.toBeNull();

    await adapter.detach('s1');
    expect(adapter.getDegradationState('s1')).toBeNull();
  });
});
