import { eq, and, or, inArray, asc, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, extractions, extractionSchemas, fieldValues, fieldValueRows, pages } from '../db/schema.js';
import type { FieldSpec, FieldType } from '../extract/schema.js';

export interface ReviewItemRow {
  id: string;
  rowIndex: number;
  cells: Record<string, unknown>;
  confidence: string;
  confidenceParts: unknown;
  status: string;
  columns: Array<{ key: string; label: string; type: string }>;
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
  confidenceParts: unknown;
  validatorStatus: string;
  status: string;
  rows: ReviewItemRow[] | null;
  pages: Array<{ id: string; pageNumber: number; width: number; height: number }>;
}

interface LatestExtractionRef {
  id: string;
  schemaId: string;
}

// A document can be re-extracted (extractDocument inserts a brand-new extractions row
// every run), which can leave an older extraction's field_values stuck at
// needs_review forever if nothing ever resolves them. The queue must only ever
// surface a document's CURRENT extraction, so every candidate's extractionId is
// checked against this (memoized) per-document lookup before it's allowed to win.
async function getLatestExtraction(
  documentId: string,
  cache: Map<string, LatestExtractionRef | undefined>,
): Promise<LatestExtractionRef | undefined> {
  if (cache.has(documentId)) return cache.get(documentId);
  const [latest] = await db
    .select({ id: extractions.id, schemaId: extractions.schemaId })
    .from(extractions)
    .where(eq(extractions.documentId, documentId))
    .orderBy(desc(extractions.startedAt))
    .limit(1);
  cache.set(documentId, latest);
  return latest;
}

export async function getNextReviewItem(batchId?: string): Promise<ReviewItem | null> {
  // Row-level candidates: a table field can have an outstanding needs_review row even
  // while the field's own reconciled status is already auto_accepted, so this list is
  // ORed onto the field-level status filter rather than replacing it.
  const needsReviewRows = await db
    .select({ fieldValueId: fieldValueRows.fieldValueId })
    .from(fieldValueRows)
    .where(eq(fieldValueRows.status, 'needs_review'));
  const rowCandidateFieldValueIds = [...new Set(needsReviewRows.map((r) => r.fieldValueId))];

  const statusCondition =
    rowCandidateFieldValueIds.length > 0
      ? or(eq(fieldValues.status, 'needs_review'), inArray(fieldValues.id, rowCandidateFieldValueIds))
      : eq(fieldValues.status, 'needs_review');

  const conditions = [statusCondition];
  if (batchId) {
    const batchDocuments = await db.select({ id: documents.id }).from(documents).where(eq(documents.batchId, batchId));
    const batchDocumentIds = batchDocuments.map((d) => d.id);
    if (batchDocumentIds.length === 0) return null;
    conditions.push(inArray(fieldValues.documentId, batchDocumentIds));
  }

  // Lowest confidence first is a documented v1 simplification: a table field whose own
  // confidence is high but which has one bad row isn't prioritized by that row's
  // severity. Acceptable for now rather than adding computed sort logic.
  const candidates = await db
    .select()
    .from(fieldValues)
    .where(and(...conditions))
    .orderBy(asc(fieldValues.confidence), asc(fieldValues.id));
  if (candidates.length === 0) return null;

  const latestExtractionCache = new Map<string, LatestExtractionRef | undefined>();
  let chosen: (typeof candidates)[number] | null = null;
  let chosenExtraction: LatestExtractionRef | undefined;
  for (const candidate of candidates) {
    const latest = await getLatestExtraction(candidate.documentId, latestExtractionCache);
    if (latest && latest.id === candidate.extractionId) {
      chosen = candidate;
      chosenExtraction = latest;
      break;
    }
  }
  if (!chosen || !chosenExtraction) return null;

  const [document] = await db.select().from(documents).where(eq(documents.id, chosen.documentId)).limit(1);
  const [schemaRow] = await db.select().from(extractionSchemas).where(eq(extractionSchemas.id, chosenExtraction.schemaId)).limit(1);
  const pageRows = await db.select().from(pages).where(eq(pages.documentId, chosen.documentId)).orderBy(asc(pages.pageNumber));

  const fields = (schemaRow?.fields as FieldSpec[] | undefined) ?? [];
  const fieldSpec = fields.find((f) => f.key === chosen!.fieldKey);

  let rows: ReviewItemRow[] | null = null;
  if (chosen.fieldType === 'table') {
    const rowRecords = await db
      .select()
      .from(fieldValueRows)
      .where(eq(fieldValueRows.fieldValueId, chosen.id))
      .orderBy(asc(fieldValueRows.rowIndex));
    const columns = (fieldSpec?.columns ?? []).map((c) => ({ key: c.key, label: c.label, type: c.type }));
    rows = rowRecords.map((r) => ({
      id: r.id,
      rowIndex: r.rowIndex,
      cells: r.cells as Record<string, unknown>,
      confidence: r.confidence,
      confidenceParts: r.confidenceParts,
      status: r.status,
      columns,
    }));
  }

  return {
    fieldValueId: chosen.id,
    documentId: chosen.documentId,
    documentFilename: document?.filename ?? '',
    fieldKey: chosen.fieldKey,
    fieldType: chosen.fieldType as FieldType,
    label: fieldSpec?.label ?? chosen.fieldKey,
    description: fieldSpec?.description ?? '',
    rawValue: chosen.rawValue,
    normalizedValue: chosen.normalizedValue,
    confidence: chosen.confidence,
    confidenceParts: chosen.confidenceParts,
    validatorStatus: chosen.validatorStatus,
    status: chosen.status,
    rows,
    pages: pageRows.map((p) => ({ id: p.id, pageNumber: p.pageNumber, width: p.width, height: p.height })),
  };
}
