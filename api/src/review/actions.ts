import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { fieldValues, fieldValueRows, corrections, reviewSessions } from '../db/schema.js';

// Thrown by every lookup in this module for a missing id; routes map it to 404.
export class NotFoundError extends Error {}

// A caller-supplied reviewSessionId that doesn't exist — kept distinct from
// NotFoundError so routes can report review_session_not_found rather than
// misattributing the failure to the field/row that was actually found fine.
export class SessionNotFoundError extends Error {}

// Thrown when an accept/correct action targets a field or row that isn't currently
// needs_review; routes map it to 400 not_needs_review.
export class NotNeedsReviewError extends Error {}

// correctRow-specific: the requested column isn't one of the row's actual cells.
export class UnknownColumnKeyError extends Error {}

// undoField/undoRow-specific: the target was never resolved by a human action —
// still needs_review (nothing happened yet) or auto_accepted (the model's own
// decision, not a reviewer's to undo).
export class NothingToUndoError extends Error {}

export interface ActionResult {
  id: string;
  status: string;
}

// field_value_rows has no reviewedBy/reviewedAt columns of its own — corrections is
// the only audit trail for row-level actions, so it's written even on a plain accept.
// corrections.new_value is NOT NULL, so a field that's needs_review with a genuinely
// null normalizedValue (e.g. a required-but-absent field) is coerced to '' here; the
// value itself (both sides identical) is what matters for the audit entry.
function auditValue(value: string | null): string {
  return value ?? '';
}

// Called before any mutation in every action below, so a bad reviewSessionId fails
// the whole request atomically — a request that mutated the field/row but then
// errored on session bookkeeping would leave the client unsure whether its review
// action actually persisted.
async function assertSessionExists(reviewSessionId: string | undefined): Promise<void> {
  if (!reviewSessionId) return;
  const [session] = await db
    .select({ id: reviewSessions.id })
    .from(reviewSessions)
    .where(eq(reviewSessions.id, reviewSessionId))
    .limit(1);
  if (!session) throw new SessionNotFoundError(`Review session not found: ${reviewSessionId}`);
}

// Atomic SQL increment, not read-then-write — two review actions against the same
// session in flight (plausible for a keyboard-fast queue: a double-fired keypress,
// two tabs) must not silently lose one side's count.
async function bumpSessionCounters(
  reviewSessionId: string | undefined,
  delta: { reviewed?: number; corrected?: number },
): Promise<void> {
  if (!reviewSessionId) return;
  await db
    .update(reviewSessions)
    .set({
      itemsReviewed: sql`${reviewSessions.itemsReviewed} + ${delta.reviewed ?? 0}`,
      itemsCorrected: sql`${reviewSessions.itemsCorrected} + ${delta.corrected ?? 0}`,
    })
    .where(eq(reviewSessions.id, reviewSessionId));
}

export async function acceptField(fieldValueId: string, reviewer: string, reviewSessionId?: string): Promise<ActionResult> {
  await assertSessionExists(reviewSessionId);
  const [field] = await db.select().from(fieldValues).where(eq(fieldValues.id, fieldValueId)).limit(1);
  if (!field) throw new NotFoundError(`Field value not found: ${fieldValueId}`);
  if (field.status !== 'needs_review') {
    throw new NotNeedsReviewError(`Field value ${fieldValueId} is not needs_review (status: ${field.status})`);
  }

  const now = new Date();
  await db
    .update(fieldValues)
    .set({ status: 'confirmed', finalValue: field.normalizedValue, reviewedBy: reviewer, reviewedAt: now })
    .where(eq(fieldValues.id, fieldValueId));

  await db.insert(corrections).values({
    fieldValueId,
    oldValue: field.normalizedValue,
    newValue: auditValue(field.normalizedValue),
    correctedBy: reviewer,
  });

  // Accepting the field-level item means the reviewer looked at everything shown,
  // including its rows — bulk-resolve any of the table's own rows still outstanding.
  if (field.fieldType === 'table') {
    const outstandingRows = await db
      .select()
      .from(fieldValueRows)
      .where(and(eq(fieldValueRows.fieldValueId, fieldValueId), eq(fieldValueRows.status, 'needs_review')));
    for (const row of outstandingRows) {
      await db.update(fieldValueRows).set({ status: 'confirmed', finalCells: row.cells }).where(eq(fieldValueRows.id, row.id));
      const serializedCells = JSON.stringify(row.cells);
      await db.insert(corrections).values({
        fieldValueRowId: row.id,
        oldValue: serializedCells,
        newValue: serializedCells,
        correctedBy: reviewer,
      });
    }
  }

  // The field-level accept counts as ONE reviewed item regardless of how many rows
  // got bulk-resolved alongside it.
  await bumpSessionCounters(reviewSessionId, { reviewed: 1 });

  return { id: fieldValueId, status: 'confirmed' };
}

export async function correctField(
  fieldValueId: string,
  reviewer: string,
  newValue: string,
  reason: string | undefined,
  reviewSessionId?: string,
): Promise<ActionResult> {
  await assertSessionExists(reviewSessionId);
  const [field] = await db.select().from(fieldValues).where(eq(fieldValues.id, fieldValueId)).limit(1);
  if (!field) throw new NotFoundError(`Field value not found: ${fieldValueId}`);
  if (field.status !== 'needs_review') {
    throw new NotNeedsReviewError(`Field value ${fieldValueId} is not needs_review (status: ${field.status})`);
  }

  const now = new Date();
  await db
    .update(fieldValues)
    .set({ status: 'corrected', finalValue: newValue, reviewedBy: reviewer, reviewedAt: now })
    .where(eq(fieldValues.id, fieldValueId));

  await db.insert(corrections).values({
    fieldValueId,
    oldValue: field.normalizedValue,
    newValue,
    reason,
    correctedBy: reviewer,
  });

  await bumpSessionCounters(reviewSessionId, { reviewed: 1, corrected: 1 });

  return { id: fieldValueId, status: 'corrected' };
}

export async function acceptRow(fieldValueRowId: string, reviewer: string, reviewSessionId?: string): Promise<ActionResult> {
  await assertSessionExists(reviewSessionId);
  const [row] = await db.select().from(fieldValueRows).where(eq(fieldValueRows.id, fieldValueRowId)).limit(1);
  if (!row) throw new NotFoundError(`Field value row not found: ${fieldValueRowId}`);
  if (row.status !== 'needs_review') {
    throw new NotNeedsReviewError(`Field value row ${fieldValueRowId} is not needs_review (status: ${row.status})`);
  }

  await db.update(fieldValueRows).set({ status: 'confirmed', finalCells: row.cells }).where(eq(fieldValueRows.id, fieldValueRowId));

  const serializedCells = JSON.stringify(row.cells);
  // The parent field_values row is deliberately left untouched — the field's own
  // state is a separate concern from a single row within it.
  await db.insert(corrections).values({
    fieldValueRowId,
    oldValue: serializedCells,
    newValue: serializedCells,
    correctedBy: reviewer,
  });

  await bumpSessionCounters(reviewSessionId, { reviewed: 1 });

  return { id: fieldValueRowId, status: 'confirmed' };
}

export async function correctRow(
  fieldValueRowId: string,
  reviewer: string,
  columnKey: string,
  newValue: string,
  reason: string | undefined,
  reviewSessionId?: string,
): Promise<ActionResult> {
  await assertSessionExists(reviewSessionId);
  const [row] = await db.select().from(fieldValueRows).where(eq(fieldValueRows.id, fieldValueRowId)).limit(1);
  if (!row) throw new NotFoundError(`Field value row not found: ${fieldValueRowId}`);
  if (row.status !== 'needs_review') {
    throw new NotNeedsReviewError(`Field value row ${fieldValueRowId} is not needs_review (status: ${row.status})`);
  }

  const currentCells = row.cells as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(currentCells, columnKey)) {
    throw new UnknownColumnKeyError(`Unknown column key ${columnKey} for row ${fieldValueRowId}`);
  }

  // Only the one cell changes — status still lands on 'confirmed' (not some third
  // "row-corrected" state, field_value_rows only has the same status vocabulary as
  // field_values); the corrections entry is what captures old vs new for this cell.
  const finalCells = { ...currentCells, [columnKey]: newValue };
  await db.update(fieldValueRows).set({ status: 'confirmed', finalCells }).where(eq(fieldValueRows.id, fieldValueRowId));

  // currentCells[columnKey] can be a real null (an optional column the extractor
  // didn't find) — String(null) would store the literal text "null" in the audit
  // trail, misreadable as "the model extracted the string null". Preserve the
  // actual null instead, same as correctField does for normalizedValue.
  const previousValue = currentCells[columnKey];
  await db.insert(corrections).values({
    fieldValueRowId,
    columnKey,
    oldValue: previousValue === null || previousValue === undefined ? null : String(previousValue),
    newValue,
    reason,
    correctedBy: reviewer,
  });

  await bumpSessionCounters(reviewSessionId, { reviewed: 1, corrected: 1 });

  return { id: fieldValueRowId, status: 'confirmed' };
}

// Reverses the effect of the reviewer's OWN last action — not the model's. Only
// 'confirmed'/'corrected' (a human touched it) is undoable; 'needs_review' (nothing
// happened) and 'auto_accepted' (the model's own decision) both throw, same as
// acceptField/correctField throw NotNeedsReviewError for the mirror-image case.
export async function undoField(fieldValueId: string, reviewer: string, reviewSessionId?: string): Promise<ActionResult> {
  await assertSessionExists(reviewSessionId);
  const [field] = await db.select().from(fieldValues).where(eq(fieldValues.id, fieldValueId)).limit(1);
  if (!field) throw new NotFoundError(`Field value not found: ${fieldValueId}`);
  if (field.status !== 'confirmed' && field.status !== 'corrected') {
    throw new NothingToUndoError(`Field value ${fieldValueId} was not resolved by a review action (status: ${field.status})`);
  }
  const wasCorrected = field.status === 'corrected';

  await db
    .update(fieldValues)
    .set({ status: 'needs_review', finalValue: null, reviewedBy: null, reviewedAt: null })
    .where(eq(fieldValues.id, fieldValueId));

  // A new audit entry, not a deletion of the original correction — reverting to the
  // model's own value is itself a reviewer action worth a truthful record of, same as
  // every other mutation in this file.
  await db.insert(corrections).values({
    fieldValueId,
    oldValue: field.finalValue,
    newValue: auditValue(field.normalizedValue),
    reason: 'undo',
    correctedBy: reviewer,
  });

  await bumpSessionCounters(reviewSessionId, { reviewed: -1, corrected: wasCorrected ? -1 : 0 });

  return { id: fieldValueId, status: 'needs_review' };
}

export async function undoRow(fieldValueRowId: string, reviewer: string, reviewSessionId?: string): Promise<ActionResult> {
  await assertSessionExists(reviewSessionId);
  const [row] = await db.select().from(fieldValueRows).where(eq(fieldValueRows.id, fieldValueRowId)).limit(1);
  if (!row) throw new NotFoundError(`Field value row not found: ${fieldValueRowId}`);
  if (row.status !== 'confirmed') {
    throw new NothingToUndoError(`Field value row ${fieldValueRowId} was not resolved by a review action (status: ${row.status})`);
  }

  // Rows share one status ('confirmed') for both accept-as-is and correct (see
  // correctRow) — whether this undo should also reverse a "corrected" session count
  // is inferred the same way the review UI itself distinguishes the two: whether the
  // reviewed cells actually differ from what was originally extracted.
  const wasCorrected = JSON.stringify(row.finalCells) !== JSON.stringify(row.cells);

  await db.update(fieldValueRows).set({ status: 'needs_review', finalCells: null }).where(eq(fieldValueRows.id, fieldValueRowId));

  await db.insert(corrections).values({
    fieldValueRowId,
    oldValue: JSON.stringify(row.finalCells),
    newValue: JSON.stringify(row.cells),
    reason: 'undo',
    correctedBy: reviewer,
  });

  await bumpSessionCounters(reviewSessionId, { reviewed: -1, corrected: wasCorrected ? -1 : 0 });

  return { id: fieldValueRowId, status: 'needs_review' };
}

export interface StartedReviewSession {
  id: string;
  reviewer: string;
  batchId: string | null;
  startedAt: Date;
}

export async function startReviewSession(reviewer: string, batchId?: string): Promise<StartedReviewSession> {
  const [session] = await db
    .insert(reviewSessions)
    .values({ reviewer, batchId: batchId ?? null })
    .returning();
  return { id: session.id, reviewer: session.reviewer, batchId: session.batchId, startedAt: session.startedAt };
}

export interface EndedReviewSession {
  id: string;
  itemsReviewed: number;
  itemsCorrected: number;
  startedAt: Date;
  endedAt: Date;
}

export async function endReviewSession(id: string): Promise<EndedReviewSession> {
  const [existing] = await db.select().from(reviewSessions).where(eq(reviewSessions.id, id)).limit(1);
  if (!existing) throw new NotFoundError(`Review session not found: ${id}`);

  const [updated] = await db.update(reviewSessions).set({ endedAt: new Date() }).where(eq(reviewSessions.id, id)).returning();

  return {
    id: updated.id,
    itemsReviewed: updated.itemsReviewed,
    itemsCorrected: updated.itemsCorrected,
    startedAt: updated.startedAt,
    endedAt: updated.endedAt as Date,
  };
}
