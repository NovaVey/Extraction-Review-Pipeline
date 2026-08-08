import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { BatchDocumentSummary, BatchFieldSummary, ReviewQueueStats } from '../../types';
import { humanizeFilename } from '../../lib/humanizeFilename';

type StatusKey = BatchFieldSummary['status'];
type Tone = 'amber' | 'teal' | 'green' | 'blue';

interface QueueSidebarProps {
  stats: ReviewQueueStats | null;
  // The batch of whatever document is currently under review, and its sibling
  // documents' live per-field status -- null (not an empty array) while there's no
  // current batch to show yet (no item loaded) or the fetch is still in flight, so
  // the stat rows below stay non-expandable rather than flashing an empty panel.
  batchDocuments: BatchDocumentSummary[] | null;
  currentFieldValueId: string | null;
  onSelectField: (fieldValueId: string) => void;
}

// The 4 top-level counts (the stats prop) are always GLOBAL, across every batch, not
// just the current one -- and stay that way regardless of whether a batch is loaded,
// because EmptyState's "100%, all caught up" display depends on them being available
// with no current document/batch at all. Only the expandable list beneath each row is
// batch-scoped, reusing whatever batchDocuments the sidebar already has in hand
// (App.tsx's existing per-batch fetch) rather than a new cross-batch aggregate. This
// replaces the previous separate "This Batch" dropdown trigger -- these rows already
// show the count that dropdown was undercounting against (it grouped one entry per
// document; this is already per-field), so the fix is to make the rows themselves the
// trigger instead of duplicating a second control beside them.
export function QueueSidebar({ stats, batchDocuments, currentFieldValueId, onSelectField }: QueueSidebarProps) {
  const resolved = stats ? stats.totalItems - stats.needsReview : 0;
  const pct = stats && stats.totalItems > 0 ? Math.round((resolved / stats.totalItems) * 100) : null;
  const [expanded, setExpanded] = useState<StatusKey | null>(null);
  const fieldsByStatus = groupFieldsByStatus(batchDocuments);

  function toggle(status: StatusKey) {
    setExpanded((current) => (current === status ? null : status));
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-[#E5E7EB] bg-white p-4">
      <div>
        <h2 className="text-xs font-medium uppercase tracking-wide text-[#4B5563]">Queue Progress</h2>
        {stats === null ? (
          <p className="mt-2 text-sm text-[#4B5563]">Loading…</p>
        ) : (
          <>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-[#101114]">{pct === null ? '—' : `${pct}%`}</p>
            <p className="text-xs text-[#4B5563]">
              {resolved} of {stats.totalItems} resolved
            </p>
            <div
              role="progressbar"
              aria-label="Queue resolved"
              aria-valuenow={pct ?? 0}
              aria-valuemin={0}
              aria-valuemax={100}
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#F3F4F6] ring-1 ring-inset ring-[#E5E7EB]"
            >
              <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${pct ?? 0}%` }} />
            </div>
          </>
        )}
      </div>

      {stats !== null && (
        <div className="flex flex-col gap-1 text-sm">
          {STAT_ROWS.map((row) => (
            <StatRow
              key={row.status}
              tone={row.tone}
              label={row.label}
              value={statValue(stats, row.status)}
              fields={fieldsByStatus.get(row.status) ?? []}
              expanded={expanded === row.status}
              onToggle={() => toggle(row.status)}
              currentFieldValueId={currentFieldValueId}
              onSelectField={onSelectField}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

const STAT_ROWS: Array<{ tone: Tone; label: string; status: StatusKey }> = [
  { tone: 'amber', label: 'Needs review', status: 'needs_review' },
  { tone: 'teal', label: 'Auto-accepted', status: 'auto_accepted' },
  { tone: 'green', label: 'Confirmed', status: 'confirmed' },
  { tone: 'blue', label: 'Corrected', status: 'corrected' },
];

function statValue(stats: ReviewQueueStats, status: StatusKey): number {
  switch (status) {
    case 'needs_review':
      return stats.needsReview;
    case 'auto_accepted':
      return stats.autoAccepted;
    case 'confirmed':
      return stats.confirmed;
    case 'corrected':
      return stats.corrected;
  }
}

const DOT_CLASSES: Record<Tone, string> = {
  amber: 'bg-amber-500',
  teal: 'bg-teal-500',
  green: 'bg-green-500',
  blue: 'bg-blue-500',
};

interface BatchFieldRef {
  fieldValueId: string;
  fieldLabel: string;
  documentLabel: string;
}

// One entry per (document, field) pair in the current batch, bucketed by the field's
// own status -- same bucketing precedence the backend already applies in
// getBatchFieldSummaries (a table field with a still-pending row buckets as
// needs_review even though its own field-level status is auto_accepted). Returns an
// empty map (every row non-expandable) when there's no current batch loaded yet.
function groupFieldsByStatus(documents: BatchDocumentSummary[] | null): Map<StatusKey, BatchFieldRef[]> {
  const groups = new Map<StatusKey, BatchFieldRef[]>();
  if (!documents) return groups;
  for (const doc of documents) {
    const documentLabel = doc.displayName ?? humanizeFilename(doc.filename);
    for (const field of doc.fields) {
      const list = groups.get(field.status) ?? [];
      list.push({ fieldValueId: field.fieldValueId, fieldLabel: field.label, documentLabel });
      groups.set(field.status, list);
    }
  }
  return groups;
}

interface StatRowProps {
  tone: Tone;
  label: string;
  value: number;
  fields: BatchFieldRef[];
  expanded: boolean;
  onToggle: () => void;
  currentFieldValueId: string | null;
  onSelectField: (fieldValueId: string) => void;
}

// Expandable only when the CURRENT batch actually has a field at this status -- value
// is the global count and can be nonzero with nothing to show here (the matching
// items are all in some other batch, or no batch is loaded at all), in which case the
// row stays a plain, inert count exactly like before this change.
function StatRow({ tone, label, value, fields, expanded, onToggle, currentFieldValueId, onSelectField }: StatRowProps) {
  const expandable = fields.length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={expandable ? onToggle : undefined}
        disabled={!expandable}
        aria-expanded={expandable ? expanded : undefined}
        className="flex w-full items-center justify-between rounded-md px-1 py-1 text-left disabled:cursor-default enabled:hover:bg-gray-50"
      >
        <span className="flex items-center gap-2 text-[#4B5563]">
          <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[tone]}`} />
          {label}
        </span>
        <span className="flex items-center gap-1">
          <span className="font-medium text-[#101114]">{value}</span>
          {expandable && <ChevronDown size={12} className={`text-[#4B5563] transition-transform ${expanded ? 'rotate-180' : ''}`} />}
        </span>
      </button>

      {expanded && expandable && (
        <div role="region" aria-label={`${label} fields in this batch`} className="mt-1 flex max-h-64 flex-col gap-0.5 overflow-y-auto pl-3">
          {fields.map((field) => (
            <button
              key={field.fieldValueId}
              type="button"
              aria-current={field.fieldValueId === currentFieldValueId ? 'true' : undefined}
              title={`${field.documentLabel} — ${field.fieldLabel}`}
              onClick={() => onSelectField(field.fieldValueId)}
              className={`truncate rounded px-1.5 py-1 text-left text-xs ${
                field.fieldValueId === currentFieldValueId ? 'bg-[#F3F4F6] font-medium text-[#101114]' : 'text-[#4B5563] hover:bg-gray-50'
              }`}
            >
              {field.documentLabel} — {field.fieldLabel}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
