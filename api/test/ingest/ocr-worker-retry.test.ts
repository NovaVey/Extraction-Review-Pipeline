import { describe, it, expect, vi, beforeEach } from 'vitest';

// A separate file (rather than adding to ocr.test.ts) so mocking 'tesseract.js' here
// doesn't interfere with ocr.test.ts's real, un-mocked end-to-end OCR pass.
const mocks = vi.hoisted(() => ({ createWorker: vi.fn() }));

vi.mock('tesseract.js', () => ({
  createWorker: mocks.createWorker,
}));

describe('getWorker (via ocrPageImage)', () => {
  let ocrPageImage: (typeof import('../../src/ingest/ocr.js'))['ocrPageImage'];

  beforeEach(async () => {
    mocks.createWorker.mockReset();
    // ocr.ts caches its worker in a module-level singleton (workerPromise) that
    // persists across it() blocks in the same file — vi.resetModules() + a fresh
    // dynamic import gives each test its own untouched singleton (workerPromise
    // starts null), rather than one test's cached worker leaking into the next.
    vi.resetModules();
    ({ ocrPageImage } = await import('../../src/ingest/ocr.js'));
  });

  // Regression: getWorker() used to assign createWorker()'s promise to the
  // module-level cache synchronously, before it settled — a rejection then stayed
  // cached forever, wedging every subsequent OCR call for the rest of the process's
  // life with no way to recover short of a restart.
  it('retries worker creation on the next call after a failed creation, instead of staying permanently wedged', async () => {
    mocks.createWorker.mockRejectedValueOnce(new Error('failed to init worker'));
    const fakeWorker = {
      recognize: vi.fn(async () => ({ data: { text: 'hello', confidence: 90 } })),
    };
    mocks.createWorker.mockResolvedValueOnce(fakeWorker);

    await expect(ocrPageImage(Buffer.from('fake-png'))).rejects.toThrow('failed to init worker');

    // Without the fix, this would reject immediately with the SAME cached rejected
    // promise instead of calling createWorker() again.
    const result = await ocrPageImage(Buffer.from('fake-png'));

    expect(result).toEqual({ text: 'hello', confidence: 0.9 });
    expect(mocks.createWorker).toHaveBeenCalledTimes(2);
  });

  it('reuses one worker across multiple successful calls rather than creating a new one each time', async () => {
    const fakeWorker = {
      recognize: vi.fn(async () => ({ data: { text: 'ok', confidence: 80 } })),
    };
    mocks.createWorker.mockResolvedValue(fakeWorker);

    await ocrPageImage(Buffer.from('fake-png-1'));
    await ocrPageImage(Buffer.from('fake-png-2'));

    expect(mocks.createWorker).toHaveBeenCalledTimes(1);
    expect(fakeWorker.recognize).toHaveBeenCalledTimes(2);
  });
});
