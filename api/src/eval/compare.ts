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

export interface LineItemRowComparison {
  rowIndex: number;
  matched: boolean;
  columns: Array<{ key: string; matched: boolean }>;
}

export interface LineItemsComparison {
  extractedRowCount: number;
  goldRowCount: number;
  rowCountMatches: boolean;
  rows: LineItemRowComparison[];
  // True only when row counts match AND every row matches on every column.
  // Rows are compared positionally (extracted row i vs gold row i) — this corpus's
  // line items are generated and, in practice, extracted in stable order, so an
  // alignment algorithm wasn't built for v1. A genuine reordering would show up as
  // every row after the swap point mismatching, not as a crash.
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
  return {
    extractedRowCount: extractedRows.length,
    goldRowCount: goldRows.length,
    rowCountMatches,
    rows,
    allMatch: rowCountMatches && rows.every((r) => r.matched),
  };
}
