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
  fieldKey: string;
  fieldType: FieldType;
  label: string;
  description: string;
  rawValue: string | null;
  normalizedValue: string | null;
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

export interface ReviewSession {
  id: string;
  reviewer: string;
  batchId: string | null;
  startedAt: string;
}

// What action handlers resolve to once a mutation attempt is fully settled —
// lets ReviewPane/RowTable show an inline error next to the control that
// failed without App needing to track per-control error state itself.
export type ActionOutcome = { ok: true } | { ok: false; message: string };
