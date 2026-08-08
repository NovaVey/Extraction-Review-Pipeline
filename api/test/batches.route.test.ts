import { describe, it, expect, vi, beforeEach } from 'vitest';
import { batches, documents } from '../src/db/schema.js';

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

const mocks = vi.hoisted(() => ({
  mockBatch: null as Record<string, unknown> | null,
  mockDocuments: [] as Array<Record<string, unknown>>,
  getNeedsReviewDocumentIds: vi.fn(async () => new Set<string>()),
}));

function chain(resolveValue: unknown) {
  const obj: Record<string, unknown> = {};
  obj.where = () => obj;
  obj.limit = () => Promise.resolve(resolveValue);
  obj.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(resolveValue).then(resolve, reject);
  return obj;
}

vi.mock('../src/db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === batches) return chain(mocks.mockBatch ? [mocks.mockBatch] : []);
        if (table === documents) return chain(mocks.mockDocuments);
        throw new Error('unexpected table in mock select().from()');
      },
    })),
  },
}));

// GET /batches/:id delegates the review-status question to review/queue.js (which
// has its own dedicated, thorough getNeedsReviewDocumentIds tests) rather than
// re-deriving it — mocked at that module boundary, same pattern review.route.test.ts
// uses for review/queue.js and review/actions.js.
vi.mock('../src/review/queue.js', () => ({
  getNeedsReviewDocumentIds: mocks.getNeedsReviewDocumentIds,
}));

const { buildApp } = await import('../src/app.js');

beforeEach(() => {
  mocks.mockBatch = null;
  mocks.mockDocuments = [];
  mocks.getNeedsReviewDocumentIds.mockReset();
  mocks.getNeedsReviewDocumentIds.mockResolvedValue(new Set());
});

describe('GET /batches/:id', () => {
  it('returns 404 batch_not_found when the batch does not exist', async () => {
    mocks.mockBatch = null;
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/batches/11111111-1111-1111-1111-111111111111' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'batch_not_found' });
  });

  it('returns the batch with a trimmed, needsReview-badged document list', async () => {
    mocks.mockBatch = { id: '11111111-1111-1111-1111-111111111111', name: 'invoice corpus', status: 'open', schemaId: 'schema-1' };
    mocks.mockDocuments = [
      { id: 'doc-1', filename: 'invoice_01.pdf', status: 'processed', archivedAt: null },
      { id: 'doc-2', filename: 'invoice_02.pdf', status: 'processed', archivedAt: null },
    ];
    mocks.getNeedsReviewDocumentIds.mockResolvedValue(new Set(['doc-1']));
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/batches/11111111-1111-1111-1111-111111111111' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'invoice corpus',
      status: 'open',
      documents: [
        { id: 'doc-1', filename: 'invoice_01.pdf', status: 'processed', needsReview: true },
        { id: 'doc-2', filename: 'invoice_02.pdf', status: 'processed', needsReview: false },
      ],
    });
  });

  it('excludes an archived document from the list entirely', async () => {
    mocks.mockBatch = { id: '11111111-1111-1111-1111-111111111111', name: 'invoice corpus', status: 'open' };
    mocks.mockDocuments = [
      { id: 'doc-1', filename: 'invoice_01.pdf', status: 'processed', archivedAt: null },
      { id: 'doc-removed', filename: 'invoice_removed.pdf', status: 'processed', archivedAt: '2026-08-01T00:00:00.000Z' },
    ];
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/batches/11111111-1111-1111-1111-111111111111' });

    const body = res.json() as { documents: Array<{ id: string }> };
    expect(body.documents.map((d) => d.id)).toEqual(['doc-1']);
  });
});
