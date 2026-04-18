// ADR-264 §2.4 — Observability Envelope (BUG-010)
// Covers M4 (non-blocking): cli_auto_turn return must include {value, status} for
// tokens_in, tokens_out, estimated_cost_usd, model_reported_by_cli, actual_model_id.

import { describe, it, expect } from 'vitest';
import { buildObservabilityEnvelope } from '../index.js';

describe('ADR-264 §2.4 — observability envelope shape', () => {
  it('returns all 5 fields with status=adapter_missing when no adapter data supplied', () => {
    const env = buildObservabilityEnvelope({});
    for (const key of [
      'tokens_in',
      'tokens_out',
      'estimated_cost_usd',
      'model_reported_by_cli',
      'actual_model_id',
    ]) {
      expect(env[key]).toBeDefined();
      expect(env[key].status).toBe('adapter_missing');
      expect(env[key].value).toBeNull();
    }
  });

  it('marks individual fields as cli_not_reporting when adapter ran but CLI omitted usage', () => {
    const env = buildObservabilityEnvelope({
      adapter: 'gemini',
      tokens_in: { value: null, status: 'cli_not_reporting' },
      tokens_out: { value: null, status: 'cli_not_reporting' },
      estimated_cost_usd: { value: null, status: 'cli_not_reporting' },
      model_reported_by_cli: { value: null, status: 'cli_not_reporting' },
      actual_model_id: { value: 'gemini-2.5-pro', status: 'ok' },
    });
    expect(env.tokens_in).toEqual({ value: null, status: 'cli_not_reporting' });
    expect(env.actual_model_id).toEqual({ value: 'gemini-2.5-pro', status: 'ok' });
  });

  it('passes through ok status with real values', () => {
    const env = buildObservabilityEnvelope({
      adapter: 'claude',
      tokens_in: { value: 1200, status: 'ok' },
      tokens_out: { value: 350, status: 'ok' },
      estimated_cost_usd: { value: 0.0042, status: 'ok' },
      model_reported_by_cli: { value: 'claude-opus-4-7', status: 'ok' },
      actual_model_id: { value: 'claude-opus-4-7', status: 'ok' },
    });
    expect(env.tokens_in.value).toBe(1200);
    expect(env.tokens_out.value).toBe(350);
    expect(env.estimated_cost_usd.value).toBeCloseTo(0.0042, 6);
  });

  it('normalizes partial inputs — missing fields default to adapter_missing', () => {
    const env = buildObservabilityEnvelope({
      adapter: 'codex',
      tokens_in: { value: 900, status: 'ok' },
    });
    expect(env.tokens_in.status).toBe('ok');
    expect(env.tokens_out.status).toBe('adapter_missing');
    expect(env.estimated_cost_usd.status).toBe('adapter_missing');
  });

  it('rejects null input by returning a fully-default envelope (defensive)', () => {
    const env = buildObservabilityEnvelope(null);
    expect(env.tokens_in.status).toBe('adapter_missing');
    expect(Object.keys(env)).toHaveLength(5);
  });
});
