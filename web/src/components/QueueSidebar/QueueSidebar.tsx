import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import type { BatchDocumentSummary, ReviewQueueStats } from '../../types';
import { humanizeFilename } from '../../lib/humanizeFilename';

interface QueueSidebarProps {
  stats: ReviewQueueStats | null;
  // The batch of whatever document is currently under review, and its sibling
  // documents' live status -- null (not an empty array) while there's no current
  // batch to show yet (no item loaded) or the fetch is still in flight, so the
  // section can be omitted entirely rather than flashing an empty list.
  batchDocuments: BatchDocumentSummary[] | null;
  currentDocumentId: string | null;
  currentFieldValueId: string | null;
  onSelectDocument: (documentId: string) => void;
  onSelectField: (fieldValueId: string) => void;
}

export function QueueSidebar({
  stats,
  batchDocuments,
  currentDocumentId,
  currentFieldValueId,
  onSelectDocument,
  onSelectField,
}: QueueSidebarProps) {
  const resolved = stats ? stats.totalItems - stats.needsReview : 0;
  const pct = stats && stats.totalItems > 0 ? Math.round((resolved / stats.totalItems) * 100) : null;

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
        <dl className="flex flex-col gap-2 text-sm">
          <StatRow tone="amber" label="Needs review" value={stats.needsReview} />
          <StatRow tone="teal" label="Auto-accepted" value={stats.autoAccepted} />
          <StatRow tone="green" label="Confirmed" value={stats.confirmed} />
          <StatRow tone="blue" label="Corrected" value={stats.corrected} />
        </dl>
      )}

      {batchDocuments !== null && batchDocuments.length > 0 && (
        <BatchDocumentsDropdown
          documents={batchDocuments}
          currentDocumentId={currentDocumentId}
          currentFieldValueId={currentFieldValueId}
          onSelectDocument={onSelectDocument}
          onSelectField={onSelectField}
        />
      )}
    </aside>
  );
}

const DOT_CLASSES: Record<'amber' | 'teal' | 'green' | 'blue', string> = {
  amber: 'bg-amber-500',
  teal: 'bg-teal-500',
  green: 'bg-green-500',
  blue: 'bg-blue-500',
};

function StatRow({ tone, label, value }: { tone: 'amber' | 'teal' | 'green' | 'blue'; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="flex items-center gap-2 text-[#4B5563]">
        <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[tone]}`} />
        {label}
      </dt>
      <dd className="font-medium text-[#101114]">{value}</dd>
    </div>
  );
}

// humanizeFilename strips numbers/difficulty tags by design (fine for a single
// document's own header, where "Invoice" reads cleanly) — but multiple documents in
// this list can collapse to the identical humanized label (every doc in the
// synthetic corpus's own batch is literally named "invoice_clean_NN.pdf"). Pulled
// independently from the raw filename, not from humanizeFilename's output, since
// that function already discarded the number and has no way to hand it back.
const TRAILING_NUMBER_RE = /(\d+)(?=\.[^.]+$)/;

// doc.displayName (a real vendor/invoice number, when the backend found one) is
// preferred; this is only the fallback path for documents with no identifying data
// extracted yet, so a same-batch collision is a real, expected possibility here, not
// an edge case. Only used for the document GROUP HEADER label — field rows
// underneath are labeled with their own field.label, which is always unique within
// one document's own schema (a schema never declares two fields with the same key),
// so no equivalent disambiguation is needed at that level.
function disambiguatedLabels(documents: BatchDocumentSummary[]): Map<string, string> {
  const baseLabelOf = new Map(documents.map((doc) => [doc.id, doc.displayName ?? humanizeFilename(doc.filename)]));
  const counts = new Map<string, number>();
  for (const label of baseLabelOf.values()) counts.set(label, (counts.get(label) ?? 0) + 1);

  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const doc of documents) {
    const base = baseLabelOf.get(doc.id)!;
    if ((counts.get(base) ?? 0) <= 1) {
      labels.set(doc.id, base);
      continue;
    }
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const numberMatch = doc.filename.match(TRAILING_NUMBER_RE);
    labels.set(doc.id, numberMatch ? `${base} #${numberMatch[1]}` : `${base} (${occurrence})`);
  }
  return labels;
}

// Two-level dropdown: each document is a clickable group header (jumps to its
// current-best item, same as before this change) with its own reviewable fields
// listed underneath as independently clickable rows (jump to that EXACT field,
// resolved or not). Previously one entry per document, which undercounted against
// Queue Progress's per-FIELD total whenever a document had more than one field
// needing attention -- see App.tsx's handleSelectDocument/handleSelectField for why
// both jump actions are kept side by side rather than one replacing the other.
function BatchDocumentsDropdown({
  documents,
  currentDocumentId,
  currentFieldValueId,
  onSelectDocument,
  onSelectField,
}: {
  documents: BatchDocumentSummary[];
  currentDocumentId: string | null;
  currentFieldValueId: string | null;
  onSelectDocument: (documentId: string) => void;
  onSelectField: (fieldValueId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const totalFields = documents.reduce((n, d) => n + d.fields.length, 0);
  const needsReviewFieldCount = documents.reduce((n, d) => n + d.fields.filter((f) => f.needsReview).length, 0);
  const labels = disambiguatedLabels(documents);

  // Close on outside click -- no existing dropdown/popover pattern anywhere in this
  // codebase to reuse (verified), so this is the whole mechanism, not a partial one.
  useEffect(() => {
    if (!open) return;
    function handleOutsideClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  // stopPropagation first, matching every other Enter/Escape handler in this
  // codebase (RowTable, ReviewPane) -- without it this would also reach App.tsx's
  // document-level "nothing focused + Enter -> accept" global shortcut.
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setOpen(false);
  }

  function handleSelectDocumentHeader(documentId: string) {
    setOpen(false);
    onSelectDocument(documentId);
  }

  function handleSelectFieldRow(fieldValueId: string) {
    setOpen(false);
    onSelectField(fieldValueId);
  }

  return (
    <div ref={containerRef} className="relative min-h-0" onKeyDown={handleKeyDown}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center justify-between gap-2 rounded-md border border-[#E5E7EB] px-2 py-1.5 text-left hover:bg-gray-50"
      >
        <span className="flex flex-col">
          <span className="text-xs font-medium uppercase tracking-wide text-[#4B5563]">This Batch</span>
          <span className="text-xs text-[#4B5563]">
            {totalFields} field{totalFields === 1 ? '' : 's'}
            {needsReviewFieldCount > 0 && `, ${needsReviewFieldCount} need review`}
          </span>
        </span>
        <ChevronDown size={14} className={`shrink-0 text-[#4B5563] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        // max-h-80/overflow-y-auto: unlike the old one-row-per-document list, this
        // can now hold several rows per document -- a real schema has up to 9 fields
        // (scripts/fieldSpecs.ts) -- so an unbounded-height panel is a real risk here
        // in a way it wasn't before.
        <div
          role="menu"
          aria-label="Fields in this batch"
          className="absolute z-30 mt-1 max-h-80 w-full overflow-y-auto rounded-md border border-[#E5E7EB] bg-white py-1 shadow-lg"
        >
          {documents.map((doc) => (
            <div key={doc.id} role="group" aria-label={labels.get(doc.id)}>
              <button
                type="button"
                role="menuitem"
                title={doc.filename}
                aria-current={doc.id === currentDocumentId ? 'true' : undefined}
                onClick={() => handleSelectDocumentHeader(doc.id)}
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs font-medium ${
                  doc.id === currentDocumentId ? 'bg-[#F3F4F6] text-[#101114]' : 'text-[#101114] hover:bg-gray-50'
                }`}
              >
                <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${doc.needsReview ? 'bg-amber-500' : 'bg-green-500'}`} />
                <span className="truncate">{labels.get(doc.id)}</span>
              </button>
              {doc.fields.map((field) => (
                <button
                  key={field.fieldValueId}
                  type="button"
                  role="menuitem"
                  aria-current={field.fieldValueId === currentFieldValueId ? 'true' : undefined}
                  onClick={() => handleSelectFieldRow(field.fieldValueId)}
                  className={`flex w-full items-center gap-2 py-1 pl-6 pr-2 text-left text-xs ${
                    field.fieldValueId === currentFieldValueId ? 'bg-[#F3F4F6] font-medium text-[#101114]' : 'text-[#4B5563] hover:bg-gray-50'
                  }`}
                >
                  <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${field.needsReview ? 'bg-amber-500' : 'bg-green-500'}`} />
                  <span className="truncate">{field.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
