import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { batches, documents, extractions, extractionSchemas, fieldValues, fieldValueRows } from '../db/schema.js';
import type { FieldSpec } from '../extract/schema.js';
import { buildCsv } from './csv.js';

export class NotFoundError extends Error {}

export interface BuildExportResult {
  csv: string;
  rowCount: number;
  skippedDocumentCount: number;
}

// A field only counts as "resolved" once either the model auto-accepted it or a
// human has looked at it. 'needs_review' and 'pending' (the latter shouldn't occur
// post-Phase-4, but isn't assumed away) are not.
const RESOLVED_STATUSES = new Set(['auto_accepted', 'confirmed', 'corrected']);

// Exports are meant to be numbers a client can act on, so an unresolved field's value
// is blanked out by default rather than exported as if it were final — the whole
// point of the review queue is that a needs_review value hasn't been verified yet.
// includeUnresolved is an explicit opt-in for callers who want the raw, unverified
// data anyway (e.g. a work-in-progress export while review is still ongoing).
export async function buildBatchExportCsv(batchId: string, includeUnresolved: boolean): Promise<BuildExportResult> {
  const [batch] = await db.select().from(batches).where(eq(batches.id, batchId)).limit(1);
  if (!batch) throw new NotFoundError(`Batch not found: ${batchId}`);

  const [schemaRow] = await db.select().from(extractionSchemas).where(eq(extractionSchemas.id, batch.schemaId)).limit(1);
  if (!schemaRow) throw new NotFoundError(`Schema not found for batch ${batchId}: ${batch.schemaId}`);
  const fields = schemaRow.fields as FieldSpec[];
  const scalarFields = fields.filter((f) => f.type !== 'table');
  const tableField = fields.find((f) => f.type === 'table');

  const docs = await db.select().from(documents).where(eq(documents.batchId, batchId)).orderBy(documents.uploadedAt);

  const headers = [
    'document_id',
    'filename',
    'doc_type',
    ...scalarFields.map((f) => f.key),
    ...(tableField ? [tableField.key] : []),
    'resolved_field_count',
    'total_field_count',
  ];

  const rows: unknown[][] = [];
  let skippedDocumentCount = 0;

  for (const doc of docs) {
    // A soft-deleted document must not appear in an export any more than it appears
    // in the review queue — its rows/Storage files are kept, but it's no longer part
    // of what this batch actually delivers.
    if (doc.archivedAt) {
      skippedDocumentCount++;
      continue;
    }

    // Same lesson as review/queue.ts: a document can have multiple extractions rows
    // over time (re-running extraction inserts a new one each run) — only the current
    // one is meaningful to export.
    const [latestExtraction] = await db
      .select()
      .from(extractions)
      .where(eq(extractions.documentId, doc.id))
      .orderBy(desc(extractions.startedAt))
      .limit(1);
    if (!latestExtraction) {
      skippedDocumentCount++;
      continue;
    }

    const values = await db.select().from(fieldValues).where(eq(fieldValues.extractionId, latestExtraction.id));
    if (values.length === 0) {
      // The extraction exists (e.g. status: 'failed', every sample unparseable) but
      // produced no field_values — nothing to export for this document yet.
      skippedDocumentCount++;
      continue;
    }
    const valuesByKey = new Map(values.map((v) => [v.fieldKey, v]));

    const scalarCells = scalarFields.map((field) => {
      const fv = valuesByKey.get(field.key);
      if (!fv) return null;
      if (RESOLVED_STATUSES.has(fv.status)) return fv.finalValue ?? fv.normalizedValue;
      return includeUnresolved ? fv.normalizedValue : null;
    });

    let tableCell: string | null = null;
    if (tableField) {
      const fv = valuesByKey.get(tableField.key);
      if (fv) {
        const rowRecords = await db
          .select()
          .from(fieldValueRows)
          .where(eq(fieldValueRows.fieldValueId, fv.id))
          .orderBy(fieldValueRows.rowIndex);
        const rowsOut = rowRecords.map((r) => ({
          rowIndex: r.rowIndex,
          status: r.status,
          cells: RESOLVED_STATUSES.has(r.status) ? (r.finalCells ?? r.cells) : includeUnresolved ? r.cells : null,
        }));
        tableCell = JSON.stringify(rowsOut);
      }
    }

    const resolvedFieldCount = scalarFields.filter((field) => {
      const fv = valuesByKey.get(field.key);
      return fv ? RESOLVED_STATUSES.has(fv.status) : false;
    }).length;

    rows.push([
      doc.id,
      doc.filename,
      schemaRow.docType,
      ...scalarCells,
      ...(tableField ? [tableCell] : []),
      resolvedFieldCount,
      scalarFields.length,
    ]);
  }

  return { csv: buildCsv(headers, rows), rowCount: rows.length, skippedDocumentCount };
}
