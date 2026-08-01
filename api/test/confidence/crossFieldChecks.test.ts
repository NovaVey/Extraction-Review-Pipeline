import { describe, it, expect } from 'vitest';
import { computeCrossFieldChecks } from '../../src/confidence/crossFieldChecks.js';
import type { ValidatorStatus } from '../../src/confidence/validate.js';

function scalar(
  normalizedValue: string | null,
  validatorStatus: ValidatorStatus = 'valid',
): { normalizedValue: string | null; validatorStatus: ValidatorStatus } {
  return { normalizedValue, validatorStatus };
}

describe('computeCrossFieldChecks — totals reconciliation', () => {
  it('passes subtotal+tax=total for a reconciling invoice-shaped set of scalars', () => {
    const scalars = new Map([
      ['subtotal', scalar('100.00')],
      ['tax', scalar('8.00')],
      ['total', scalar('108.00')],
    ]);
    const { perFieldChecks } = computeCrossFieldChecks(scalars, null);
    const expected = [{ name: 'subtotal_plus_tax_equals_total', passed: true }];
    expect(perFieldChecks.get('subtotal')).toEqual(expected);
    expect(perFieldChecks.get('tax')).toEqual(expected);
    expect(perFieldChecks.get('total')).toEqual(expected);
  });

  it('fails subtotal+tax=total when they do not reconcile', () => {
    const scalars = new Map([
      ['subtotal', scalar('100.00')],
      ['tax', scalar('8.00')],
      ['total', scalar('200.00')],
    ]);
    const { perFieldChecks } = computeCrossFieldChecks(scalars, null);
    expect(perFieldChecks.get('total')).toEqual([{ name: 'subtotal_plus_tax_equals_total', passed: false }]);
  });

  it('checks subtotal=total when tax is not a field at all (purchase_order-shaped)', () => {
    const scalars = new Map([
      ['subtotal', scalar('100.00')],
      ['total', scalar('100.00')],
    ]);
    const { perFieldChecks } = computeCrossFieldChecks(scalars, null);
    const expected = [{ name: 'subtotal_equals_total', passed: true }];
    expect(perFieldChecks.get('subtotal')).toEqual(expected);
    expect(perFieldChecks.get('total')).toEqual(expected);
  });

  it('fails subtotal=total when they differ, for a doc type with no tax field', () => {
    const scalars = new Map([
      ['subtotal', scalar('100.00')],
      ['total', scalar('150.00')],
    ]);
    const { perFieldChecks } = computeCrossFieldChecks(scalars, null);
    expect(perFieldChecks.get('subtotal')).toEqual([{ name: 'subtotal_equals_total', passed: false }]);
  });

  it('skips the check entirely (not a failure) when tax is present but not itself valid', () => {
    const scalars = new Map([
      ['subtotal', scalar('100.00')],
      ['tax', scalar(null, 'missing')],
      ['total', scalar('108.00')],
    ]);
    const { perFieldChecks } = computeCrossFieldChecks(scalars, null);
    expect(perFieldChecks.get('subtotal')).toBeUndefined();
    expect(perFieldChecks.get('tax')).toBeUndefined();
    expect(perFieldChecks.get('total')).toBeUndefined();
  });

  it('skips the check entirely (not a failure) when subtotal or total is not valid', () => {
    const scalars = new Map([
      ['subtotal', scalar(null, 'missing')],
      ['tax', scalar('8.00')],
      ['total', scalar('108.00')],
    ]);
    const { perFieldChecks } = computeCrossFieldChecks(scalars, null);
    expect(perFieldChecks.get('tax')).toBeUndefined();
    expect(perFieldChecks.get('total')).toBeUndefined();
  });
});

describe('computeCrossFieldChecks — line-item sum reconciliation', () => {
  it('passes when line item amounts sum to subtotal', () => {
    const scalars = new Map([['subtotal', scalar('30.00')]]);
    const rows = [{ amount: '10.00' }, { amount: '20.00' }];
    const { perFieldChecks } = computeCrossFieldChecks(scalars, rows);
    expect(perFieldChecks.get('line_items')).toEqual([{ name: 'line_items_sum_equals_subtotal', passed: true }]);
  });

  it('fails when line item amounts do not sum to subtotal', () => {
    const scalars = new Map([['subtotal', scalar('30.00')]]);
    const rows = [{ amount: '10.00' }, { amount: '10.00' }];
    const { perFieldChecks } = computeCrossFieldChecks(scalars, rows);
    expect(perFieldChecks.get('line_items')).toEqual([{ name: 'line_items_sum_equals_subtotal', passed: false }]);
  });

  it('skips (not a failure) when a row amount is unparseable', () => {
    const scalars = new Map([['subtotal', scalar('30.00')]]);
    const rows = [{ amount: '10.00' }, { amount: 'garbage' }];
    const { perFieldChecks } = computeCrossFieldChecks(scalars, rows);
    expect(perFieldChecks.get('line_items')).toBeUndefined();
  });

  it('skips when there are no rows or subtotal is not valid', () => {
    const scalars = new Map([['subtotal', scalar('30.00')]]);
    expect(computeCrossFieldChecks(scalars, []).perFieldChecks.get('line_items')).toBeUndefined();

    const notValidScalars = new Map([['subtotal', scalar(null, 'missing')]]);
    expect(
      computeCrossFieldChecks(notValidScalars, [{ amount: '10.00' }]).perFieldChecks.get('line_items'),
    ).toBeUndefined();
  });

  it('does not push the line-item sum check onto subtotal itself', () => {
    const scalars = new Map([['subtotal', scalar('30.00')]]);
    const rows = [{ amount: '10.00' }, { amount: '20.00' }];
    const { perFieldChecks } = computeCrossFieldChecks(scalars, rows);
    expect(perFieldChecks.get('subtotal')).toBeUndefined();
  });
});

describe('computeCrossFieldChecks — per-row arithmetic', () => {
  it('passes when quantity * unit_price = amount for a row', () => {
    const rows = [{ quantity: 2, unit_price: '5.00', amount: '10.00' }];
    const { perRowChecks } = computeCrossFieldChecks(new Map(), rows);
    expect(perRowChecks[0]).toEqual([{ name: 'quantity_times_unit_price_equals_amount', passed: true }]);
  });

  it('fails when quantity * unit_price does not equal amount', () => {
    const rows = [{ quantity: 2, unit_price: '5.00', amount: '99.00' }];
    const { perRowChecks } = computeCrossFieldChecks(new Map(), rows);
    expect(perRowChecks[0]).toEqual([{ name: 'quantity_times_unit_price_equals_amount', passed: false }]);
  });

  it('skips (empty array, not a failure) when a row value is unparseable', () => {
    const rows = [{ quantity: 2, unit_price: 'garbage', amount: '10.00' }];
    const { perRowChecks } = computeCrossFieldChecks(new Map(), rows);
    expect(perRowChecks[0]).toEqual([]);
  });

  it('index-aligns perRowChecks, evaluating each row independently', () => {
    const rows = [
      { quantity: 2, unit_price: '5.00', amount: '10.00' },
      { quantity: 3, unit_price: '5.00', amount: '999.00' },
    ];
    const { perRowChecks } = computeCrossFieldChecks(new Map(), rows);
    expect(perRowChecks[0]).toEqual([{ name: 'quantity_times_unit_price_equals_amount', passed: true }]);
    expect(perRowChecks[1]).toEqual([{ name: 'quantity_times_unit_price_equals_amount', passed: false }]);
  });

  it('returns an empty perRowChecks array when lineItemRows is null', () => {
    const { perRowChecks } = computeCrossFieldChecks(new Map(), null);
    expect(perRowChecks).toEqual([]);
  });
});
