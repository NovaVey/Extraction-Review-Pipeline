import { useEffect, useState, type KeyboardEvent } from 'react';
import { Check, Pencil } from 'lucide-react';
import type { ActionOutcome, ReviewItem } from '../../types';
import { ConfidenceBadge, CrossFieldChecksList, ResolutionStatusBadge, ValidatorStatusBadge } from './Badges';
import { RowTable } from './RowTable';

interface ReviewPaneProps {
  item: ReviewItem;
  onAcceptField: (fieldValueId: string) => Promise<ActionOutcome>;
  onCorrectField: (fieldValueId: string, newValue: string) => Promise<ActionOutcome>;
  onAcceptRow: (rowId: string) => Promise<ActionOutcome>;
  onCorrectRow: (rowId: string, columnKey: string, newValue: string) => Promise<ActionOutcome>;
  // True while the app is transitioning to the next item after a resolved action —
  // dimmed visually by the parent already, but that alone (pointer-events-none)
  // doesn't stop an already-focused control from still receiving keystrokes, so
  // this actually disables the controls too.
  locked?: boolean;
  // True when this exact field was just accepted via the global "nothing focused"
  // keyboard shortcut rather than this component's own Accept button/input Enter
  // handler — that path bypasses local state entirely, so without this the "Saved"
  // confirmation would never show for what is actually the most common interaction.
  globallyAccepted?: boolean;
}

const DIFFICULTY_TOKENS = new Set(['clean', 'scanned', 'multipage', 'edge', 'case']);

// "invoice_clean_01.pdf" -> "Invoice" — drops the synthetic-corpus difficulty tag
// and trailing index rather than showing raw fixture naming in the product UI;
// the real filename is still available via the title attribute where it's used.
function humanizeFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  const parts = base.split('_');
  const kept = parts.filter((p) => !/^\d+$/.test(p) && !DIFFICULTY_TOKENS.has(p.toLowerCase()));
  const words = kept.length > 0 ? kept : parts;
  return words.map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

export function ReviewPane({ item, onAcceptField, onCorrectField, onAcceptRow, onCorrectRow, locked = false, globallyAccepted = false }: ReviewPaneProps) {
  const originalValue = item.normalizedValue ?? '';
  const [value, setValue] = useState(originalValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which control most recently saved successfully, so only that one shows the
  // brief "Saved" confirmation rather than both buttons claiming it at once.
  const [savedVia, setSavedVia] = useState<'accept' | 'correct' | null>(null);

  // New item loaded (fieldValueId changed) — start the input fresh rather than
  // carrying over the previous item's edit state.
  useEffect(() => {
    setValue(originalValue);
    setError(null);
    setSavedVia(null);
  }, [item.fieldValueId, originalValue]);

  const isChanged = value !== originalValue;
  // Always true for scalar fields (the queue only ever surfaces those when the
  // field itself is needs_review). For a table field it can be false: the field
  // may already be resolved while it's shown here purely because one of its rows
  // still needs review — accepting/correcting it again would 400 not_needs_review.
  const canActOnField = item.status === 'needs_review';
  // Folds in `locked` (mirrors RowTable's identical `busy`) so these handlers have
  // their own JS-level circuit breaker, not just the disabled DOM attribute — matches
  // RowTableRow's handleAcceptRow/handleCellKeyDown, which already re-check this
  // explicitly rather than trusting `disabled` alone to prevent the action firing.
  const busy = pending || savedVia !== null || globallyAccepted || locked;

  async function handleAccept() {
    if (!canActOnField || busy) return;
    setPending(true);
    setError(null);
    const result = await onAcceptField(item.fieldValueId);
    setPending(false);
    if (!result.ok) { setError(result.message); return; }
    setSavedVia('accept');
  }

  async function handleSaveCorrection() {
    if (!canActOnField || !isChanged || busy) return;
    setPending(true);
    setError(null);
    const result = await onCorrectField(item.fieldValueId, value);
    setPending(false);
    if (!result.ok) { setError(result.message); return; }
    setSavedVia('correct');
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      // Stop this from also reaching the App-level "nothing focused" shortcut.
      event.stopPropagation();
      if (isChanged) void handleSaveCorrection();
      else void handleAccept();
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      setValue(originalValue);
      event.currentTarget.blur();
    }
  }

  const label = item.label.trim().length > 0 ? item.label : item.fieldKey;
  const inputId = `review-value-${item.fieldValueId}`;
  const acceptSaved = savedVia === 'accept' || globallyAccepted;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <p className="text-xs text-[#4B5563]" title={item.documentFilename}>
          {humanizeFilename(item.documentFilename)}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight text-[#101114]">{label}</h2>
          <span className="inline-flex items-center rounded-full border border-[#E5E7EB] bg-[#F3F4F6] px-2 py-0.5 text-xs font-medium text-[#4B5563]">
            {item.fieldType}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ConfidenceBadge confidence={item.confidence} />
        <ValidatorStatusBadge status={item.validatorStatus} />
        {!canActOnField && <ResolutionStatusBadge status={item.status} />}
      </div>

      {item.confidenceParts.crossFieldChecks.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[#4B5563]">Cross-field checks</p>
          <CrossFieldChecksList checks={item.confidenceParts.crossFieldChecks} />
        </div>
      )}

      <div>
        <label htmlFor={inputId} className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-[#4B5563]">
          <Pencil size={12} />
          {item.fieldType === 'table' ? 'Table value' : 'Value'}
        </label>
        <div className="flex items-center gap-2">
          <input
            id={inputId}
            type="text"
            value={value}
            disabled={!canActOnField || busy}
            autoFocus={canActOnField}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleInputKeyDown}
            className="w-full max-w-sm rounded-md border border-[#D1D5DB] bg-white px-2 py-1.5 text-sm disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void handleAccept()}
            disabled={!canActOnField || busy}
            className={`flex items-center gap-1 whitespace-nowrap rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${
              acceptSaved ? 'border-green-600 bg-green-600 text-white' : 'border-brand bg-brand text-white hover:bg-brand-hover'
            }`}
          >
            {acceptSaved ? (
              <>
                <Check size={14} /> Saved
              </>
            ) : (
              'Accept'
            )}
          </button>
          <button
            type="button"
            onClick={() => void handleSaveCorrection()}
            disabled={!canActOnField || !isChanged || busy}
            className={`flex items-center gap-1 whitespace-nowrap rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${
              savedVia === 'correct'
                ? 'border-green-600 bg-green-600 text-white'
                : 'border-[#D1D5DB] bg-gray-50 text-[#101114] hover:bg-gray-100'
            }`}
          >
            {savedVia === 'correct' ? (
              <>
                <Check size={14} /> Saved
              </>
            ) : (
              'Save correction'
            )}
          </button>
        </div>
        {!canActOnField && (
          <p className="mt-1 text-xs text-[#4B5563]">
            This field is already {item.status.replaceAll('_', ' ')} — only its rows below still need review.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {error}
          </p>
        )}
      </div>

      {item.fieldType === 'table' && item.rows && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-[#4B5563]">
            Accepting the field above resolves any rows below still marked "needs review" too — row-level accepts aren't the only
            way to clear them.
          </p>
          <RowTable rows={item.rows} onAcceptRow={onAcceptRow} onCorrectRow={onCorrectRow} locked={locked} />
        </div>
      )}
    </div>
  );
}
