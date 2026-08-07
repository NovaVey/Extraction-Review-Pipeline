import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fieldValues, fieldValueRows, corrections, reviewSessions } from '../../src/db/schema.js';

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

const mocks = vi.hoisted(() => ({
  fieldValuesResult: [] as unknown[],
  fieldValueRowsResult: [] as unknown[],
  reviewSessionsResult: [] as unknown[],
  insertReturning: [] as unknown[],
  updateReturning: [] as unknown[],
  insertCalls: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  updateCalls: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
}));

function chain(resolveValue: unknown) {
  const obj: Record<string, unknown> = {};
  obj.where = () => obj;
  obj.limit = () => Promise.resolve(resolveValue);
  obj.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(resolveValue).then(resolve, reject);
  return obj;
}

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === fieldValues) return chain(mocks.fieldValuesResult);
        if (table === fieldValueRows) return chain(mocks.fieldValueRowsResult);
        if (table === reviewSessions) return chain(mocks.reviewSessionsResult);
        throw new Error('unexpected table in mock select().from()');
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        mocks.updateCalls.push({ table, values });
        return {
          where: () => ({
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(undefined).then(resolve, reject),
            returning: () => Promise.resolve(mocks.updateReturning),
          }),
        };
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        mocks.insertCalls.push({ table, values });
        return {
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(undefined).then(resolve, reject),
          returning: () => Promise.resolve(mocks.insertReturning),
        };
      },
    })),
  },
}));

const {
  acceptField,
  correctField,
  acceptRow,
  correctRow,
  undoField,
  undoRow,
  startReviewSession,
  endReviewSession,
  NotFoundError,
  SessionNotFoundError,
  NotNeedsReviewError,
  NothingToUndoError,
  TableFieldUndoUnsupportedError,
  UnknownColumnKeyError,
} = await import('../../src/review/actions.js');

// Session counters are now an atomic `sql\`column + delta\`` update, not a computed
// plain number (see review/actions.ts's bumpSessionCounters) — pull the delta back
// out of the SQL fragment's queryChunks rather than asserting on drizzle internals.
function sqlDelta(value: unknown): number | undefined {
  const chunks = (value as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return undefined;
  return chunks.find((c): c is number => typeof c === 'number');
}

beforeEach(() => {
  mocks.fieldValuesResult = [];
  mocks.fieldValueRowsResult = [];
  mocks.reviewSessionsResult = [];
  mocks.insertReturning = [];
  mocks.updateReturning = [];
  mocks.insertCalls.length = 0;
  mocks.updateCalls.length = 0;
});

function updatesTo(table: unknown) {
  return mocks.updateCalls.filter((c) => c.table === table);
}
function insertsTo(table: unknown) {
  return mocks.insertCalls.filter((c) => c.table === table);
}

describe('acceptField', () => {
  it('throws NotFoundError when the field value does not exist', async () => {
    mocks.fieldValuesResult = [];
    await expect(acceptField('missing-id', 'alice')).rejects.toThrow(NotFoundError);
  });

  it('throws NotNeedsReviewError when the field is not currently needs_review', async () => {
    mocks.fieldValuesResult = [{ id: 'fv-1', status: 'auto_accepted', fieldType: 'string', normalizedValue: 'x' }];
    await expect(acceptField('fv-1', 'alice')).rejects.toThrow(NotNeedsReviewError);
  });

  it('confirms a scalar field, writing an identical-value accept-as-is corrections row', async () => {
    mocks.fieldValuesResult = [{ id: 'fv-1', status: 'needs_review', fieldType: 'string', normalizedValue: 'INV-1' }];

    const result = await acceptField('fv-1', 'alice');

    expect(result).toEqual({ id: 'fv-1', status: 'confirmed' });
    const fvUpdates = updatesTo(fieldValues);
    expect(fvUpdates).toHaveLength(1);
    expect(fvUpdates[0].values).toMatchObject({ status: 'confirmed', finalValue: 'INV-1', reviewedBy: 'alice' });
    expect(fvUpdates[0].values.reviewedAt).toBeInstanceOf(Date);

    const correctionInserts = insertsTo(corrections);
    expect(correctionInserts).toHaveLength(1);
    expect(correctionInserts[0].values).toMatchObject({ fieldValueId: 'fv-1', oldValue: 'INV-1', newValue: 'INV-1', correctedBy: 'alice' });
  });

  it('coerces a null normalizedValue to an empty string in corrections.newValue (NOT NULL column) while keeping oldValue null', async () => {
    mocks.fieldValuesResult = [{ id: 'fv-1', status: 'needs_review', fieldType: 'string', normalizedValue: null }];

    await acceptField('fv-1', 'alice');

    const correctionInserts = insertsTo(corrections);
    expect(correctionInserts[0].values).toMatchObject({ oldValue: null, newValue: '' });
  });

  it('bulk-resolves a table field\'s own outstanding needs_review rows and counts as a single reviewed item', async () => {
    mocks.fieldValuesResult = [{ id: 'fv-table', status: 'needs_review', fieldType: 'table', normalizedValue: null }];
    mocks.fieldValueRowsResult = [
      { id: 'row-1', cells: { description: 'Widget', amount: '1.00' }, status: 'needs_review' },
      { id: 'row-2', cells: { description: 'Gadget', amount: '2.00' }, status: 'needs_review' },
    ];
    mocks.reviewSessionsResult = [{ id: 'session-1', itemsReviewed: 0, itemsCorrected: 0 }];

    const result = await acceptField('fv-table', 'alice', 'session-1');

    expect(result).toEqual({ id: 'fv-table', status: 'confirmed' });

    const rowUpdates = updatesTo(fieldValueRows);
    expect(rowUpdates).toHaveLength(2);
    for (const update of rowUpdates) {
      expect(update.values).toMatchObject({ status: 'confirmed' });
    }

    const correctionInserts = insertsTo(corrections);
    // One for the field-level accept, one per resolved row.
    expect(correctionInserts).toHaveLength(3);
    const rowCorrections = correctionInserts.filter((c) => c.values.fieldValueRowId !== undefined);
    expect(rowCorrections).toHaveLength(2);
    for (const rc of rowCorrections) {
      expect(rc.values.oldValue).toBe(rc.values.newValue);
    }

    // Bulk-resolved rows count as part of the ONE field-level accept, not individually.
    const sessionUpdates = updatesTo(reviewSessions);
    expect(sessionUpdates).toHaveLength(1);
    expect(sqlDelta(sessionUpdates[0].values.itemsReviewed)).toBe(1);
    expect(sqlDelta(sessionUpdates[0].values.itemsCorrected)).toBe(0);
  });
});

describe('correctField', () => {
  it('throws NotFoundError when missing and NotNeedsReviewError when already resolved', async () => {
    mocks.fieldValuesResult = [];
    await expect(correctField('missing', 'alice', 'new', undefined)).rejects.toThrow(NotFoundError);

    mocks.fieldValuesResult = [{ id: 'fv-1', status: 'confirmed', fieldType: 'string', normalizedValue: 'x' }];
    await expect(correctField('fv-1', 'alice', 'new', undefined)).rejects.toThrow(NotNeedsReviewError);
  });

  it('corrects a field, recording old vs new values and incrementing both session counters', async () => {
    mocks.fieldValuesResult = [{ id: 'fv-1', status: 'needs_review', fieldType: 'string', normalizedValue: 'INV-1' }];
    mocks.reviewSessionsResult = [{ id: 'session-1', itemsReviewed: 3, itemsCorrected: 1 }];

    const result = await correctField('fv-1', 'alice', 'INV-2', 'typo fix', 'session-1');

    expect(result).toEqual({ id: 'fv-1', status: 'corrected' });
    expect(updatesTo(fieldValues)[0].values).toMatchObject({ status: 'corrected', finalValue: 'INV-2', reviewedBy: 'alice' });
    expect(insertsTo(corrections)[0].values).toMatchObject({
      fieldValueId: 'fv-1',
      oldValue: 'INV-1',
      newValue: 'INV-2',
      reason: 'typo fix',
      correctedBy: 'alice',
    });
    const sessionUpdate = updatesTo(reviewSessions)[0].values;
    expect(sqlDelta(sessionUpdate.itemsReviewed)).toBe(1);
    expect(sqlDelta(sessionUpdate.itemsCorrected)).toBe(1);
  });

  it('throws SessionNotFoundError when reviewSessionId does not exist, before mutating the field', async () => {
    mocks.fieldValuesResult = [{ id: 'fv-1', status: 'needs_review', fieldType: 'string', normalizedValue: 'INV-1' }];
    mocks.reviewSessionsResult = [];

    await expect(correctField('fv-1', 'alice', 'INV-2', undefined, 'missing-session')).rejects.toThrow(SessionNotFoundError);
    expect(updatesTo(fieldValues)).toHaveLength(0);
    expect(insertsTo(corrections)).toHaveLength(0);
  });
});

describe('acceptRow', () => {
  it('throws NotFoundError / NotNeedsReviewError based on the ROW status, independent of the parent field', async () => {
    mocks.fieldValueRowsResult = [];
    await expect(acceptRow('missing-row', 'alice')).rejects.toThrow(NotFoundError);

    mocks.fieldValueRowsResult = [{ id: 'row-1', status: 'confirmed', cells: {} }];
    await expect(acceptRow('row-1', 'alice')).rejects.toThrow(NotNeedsReviewError);
  });

  it('confirms the row and writes an identical-value corrections entry, leaving the parent field untouched', async () => {
    mocks.fieldValueRowsResult = [{ id: 'row-1', status: 'needs_review', cells: { description: 'Widget', amount: '1.00' } }];

    const result = await acceptRow('row-1', 'alice');

    expect(result).toEqual({ id: 'row-1', status: 'confirmed' });
    expect(updatesTo(fieldValueRows)[0].values).toMatchObject({ status: 'confirmed', finalCells: { description: 'Widget', amount: '1.00' } });
    expect(updatesTo(fieldValues)).toHaveLength(0);

    const rowCorrection = insertsTo(corrections)[0];
    expect(rowCorrection.values.fieldValueRowId).toBe('row-1');
    expect(rowCorrection.values.oldValue).toBe(rowCorrection.values.newValue);
  });

  it('increments only itemsReviewed on the session', async () => {
    mocks.fieldValueRowsResult = [{ id: 'row-1', status: 'needs_review', cells: {} }];
    mocks.reviewSessionsResult = [{ id: 'session-1', itemsReviewed: 0, itemsCorrected: 0 }];

    await acceptRow('row-1', 'alice', 'session-1');

    const sessionUpdate = updatesTo(reviewSessions)[0].values;
    expect(sqlDelta(sessionUpdate.itemsReviewed)).toBe(1);
    expect(sqlDelta(sessionUpdate.itemsCorrected)).toBe(0);
  });

  it('throws SessionNotFoundError when reviewSessionId does not exist, before mutating the row', async () => {
    mocks.fieldValueRowsResult = [{ id: 'row-1', status: 'needs_review', cells: {} }];
    mocks.reviewSessionsResult = [];

    await expect(acceptRow('row-1', 'alice', 'missing-session')).rejects.toThrow(SessionNotFoundError);
    expect(updatesTo(fieldValueRows)).toHaveLength(0);
  });
});

describe('correctRow', () => {
  it('throws NotFoundError / NotNeedsReviewError based on the row status', async () => {
    mocks.fieldValueRowsResult = [];
    await expect(correctRow('missing-row', 'alice', 'amount', '5.00', undefined)).rejects.toThrow(NotFoundError);

    mocks.fieldValueRowsResult = [{ id: 'row-1', status: 'confirmed', cells: { amount: '1.00' } }];
    await expect(correctRow('row-1', 'alice', 'amount', '5.00', undefined)).rejects.toThrow(NotNeedsReviewError);
  });

  it('throws UnknownColumnKeyError when columnKey is not one of the row\'s cells', async () => {
    mocks.fieldValueRowsResult = [{ id: 'row-1', status: 'needs_review', cells: { description: 'Widget', amount: '1.00' } }];
    await expect(correctRow('row-1', 'alice', 'not_a_column', '5.00', undefined)).rejects.toThrow(UnknownColumnKeyError);
  });

  it('changes only the targeted cell, confirms the row, and increments both session counters', async () => {
    mocks.fieldValueRowsResult = [{ id: 'row-1', status: 'needs_review', cells: { description: 'Widget', amount: '1.00' } }];
    mocks.reviewSessionsResult = [{ id: 'session-1', itemsReviewed: 2, itemsCorrected: 0 }];

    const result = await correctRow('row-1', 'alice', 'amount', '9.99', 'misread digit', 'session-1');

    expect(result).toEqual({ id: 'row-1', status: 'confirmed' });
    expect(updatesTo(fieldValueRows)[0].values).toMatchObject({
      status: 'confirmed',
      finalCells: { description: 'Widget', amount: '9.99' },
    });
    expect(insertsTo(corrections)[0].values).toMatchObject({
      fieldValueRowId: 'row-1',
      columnKey: 'amount',
      oldValue: '1.00',
      newValue: '9.99',
      reason: 'misread digit',
      correctedBy: 'alice',
    });
    const sessionUpdate = updatesTo(reviewSessions)[0].values;
    expect(sqlDelta(sessionUpdate.itemsReviewed)).toBe(1);
    expect(sqlDelta(sessionUpdate.itemsCorrected)).toBe(1);
  });

  it('preserves an actual null oldValue for a cell the extractor never found, instead of the literal string "null"', async () => {
    mocks.fieldValueRowsResult = [{ id: 'row-1', status: 'needs_review', cells: { description: 'Widget', amount: null } }];

    await correctRow('row-1', 'alice', 'amount', '9.99', undefined);

    expect(insertsTo(corrections)[0].values).toMatchObject({ oldValue: null, newValue: '9.99' });
  });
});

describe('undoField', () => {
  it('throws NotFoundError when missing, NothingToUndoError when needs_review or auto_accepted', async () => {
    mocks.fieldValuesResult = [];
    await expect(undoField('missing', 'alice')).rejects.toThrow(NotFoundError);

    mocks.fieldValuesResult = [{ id: 'fv-1', status: 'needs_review', normalizedValue: 'x', finalValue: null }];
    await expect(undoField('fv-1', 'alice')).rejects.toThrow(NothingToUndoError);

    mocks.fieldValuesResult = [{ id: 'fv-1', status: 'auto_accepted', normalizedValue: 'x', finalValue: null }];
    await expect(undoField('fv-1', 'alice')).rejects.toThrow(NothingToUndoError);
  });

  it('reverts a confirmed field to needs_review, clearing finalValue/reviewedBy/reviewedAt, and decrements only itemsReviewed', async () => {
    mocks.fieldValuesResult = [{ id: 'fv-1', status: 'confirmed', normalizedValue: 'INV-1', finalValue: 'INV-1' }];
    mocks.reviewSessionsResult = [{ id: 'session-1', itemsReviewed: 3, itemsCorrected: 1 }];

    const result = await undoField('fv-1', 'alice', 'session-1');

    expect(result).toEqual({ id: 'fv-1', status: 'needs_review' });
    expect(updatesTo(fieldValues)[0].values).toMatchObject({
      status: 'needs_review',
      finalValue: null,
      reviewedBy: null,
      reviewedAt: null,
    });
    expect(insertsTo(corrections)[0].values).toMatchObject({
      fieldValueId: 'fv-1',
      oldValue: 'INV-1',
      newValue: 'INV-1',
      reason: 'undo',
      correctedBy: 'alice',
    });
    const sessionUpdate = updatesTo(reviewSessions)[0].values;
    expect(sqlDelta(sessionUpdate.itemsReviewed)).toBe(-1);
    expect(sqlDelta(sessionUpdate.itemsCorrected)).toBe(0);
  });

  it('reverting a corrected field also decrements itemsCorrected', async () => {
    mocks.fieldValuesResult = [{ id: 'fv-1', status: 'corrected', normalizedValue: 'INV-1', finalValue: 'INV-2' }];
    mocks.reviewSessionsResult = [{ id: 'session-1', itemsReviewed: 3, itemsCorrected: 1 }];

    await undoField('fv-1', 'alice', 'session-1');

    const sessionUpdate = updatesTo(reviewSessions)[0].values;
    expect(sqlDelta(sessionUpdate.itemsReviewed)).toBe(-1);
    expect(sqlDelta(sessionUpdate.itemsCorrected)).toBe(-1);
  });

  it('refuses to undo a confirmed table field, since acceptField may have bulk-resolved its rows and undoField has no way to revert those too', async () => {
    mocks.fieldValuesResult = [
      { id: 'fv-1', fieldType: 'table', status: 'confirmed', normalizedValue: null, finalValue: null },
    ];
    await expect(undoField('fv-1', 'alice')).rejects.toThrow(TableFieldUndoUnsupportedError);
    expect(updatesTo(fieldValues)).toHaveLength(0);
  });
});

describe('undoRow', () => {
  it('throws NotFoundError when missing, NothingToUndoError when needs_review or auto_accepted', async () => {
    mocks.fieldValueRowsResult = [];
    await expect(undoRow('missing-row', 'alice')).rejects.toThrow(NotFoundError);

    mocks.fieldValueRowsResult = [{ id: 'row-1', status: 'needs_review', cells: {}, finalCells: null }];
    await expect(undoRow('row-1', 'alice')).rejects.toThrow(NothingToUndoError);

    mocks.fieldValueRowsResult = [{ id: 'row-1', status: 'auto_accepted', cells: {}, finalCells: null }];
    await expect(undoRow('row-1', 'alice')).rejects.toThrow(NothingToUndoError);
  });

  it('reverts an accepted-as-is row (finalCells === cells) to needs_review, decrementing only itemsReviewed', async () => {
    const cells = { description: 'Widget', amount: '1.00' };
    mocks.fieldValueRowsResult = [{ id: 'row-1', status: 'confirmed', cells, finalCells: cells }];
    mocks.reviewSessionsResult = [{ id: 'session-1', itemsReviewed: 2, itemsCorrected: 0 }];

    const result = await undoRow('row-1', 'alice', 'session-1');

    expect(result).toEqual({ id: 'row-1', status: 'needs_review' });
    expect(updatesTo(fieldValueRows)[0].values).toMatchObject({ status: 'needs_review', finalCells: null });
    const sessionUpdate = updatesTo(reviewSessions)[0].values;
    expect(sqlDelta(sessionUpdate.itemsReviewed)).toBe(-1);
    expect(sqlDelta(sessionUpdate.itemsCorrected)).toBe(0);
  });

  it('reverting a row whose finalCells differ from cells (was corrected) also decrements itemsCorrected', async () => {
    mocks.fieldValueRowsResult = [
      { id: 'row-1', status: 'confirmed', cells: { amount: '1.00' }, finalCells: { amount: '9.99' } },
    ];
    mocks.reviewSessionsResult = [{ id: 'session-1', itemsReviewed: 2, itemsCorrected: 1 }];

    await undoRow('row-1', 'alice', 'session-1');

    const sessionUpdate = updatesTo(reviewSessions)[0].values;
    expect(sqlDelta(sessionUpdate.itemsReviewed)).toBe(-1);
    expect(sqlDelta(sessionUpdate.itemsCorrected)).toBe(-1);
  });
});

describe('startReviewSession / endReviewSession', () => {
  it('starts a session with a null batchId when omitted', async () => {
    mocks.insertReturning = [{ id: 'session-1', reviewer: 'alice', batchId: null, startedAt: new Date('2026-08-01T00:00:00Z') }];

    const session = await startReviewSession('alice');

    expect(session).toEqual({ id: 'session-1', reviewer: 'alice', batchId: null, startedAt: new Date('2026-08-01T00:00:00Z') });
    expect(insertsTo(reviewSessions)[0].values).toMatchObject({ reviewer: 'alice', batchId: null });
  });

  it('starts a session carrying the given batchId', async () => {
    mocks.insertReturning = [{ id: 'session-1', reviewer: 'alice', batchId: 'batch-1', startedAt: new Date() }];

    await startReviewSession('alice', 'batch-1');

    expect(insertsTo(reviewSessions)[0].values).toMatchObject({ reviewer: 'alice', batchId: 'batch-1' });
  });

  it('throws NotFoundError when ending a session that does not exist', async () => {
    mocks.reviewSessionsResult = [];
    await expect(endReviewSession('missing')).rejects.toThrow(NotFoundError);
  });

  it('sets endedAt and returns the final counters', async () => {
    mocks.reviewSessionsResult = [{ id: 'session-1', itemsReviewed: 5, itemsCorrected: 2, startedAt: new Date('2026-08-01T00:00:00Z') }];
    const endedAt = new Date('2026-08-01T01:00:00Z');
    mocks.updateReturning = [{ id: 'session-1', itemsReviewed: 5, itemsCorrected: 2, startedAt: new Date('2026-08-01T00:00:00Z'), endedAt }];

    const result = await endReviewSession('session-1');

    expect(result).toEqual({ id: 'session-1', itemsReviewed: 5, itemsCorrected: 2, startedAt: new Date('2026-08-01T00:00:00Z'), endedAt });
  });
});
