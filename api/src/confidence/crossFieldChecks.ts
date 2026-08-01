import type { CrossFieldCheck } from './score.js';
import { parseMoney, type ValidatorStatus } from './validate.js';

export interface CrossFieldCheckResults {
  perFieldChecks: Map<string, CrossFieldCheck[]>; // keyed by top-level field key: 'subtotal' | 'tax' | 'total' | 'line_items'
  perRowChecks: CrossFieldCheck[][]; // index-aligned with lineItemRows; [] if lineItemRows is null
}

// One cent, to absorb float rounding — not a "close enough" business tolerance.
const MONEY_TOLERANCE = 0.01;

function recordCheck(perFieldChecks: Map<string, CrossFieldCheck[]>, key: string, check: CrossFieldCheck): void {
  const existing = perFieldChecks.get(key);
  if (existing) existing.push(check);
  else perFieldChecks.set(key, [check]);
}

// Business-rule reconciliation across sibling fields on the same extraction — the piece
// Phase 3 deliberately deferred (no subtotal+tax=total cross-field checks at extraction
// time). Doc type is never branched on directly: which reconciliation applies falls out
// of whether a 'tax' field is present in `scalars` at all (invoice/receipt vs
// purchase_order), which is itself a function of doc type via scripts/fieldSpecs.ts —
// so the caller doesn't need to pass doc type in.
export function computeCrossFieldChecks(
  scalars: Map<string, { normalizedValue: string | null; validatorStatus: ValidatorStatus }>,
  lineItemRows: Record<string, unknown>[] | null,
): CrossFieldCheckResults {
  const perFieldChecks = new Map<string, CrossFieldCheck[]>();

  const subtotal = scalars.get('subtotal');
  const tax = scalars.get('tax');
  const total = scalars.get('total');

  if (subtotal?.validatorStatus === 'valid' && total?.validatorStatus === 'valid') {
    if (tax !== undefined) {
      // Tax exists but isn't itself valid: skip entirely rather than penalize on top of
      // its own already-bad validatorStatus.
      if (tax.validatorStatus === 'valid') {
        const subtotalNum = parseMoney(subtotal.normalizedValue);
        const taxNum = parseMoney(tax.normalizedValue);
        const totalNum = parseMoney(total.normalizedValue);
        if (subtotalNum !== null && taxNum !== null && totalNum !== null) {
          const check: CrossFieldCheck = {
            name: 'subtotal_plus_tax_equals_total',
            passed: Math.abs(subtotalNum + taxNum - totalNum) <= MONEY_TOLERANCE,
          };
          recordCheck(perFieldChecks, 'subtotal', check);
          recordCheck(perFieldChecks, 'tax', check);
          recordCheck(perFieldChecks, 'total', check);
        }
      }
    } else {
      const subtotalNum = parseMoney(subtotal.normalizedValue);
      const totalNum = parseMoney(total.normalizedValue);
      if (subtotalNum !== null && totalNum !== null) {
        const check: CrossFieldCheck = {
          name: 'subtotal_equals_total',
          passed: Math.abs(subtotalNum - totalNum) <= MONEY_TOLERANCE,
        };
        recordCheck(perFieldChecks, 'subtotal', check);
        recordCheck(perFieldChecks, 'total', check);
      }
    }
  }

  if (lineItemRows !== null && lineItemRows.length > 0 && subtotal?.validatorStatus === 'valid') {
    const amounts = lineItemRows.map((row) => parseMoney(String(row.amount)));
    const subtotalNum = parseMoney(subtotal.normalizedValue);
    if (subtotalNum !== null && amounts.every((a): a is number => a !== null)) {
      const sum = amounts.reduce((acc, a) => acc + a, 0);
      recordCheck(perFieldChecks, 'line_items', {
        name: 'line_items_sum_equals_subtotal',
        passed: Math.abs(sum - subtotalNum) <= MONEY_TOLERANCE,
      });
    }
  }

  const perRowChecks: CrossFieldCheck[][] = [];
  if (lineItemRows !== null) {
    for (const row of lineItemRows) {
      const quantity = row.quantity;
      const unitPriceNum = parseMoney(String(row.unit_price));
      const amountNum = parseMoney(String(row.amount));
      if (typeof quantity === 'number' && Number.isFinite(quantity) && unitPriceNum !== null && amountNum !== null) {
        perRowChecks.push([
          {
            name: 'quantity_times_unit_price_equals_amount',
            passed: Math.abs(quantity * unitPriceNum - amountNum) <= MONEY_TOLERANCE,
          },
        ]);
      } else {
        perRowChecks.push([]);
      }
    }
  }

  return { perFieldChecks, perRowChecks };
}
