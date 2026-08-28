import type { FieldType } from '../extract/schema.js';
import { stripMoneySymbols } from './validate.js';

// Shared by extract/run.ts (voting on semantic agreement across extraction samples)
// and eval/compare.ts (comparing an extracted value against gold) — both need the
// same "is this the same value, ignoring how it happens to be formatted" logic, so
// it lives here once rather than being reimplemented per caller.

// Date.parse treats an ISO date-only string ("2025-09-19") as UTC midnight but a
// verbose one ("September 19, 2025") as *local* midnight (ECMA-262 21.4.3.2) — on a
// host with a large positive UTC offset, a non-ISO extracted date could compute one
// calendar day off from the same date parsed from an ISO string. Not fixed: this
// deployment runs UTC (offsets agree), and the corpus only ever prints ISO dates on
// the page (scripts/make-synthetic-docs.ts uses fmtDateISO, never fmtDateDisplay), so
// the model has nothing non-ISO to transcribe. Revisit if either assumption changes.
export function parseDateDay(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 86400000);
}

export function parseNumeric(value: string | number): number | null {
  // Number('') and Number('   ') both coerce to 0, not NaN — the same gotcha
  // confidence/validate.ts's own number/money branches guard against explicitly.
  // Without this, a blank or non-numeric value would silently compare equal to a
  // real value of "0".
  const stripped = stripMoneySymbols(String(value)).trim();
  if (stripped.length === 0) return null;
  const numeric = Number(stripped);
  return Number.isNaN(numeric) ? null : numeric;
}

// A canonical string for one value, type-aware: money/number values compare as
// 2dp-rounded numerics ("$1,234.00" / "1234.00" / "1,234" all canonicalize the same),
// dates compare by calendar day regardless of format, everything else compares
// trimmed. This is for COMPARISON only (voting agreement, gold matching) — the
// original raw string is always what's kept for storage/display/audit.
export function canonicalizeValue(type: FieldType, value: unknown): string {
  if (value === null || value === undefined) return '__NULL__';
  switch (type) {
    case 'money':
    case 'number': {
      const numeric = parseNumeric(value as string | number);
      return numeric === null ? `__UNPARSEABLE__:${String(value)}` : numeric.toFixed(2);
    }
    case 'date': {
      const day = parseDateDay(String(value));
      return day === null ? `__UNPARSEABLE__:${String(value)}` : String(day);
    }
    default:
      return String(value).trim();
  }
}
