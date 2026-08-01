import type { FieldType } from '../extract/schema.js';
import { stripMoneySymbols } from '../confidence/validate.js';
import type { GoldLineItem } from './goldSet.js';

// Money/number values are compared numerically after stripping symbols (so "$106.81"
// vs "106.81" vs 106.81 all compare equal), not as strings — a small epsilon absorbs
// float round-tripping, not real disagreement (a genuine typo'd cent is still >0.005
// away in every case this corpus produces).
const NUMERIC_EPSILON = 0.005;

// Date.parse treats an ISO date-only string ("2025-09-19") as UTC midnight but a
// verbose one ("September 19, 2025") as *local* midnight (ECMA-262 21.4.3.2) — on a
// host with a large positive UTC offset, a non-ISO extracted date could compute one
// calendar day off from the same date parsed from gold's ISO string. Not fixed: this
// deployment runs UTC (offsets agree), and the corpus only ever prints ISO dates on
// the page (scripts/make-synthetic-docs.ts uses fmtDateISO, never fmtDateDisplay), so
// the model has nothing non-ISO to transcribe. Revisit if either assumption changes.
function parseDateDay(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 86400000);
}

function parseNumeric(value: string | number): number | null {
  // Number('') and Number('   ') both coerce to 0, not NaN — the same gotcha
  // confidence/validate.ts's own number/money branches guard against explicitly.
  // Without this, a blank or non-numeric value would silently compare equal to a
  // real gold value of "0".
  const stripped = stripMoneySymbols(String(value)).trim();
  if (stripped.length === 0) return null;
  const numeric = Number(stripped);
  return Number.isNaN(numeric) ? null : numeric;
}

// Compares one extracted value against its gold counterpart for a single scalar
// field or table cell, per field-type semantics. null/undefined only matches
// null/undefined — a missing extraction is never silently credited as correct.
export function valuesMatch(type: FieldType, extracted: string | number | null | undefined, gold: string | number | null | undefined): boolean {
  if (extracted === null || extracted === undefined || gold === null || gold === undefined) {
    return (extracted === null || extracted === undefined) && (gold === null || gold === undefined);
  }
  switch (type) {
    case 'date': {
      const a = parseDateDay(String(extracted));
      const b = parseDateDay(String(gold));
      return a !== null && b !== null && a === b;
    }
    case 'money':
    case 'number': {
      const a = parseNumeric(extracted);
      const b = parseNumeric(gold);
      return a !== null && b !== null && Math.abs(a - b) < NUMERIC_EPSILON;
    }
    case 'enum':
    case 'string':
    default:
      // Trimmed exact match, case-sensitive — the model sees clean, precisely
      // rendered text in this corpus, so a case mismatch is a real transcription
      // difference worth surfacing, not noise to fold away.
      return String(extracted).trim() === String(gold).trim();
  }
}

const LINE_ITEM_COLUMN_TYPES: Record<string, FieldType> = {
  description: 'string',
  quantity: 'number',
  unit_price: 'money',
  amount: 'money',
};

// A canonical string for one row, used only for the order-independent multiset match
// below — NOT for the positional per-row breakdown, which still uses valuesMatch's
// epsilon-based comparison directly. Money/number values are rounded to 2dp rather
// than epsilon-compared here; every value in this corpus is an exact decimal string,
// so this is equivalent in practice, but a value that was merely epsilon-close
// (not exactly equal after rounding) would not collide in the multiset the way it
// would under valuesMatch's epsilon check.
function canonicalizeCell(type: FieldType, value: unknown): string {
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

function rowSignature(row: Record<string, unknown>): string {
  return Object.entries(LINE_ITEM_COLUMN_TYPES)
    .map(([key, type]) => canonicalizeCell(type, row[key]))
    .join('');
}

// True iff the two arrays contain exactly the same rows the same number of times
// each, ignoring order — a duplicate row (e.g. the same item ordered twice at
// different quantities, which produces two genuinely distinct signatures) is still
// required to appear the same number of times on both sides.
function multisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const s of a) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const s of b) {
    const remaining = counts.get(s);
    if (!remaining) return false;
    counts.set(s, remaining - 1);
  }
  return true;
}

export interface LineItemRowComparison {
  rowIndex: number;
  matched: boolean;
  columns: Array<{ key: string; matched: boolean }>;
}

export interface LineItemsComparison {
  extractedRowCount: number;
  goldRowCount: number;
  rowCountMatches: boolean;
  // Positional (extracted row i vs gold row i) — kept for diagnostic detail (which
  // specific position differs), but NOT what allMatch is based on; a document whose
  // rows are extracted in a different but internally-consistent order would show every
  // row here as non-matching even though nothing is actually wrong. Read this only
  // alongside allMatch, never as the pass/fail signal on its own.
  rows: LineItemRowComparison[];
  // The real pass/fail signal: true iff row counts match AND the multiset of
  // extracted rows equals the multiset of gold rows, order-independent. Confirmed
  // live (Phase 7 checkpoint) that this distinction matters in practice, not just in
  // theory — three real scanned documents extract every line item correctly but in
  // reversed row order (plausibly the OCR text layer linearizing scanned tables
  // differently than a clean PDF's text stream); a positional-only check flagged all
  // three as complete misses despite zero actual value errors.
  allMatch: boolean;
}

export function compareLineItems(extractedRows: Array<Record<string, unknown>>, goldRows: GoldLineItem[]): LineItemsComparison {
  const rowCountMatches = extractedRows.length === goldRows.length;
  const rows: LineItemRowComparison[] = goldRows.map((goldRow, i) => {
    const extractedRow = extractedRows[i];
    const columns = Object.entries(LINE_ITEM_COLUMN_TYPES).map(([key, type]) => ({
      key,
      matched: extractedRow
        ? valuesMatch(type, extractedRow[key] as string | number | null | undefined, (goldRow as unknown as Record<string, string | number>)[key])
        : false,
    }));
    return { rowIndex: i, matched: columns.every((c) => c.matched), columns };
  });
  const orderIndependentMatch = multisetEqual(
    extractedRows.map((r) => rowSignature(r)),
    goldRows.map((g) => rowSignature(g as unknown as Record<string, unknown>)),
  );
  return {
    extractedRowCount: extractedRows.length,
    goldRowCount: goldRows.length,
    rowCountMatches,
    rows,
    allMatch: orderIndependentMatch,
  };
}
