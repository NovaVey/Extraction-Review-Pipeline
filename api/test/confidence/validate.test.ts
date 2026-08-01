import { describe, it, expect } from 'vitest';
import { validateValue, parseMoney, stripMoneySymbols } from '../../src/confidence/validate.js';

describe('validateValue', () => {
  it('reports missing for null or undefined regardless of type', () => {
    expect(validateValue('string', undefined, null)).toBe('missing');
    expect(validateValue('date', undefined, undefined)).toBe('missing');
  });

  it('validates date-parseable strings and rejects garbage', () => {
    expect(validateValue('date', undefined, '2025-09-19')).toBe('valid');
    expect(validateValue('date', undefined, 'not a date')).toBe('invalid');
  });

  it('validates numeric-after-stripping-symbols money values', () => {
    expect(validateValue('money', undefined, '$1,234.56')).toBe('valid');
    expect(validateValue('money', undefined, 'not money')).toBe('invalid');
  });

  it('validates enum membership', () => {
    expect(validateValue('enum', ['USD', 'EUR'], 'USD')).toBe('valid');
    expect(validateValue('enum', ['USD', 'EUR'], 'JPY')).toBe('invalid');
    expect(validateValue('enum', undefined, 'USD')).toBe('invalid');
  });

  it('validates non-empty strings for the default string type', () => {
    expect(validateValue('string', undefined, 'hello')).toBe('valid');
    expect(validateValue('string', undefined, '   ')).toBe('invalid');
  });

  // Previously ungoverned in run.ts's local validateField (no 'number' case existed),
  // so a garbage non-numeric quantity string would fall through unnoticed.
  it('validates numbers, including real JS numbers from table columns', () => {
    expect(validateValue('number', undefined, 3)).toBe('valid');
    expect(validateValue('number', undefined, '3')).toBe('valid');
    expect(validateValue('number', undefined, 'not a number')).toBe('invalid');
  });
});

describe('stripMoneySymbols', () => {
  it('strips everything but digits, dot, and minus', () => {
    expect(stripMoneySymbols('$1,234.56')).toBe('1234.56');
    expect(stripMoneySymbols('-$5.00')).toBe('-5.00');
  });
});

describe('parseMoney', () => {
  it('parses stripped numeric strings to numbers', () => {
    expect(parseMoney('$1,234.56')).toBe(1234.56);
  });

  it('returns null for null input', () => {
    expect(parseMoney(null)).toBeNull();
  });

  it('returns null (not NaN) for unparseable input', () => {
    expect(parseMoney('not money')).toBeNull();
    expect(parseMoney('')).toBeNull();
  });
});
