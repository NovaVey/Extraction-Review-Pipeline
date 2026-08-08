import { eq, and, or, inArray, notInArray, isNotNull, asc, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, extractions, extractionSchemas, fieldValues, fieldValueRows, pages } from '../db/schema.js';
import type { FieldSpec, FieldType } from '../extract/schema.js';
import { DocumentNotFoundError } from '../documents/archive.js';
import { NotFoundError } from './actions.js';
import { RESOLVED_STATUSES } from './status.js';

export interface ReviewItemRow {
  id: string;
  rowIndex: number;
  cells: Record<string, unknown>;
  // The reviewer-confirmed cells, if this row has already been resolved via
  // correctRow — null otherwise. Only meaningful when getReviewItemForDocument's
  // schema-order fallback surfaces an already-resolved row; getNextReviewItem never
  // did (it only ever surfaced needs_review rows), so this was never needed before.
  finalCells: Record<string, unknown> | null;
  confidence: string;
  confidenceParts: unknown;
  status: string;
  columns: Array<{ key: string; label: string; type: string }>;
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
  // The reviewer-confirmed value, if this field has already been resolved via
  // correctField — null otherwise. See ReviewItemRow.finalCells for why this exists.
  finalValue: string | null;
  confidence: string;
  confidenceParts: unknown;
  validatorStatus: string;
  status: string;
  rows: ReviewItemRow[] | null;
  pages: Array<{ id: string; pageNumber: number; width: number; height: number }>;
}

// undoField/undoRow-specific in review/actions.ts, but the same "not resolved by a
// review action" absence shows up here too — thrown by getReviewItemForDocument when
// a document has no extraction at all, or its extraction produced zero field_values
// (e.g. every sample failed to parse — see extract/run.ts). Distinct from
// DocumentNotFoundError so routes/review.ts can report a different code (the
// document itself is fine; there's just nothing to review on it yet).
export class NoReviewableFieldError extends Error {}

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

  // An archived document (soft-deleted "if needed" from the review flow) must never
  // resurface here, regardless of its field_values' own status.
  const archivedDocuments = await db.select({ id: documents.id }).from(documents).where(isNotNull(documents.archivedAt));
  if (archivedDocuments.length > 0) {
    conditions.push(notInArray(fieldValues.documentId, archivedDocuments.map((d) => d.id)));
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
  return buildReviewItem(chosen, chosenExtraction, document);
}

type FieldValueRow = typeof fieldValues.$inferSelect;
type DocumentRow = typeof documents.$inferSelect;

// Shared by getNextReviewItem and getReviewItemForDocument — both end up with a
// chosen field_values row + the extraction it belongs to + its document, and need
// the identical shape built from there (schema/fieldSpec resolution, table-row
// fetching, page list). Takes `document` as a parameter rather than re-querying it
// internally — every call site already has it in hand from its own selection logic.
async function buildReviewItem(
  chosen: FieldValueRow,
  chosenExtraction: LatestExtractionRef,
  document: DocumentRow | undefined,
): Promise<ReviewItem> {
  const [schemaRow] = await db.select().from(extractionSchemas).where(eq(extractionSchemas.id, chosenExtraction.schemaId)).limit(1);
  const pageRows = await db.select().from(pages).where(eq(pages.documentId, chosen.documentId)).orderBy(asc(pages.pageNumber));

  const fields = (schemaRow?.fields as FieldSpec[] | undefined) ?? [];
  const fieldSpec = fields.find((f) => f.key === chosen.fieldKey);

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
      finalCells: (r.finalCells as Record<string, unknown> | null) ?? null,
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
    batchId: document?.batchId ?? null,
    fieldKey: chosen.fieldKey,
    fieldType: chosen.fieldType as FieldType,
    label: fieldSpec?.label ?? chosen.fieldKey,
    description: fieldSpec?.description ?? '',
    rawValue: chosen.rawValue,
    normalizedValue: chosen.normalizedValue,
    finalValue: chosen.finalValue,
    confidence: chosen.confidence,
    confidenceParts: chosen.confidenceParts,
    validatorStatus: chosen.validatorStatus,
    status: chosen.status,
    rows,
    pages: pageRows.map((p) => ({ id: p.id, pageNumber: p.pageNumber, width: p.width, height: p.height })),
  };
}

// Confidence-then-id comparator matching getNextReviewItem's own
// `.orderBy(asc(fieldValues.confidence), asc(fieldValues.id))` — replicated in JS
// here rather than issuing a second SQL query, since a single document's field set
// is small (at most ~9 rows per the real schemas in scripts/fieldSpecs.ts).
function byConfidenceThenId(a: FieldValueRow, b: FieldValueRow): number {
  const byConfidence = Number(a.confidence) - Number(b.confidence);
  if (byConfidence !== 0) return byConfidence;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Powers the batch-documents sidebar's "jump to this document" action — unlike
// getNextReviewItem (which scans globally and returns null when nothing qualifies),
// this always resolves to SOME field on the given document: it prefers one that
// still needs review, but falls back to the first field in the schema's declared
// order when the document is fully resolved, so a reviewer can still open (and
// double-check) a document with nothing currently outstanding.
export async function getReviewItemForDocument(documentId: string): Promise<ReviewItem> {
  const [document] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!document || document.archivedAt) {
    throw new DocumentNotFoundError(`Document not found: ${documentId}`);
  }

  const latestExtraction = await getLatestExtraction(documentId, new Map());
  if (!latestExtraction) {
    throw new NoReviewableFieldError(`Document ${documentId} has never been extracted`);
  }

  // Filtered by extractionId, NOT documentId — documentId is denormalized onto
  // every historical field_values row, so filtering by it alone would silently
  // resurface a superseded extraction's stale data after a re-extract (the same
  // trap getNextReviewItem's getLatestExtraction check exists to avoid).
  const fieldValueRowsForExtraction = await db
    .select()
    .from(fieldValues)
    .where(eq(fieldValues.extractionId, latestExtraction.id));
  if (fieldValueRowsForExtraction.length === 0) {
    throw new NoReviewableFieldError(`Document ${documentId}'s current extraction has no field values`);
  }

  const needsReviewRows = await db
    .select({ fieldValueId: fieldValueRows.fieldValueId })
    .from(fieldValueRows)
    .where(and(eq(fieldValueRows.status, 'needs_review'), inArray(fieldValueRows.fieldValueId, fieldValueRowsForExtraction.map((f) => f.id))));
  const rowPendingFieldValueIds = new Set(needsReviewRows.map((r) => r.fieldValueId));

  const needsReviewCandidates = fieldValueRowsForExtraction
    .filter((fv) => fv.status === 'needs_review' || rowPendingFieldValueIds.has(fv.id))
    .sort(byConfidenceThenId);

  let chosen: FieldValueRow;
  if (needsReviewCandidates.length > 0) {
    chosen = needsReviewCandidates[0];
  } else {
    // Fully resolved document — fall back to the first field in the schema's own
    // declared order that actually has a field_value, regardless of its status.
    const [schemaRow] = await db.select().from(extractionSchemas).where(eq(extractionSchemas.id, latestExtraction.schemaId)).limit(1);
    const schemaFields = (schemaRow?.fields as FieldSpec[] | undefined) ?? [];
    const byFieldKey = new Map(fieldValueRowsForExtraction.map((fv) => [fv.fieldKey, fv]));
    const firstDeclared = schemaFields.map((f) => byFieldKey.get(f.key)).find((fv): fv is FieldValueRow => fv !== undefined);
    // Every field_value's fieldKey should exist in the schema it was extracted
    // against, but degrade to the first field_value found rather than throwing if
    // a hand-edited/legacy row somehow doesn't match — same defensive spirit as
    // buildReviewItem's `fieldSpec?.label ?? chosen.fieldKey` fallback.
    chosen = firstDeclared ?? fieldValueRowsForExtraction[0];
  }

  return buildReviewItem(chosen, latestExtraction, document);
}

// Powers the batch-documents dropdown's per-FIELD "jump to this exact field" action
// (and the in-place Undo button's own post-undo refresh — see App.tsx) — unlike
// getReviewItemForDocument, this is a direct, unambiguous lookup with no candidate
// selection: given an exact field_value id, there's only ever one right answer.
// Always resolves regardless of the field's current status, including already
// resolved — reachable on purpose, so a reviewer can jump back and double-check (or
// undo) any past decision, not just what's currently outstanding.
export async function getReviewItemForField(fieldValueId: string): Promise<ReviewItem> {
  const [chosen] = await db.select().from(fieldValues).where(eq(fieldValues.id, fieldValueId)).limit(1);
  if (!chosen) {
    throw new NotFoundError(`Field value not found: ${fieldValueId}`);
  }

  const [document] = await db.select().from(documents).where(eq(documents.id, chosen.documentId)).limit(1);
  if (!document || document.archivedAt) {
    throw new DocumentNotFoundError(`Document not found: ${chosen.documentId}`);
  }

  const latestExtraction = await getLatestExtraction(chosen.documentId, new Map());
  // Filtered by extractionId, not documentId — same "never surface stale data" guard
  // getReviewItemForDocument already applies via its own extractionId scoping, just
  // expressed as a post-fetch check here since this lookup starts from a field_value
  // id directly rather than a schema-order walk. A field_value id from a superseded
  // extraction (e.g. a stale browser tab open since before a re-extract) must not be
  // treated as current data — and if the document's latest extraction can't be
  // resolved at all, this field can't be current either way.
  if (!latestExtraction || chosen.extractionId !== latestExtraction.id) {
    throw new NotFoundError(`Field value ${fieldValueId} does not belong to ${chosen.documentId}'s current extraction`);
  }

  return buildReviewItem(chosen, latestExtraction, document);
}

export interface ReviewQueueStats {
  totalItems: number;
  needsReview: number;
  autoAccepted: number;
  confirmed: number;
  corrected: number;
}

const EMPTY_STATS: ReviewQueueStats = { totalItems: 0, needsReview: 0, autoAccepted: 0, confirmed: 0, corrected: 0 };

// Shared by getReviewQueueStats and getNeedsReviewDocumentIds below — both need the
// identical "which field_values actually count right now" set (only a document's
// CURRENT extraction counts, so a superseded extraction's stale needs_review field
// is ignored; an archived document never counts regardless of its field_values' own
// status), just aggregated differently. Extracted once both call sites needed it,
// not preemptively — a bugfix to this logic no longer has to be applied twice.
async function getCurrentFieldValuesExcludingArchived(): Promise<{
  currentFieldValues: Array<{ id: string; documentId: string; status: string }>;
  rowPendingFieldValueIds: Set<string>;
}> {
  const archivedDocuments = await db.select({ id: documents.id }).from(documents).where(isNotNull(documents.archivedAt));
  const archivedDocumentIds = new Set(archivedDocuments.map((d) => d.id));

  const allExtractions = await db.select({ documentId: extractions.documentId, id: extractions.id, startedAt: extractions.startedAt }).from(extractions);
  const latestByDocument = new Map<string, { id: string; startedAt: Date }>();
  for (const e of allExtractions) {
    // Same soft-delete exclusion as getNextReviewItem — an archived document's
    // field_values must never count toward these stats either.
    if (archivedDocumentIds.has(e.documentId)) continue;
    const existing = latestByDocument.get(e.documentId);
    if (!existing || e.startedAt > existing.startedAt) latestByDocument.set(e.documentId, { id: e.id, startedAt: e.startedAt });
  }
  const currentExtractionIds = [...new Set([...latestByDocument.values()].map((v) => v.id))];
  // No further queries once there's nothing to count — matches getReviewQueueStats'
  // and getNeedsReviewDocumentIds' original short-circuit behavior exactly (neither
  // fieldValueRows nor fieldValues gets queried when this is empty).
  if (currentExtractionIds.length === 0) return { currentFieldValues: [], rowPendingFieldValueIds: new Set() };

  const needsReviewRows = await db.select({ fieldValueId: fieldValueRows.fieldValueId }).from(fieldValueRows).where(eq(fieldValueRows.status, 'needs_review'));
  const rowPendingFieldValueIds = new Set(needsReviewRows.map((r) => r.fieldValueId));

  const currentFieldValues = await db
    .select({ id: fieldValues.id, documentId: fieldValues.documentId, status: fieldValues.status })
    .from(fieldValues)
    .where(inArray(fieldValues.extractionId, currentExtractionIds));

  return { currentFieldValues, rowPendingFieldValueIds };
}

// Same "only a document's current extraction counts" rule as getNextReviewItem (a
// re-extracted document's superseded field_values must not be counted, needs_review
// or otherwise) and the same row-candidate OR-ing — a field already auto_accepted at
// its own level still counts as needing review here if one of its rows does, since
// that's exactly what would surface it in the queue.
export async function getReviewQueueStats(): Promise<ReviewQueueStats> {
  const { currentFieldValues, rowPendingFieldValueIds } = await getCurrentFieldValuesExcludingArchived();

  const stats = { ...EMPTY_STATS, totalItems: currentFieldValues.length };
  for (const fv of currentFieldValues) {
    if (fv.status === 'needs_review' || rowPendingFieldValueIds.has(fv.id)) stats.needsReview++;
    else if (fv.status === 'auto_accepted') stats.autoAccepted++;
    else if (fv.status === 'confirmed') stats.confirmed++;
    else if (fv.status === 'corrected') stats.corrected++;
  }
  return stats;
}

// Documents whose current extraction has at least one field or row still
// needs_review — used by the batch-documents sidebar to badge which invoices in a
// batch still need attention. Same exclusions as getReviewQueueStats: an archived
// document never counts, and only a document's current extraction counts.
export async function getNeedsReviewDocumentIds(): Promise<Set<string>> {
  const { currentFieldValues, rowPendingFieldValueIds } = await getCurrentFieldValuesExcludingArchived();

  const needsReviewDocumentIds = new Set<string>();
  for (const fv of currentFieldValues) {
    if (fv.status === 'needs_review' || rowPendingFieldValueIds.has(fv.id)) needsReviewDocumentIds.add(fv.documentId);
  }
  return needsReviewDocumentIds;
}

// Batched sibling of getLatestExtraction (single document, cached) — resolves the
// latest extraction per document for a whole set of ids in one query. Shared by
// getDocumentDisplayNames and getBatchFieldSummaries so they can never disagree
// about which extraction is "current" for the same document at the same moment —
// before this existed they were two independent, slightly different reductions of
// an identical query. The id tiebreak matters for real: extractions.startedAt is
// set in application code (extract/run.ts), not a DB default, so two extractions
// for the same document CAN share a millisecond on a scripted bulk re-extract.
async function getLatestExtractionsForDocuments(documentIds: string[]): Promise<Map<string, LatestExtractionRef>> {
  if (documentIds.length === 0) return new Map();
  const relevant = await db
    .select({ documentId: extractions.documentId, id: extractions.id, schemaId: extractions.schemaId, startedAt: extractions.startedAt })
    .from(extractions)
    .where(inArray(extractions.documentId, documentIds));
  const latest = new Map<string, { id: string; schemaId: string; startedAt: Date }>();
  for (const e of relevant) {
    const existing = latest.get(e.documentId);
    if (!existing || e.startedAt > existing.startedAt || (e.startedAt.getTime() === existing.startedAt.getTime() && e.id > existing.id)) {
      latest.set(e.documentId, e);
    }
  }
  return new Map([...latest].map(([documentId, e]) => [documentId, { id: e.id, schemaId: e.schemaId }]));
}

// A per-document display name for the batch-documents sidebar — "invoice_clean_01.pdf"
// tells a reviewer nothing; the invoice number or vendor name on it does. Only
// `type === 'string'` schema fields are considered, in the schema's OWN declared
// order — verified against scripts/fieldSpecs.ts: for every real doc type the first
// declared field is always the document's own identifier (invoice_number/
// receipt_number/po_number) and the second is the counterparty name (vendor_name/
// merchant_name/vendor_name), so "first non-null string field in schema order" finds
// the most identifying value without hardcoding specific field keys. (purchase_order
// also has a third, optional string field, approved_by, at the end — the plain
// ordered walk already handles that correctly, it just loses every tie-break to the
// two fields ahead of it.)
export async function getDocumentDisplayNames(documentIds: string[], schemaId: string): Promise<Map<string, string | null>> {
  if (documentIds.length === 0) return new Map();

  const [schemaRow] = await db.select({ fields: extractionSchemas.fields }).from(extractionSchemas).where(eq(extractionSchemas.id, schemaId)).limit(1);
  const schemaFields = (schemaRow?.fields as FieldSpec[] | undefined) ?? [];
  const stringFieldKeys = schemaFields.filter((f) => f.type === 'string').map((f) => f.key);
  if (stringFieldKeys.length === 0) return new Map(documentIds.map((id) => [id, null]));

  const latestExtractionByDocument = await getLatestExtractionsForDocuments(documentIds);
  const latestExtractionIds = [...new Set([...latestExtractionByDocument.values()].map((e) => e.id))];
  if (latestExtractionIds.length === 0) return new Map(documentIds.map((id) => [id, null]));

  const relevantFieldValues = await db
    .select({ documentId: fieldValues.documentId, fieldKey: fieldValues.fieldKey, status: fieldValues.status, normalizedValue: fieldValues.normalizedValue, finalValue: fieldValues.finalValue })
    .from(fieldValues)
    .where(and(inArray(fieldValues.extractionId, latestExtractionIds), inArray(fieldValues.fieldKey, stringFieldKeys)));

  const byDocument = new Map<string, typeof relevantFieldValues>();
  for (const fv of relevantFieldValues) {
    const list = byDocument.get(fv.documentId) ?? [];
    list.push(fv);
    byDocument.set(fv.documentId, list);
  }

  const names = new Map<string, string | null>();
  for (const documentId of documentIds) {
    const fieldsForDocument = byDocument.get(documentId) ?? [];
    let name: string | null = null;
    for (const key of stringFieldKeys) {
      const fv = fieldsForDocument.find((f) => f.fieldKey === key);
      if (!fv) continue;
      // Always falls back to normalizedValue when unresolved rather than nulling it
      // out — unlike export/build.ts's identical-looking pattern, which nulls
      // unverified data on purpose for data-export correctness. A display name has
      // no such requirement, and nulling it here would blank out most documents,
      // which haven't been reviewed yet.
      const value = RESOLVED_STATUSES.has(fv.status) ? (fv.finalValue ?? fv.normalizedValue) : fv.normalizedValue;
      if (value) {
        name = value;
        break;
      }
    }
    names.set(documentId, name);
  }
  return names;
}

export interface BatchFieldSummary {
  fieldValueId: string;
  fieldKey: string;
  label: string;
  needsReview: boolean;
}

// Powers the batch-documents dropdown's per-FIELD entries — every field on every
// document, in the schema's own declared order, so a document with N reviewable
// fields shows N dropdown rows, not one. Deliberately does NOT filter to
// needs_review-only fields — the dropdown intentionally keeps every field listed
// even once resolved, so a reviewer can jump back and double-check (or undo) any
// decision at any time, not just what's currently outstanding. Kept separate from
// getDocumentDisplayNames (not merged into one function) — different callers,
// different shapes, sharing only the extraction-resolution step that actually
// needed sharing (getLatestExtractionsForDocuments above).
export async function getBatchFieldSummaries(documentIds: string[], schemaId: string): Promise<Map<string, BatchFieldSummary[]>> {
  if (documentIds.length === 0) return new Map();

  const [schemaRow] = await db.select({ fields: extractionSchemas.fields }).from(extractionSchemas).where(eq(extractionSchemas.id, schemaId)).limit(1);
  const schemaFields = (schemaRow?.fields as FieldSpec[] | undefined) ?? [];
  if (schemaFields.length === 0) return new Map(documentIds.map((id) => [id, []]));

  const latestExtractionByDocument = await getLatestExtractionsForDocuments(documentIds);
  const latestExtractionIds = [...new Set([...latestExtractionByDocument.values()].map((e) => e.id))];
  if (latestExtractionIds.length === 0) return new Map(documentIds.map((id) => [id, []]));

  // Every field type this time, not just string — the dropdown needs every field,
  // not just naming candidates (getDocumentDisplayNames's own concern).
  const relevantFieldValues = await db
    .select({ id: fieldValues.id, documentId: fieldValues.documentId, fieldKey: fieldValues.fieldKey, status: fieldValues.status })
    .from(fieldValues)
    .where(inArray(fieldValues.extractionId, latestExtractionIds));

  const relevantFieldValueIds = relevantFieldValues.map((f) => f.id);
  const needsReviewRows =
    relevantFieldValueIds.length > 0
      ? await db
          .select({ fieldValueId: fieldValueRows.fieldValueId })
          .from(fieldValueRows)
          .where(and(eq(fieldValueRows.status, 'needs_review'), inArray(fieldValueRows.fieldValueId, relevantFieldValueIds)))
      : [];
  const rowPendingFieldValueIds = new Set(needsReviewRows.map((r) => r.fieldValueId));

  const byDocument = new Map<string, typeof relevantFieldValues>();
  for (const fv of relevantFieldValues) {
    const list = byDocument.get(fv.documentId) ?? [];
    list.push(fv);
    byDocument.set(fv.documentId, list);
  }

  const labelByKey = new Map(schemaFields.map((f) => [f.key, f.label]));
  const result = new Map<string, BatchFieldSummary[]>();
  for (const documentId of documentIds) {
    const fieldsForDocument = byDocument.get(documentId) ?? [];
    const byFieldKey = new Map(fieldsForDocument.map((fv) => [fv.fieldKey, fv]));
    const summaries: BatchFieldSummary[] = [];
    const seenFieldValueIds = new Set<string>();
    for (const spec of schemaFields) {
      const fv = byFieldKey.get(spec.key);
      if (!fv) continue;
      seenFieldValueIds.add(fv.id);
      summaries.push({
        fieldValueId: fv.id,
        fieldKey: fv.fieldKey,
        label: spec.label,
        needsReview: fv.status === 'needs_review' || rowPendingFieldValueIds.has(fv.id),
      });
    }
    // A field_value whose fieldKey doesn't match any CURRENT schema field (a
    // hand-edited/legacy row — same case buildReviewItem already defends against
    // via `fieldSpec?.label ?? chosen.fieldKey`) would otherwise be silently
    // dropped from the dropdown entirely — reintroducing the exact "3 of 4"
    // undercount this feature exists to fix, just relocated. Appended after the
    // schema-ordered entries (no declared position to sort it by), labeled with
    // its own fieldKey the same way buildReviewItem falls back.
    for (const fv of fieldsForDocument) {
      if (seenFieldValueIds.has(fv.id)) continue;
      summaries.push({
        fieldValueId: fv.id,
        fieldKey: fv.fieldKey,
        label: labelByKey.get(fv.fieldKey) ?? fv.fieldKey,
        needsReview: fv.status === 'needs_review' || rowPendingFieldValueIds.has(fv.id),
      });
    }
    result.set(documentId, summaries);
  }
  return result;
}
