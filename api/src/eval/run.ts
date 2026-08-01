import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, extractions, fieldValues, fieldValueRows } from '../db/schema.js';
import type { FieldType } from '../extract/schema.js';
import { loadGoldSet } from './goldSet.js';
import { valuesMatch, compareLineItems } from './compare.js';

export interface FieldEvalResult {
  documentFilename: string;
  docType: string;
  difficultyGroup: string;
  fieldKey: string;
  fieldType: FieldType;
  status: string;
  matched: boolean;
  // Whether this field represents a genuine, entirely-unreviewed model decision.
  // For a scalar field this is just status === 'auto_accepted' (finalValue is
  // guaranteed null in that state). A table field's OWN status can stay
  // 'auto_accepted' while a human corrects one specific row via the row-level
  // accept/correct actions (review/actions.ts never touches the parent field's
  // status) — that row's finalCells being non-null means a human *did* touch this
  // field, even though its status column doesn't reflect that. Without this
  // distinction, a human's row fix gets silently credited to the model.
  countsAsAutoAccept: boolean;
}

export interface RateStat {
  matched: number;
  total: number;
  // null (not 0) when total is 0 — "no data" is a different claim than "0% correct",
  // and collapsing them would misreport an empty group as a failing one.
  rate: number | null;
}

export interface GroupStats {
  autoAcceptPrecision: RateStat;
  overallAccuracy: RateStat;
  automationRate: RateStat;
}

export interface EvalSummary {
  documentsEvaluated: number;
  documentsSkipped: Array<{ filename: string; reason: string }>;
  fields: FieldEvalResult[];
  overall: GroupStats;
  byDocType: Record<string, GroupStats>;
  byDifficultyGroup: Record<string, GroupStats>;
}

const RESOLVED_STATUSES = new Set(['auto_accepted', 'confirmed', 'corrected']);

function rate(matched: number, total: number): RateStat {
  return { matched, total, rate: total === 0 ? null : matched / total };
}

function computeGroupStats(fields: FieldEvalResult[]): GroupStats {
  const autoAccepted = fields.filter((f) => f.countsAsAutoAccept);
  const resolved = fields.filter((f) => RESOLVED_STATUSES.has(f.status));
  return {
    // The headline metric: of fields the system decided NOT to send to a human, how
    // many were actually right. Gated on countsAsAutoAccept, not just status ===
    // 'auto_accepted' — a table field whose status never changed but whose row was
    // individually corrected is human-touched in every way that matters here.
    autoAcceptPrecision: rate(autoAccepted.filter((f) => f.matched).length, autoAccepted.length),
    // Context metric: accuracy of the current best-known value (post-review) across
    // every resolved field, auto-accepted or human-touched alike.
    overallAccuracy: rate(resolved.filter((f) => f.matched).length, resolved.length),
    // How much of the total review workload the system removed by auto-accepting —
    // same countsAsAutoAccept gate, so a partially-corrected table field correctly
    // stops counting as "required zero human effort".
    automationRate: rate(autoAccepted.length, fields.length),
  };
}

function groupBy<K extends string>(fields: FieldEvalResult[], key: (f: FieldEvalResult) => K): Record<K, GroupStats> {
  const groups = new Map<K, FieldEvalResult[]>();
  for (const field of fields) {
    const k = key(field);
    const list = groups.get(k);
    if (list) list.push(field);
    else groups.set(k, [field]);
  }
  const result = {} as Record<K, GroupStats>;
  for (const [k, list] of groups) result[k] = computeGroupStats(list);
  return result;
}

// Compares the current (post-review) state of every dev-subset document's latest
// extraction against the synthetic corpus's ground truth (samples/manifest.json).
// Only inDevSubset documents are considered — that's the only slice that's ever been
// through real extraction (see scripts/extract-devset.ts).
export async function runEval(manifestPath?: string): Promise<EvalSummary> {
  const goldSet = loadGoldSet(manifestPath);
  const devSetDocs = await db
    .select({ id: documents.id, filename: documents.filename })
    .from(documents)
    .where(eq(documents.inDevSubset, true))
    .orderBy(documents.filename);

  const documentsSkipped: Array<{ filename: string; reason: string }> = [];
  const fields: FieldEvalResult[] = [];
  let documentsEvaluated = 0;

  for (const doc of devSetDocs) {
    const gold = goldSet.get(doc.filename);
    if (!gold) {
      documentsSkipped.push({ filename: doc.filename, reason: 'not_in_gold_set' });
      continue;
    }

    const [latestExtraction] = await db
      .select({ id: extractions.id })
      .from(extractions)
      .where(eq(extractions.documentId, doc.id))
      .orderBy(desc(extractions.startedAt))
      .limit(1);
    if (!latestExtraction) {
      documentsSkipped.push({ filename: doc.filename, reason: 'no_extraction' });
      continue;
    }

    const values = await db.select().from(fieldValues).where(eq(fieldValues.extractionId, latestExtraction.id));
    if (values.length === 0) {
      documentsSkipped.push({ filename: doc.filename, reason: 'extraction_produced_no_fields' });
      continue;
    }

    for (const fv of values) {
      const fieldType = fv.fieldType as FieldType;
      let matched: boolean;
      let countsAsAutoAccept: boolean;
      if (fieldType === 'table') {
        const rowRecords = await db
          .select()
          .from(fieldValueRows)
          .where(eq(fieldValueRows.fieldValueId, fv.id))
          .orderBy(fieldValueRows.rowIndex);
        const extractedRows = rowRecords.map((r) => (r.finalCells ?? r.cells) as Record<string, unknown>);
        matched = compareLineItems(extractedRows, gold.lineItems).allMatch;
        // A row's finalCells is set by both correct AND accept-as-is (review/actions.ts
        // mirrors the field-level accept's audit-trail convention) — either way, a
        // non-null finalCells means a human looked at that specific row, regardless of
        // what the parent field's own status column still says.
        const anyRowHumanTouched = rowRecords.some((r) => r.finalCells !== null);
        countsAsAutoAccept = fv.status === 'auto_accepted' && !anyRowHumanTouched;
      } else {
        const extractedValue = fv.finalValue ?? fv.normalizedValue;
        matched = valuesMatch(fieldType, extractedValue, gold.fields[fv.fieldKey] ?? null);
        countsAsAutoAccept = fv.status === 'auto_accepted';
      }
      fields.push({
        documentFilename: doc.filename,
        docType: gold.docType,
        difficultyGroup: gold.difficultyGroup,
        fieldKey: fv.fieldKey,
        fieldType,
        status: fv.status,
        matched,
        countsAsAutoAccept,
      });
    }
    documentsEvaluated++;
  }

  return {
    documentsEvaluated,
    documentsSkipped,
    fields,
    overall: computeGroupStats(fields),
    byDocType: groupBy(fields, (f) => f.docType),
    byDifficultyGroup: groupBy(fields, (f) => f.difficultyGroup),
  };
}
