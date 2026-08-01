import type { FieldType } from '../extract/schema.js';

export type ValidatorStatus = 'valid' | 'invalid' | 'missing';

export function stripMoneySymbols(rawValue: string): string {
  return rawValue.replace(/[^0-9.-]/g, '');
}

// Generalizes the per-field-type format check so it can validate both top-level scalar
// fields AND individual line-item cell values with the same logic. rawValue may be a
// number because table columns of type 'number' (e.g. quantity) come back from the
// JSON-schema-constrained model output as a real JSON number, not a string (see
// extract/schema.ts's scalarSchema).
export function validateValue(
  type: FieldType,
  enumValues: string[] | undefined,
  rawValue: string | number | null | undefined,
): ValidatorStatus {
  if (rawValue === null || rawValue === undefined) return 'missing';
  switch (type) {
    case 'date':
      return Number.isNaN(Date.parse(String(rawValue))) ? 'invalid' : 'valid';
    case 'money': {
      const numeric = stripMoneySymbols(String(rawValue));
      return numeric.length > 0 && !Number.isNaN(Number(numeric)) ? 'valid' : 'invalid';
    }
    case 'number': {
      // Number('') and Number('  ') both coerce to 0, not NaN — an explicit blank
      // check is needed here to match the 'money'/'string' branches' rejection of
      // empty input (Number(3) is never blank, so this only affects string input).
      const asString = String(rawValue).trim();
      return asString.length > 0 && !Number.isNaN(Number(asString)) ? 'valid' : 'invalid';
    }
    case 'enum':
      return (enumValues ?? []).includes(String(rawValue)) ? 'valid' : 'invalid';
    default: // 'string'
      return String(rawValue).trim().length > 0 ? 'valid' : 'invalid';
  }
}

// Returns null (not NaN/throw) when unparseable — callers treat that as "this check
// doesn't apply" rather than a crash, since arithmetic checks should skip gracefully
// when an input is already known-bad (its own validatorStatus already flags that).
export function parseMoney(rawValue: string | null): number | null {
  if (rawValue === null) return null;
  const numeric = stripMoneySymbols(rawValue);
  if (numeric.length === 0 || Number.isNaN(Number(numeric))) return null;
  return Number(numeric);
}
