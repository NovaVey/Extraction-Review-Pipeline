import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

const { uploadObject, downloadObject } = await import('../../src/lib/storage.js');

describe('uploadObject / downloadObject', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Regression: neither call bounded its request at all, unlike pingStorage (same
  // file) which already sets a 5s AbortSignal.timeout — a stalled Supabase Storage
  // endpoint used to hang the calling ingest/export/download request indefinitely.
  it('bounds the upload request with an AbortSignal timeout', async () => {
    await uploadObject('path/to/file.pdf', Buffer.from('hello'), 'application/pdf');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('bounds the download request with an AbortSignal timeout', async () => {
    await downloadObject('path/to/file.pdf');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('still throws a descriptive error on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    await expect(downloadObject('missing.pdf')).rejects.toThrow(/HTTP 404/);
  });

  it('returns the response body as a Buffer on a successful download', async () => {
    const buf = await downloadObject('path/to/file.pdf');
    expect(buf).toBeInstanceOf(Buffer);
    expect(Array.from(buf)).toEqual([1, 2, 3]);
  });
});
