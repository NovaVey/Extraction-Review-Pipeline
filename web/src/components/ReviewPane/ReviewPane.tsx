import { useEffect, useState, type KeyboardEvent } from 'react';
import type { ActionOutcome, ReviewItem } from '../../types';
import { ConfidenceBadge, CrossFieldChecksList, ResolutionStatusBadge, ValidatorStatusBadge } from './Badges';
import { RowTable } from './RowTable';

interface ReviewPaneProps {
  item: ReviewItem;
  onAcceptField: (fieldValueId: string) => Promise<ActionOutcome>;
  onCorrectField: (fieldValueId: string, newValue: string) => Promise<ActionOutcome>;
  onAcceptRow: (rowId: string) => Promise<ActionOutcome>;
  onCorrectRow: (rowId: string, columnKey: string, newValue: string) => Promise<ActionOutcome>;
}

export function ReviewPane({ item, onAcceptField, onCorrectField, onAcceptRow, onCorrectRow }: ReviewPaneProps) {
  const originalValue = item.normalizedValue ?? '';
  const [value, setValue] = useState(originalValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New item loaded (fieldValueId changed) — start the input fresh rather than
  // carrying over the previous item's edit state.
  useEffect(() => {
    setValue(originalValue);
    setError(null);
  }, [item.fieldValueId, originalValue]);

  const isChanged = value !== originalValue;
  // Always true for scalar fields (the queue only ever surfaces those when the
  // field itself is needs_review). For a table field it can be false: the field
  // may already be resolved while it's shown here purely because one of its rows
  // still needs review — accepting/correcting it again would 400 not_needs_review.
  const canActOnField = item.status === 'needs_review';

  async function handleAccept() {
    if (!canActOnField || pending) return;
    setPending(true);
    setError(null);
    const result = await onAcceptField(item.fieldValueId);
    setPending(false);
    if (!result.ok) setError(result.message);
  }

  async function handleSaveCorrection() {
    if (!canActOnField || !isChanged || pending) return;
    setPending(true);
    setError(null);
    const result = await onCorrectField(item.fieldValueId, value);
    setPending(false);
    if (!result.ok) setError(result.message);
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

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <p className="text-xs text-[#6B7280]">{item.documentFilename}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-[#101114]">{label}</h2>
          <span className="inline-flex items-center rounded-full border border-[#E5E7EB] bg-[#F3F4F6] px-2 py-0.5 text-xs font-medium text-[#6B7280]">
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
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[#6B7280]">Cross-field checks</p>
          <CrossFieldChecksList checks={item.confidenceParts.crossFieldChecks} />
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[#6B7280]">
          {item.fieldType === 'table' ? 'Table value' : 'Value'}
        </label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={value}
            disabled={!canActOnField || pending}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleInputKeyDown}
            className="w-full max-w-sm rounded border border-[#E5E7EB] bg-white px-2 py-1.5 text-sm disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void handleAccept()}
            disabled={!canActOnField || pending}
            className="whitespace-nowrap rounded border border-[#101114] bg-[#101114] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Accept
          </button>
          <button
            type="button"
            onClick={() => void handleSaveCorrection()}
            disabled={!canActOnField || !isChanged || pending}
            className="whitespace-nowrap rounded border border-[#E5E7EB] bg-white px-3 py-1.5 text-sm font-medium text-[#101114] disabled:opacity-50"
          >
            Save correction
          </button>
        </div>
        {!canActOnField && (
          <p className="mt-1 text-xs text-[#6B7280]">
            This field is already {item.status.replaceAll('_', ' ')} — only its rows below still need review.
          </p>
        )}
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>

      {item.fieldType === 'table' && item.rows && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-[#6B7280]">
            Accepting the field above resolves any rows below still marked "needs review" too — row-level accepts aren't the only
            way to clear them.
          </p>
          <RowTable rows={item.rows} onAcceptRow={onAcceptRow} onCorrectRow={onCorrectRow} />
        </div>
      )}
    </div>
  );
}
