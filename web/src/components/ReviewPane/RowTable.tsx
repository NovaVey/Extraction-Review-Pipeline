import { useState, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import type { ActionOutcome, ReviewItemColumn, ReviewItemRow } from '../../types';
import { ResolutionStatusBadge } from './Badges';

interface RowTableProps {
  rows: ReviewItemRow[];
  onAcceptRow: (rowId: string) => Promise<ActionOutcome>;
  onCorrectRow: (rowId: string, columnKey: string, newValue: string) => Promise<ActionOutcome>;
  locked?: boolean;
}

// The action column doesn't need much room, and by convention (see
// scripts/fieldSpecs.ts's LINE_ITEM_COLUMNS) the first data column is always the
// long free-text one ("Description") while the rest are short numbers/currency —
// giving every data column an equal share was starving the one that actually
// needs it, which is what left it visibly truncated even after table-fixed
// stopped it from blowing out the table's total width.
const ROW_ACTION_COL_PCT = 20;
const FIRST_COL_PCT = 34;

export function RowTable({ rows, onAcceptRow, onCorrectRow, locked = false }: RowTableProps) {
  if (rows.length === 0) return <p className="text-sm text-[#4B5563]">This table has no rows.</p>;

  // Columns are constant across every row of the same table field (per FieldSpec),
  // so the first row's columns are representative of all of them.
  const columns = rows[0].columns;
  const firstColPct = columns.length > 1 ? FIRST_COL_PCT : 100 - ROW_ACTION_COL_PCT;
  const restColPct = columns.length > 1 ? (100 - ROW_ACTION_COL_PCT - FIRST_COL_PCT) / (columns.length - 1) : 0;

  return (
    <div className="overflow-x-auto rounded-md border border-[#E5E7EB]">
      <table className="w-full table-fixed text-sm">
        <colgroup>
          {columns.map((col, i) => (
            <col key={col.key} style={{ width: `${i === 0 ? firstColPct : restColPct}%` }} />
          ))}
          <col style={{ width: `${ROW_ACTION_COL_PCT}%` }} />
        </colgroup>
        <thead>
          <tr className="bg-[#F9FAFB] text-left">
            {columns.map((col) => (
              <th key={col.key} className="truncate border-b border-[#E5E7EB] px-2 py-1.5 font-medium text-[#101114]">
                {col.label}
              </th>
            ))}
            <th className="border-b border-[#E5E7EB] px-2 py-1.5 font-medium text-[#101114]">Row</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <RowTableRow key={row.id} row={row} columns={columns} onAcceptRow={onAcceptRow} onCorrectRow={onCorrectRow} locked={locked} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface RowTableRowProps {
  row: ReviewItemRow;
  columns: ReviewItemColumn[];
  onAcceptRow: (rowId: string) => Promise<ActionOutcome>;
  onCorrectRow: (rowId: string, columnKey: string, newValue: string) => Promise<ActionOutcome>;
  locked: boolean;
}

function RowTableRow({ row, columns, onAcceptRow, onCorrectRow, locked }: RowTableRowProps) {
  const originals = Object.fromEntries(columns.map((col) => [col.key, String(row.cells[col.key] ?? '')]));
  const [values, setValues] = useState<Record<string, string>>(originals);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const canAccept = row.status === 'needs_review';
  const busy = pending || saved || locked;

  async function handleCellKeyDown(event: KeyboardEvent<HTMLInputElement>, columnKey: string) {
    if (event.key === 'Enter') {
      // Never let this bubble to the App-level "nothing focused" shortcut.
      event.stopPropagation();
      // A row already resolved (auto_accepted/confirmed/corrected) is still shown for
      // context — the queue returns every row of a table field, not just flagged ones
      // — but correctRow() 400s not_needs_review for it, and runAction() treats that
      // specific 400 as a silent success (someone/something else already resolved this
      // item). Without this guard the reviewer's edit would be discarded with no
      // visible error at all.
      if (!canAccept || values[columnKey] === originals[columnKey] || busy) return;
      setPending(true);
      setError(null);
      const result = await onCorrectRow(row.id, columnKey, values[columnKey]);
      setPending(false);
      if (!result.ok) { setError(result.message); return; }
      setSaved(true);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      setValues((v) => ({ ...v, [columnKey]: originals[columnKey] }));
      event.currentTarget.blur();
    }
  }

  async function handleAcceptRow() {
    if (!canAccept || busy) return;
    setPending(true);
    setError(null);
    const result = await onAcceptRow(row.id);
    setPending(false);
    if (!result.ok) { setError(result.message); return; }
    setSaved(true);
  }

  return (
    <tr>
      {columns.map((col) => (
        <td key={col.key} className="border-b border-[#E5E7EB] px-2 py-1 align-top">
          <input
            type="text"
            value={values[col.key]}
            disabled={busy || !canAccept}
            aria-label={`${col.label}, row ${row.rowIndex + 1}`}
            onChange={(e) => setValues((v) => ({ ...v, [col.key]: e.target.value }))}
            onKeyDown={(e) => void handleCellKeyDown(e, col.key)}
            className="w-full min-w-0 truncate rounded bg-transparent px-1.5 py-1 text-sm disabled:opacity-50"
          />
        </td>
      ))}
      <td className="border-b border-[#E5E7EB] px-2 py-1 align-top">
        <div className="flex flex-col items-start gap-1">
          {canAccept ? (
            <button
              type="button"
              onClick={() => void handleAcceptRow()}
              disabled={busy}
              className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-60 ${
                saved ? 'border-green-600 bg-green-600 text-white' : 'border-brand bg-brand text-white hover:bg-brand-hover'
              }`}
            >
              {saved ? (
                <>
                  <Check size={12} /> Saved
                </>
              ) : (
                'Accept row'
              )}
            </button>
          ) : (
            <ResolutionStatusBadge status={row.status} />
          )}
          {error && (
            <span role="alert" className="text-xs text-red-600">
              {error}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}
