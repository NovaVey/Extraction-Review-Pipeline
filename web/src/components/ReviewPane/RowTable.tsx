import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import type { ActionOutcome, ReviewItemColumn, ReviewItemRow } from '../../types';
import { ResolutionStatusBadge } from './Badges';

interface RowTableProps {
  rows: ReviewItemRow[];
  onAcceptRow: (rowId: string) => Promise<ActionOutcome>;
  onCorrectRow: (rowId: string, columnKey: string, newValue: string) => Promise<ActionOutcome>;
  // Reverts an already-resolved (confirmed) row back to needs_review — same
  // "reachable any time, not just right after resolving it" reasoning as
  // ReviewPane's onUndoField. Rows never reach 'corrected' as a distinct status
  // (correctRow lands on 'confirmed' too — see actions.ts), so unlike ReviewPane
  // there's only one resolved status to check for here.
  onUndoRow: (rowId: string) => Promise<ActionOutcome>;
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

export function RowTable({ rows, onAcceptRow, onCorrectRow, onUndoRow, locked = false }: RowTableProps) {
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
            <RowTableRow
              key={row.id}
              row={row}
              columns={columns}
              onAcceptRow={onAcceptRow}
              onCorrectRow={onCorrectRow}
              onUndoRow={onUndoRow}
              locked={locked}
            />
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
  onUndoRow: (rowId: string) => Promise<ActionOutcome>;
  locked: boolean;
}

function RowTableRow({ row, columns, onAcceptRow, onCorrectRow, onUndoRow, locked }: RowTableRowProps) {
  // Prefer the reviewer-confirmed cells once the row is resolved, rather than the
  // (possibly stale, pre-correction) extracted cells — same reasoning as
  // ReviewPane's identical fix, for the same "jump to an already-resolved document"
  // reason. Memoized (not a plain const) so its REFERENCE only changes when the
  // underlying row data actually does — needed so the reset effect below can
  // legitimately depend on it directly, the same way ReviewPane's own reset effect
  // depends on its (naturally reference-stable, because it's a primitive string)
  // originalValue; a fresh object every render here would otherwise re-fire that
  // effect (and wipe in-progress edits) on every keystroke.
  const displayCells = row.status === 'needs_review' ? row.cells : (row.finalCells ?? row.cells);
  const originals = useMemo(
    () => Object.fromEntries(columns.map((col) => [col.key, String(displayCells[col.key] ?? '')])),
    [columns, displayCells],
  );
  const [values, setValues] = useState<Record<string, string>>(originals);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [undoPending, setUndoPending] = useState(false);
  const canAccept = row.status === 'needs_review';
  // Rows only ever land on 'confirmed' (both accept-as-is and correctRow use that
  // one status — see actions.ts's correctRow), so unlike ReviewPane's canUndo
  // there's no 'corrected' variant to also check.
  const canUndo = row.status === 'confirmed';
  const busy = pending || saved || locked;

  // Every existing mutation path here (accept-as-is, correct) is self-consistent
  // without this: the component always drives its own edits, and its local state
  // (values/saved) already reflects the outcome by the time the parent's row prop
  // catches up ~400ms later (runAction's debounced refetch) -- by then rendering has
  // already moved on to canAccept-gated UI regardless of saved's value. Undo breaks
  // that: it changes row.cells/finalCells "backward" while this component stays
  // mounted with the same key (undoing a row doesn't change which FIELD is open, so
  // unlike jumping fields via ReviewPane's own key, this component never remounts).
  // Without this, a just-undone row would keep showing its stale pre-undo values
  // once it becomes editable again.
  useEffect(() => {
    setValues(originals);
    setError(null);
    setSaved(false);
    setUndoPending(false);
  }, [row.id, originals]);

  async function handleUndoRow() {
    if (!canUndo || busy || undoPending) return;
    setUndoPending(true);
    setError(null);
    const result = await onUndoRow(row.id);
    setUndoPending(false);
    if (!result.ok) setError(result.message);
  }

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
      // A noop (result.ok but result.noop) means the server 400'd not_needs_review —
      // someone/something else already resolved this row (e.g. the parent field's
      // own Accept bulk-resolving it — see review/actions.ts's acceptField) and
      // runAction() swallowed that as a non-error. The reviewer's typed edit was
      // NOT persisted; showing the same green "Saved" state as a real save here
      // would silently discard it with no indication anything was off.
      if (result.noop) { setError('Already resolved elsewhere — refresh to see the current value.'); return; }
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
    // Same noop case as handleCellKeyDown above — nothing was actually accepted.
    if (result.noop) { setError('Already resolved elsewhere — refresh to see the current value.'); return; }
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
            <div className="flex flex-wrap items-center gap-1.5">
              <ResolutionStatusBadge status={row.status} />
              {canUndo && (
                <button
                  type="button"
                  onClick={() => void handleUndoRow()}
                  disabled={undoPending}
                  aria-label={`Undo row ${row.rowIndex + 1}`}
                  className="flex items-center gap-1 rounded-md border border-[#D1D5DB] bg-gray-50 px-1.5 py-0.5 text-xs font-medium text-[#4B5563] hover:bg-gray-100 disabled:opacity-60"
                >
                  <RotateCcw size={11} /> {undoPending ? '…' : 'Undo'}
                </button>
              )}
            </div>
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
