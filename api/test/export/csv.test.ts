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

  describe('CSV/formula injection hardening (CWE-1236)', () => {
    it('prefixes a leading =, +, or @ with an apostrophe so Excel/Sheets treat it as text', () => {
      // No commas/quotes in these three, so RFC 4180 quoting stays out of the way —
      // isolates the prefix behavior itself; the interaction with quoting is its own
      // test below.
      const csv = buildCsv(['vendor'], [
        ["=cmd|' /C calc'!A0"],
        ["+cmd|' /C calc'!A0"],
        ['@SUM(1+1)'],
      ]);
      expect(csv).toBe(
        'vendor\r\n' +
          "'=cmd|' /C calc'!A0\r\n" +
          "'+cmd|' /C calc'!A0\r\n" +
          "'@SUM(1+1)\r\n",
      );
    });

    it('quotes the field as usual when neutralization introduces a comma/quote/newline that needs escaping', () => {
      const csv = buildCsv(['vendor'], [['=HYPERLINK("x","y")']]);
      // Apostrophe-prefixed first, then RFC 4180 quoting still applies on top since
      // the value contains a comma and quotes.
      expect(csv).toBe('vendor\r\n"\'=HYPERLINK(""x"",""y"")"\r\n');
    });

    it('does not touch an ordinary negative number, since a leading "-" followed by a digit is not a formula trigger', () => {
      const csv = buildCsv(['amount'], [['-54.00'], ['-5']]);
      expect(csv).toBe('amount\r\n-54.00\r\n-5\r\n');
    });

    it('does neutralize a leading "-" NOT followed by a digit, since that shape can still start a formula', () => {
      const csv = buildCsv(['field'], [['-cmd|\' /C calc\'!A0']]);
      expect(csv).toBe('field\r\n\'-cmd|\' /C calc\'!A0\r\n');
    });

    it('leaves a value with no leading trigger character untouched', () => {
      const csv = buildCsv(['vendor'], [['Acme Co']]);
      expect(csv).toBe('vendor\r\nAcme Co\r\n');
    });
  });
});
