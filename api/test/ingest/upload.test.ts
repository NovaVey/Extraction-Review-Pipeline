import { describe, it, expect, vi, beforeEach } from 'vitest';
import { documents } from '../../src/db/schema.js';

const mocks = vi.hoisted(() => ({
  selectResult: [] as Array<{ id: string }>,
  updateSetCalls: [] as unknown[],
  uploadObject: vi.fn(async () => undefined),
}));

function chainable(resolveValue: unknown) {
  const obj: Record<string, unknown> = {};
  obj.from = () => obj;
  obj.where = () => obj;
  obj.limit = () => Promise.resolve(resolveValue);
  return obj;
}

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(() => chainable(mocks.selectResult)),
    insert: vi.fn((table: unknown) => ({
      values: (_values: unknown) =>
        table === documents
          ? { returning: () => Promise.resolve([{ id: 'new-doc-id' }]) }
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
  mocks.updateSetCalls.length = 0;
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
