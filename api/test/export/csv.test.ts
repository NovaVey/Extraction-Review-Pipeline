import { describe, it, expect } from 'vitest';
import { buildCsv } from '../../src/export/csv.js';

describe('buildCsv', () => {
  it('writes a header row and one row per record, CRLF-terminated', () => {
    const csv = buildCsv(['a', 'b'], [
      [1, 'x'],
      [2, 'y'],
    ]);
    expect(csv).toBe('a,b\r\n1,x\r\n2,y\r\n');
  });

  it('quotes a field containing a comma, a quote, or a newline, doubling internal quotes', () => {
    const csv = buildCsv(['field'], [['has, a comma'], ['has "quotes"'], ['has\na newline']]);
    expect(csv).toBe('field\r\n"has, a comma"\r\n"has ""quotes"""\r\n"has\na newline"\r\n');
  });

  it('renders null and undefined as an empty field, not the literal string', () => {
    const csv = buildCsv(['a', 'b'], [[null, undefined]]);
    expect(csv).toBe('a,b\r\n,\r\n');
  });

  it('leaves plain values unquoted', () => {
    const csv = buildCsv(['n'], [[42]]);
    expect(csv).toBe('n\r\n42\r\n');
  });
});
