import { describe, it, expect } from 'vitest';
import { sha256Hex } from '../../src/ingest/upload.js';

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
