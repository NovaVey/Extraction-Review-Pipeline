// Mirrors api/src/review/queue.ts (ReviewItem/ReviewItemRow) and
// api/src/review/actions.ts (ActionResult). Kept as a hand-duplicated contract
// rather than a shared import — web and api are separate workspaces/tsconfigs
// with no path alias between them, and this is the exact wire shape, not an
// internal type worth abstracting over.

export type FieldType = 'string' | 'number' | 'money' | 'date' | 'enum' | 'table';

export interface CrossFieldCheck {
  name: string;
  passed: boolean;
}

// api/src/extract/run.ts is what actually writes confidence_parts; queue.ts only
// types it as `unknown` because it's a jsonb column, but this is the real shape.
export interface ConfidenceParts {
  sampleAgreement: number;
  validatorStatus: string;
  crossFieldChecks: CrossFieldCheck[];
}

export interface ReviewItemColumn {
  key: string;
  label: string;
  type: string;
}

export interface ReviewItemRow {
  id: string;
  rowIndex: number;
  cells: Record<string, unknown>;
  // The reviewer-confirmed cells, when this row has already been resolved via a
  // correction — null otherwise. Prefer this over `cells` for display whenever the
  // row is resolved, so a document opened via "jump to document" shows what was
  // actually decided rather than the stale pre-correction extracted value.
  finalCells: Record<string, unknown> | null;
  confidence: string;
  confidenceParts: ConfidenceParts;
  status: string;
  columns: ReviewItemColumn[];
}

export interface ReviewItemPage {
  id: string;
  pageNumber: number;
  width: number;
  height: number;
}

export interface ReviewItem {
  fieldValueId: string;
  documentId: string;
  documentFilename: string;
  batchId: string | null;
  fieldKey: string;
  fieldType: FieldType;
  label: string;
  description: string;
  rawValue: string | null;
  normalizedValue: string | null;
  // Same reasoning as ReviewItemRow.finalCells, for the field level.
  finalValue: string | null;
  confidence: string;
  confidenceParts: ConfidenceParts;
  validatorStatus: string;
  status: string;
  rows: ReviewItemRow[] | null;
  pages: ReviewItemPage[];
}

export interface ActionResult {
  id: string;
  status: string;
}

// Mirrors api/src/review/queue.ts's ReviewQueueStats.
export interface ReviewQueueStats {
  totalItems: number;
  needsReview: number;
  autoAccepted: number;
  confirmed: number;
  corrected: number;
}

export interface ReviewSession {
  id: string;
  reviewer: string;
  batchId: string | null;
  startedAt: string;
}

// Mirrors api/src/review/queue.ts's BatchFieldSummary — one entry per reviewable
// field on a document, always present regardless of resolution status (the Queue
// Progress stat rows intentionally keep every field listed even once resolved, so a
// reviewer can jump back and double-check or undo any decision at any time). `status`
// is already bucketed server-side (a table field with a still-pending row buckets as
// needs_review even though its own field-level status is auto_accepted) using the
// same precedence as ReviewQueueStats, so the two never disagree about a count.
export interface BatchFieldSummary {
  fieldValueId: string;
  fieldKey: string;
  label: string;
  status: 'needs_review' | 'auto_accepted' | 'confirmed' | 'corrected';
}

// Mirrors api/src/routes/batches.ts's GET /batches/:id response — a trimmed,
// needsReview-badged view of a batch's active (non-archived) documents, not the raw
// documents table row.
export interface BatchDocumentSummary {
  id: string;
  filename: string;
  status: string;
  needsReview: boolean;
  // A real identifying value (an invoice number or vendor name) pulled from the
  // document's own extraction, when one's available — null falls back to a
  // cleaned-up filename in the UI.
  displayName: string | null;
  fields: BatchFieldSummary[];
}

export interface BatchWithDocuments {
  id: string;
  name: string;
  status: string;
  documents: BatchDocumentSummary[];
}

// What action handlers resolve to once a mutation attempt is fully settled —
// lets ReviewPane/RowTable show an inline error next to the control that
// failed without App needing to track per-control error state itself. `noop`
// distinguishes "this call genuinely resolved the item" from runAction's
// not_needs_review passthrough (someone/something else already resolved it) —
// only a genuine resolution should ever surface an Undo affordance.
export type ActionOutcome = { ok: true; noop?: boolean } | { ok: false; message: string };
