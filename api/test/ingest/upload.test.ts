import { describe, it, expect, vi, beforeEach } from 'vitest';
import { documents } from '../../src/db/schema.js';

const mocks = vi.hoisted(() => ({
  selectResult: [] as Array<{ id: string; status?: string }>,
  // Per-call override for select(...).limit(), consumed in FIFO order — ingestDocument
  // can now issue two SELECTs in one call (the initial dedupe check, then a second
  // lookup after a unique-violation race), and they need different results. Falls
  // back to `selectResult` once exhausted, so single-SELECT scenarios are unaffected.
  selectResultQueue: [] as Array<Array<{ id: string; status?: string }>>,
  updateSetCalls: [] as unknown[],
  deleteCalls: [] as unknown[],
  insertShouldThrowCode: null as string | null,
  uploadObject: vi.fn(async () => undefined),
}));

function chainable(resolveValue: () => unknown) {
  const obj: Record<string, unknown> = {};
  obj.from = () => obj;
  obj.where = () => obj;
  obj.limit = () => Promise.resolve(resolveValue());
  return obj;
}

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(() => chainable(() => (mocks.selectResultQueue.length > 0 ? mocks.selectResultQueue.shift() : mocks.selectResult))),
    delete: vi.fn((table: unknown) => ({
      where: () => {
        mocks.deleteCalls.push(table);
        return Promise.resolve(undefined);
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: (_values: unknown) =>
        table === documents
          ? {
              returning: () => {
                if (mocks.insertShouldThrowCode) {
                  const err = new Error('simulated pg error') as Error & { code: string };
                  err.code = mocks.insertShouldThrowCode;
                  return Promise.reject(err);
                }
                return Promise.resolve([{ id: 'new-doc-id' }]);
              },
            }
          : Promise.resolve(undefined),
    })),
    update: vi.fn(() => ({
      set: (values: unknown) => {
        mocks.updateSetCalls.push(values);
        return { where: () => Promise.resolve(undefined) };
      },
    })),
  },
}));

vi.mock('../../src/lib/storage.js', () => ({
  uploadObject: mocks.uploadObject,
}));

const { ingestDocument } = await import('../../src/ingest/upload.js');
const { readSample } = await import('../fixtures.js');

beforeEach(() => {
  mocks.selectResult = [];
  mocks.selectResultQueue = [];
  mocks.updateSetCalls.length = 0;
  mocks.deleteCalls.length = 0;
  mocks.insertShouldThrowCode = null;
  mocks.uploadObject.mockReset();
  mocks.uploadObject.mockResolvedValue(undefined);
});

describe('ingestDocument', () => {
  it('short-circuits on an existing (batchId, sha256) match without uploading or writing rows', async () => {
    mocks.selectResult = [{ id: 'existing-doc-id' }];
    const buf = await readSample('invoice_clean_01.pdf');

    const result = await ingestDocument({
      batchId: 'batch-1',
      filename: 'invoice_clean_01.pdf',
      mimeType: 'application/pdf',
      buffer: buf,
    });

    expect(result).toEqual({ documentId: 'existing-doc-id', deduped: true });
    expect(mocks.uploadObject).not.toHaveBeenCalled();
  });

  it('uploads the original + each page image and marks the document processed', async () => {
    mocks.selectResult = [];
    const buf = await readSample('invoice_clean_01.pdf'); // 1 page, has a text layer (no OCR needed)

    const result = await ingestDocument({
      batchId: 'batch-1',
      filename: 'invoice_clean_01.pdf',
      mimeType: 'application/pdf',
      buffer: buf,
    });

    expect(result).toEqual({ documentId: 'new-doc-id', deduped: false });
    // 1 upload for the original PDF + 1 for the single page's rendered image.
    expect(mocks.uploadObject).toHaveBeenCalledTimes(2);
    expect(mocks.updateSetCalls).toContainEqual({ status: 'processed' });
  });

  // Regression: a previously-failed ingest of the same bytes used to be reported as
  // a successful dedupe hit (existing row found, short-circuit) instead of retried.
  it('retries a previously-failed ingest instead of reporting a false dedupe hit', async () => {
    mocks.selectResult = [{ id: 'old-failed-doc-id', status: 'failed' }];
    const buf = await readSample('invoice_clean_01.pdf');

    const result = await ingestDocument({
      batchId: 'batch-1',
      filename: 'invoice_clean_01.pdf',
      mimeType: 'application/pdf',
      buffer: buf,
    });

    expect(mocks.deleteCalls).toEqual([documents]);
    expect(result).toEqual({ documentId: 'new-doc-id', deduped: false });
    expect(mocks.uploadObject).toHaveBeenCalled();
  });

  // Regression: two concurrent uploads of identical bytes both pass the dedupe
  // SELECT before either has inserted; the loser used to surface the DB's raw
  // unique-violation error instead of a normal dedupe hit against the winner.
  it('reports a dedupe hit against the winning row when a concurrent insert wins the unique-constraint race', async () => {
    mocks.selectResultQueue = [[], [{ id: 'winner-doc-id' }]];
    mocks.insertShouldThrowCode = '23505'; // unique_violation
    const buf = await readSample('invoice_clean_01.pdf');

    const result = await ingestDocument({
      batchId: 'batch-1',
      filename: 'invoice_clean_01.pdf',
      mimeType: 'application/pdf',
      buffer: buf,
    });

    expect(result).toEqual({ documentId: 'winner-doc-id', deduped: true });
  });

  it('rethrows a non-unique-violation insert error rather than swallowing it', async () => {
    mocks.selectResultQueue = [[]];
    mocks.insertShouldThrowCode = '23503'; // foreign_key_violation, unrelated to dedupe
    const buf = await readSample('invoice_clean_01.pdf');

    await expect(
      ingestDocument({ batchId: 'batch-1', filename: 'invoice_clean_01.pdf', mimeType: 'application/pdf', buffer: buf }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('marks the document failed and rethrows when page processing fails', async () => {
    mocks.selectResult = [];
    mocks.uploadObject
      .mockResolvedValueOnce(undefined) // original file upload succeeds
      .mockRejectedValueOnce(new Error('storage is down')); // first page image upload fails
    const buf = await readSample('invoice_clean_01.pdf');

    await expect(
      ingestDocument({
        batchId: 'batch-1',
        filename: 'invoice_clean_01.pdf',
        mimeType: 'application/pdf',
        buffer: buf,
      }),
    ).rejects.toThrow('storage is down');

    expect(mocks.updateSetCalls).toContainEqual({ status: 'failed', failureReason: 'storage is down' });
  });
});
