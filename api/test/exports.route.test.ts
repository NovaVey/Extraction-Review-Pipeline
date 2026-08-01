import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportsTable } from '../src/db/schema.js';

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

const mocks = vi.hoisted(() => ({
  insertShouldThrowCode: null as string | null,
  insertReturning: [] as unknown[],
  selectResult: [] as unknown[],
  updateReturning: [] as unknown[],
  uploadObject: vi.fn(async () => undefined),
  downloadObject: vi.fn(async () => Buffer.from('csv-bytes')),
}));

function selectChain(resolveValue: unknown) {
  const obj: Record<string, unknown> = {};
  obj.where = () => obj;
  obj.limit = () => Promise.resolve(resolveValue);
  return obj;
}

vi.mock('../src/db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === exportsTable) return selectChain(mocks.selectResult);
        throw new Error('unexpected table in mock select().from()');
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: () => ({
        returning: () => {
          if (table !== exportsTable) throw new Error('unexpected table in mock insert()');
          if (mocks.insertShouldThrowCode) {
            const err = new Error('simulated pg error') as Error & { code: string };
            err.code = mocks.insertShouldThrowCode;
            return Promise.reject(err);
          }
          return Promise.resolve(mocks.insertReturning);
        },
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: () => ({
        where: () => {
          if (table !== exportsTable) throw new Error('unexpected table in mock update()');
          return {
            returning: () => Promise.resolve(mocks.updateReturning),
            then: (resolve: (v: undefined) => void) => resolve(undefined),
          };
        },
      }),
    })),
  },
}));

vi.mock('../src/lib/storage.js', () => ({
  uploadObject: mocks.uploadObject,
  downloadObject: mocks.downloadObject,
}));

vi.mock('../src/export/build.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/export/build.js')>();
  return { ...actual, buildBatchExportCsv: vi.fn() };
});

const { buildApp } = await import('../src/app.js');
const { buildBatchExportCsv, NotFoundError } = await import('../src/export/build.js');

beforeEach(() => {
  mocks.insertShouldThrowCode = null;
  mocks.insertReturning = [];
  mocks.selectResult = [];
  mocks.updateReturning = [];
  mocks.uploadObject.mockClear();
  mocks.downloadObject.mockClear();
  vi.mocked(buildBatchExportCsv).mockReset();
});

describe('POST /batches/:id/export', () => {
  it('builds, uploads, and marks the export completed on success', async () => {
    mocks.insertReturning = [{ id: 'exp-1', batchId: 'batch-1', target: 'csv', status: 'processing', idempotencyKey: 'key-1' }];
    mocks.updateReturning = [{ id: 'exp-1', status: 'completed', rowCount: 3, filePath: 'exports/batch-1/exp-1.csv' }];
    vi.mocked(buildBatchExportCsv).mockResolvedValue({ csv: 'a,b\r\n1,2\r\n', rowCount: 3, skippedDocumentCount: 0 });
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/batches/batch-1/export',
      payload: { target: 'csv', idempotencyKey: 'key-1' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 'exp-1', status: 'completed', rowCount: 3, skippedDocumentCount: 0 });
    expect(mocks.uploadObject).toHaveBeenCalledWith('exports/batch-1/exp-1.csv', Buffer.from('a,b\r\n1,2\r\n', 'utf8'), 'text/csv');
    expect(buildBatchExportCsv).toHaveBeenCalledWith('batch-1', false);
  });

  it('passes includeUnresolved through when set', async () => {
    mocks.insertReturning = [{ id: 'exp-1' }];
    mocks.updateReturning = [{ id: 'exp-1', status: 'completed' }];
    vi.mocked(buildBatchExportCsv).mockResolvedValue({ csv: 'a\r\n', rowCount: 0, skippedDocumentCount: 0 });
    const app = buildApp();

    await app.inject({
      method: 'POST',
      url: '/batches/batch-1/export',
      payload: { target: 'csv', idempotencyKey: 'key-1', includeUnresolved: true },
    });

    expect(buildBatchExportCsv).toHaveBeenCalledWith('batch-1', true);
  });

  it('returns the existing export (200, not an error) when the idempotency key was already used', async () => {
    mocks.insertShouldThrowCode = '23505'; // unique_violation
    mocks.selectResult = [{ id: 'exp-existing', status: 'completed', idempotencyKey: 'key-1' }];
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/batches/batch-1/export',
      payload: { target: 'csv', idempotencyKey: 'key-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'exp-existing', status: 'completed', idempotencyKey: 'key-1' });
    expect(buildBatchExportCsv).not.toHaveBeenCalled();
  });

  it('returns 400 unknown_batch_id on a foreign-key violation instead of a bare 500', async () => {
    mocks.insertShouldThrowCode = '23503'; // foreign_key_violation
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/batches/missing-batch/export',
      payload: { target: 'csv', idempotencyKey: 'key-1' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_batch_id');
  });

  it('marks the export failed and returns 404 when buildBatchExportCsv reports the batch missing', async () => {
    mocks.insertReturning = [{ id: 'exp-1' }];
    vi.mocked(buildBatchExportCsv).mockRejectedValue(new NotFoundError('gone'));
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/batches/batch-1/export',
      payload: { target: 'csv', idempotencyKey: 'key-1' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'batch_not_found' });
  });

  it('returns 400 invalid_body for a non-csv target', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/batches/batch-1/export',
      payload: { target: 'xml', idempotencyKey: 'key-1' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
  });
});

describe('GET /exports/:id', () => {
  it('returns 404 export_not_found when missing', async () => {
    mocks.selectResult = [];
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/exports/missing' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'export_not_found' });
  });

  it('returns the export row', async () => {
    mocks.selectResult = [{ id: 'exp-1', status: 'completed', rowCount: 5 }];
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/exports/exp-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'exp-1', status: 'completed', rowCount: 5 });
  });
});

describe('GET /exports/:id/download', () => {
  it('returns 400 export_not_ready when the export has not completed', async () => {
    mocks.selectResult = [{ id: 'exp-1', status: 'processing', filePath: null }];
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/exports/exp-1/download' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('export_not_ready');
    expect(mocks.downloadObject).not.toHaveBeenCalled();
  });

  it('streams the CSV bytes as text/csv with a content-disposition header', async () => {
    mocks.selectResult = [{ id: 'exp-1', status: 'completed', filePath: 'exports/batch-1/exp-1.csv' }];
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/exports/exp-1/download' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv');
    expect(res.headers['content-disposition']).toContain('export-exp-1.csv');
    expect(res.rawPayload.toString()).toBe('csv-bytes');
    expect(mocks.downloadObject).toHaveBeenCalledWith('exports/batch-1/exp-1.csv');
  });
});
