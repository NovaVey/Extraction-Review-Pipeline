import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pages } from '../src/db/schema.js';

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

vi.mock('../src/review/queue.js', () => ({
  getNextReviewItem: vi.fn(),
}));

vi.mock('../src/review/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/review/actions.js')>();
  return {
    ...actual,
    acceptField: vi.fn(),
    correctField: vi.fn(),
    acceptRow: vi.fn(),
    correctRow: vi.fn(),
    startReviewSession: vi.fn(),
    endReviewSession: vi.fn(),
  };
});

const { buildApp } = await import('../src/app.js');
const { getNextReviewItem } = await import('../src/review/queue.js');
const { acceptField, correctField, acceptRow, correctRow, startReviewSession, endReviewSession, NotFoundError, NotNeedsReviewError } =
  await import('../src/review/actions.js');

beforeEach(() => {
  mocks.mockPage = null;
  mocks.downloadObject.mockClear();
  vi.mocked(getNextReviewItem).mockReset();
  vi.mocked(acceptField).mockReset();
  vi.mocked(correctField).mockReset();
  vi.mocked(acceptRow).mockReset();
  vi.mocked(correctRow).mockReset();
  vi.mocked(startReviewSession).mockReset();
  vi.mocked(endReviewSession).mockReset();
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

describe('POST /review/fields/:id/accept', () => {
  it('round trips a successful accept', async () => {
    vi.mocked(acceptField).mockResolvedValue({ id: 'fv-1', status: 'confirmed' });
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/fields/fv-1/accept', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'fv-1', status: 'confirmed' });
    expect(acceptField).toHaveBeenCalledWith('fv-1', 'alice', undefined);
  });

  it('returns 400 not_needs_review when the action rejects with NotNeedsReviewError', async () => {
    vi.mocked(acceptField).mockRejectedValue(new NotNeedsReviewError('already resolved'));
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/fields/fv-1/accept', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'not_needs_review' });
  });

  it('returns 404 field_not_found when the action rejects with NotFoundError', async () => {
    vi.mocked(acceptField).mockRejectedValue(new NotFoundError('no such field'));
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/fields/missing/accept', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'field_not_found' });
  });

  it('returns 400 invalid_body when reviewer is missing', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/review/fields/fv-1/accept', payload: {} });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
    expect(acceptField).not.toHaveBeenCalled();
  });
});

describe('POST /review/fields/:id/correct', () => {
  it('round trips a successful correction', async () => {
    vi.mocked(correctField).mockResolvedValue({ id: 'fv-1', status: 'corrected' });
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/review/fields/fv-1/correct',
      payload: { reviewer: 'alice', newValue: 'INV-2', reason: 'typo' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'fv-1', status: 'corrected' });
    expect(correctField).toHaveBeenCalledWith('fv-1', 'alice', 'INV-2', 'typo', undefined);
  });
});

describe('POST /review/rows/:id/accept and /correct', () => {
  it('round trips a successful row accept', async () => {
    vi.mocked(acceptRow).mockResolvedValue({ id: 'row-1', status: 'confirmed' });
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/rows/row-1/accept', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'row-1', status: 'confirmed' });
  });

  it('returns 404 review_row_not_found when the row does not exist', async () => {
    vi.mocked(acceptRow).mockRejectedValue(new NotFoundError('no such row'));
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/review/rows/missing/accept', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'review_row_not_found' });
  });

  it('round trips a successful row correction', async () => {
    vi.mocked(correctRow).mockResolvedValue({ id: 'row-1', status: 'confirmed' });
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/review/rows/row-1/correct',
      payload: { reviewer: 'alice', columnKey: 'amount', newValue: '9.99' },
    });

    expect(res.statusCode).toBe(200);
    expect(correctRow).toHaveBeenCalledWith('row-1', 'alice', 'amount', '9.99', undefined, undefined);
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

    const res = await app.inject({ method: 'POST', url: '/review-sessions/missing/end' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'review_session_not_found' });
  });
});

describe('GET /pages/:id/image', () => {
  it('returns 404 page_not_found when the page does not exist', async () => {
    mocks.mockPage = null;
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/pages/missing/image' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'page_not_found' });
  });

  it('streams the page image as image/png', async () => {
    mocks.mockPage = { id: 'page-1', imagePath: 'batches/b/x/pages/1.png' };
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/pages/page-1/image' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.toString()).toBe('fake-png-bytes');
    expect(mocks.downloadObject).toHaveBeenCalledWith('batches/b/x/pages/1.png');
  });
});
