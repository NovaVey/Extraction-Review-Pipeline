import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pages } from '../src/db/schema.js';
import type { ReviewItem } from '../src/review/queue.js';

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

const mocks = vi.hoisted(() => ({
  mockPage: null as { id: string; imagePath: string } | null,
  downloadObject: vi.fn(async () => Buffer.from('fake-png-bytes')),
}));

function chain(resolveValue: unknown) {
  const obj: Record<string, unknown> = {};
  obj.where = () => obj;
  obj.limit = () => Promise.resolve(resolveValue);
  obj.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(resolveValue).then(resolve, reject);
  return obj;
}

// review.ts and pages.ts are exercised via app.inject(); the review routes delegate
// all DB access to review/queue.js and review/actions.js, which get their own
// dedicated unit tests (queue.test.ts, actions.test.ts) — so here they're mocked at
// that module boundary rather than re-mocked at the db-client level. Only pages.ts
// touches `db` directly (the `pages` table), so that's the one table this file's db
// mock needs to support.
vi.mock('../src/db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === pages) return chain(mocks.mockPage ? [mocks.mockPage] : []);
        throw new Error('unexpected table in mock select().from()');
      },
    })),
  },
}));

vi.mock('../src/lib/storage.js', () => ({
  downloadObject: mocks.downloadObject,
}));

// Preserves real exports (notably NoReviewableFieldError — routes/review.ts does a
// live `err instanceof NoReviewableFieldError` check, which would throw a TypeError
// against a plain `{...}` mock replacement that dropped the class entirely) while
// replacing only the DB-touching functions — same importOriginal pattern already
// used for review/actions.js just below.
vi.mock('../src/review/queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/review/queue.js')>();
  return {
    ...actual,
    getNextReviewItem: vi.fn(),
    getReviewItemForDocument: vi.fn(),
    getReviewItemForField: vi.fn(),
    getReviewQueueStats: vi.fn(),
  };
});

vi.mock('../src/review/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/review/actions.js')>();
  return {
    ...actual,
    acceptField: vi.fn(),
    correctField: vi.fn(),
    acceptRow: vi.fn(),
    correctRow: vi.fn(),
    undoField: vi.fn(),
    undoRow: vi.fn(),
    startReviewSession: vi.fn(),
    endReviewSession: vi.fn(),
  };
});

const { buildApp } = await import('../src/app.js');
const { getNextReviewItem, getReviewItemForDocument, getReviewItemForField, getReviewQueueStats, NoReviewableFieldError } = await import(
  '../src/review/queue.js'
);
const { DocumentNotFoundError } = await import('../src/documents/archive.js');
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
  NotNeedsReviewError,
  NothingToUndoError,
  TableFieldUndoUnsupportedError,
} = await import('../src/review/actions.js');

beforeEach(() => {
  mocks.mockPage = null;
  mocks.downloadObject.mockClear();
  vi.mocked(getNextReviewItem).mockReset();
  vi.mocked(getReviewItemForDocument).mockReset();
  vi.mocked(getReviewItemForField).mockReset();
  vi.mocked(getReviewQueueStats).mockReset();
  vi.mocked(acceptField).mockReset();
  vi.mocked(correctField).mockReset();
  vi.mocked(acceptRow).mockReset();
  vi.mocked(correctRow).mockReset();
  vi.mocked(undoField).mockReset();
  vi.mocked(undoRow).mockReset();
  vi.mocked(startReviewSession).mockReset();
  vi.mocked(endReviewSession).mockReset();
});

describe('GET /review/stats', () => {
  it('returns whatever getReviewQueueStats resolves', async () => {
    const stats = { totalItems: 5, needsReview: 2, autoAccepted: 1, confirmed: 1, corrected: 1 };
    vi.mocked(getReviewQueueStats).mockResolvedValue(stats);

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/review/stats' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(stats);
  });
});

describe('GET /review/next', () => {
  it('returns 200 with a null item when the queue is empty', async () => {
    vi.mocked(getNextReviewItem).mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/review/next' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ item: null });
  });

  it('passes the batchId query param through to getNextReviewItem', async () => {
    vi.mocked(getNextReviewItem).mockResolvedValue(null);
    const app = buildApp();

    await app.inject({ method: 'GET', url: '/review/next?batchId=11111111-1111-1111-1111-111111111111' });

    expect(getNextReviewItem).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
  });

  it('returns 400 invalid_query for a malformed batchId', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/review/next?batchId=not-a-uuid' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_query');
  });
});

describe('GET /review/documents/:id', () => {
  const sampleItem: ReviewItem = {
    fieldValueId: '55555555-5555-5555-5555-555555555555',
    documentId: '22222222-2222-2222-2222-222222222222',
    documentFilename: 'invoice.pdf',
    batchId: null,
    fieldKey: 'vendor_name',
    fieldType: 'string',
    label: 'Vendor Name',
    description: 'd',
    rawValue: 'Acme',
    normalizedValue: 'Acme',
    finalValue: null,
    confidence: '0.5',
    confidenceParts: {},
    validatorStatus: 'valid',
    status: 'needs_review',
    rows: null,
    pages: [],
  };

  it('returns 200 with the item', async () => {
    vi.mocked(getReviewItemForDocument).mockResolvedValue(sampleItem);
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/review/documents/22222222-2222-2222-2222-222222222222' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ item: sampleItem });
  });

  it('passes the :id param through to getReviewItemForDocument', async () => {
    vi.mocked(getReviewItemForDocument).mockResolvedValue(sampleItem);
    const app = buildApp();

    await app.inject({ method: 'GET', url: '/review/documents/22222222-2222-2222-2222-222222222222' });

    expect(getReviewItemForDocument).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222');
  });

  it('returns 404 document_not_found when the document is missing or archived', async () => {
    vi.mocked(getReviewItemForDocument).mockRejectedValue(new DocumentNotFoundError('not found'));
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/review/documents/22222222-2222-2222-2222-222222222222' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'document_not_found' });
  });

  it('returns 404 no_review_item_found when the document has nothing to review', async () => {
    vi.mocked(getReviewItemForDocument).mockRejectedValue(new NoReviewableFieldError('nothing to review'));
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/review/documents/22222222-2222-2222-2222-222222222222' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no_review_item_found' });
  });

  // The global registerUuidParamGuard preHandler hook (lib/uuidParamGuard.ts) runs
  // before this handler and 404s any malformed :id with its own 'not_found' code —
  // distinct from this route's 'document_not_found', and this route's handler (and
  // therefore getReviewItemForDocument) must never even run for it.
  it('rejects a malformed id with the global uuid guards 404 not_found code, without ever calling getReviewItemForDocument', async () => {
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/review/documents/not-a-uuid' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect(getReviewItemForDocument).not.toHaveBeenCalled();
  });
});

describe('GET /review/fields/:id', () => {
  const sampleFieldItem: ReviewItem = {
    fieldValueId: '55555555-5555-5555-5555-555555555555',
    documentId: '22222222-2222-2222-2222-222222222222',
    documentFilename: 'invoice.pdf',
    batchId: null,
    fieldKey: 'due_date',
    fieldType: 'date',
    label: 'Due Date',
    description: 'd',
    rawValue: '2025-10-20',
    normalizedValue: '2025-10-20',
    finalValue: null,
    confidence: '0.78',
    confidenceParts: {},
    validatorStatus: 'valid',
    status: 'needs_review',
    rows: null,
    pages: [],
  };

  it('returns 200 with the item', async () => {
    vi.mocked(getReviewItemForField).mockResolvedValue(sampleFieldItem);
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/review/fields/55555555-5555-5555-5555-555555555555' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ item: sampleFieldItem });
  });

  it('passes the :id param through to getReviewItemForField', async () => {
    vi.mocked(getReviewItemForField).mockResolvedValue(sampleFieldItem);
    const app = buildApp();

    await app.inject({ method: 'GET', url: '/review/fields/55555555-5555-5555-5555-555555555555' });

    expect(getReviewItemForField).toHaveBeenCalledWith('55555555-5555-5555-5555-555555555555');
  });

  it('returns 404 field_not_found when the field does not exist (or belongs to a superseded extraction)', async () => {
    vi.mocked(getReviewItemForField).mockRejectedValue(new NotFoundError('not found'));
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/review/fields/55555555-5555-5555-5555-555555555555' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'field_not_found' });
  });

  it('returns 404 document_not_found when the owning document is missing or archived', async () => {
    vi.mocked(getReviewItemForField).mockRejectedValue(new DocumentNotFoundError('not found'));
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/review/fields/55555555-5555-5555-5555-555555555555' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'document_not_found' });
  });

  // Same global-guard-takes-precedence shape as GET /review/documents/:id above.
  it('rejects a malformed id with the global uuid guards 404 not_found code, without ever calling getReviewItemForField', async () => {
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/review/fields/not-a-uuid' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect(getReviewItemForField).not.toHaveBeenCalled();
  });
});

describe('POST /review/fields/:id/accept', () => {
  it('round trips a successful accept', async () => {
    vi.mocked(acceptField).mockResolvedValue({ id: '55555555-5555-5555-5555-555555555555', status: 'confirmed' });
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/fields/55555555-5555-5555-5555-555555555555/accept', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: '55555555-5555-5555-5555-555555555555', status: 'confirmed' });
    expect(acceptField).toHaveBeenCalledWith('55555555-5555-5555-5555-555555555555', 'alice', undefined);
  });

  it('returns 400 not_needs_review when the action rejects with NotNeedsReviewError', async () => {
    vi.mocked(acceptField).mockRejectedValue(new NotNeedsReviewError('already resolved'));
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/fields/55555555-5555-5555-5555-555555555555/accept', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'not_needs_review' });
  });

  it('returns 404 field_not_found when the action rejects with NotFoundError', async () => {
    vi.mocked(acceptField).mockRejectedValue(new NotFoundError('no such field'));
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/fields/99999999-9999-9999-9999-999999999999/accept', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'field_not_found' });
  });

  it('returns 400 invalid_body when reviewer is missing', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/review/fields/55555555-5555-5555-5555-555555555555/accept', payload: {} });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
    expect(acceptField).not.toHaveBeenCalled();
  });
});

describe('POST /review/fields/:id/correct', () => {
  it('round trips a successful correction', async () => {
    vi.mocked(correctField).mockResolvedValue({ id: '55555555-5555-5555-5555-555555555555', status: 'corrected' });
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/review/fields/55555555-5555-5555-5555-555555555555/correct',
      payload: { reviewer: 'alice', newValue: 'INV-2', reason: 'typo' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: '55555555-5555-5555-5555-555555555555', status: 'corrected' });
    expect(correctField).toHaveBeenCalledWith('55555555-5555-5555-5555-555555555555', 'alice', 'INV-2', 'typo', undefined);
  });
});

describe('POST /review/rows/:id/accept and /correct', () => {
  it('round trips a successful row accept', async () => {
    vi.mocked(acceptRow).mockResolvedValue({ id: '66666666-6666-6666-6666-666666666666', status: 'confirmed' });
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/rows/66666666-6666-6666-6666-666666666666/accept', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: '66666666-6666-6666-6666-666666666666', status: 'confirmed' });
  });

  it('returns 404 review_row_not_found when the row does not exist', async () => {
    vi.mocked(acceptRow).mockRejectedValue(new NotFoundError('no such row'));
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/rows/99999999-9999-9999-9999-999999999999/accept', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'review_row_not_found' });
  });

  it('round trips a successful row correction', async () => {
    vi.mocked(correctRow).mockResolvedValue({ id: '66666666-6666-6666-6666-666666666666', status: 'confirmed' });
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/review/rows/66666666-6666-6666-6666-666666666666/correct',
      payload: { reviewer: 'alice', columnKey: 'amount', newValue: '9.99' },
    });

    expect(res.statusCode).toBe(200);
    expect(correctRow).toHaveBeenCalledWith('66666666-6666-6666-6666-666666666666', 'alice', 'amount', '9.99', undefined, undefined);
  });
});

describe('POST /review/fields/:id/undo and /review/rows/:id/undo', () => {
  it('round trips a successful field undo', async () => {
    vi.mocked(undoField).mockResolvedValue({ id: '55555555-5555-5555-5555-555555555555', status: 'needs_review' });
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/fields/55555555-5555-5555-5555-555555555555/undo', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: '55555555-5555-5555-5555-555555555555', status: 'needs_review' });
    expect(undoField).toHaveBeenCalledWith('55555555-5555-5555-5555-555555555555', 'alice', undefined);
  });

  it('returns 400 nothing_to_undo when the field was never resolved by a review action', async () => {
    vi.mocked(undoField).mockRejectedValue(new NothingToUndoError('nothing to undo'));
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/fields/55555555-5555-5555-5555-555555555555/undo', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'nothing_to_undo' });
  });

  it('returns 400 table_field_undo_unsupported when undoing a table field whose rows may have been bulk-resolved', async () => {
    vi.mocked(undoField).mockRejectedValue(new TableFieldUndoUnsupportedError('unsupported'));
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/fields/55555555-5555-5555-5555-555555555555/undo', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'table_field_undo_unsupported' });
  });

  it('round trips a successful row undo', async () => {
    vi.mocked(undoRow).mockResolvedValue({ id: '66666666-6666-6666-6666-666666666666', status: 'needs_review' });
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/rows/66666666-6666-6666-6666-666666666666/undo', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: '66666666-6666-6666-6666-666666666666', status: 'needs_review' });
  });

  it('returns 404 review_row_not_found when the row does not exist', async () => {
    vi.mocked(undoRow).mockRejectedValue(new NotFoundError('no such row'));
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/rows/99999999-9999-9999-9999-999999999999/undo', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'review_row_not_found' });
  });
});

describe('review sessions', () => {
  it('POST /review-sessions returns 201 with the created session', async () => {
    const startedAt = new Date('2026-08-01T00:00:00Z');
    vi.mocked(startReviewSession).mockResolvedValue({ id: 'session-1', reviewer: 'alice', batchId: null, startedAt });
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review-sessions', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'session-1', reviewer: 'alice', batchId: null, startedAt: startedAt.toISOString() });
  });

  it('POST /review-sessions/:id/end returns 404 review_session_not_found when missing', async () => {
    vi.mocked(endReviewSession).mockRejectedValue(new NotFoundError('no such session'));
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review-sessions/99999999-9999-9999-9999-999999999999/end' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'review_session_not_found' });
  });
});

describe('GET /pages/:id/image', () => {
  it('returns 404 page_not_found when the page does not exist', async () => {
    mocks.mockPage = null;
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/pages/99999999-9999-9999-9999-999999999999/image' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'page_not_found' });
  });

  it('streams the page image as image/png', async () => {
    mocks.mockPage = { id: '77777777-7777-7777-7777-777777777777', imagePath: 'batches/b/x/pages/1.png' };
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/pages/77777777-7777-7777-7777-777777777777/image' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.toString()).toBe('fake-png-bytes');
    expect(mocks.downloadObject).toHaveBeenCalledWith('batches/b/x/pages/1.png');
  });
});
