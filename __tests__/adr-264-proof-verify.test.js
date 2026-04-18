// ADR-264 §2.2 — Proxy Response Submission (BUG-002)
// Covers metric M2: SHA-256 hash verification of external_output.
// Pure function: verifyExternalOutputProof({ external_output, external_output_proof, verify }).

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyExternalOutputProof } from '../index.js';

const hash = (s) => crypto.createHash('sha256').update(s, 'utf-8').digest('hex');

describe('ADR-264 §2.2 — verifyExternalOutputProof', () => {
  it('accepts correct sha256 digest with verify=hash (default)', () => {
    const content = 'Hello from pre-spawned claude.';
    const result = verifyExternalOutputProof({
      external_output: content,
      external_output_proof: {
        algo: 'sha256',
        digest: hash(content),
        source: 'cli_stdout',
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects mismatched digest with E_EXTERNAL_OUTPUT_PROOF_MISMATCH', () => {
    const result = verifyExternalOutputProof({
      external_output: 'actual content',
      external_output_proof: {
        algo: 'sha256',
        digest: hash('tampered content'),
        source: 'cli_stdout',
      },
      verify: 'hash',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_EXTERNAL_OUTPUT_PROOF_MISMATCH');
  });

  it('rejects missing proof when verify=hash', () => {
    const result = verifyExternalOutputProof({
      external_output: 'some content',
      verify: 'hash',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_EXTERNAL_OUTPUT_PROOF_MISSING');
  });

  it('rejects unsupported algo', () => {
    const result = verifyExternalOutputProof({
      external_output: 'some content',
      external_output_proof: {
        algo: 'md5',
        digest: 'abc123',
        source: 'cli_stdout',
      },
      verify: 'hash',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_EXTERNAL_OUTPUT_PROOF_ALGO_UNSUPPORTED');
  });

  it('accepts trusted_orchestrator source when verify=none', () => {
    const result = verifyExternalOutputProof({
      external_output: 'content claimed by orchestrator without hash',
      external_output_proof: {
        algo: 'sha256',
        digest: 'ignored',
        source: 'trusted_orchestrator',
      },
      verify: 'none',
    });
    expect(result.ok).toBe(true);
    expect(result.audit).toMatchObject({ source: 'trusted_orchestrator', verify: 'none' });
  });

  it('rejects missing external_output', () => {
    const result = verifyExternalOutputProof({
      external_output: '',
      external_output_proof: { algo: 'sha256', digest: 'x', source: 'cli_stdout' },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_EXTERNAL_OUTPUT_MISSING');
  });

  it('hashes full UTF-8 bytes without trimming', () => {
    // Whitespace-sensitive: digest must be computed over the exact bytes.
    const content = '  leading and trailing spaces  \n';
    const result = verifyExternalOutputProof({
      external_output: content,
      external_output_proof: {
        algo: 'sha256',
        digest: hash(content),
        source: 'cli_stdout',
      },
    });
    expect(result.ok).toBe(true);
  });
});
