import { describe, it, expect } from 'vitest';
import { valuesMatch, compareLineItems } from '../../src/eval/compare.js';

describe('valuesMatch', () => {
  it('matches string values after trimming, case-sensitively', () => {
    expect(valuesMatch('string', '  Acme Corp  ', 'Acme Corp')).toBe(true);
    expect(valuesMatch('string', 'acme corp', 'Acme Corp')).toBe(false);
  });

  it('matches enum values the same way as string', () => {
    expect(valuesMatch('enum', 'USD', 'USD')).toBe(true);
    expect(valuesMatch('enum', 'usd', 'USD')).toBe(false);
  });

  it('matches money values numerically regardless of symbol or formatting', () => {
    expect(valuesMatch('money', '$106.81', '106.81')).toBe(true);
    expect(valuesMatch('money', '106.81', 106.81)).toBe(true);
    expect(valuesMatch('money', '€7.62', '7.62')).toBe(true); // the exact edge case that motivated this eval
    expect(valuesMatch('money', '106.82', '106.81')).toBe(false);
  });

  it('does not treat a blank or non-numeric money/number value as zero', () => {
    // Number('') and Number('  ') both coerce to 0 in JS — a blank extracted value
    // must never register as matching a genuine gold value of "0".
    expect(valuesMatch('money', '', '0.00')).toBe(false);
    expect(valuesMatch('money', '   ', '0')).toBe(false);
    expect(valuesMatch('money', 'N/A', '0.00')).toBe(false);
    expect(valuesMatch('number', '', 0)).toBe(false);
  });

  it('matches number values numerically', () => {
    expect(valuesMatch('number', 5, '5')).toBe(true);
    expect(valuesMatch('number', 5, 6)).toBe(false);
  });

  it('matches date values by calendar day regardless of string format', () => {
    expect(valuesMatch('date', '2025-09-19', '2025-09-19')).toBe(true);
    expect(valuesMatch('date', 'September 19, 2025', '2025-09-19')).toBe(true);
    expect(valuesMatch('date', '2025-09-20', '2025-09-19')).toBe(false);
  });

  it('treats an unparseable date as not matching, not a throw', () => {
    expect(valuesMatch('date', 'not a date', '2025-09-19')).toBe(false);
  });

  it('treats null/undefined as matching only null/undefined, never crediting a missing extraction as correct', () => {
    expect(valuesMatch('string', null, 'Acme')).toBe(false);
    expect(valuesMatch('string', 'Acme', null)).toBe(false);
    expect(valuesMatch('string', null, null)).toBe(true);
    expect(valuesMatch('string', undefined, null)).toBe(true);
  });
});

describe('compareLineItems', () => {
  const gold = [
    { description: 'Widget', quantity: 2, unit_price: '10.00', amount: '20.00' },
    { description: 'Gadget', quantity: 1, unit_price: '5.50', amount: '5.50' },
  ];

  it('matches when every row and column matches positionally', () => {
    const extracted = [
      { description: 'Widget', quantity: 2, unit_price: '$10.00', amount: '$20.00' },
      { description: 'Gadget', quantity: 1, unit_price: '$5.50', amount: '$5.50' },
    ];
    const result = compareLineItems(extracted, gold);
    expect(result.allMatch).toBe(true);
    expect(result.rowCountMatches).toBe(true);
    expect(result.rows.every((r) => r.matched)).toBe(true);
  });

  it('flags a single wrong column without failing the whole row incorrectly attributed', () => {
    const extracted = [
      { description: 'Widget', quantity: 2, unit_price: '10.00', amount: '20.00' },
      { description: 'Gadget', quantity: 1, unit_price: '5.50', amount: '99.99' }, // wrong amount
    ];
    const result = compareLineItems(extracted, gold);
    expect(result.allMatch).toBe(false);
    expect(result.rows[0].matched).toBe(true);
    expect(result.rows[1].matched).toBe(false);
    expect(result.rows[1].columns.find((c) => c.key === 'amount')?.matched).toBe(false);
    expect(result.rows[1].columns.find((c) => c.key === 'description')?.matched).toBe(true);
  });

  it('flags a row-count mismatch as not matching, even if the rows present are correct', () => {
    const extracted = [{ description: 'Widget', quantity: 2, unit_price: '10.00', amount: '20.00' }]; // missing the second row
    const result = compareLineItems(extracted, gold);
    expect(result.rowCountMatches).toBe(false);
    expect(result.allMatch).toBe(false);
    expect(result.extractedRowCount).toBe(1);
    expect(result.goldRowCount).toBe(2);
  });

  it('handles zero extracted rows without throwing', () => {
    const result = compareLineItems([], gold);
    expect(result.allMatch).toBe(false);
    expect(result.rows.every((r) => !r.matched)).toBe(true);
  });

  it('flags surplus extracted rows (more than gold) as a row-count mismatch, not a match', () => {
    const extracted = [
      { description: 'Widget', quantity: 2, unit_price: '10.00', amount: '20.00' },
      { description: 'Gadget', quantity: 1, unit_price: '5.50', amount: '5.50' },
      { description: 'Extra phantom row', quantity: 1, unit_price: '1.00', amount: '1.00' },
    ];
    const result = compareLineItems(extracted, gold);
    expect(result.rowCountMatches).toBe(false);
    expect(result.allMatch).toBe(false);
    expect(result.extractedRowCount).toBe(3);
    expect(result.goldRowCount).toBe(2);
    // The two rows that do line up with gold are still reported correctly — only
    // rowCountMatches/allMatch reflect the surplus, .rows[] itself stays gold-length.
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.matched)).toBe(true);
  });
});
