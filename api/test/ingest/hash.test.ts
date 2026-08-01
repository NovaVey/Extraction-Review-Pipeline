import { describe, it, expect } from 'vitest';

// upload.js imports db/client.js and lib/storage.js directly, both of which import
// the real (never-mocked-here) env.js — a static top-level import of upload.js would
// be hoisted and evaluate env.js before this file gets a chance to run anything, so
// the stubs have to be in place first and the import has to be dynamic. This was
// missing until a CI run on a different machine (different Vitest worker/thread
// scheduling than any local machine had hit) exposed that this file had only ever
// passed by accident, riding on another file's stubs being set first in a shared
// worker — not a guarantee Vitest's docs make.
process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

const { sha256Hex } = await import('../../src/ingest/upload.js');

describe('sha256Hex', () => {
  it('matches a known digest', () => {
    expect(sha256Hex(Buffer.from('hello world'))).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
  });

  it('is deterministic and content-sensitive', () => {
    const a = sha256Hex(Buffer.from('a'));
    const aAgain = sha256Hex(Buffer.from('a'));
    const b = sha256Hex(Buffer.from('b'));
    expect(a).toBe(aAgain);
    expect(a).not.toBe(b);
  });
});
