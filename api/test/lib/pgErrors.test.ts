import { describe, it, expect } from 'vitest';
import { isUniqueViolation, isForeignKeyViolation } from '../../src/lib/pgErrors.js';

function flatPgError(code: string): Error {
  const err = new Error('simulated pg error') as Error & { code: string };
  err.code = code;
  return err;
}

// The shape Drizzle actually throws in production: a DrizzleQueryError wrapper
// with the real node-postgres error (carrying `.code`) nested on `.cause`, not
// on the wrapper itself. A flat error with `.code` set directly was the only
// shape tested before this file existed, which is exactly why this went
// unnoticed until a live request hit it (see PROGRESS.md, Phase 6 checkpoint).
function wrappedPgError(code: string): Error {
  return new Error('Failed query: ...', { cause: flatPgError(code) });
}

describe('isUniqueViolation', () => {
  it('recognizes a flat pg error (code directly on the error)', () => {
    expect(isUniqueViolation(flatPgError('23505'))).toBe(true);
  });

  it('recognizes a DrizzleQueryError-wrapped pg error (code on .cause)', () => {
    expect(isUniqueViolation(wrappedPgError('23505'))).toBe(true);
  });

  it('recognizes a code nested two levels deep', () => {
    const doublyWrapped = new Error('outer', { cause: wrappedPgError('23505') });
    expect(isUniqueViolation(doublyWrapped)).toBe(true);
  });

  it('returns false for an unrelated error code', () => {
    expect(isUniqueViolation(flatPgError('23503'))).toBe(false);
    expect(isUniqueViolation(wrappedPgError('23503'))).toBe(false);
  });

  it('returns false for a non-Error and for an Error with no code anywhere in the chain', () => {
    expect(isUniqueViolation('not an error')).toBe(false);
    expect(isUniqueViolation(new Error('plain, no cause'))).toBe(false);
  });
});

describe('isForeignKeyViolation', () => {
  it('recognizes both the flat and wrapped shapes', () => {
    expect(isForeignKeyViolation(flatPgError('23503'))).toBe(true);
    expect(isForeignKeyViolation(wrappedPgError('23503'))).toBe(true);
  });

  it('returns false for a unique-violation code', () => {
    expect(isForeignKeyViolation(wrappedPgError('23505'))).toBe(false);
  });
});
