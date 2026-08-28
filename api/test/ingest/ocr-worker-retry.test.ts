import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A separate file (rather than adding to ocr.test.ts) so mocking 'tesseract.js' here
// doesn't interfere with ocr.test.ts's real, un-mocked end-to-end OCR pass.
const mocks = vi.hoisted(() => ({ createWorker: vi.fn() }));

vi.mock('tesseract.js', () => ({
  createWorker: mocks.createWorker,
}));

describe('getWorker (via ocrPageImage)', () => {
  let ocrPageImage: (typeof import('../../src/ingest/ocr.js'))['ocrPageImage'];
  let RECOGNIZE_TIMEOUT_MS: (typeof import('../../src/ingest/ocr.js'))['RECOGNIZE_TIMEOUT_MS'];

  beforeEach(async () => {
    mocks.createWorker.mockReset();
    // ocr.ts caches its worker in a module-level singleton (workerPromise) that
    // persists across it() blocks in the same file — vi.resetModules() + a fresh
    // dynamic import gives each test its own untouched singleton (workerPromise
    // starts null), rather than one test's cached worker leaking into the next.
    vi.resetModules();
    ({ ocrPageImage, RECOGNIZE_TIMEOUT_MS } = await import('../../src/ingest/ocr.js'));
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

  describe('recognize() timeout', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // Regression: recognize() used to be awaited with no timeout at all -- a single
    // stuck native OCR call would hang that request forever AND, since getWorker()
    // shares one worker for the whole process, wedge every subsequent OCR call
    // behind it indefinitely with no way to recover short of restarting the process.
    it('gives up on a hung recognize() call after the timeout and discards the stuck worker, so the next call builds a fresh one', async () => {
      const hungWorker = {
        recognize: vi.fn(() => new Promise(() => {})), // never settles
        terminate: vi.fn(async () => {}),
      };
      const freshWorker = {
        recognize: vi.fn(async () => ({ data: { text: 'ok', confidence: 80 } })),
        terminate: vi.fn(async () => {}),
      };
      mocks.createWorker.mockResolvedValueOnce(hungWorker).mockResolvedValueOnce(freshWorker);

      vi.useFakeTimers();
      const pending = ocrPageImage(Buffer.from('fake-png'));
      // Attach a handler synchronously so advancing the timer below (which settles
      // `pending` mid-await, before the `expect(pending).rejects` line a tick later
      // gets to attach its own) doesn't trip Node's unhandled-rejection detection --
      // purely a test-timing artifact, not a claim about production behavior.
      pending.catch(() => {});
      // advanceTimersByTimeAsync also flushes the microtasks in between (getWorker()
      // resolving, recognize() being called and registering its timer) as it ticks
      // forward, so one call covering the full timeout window is enough.
      await vi.advanceTimersByTimeAsync(RECOGNIZE_TIMEOUT_MS);

      await expect(pending).rejects.toThrow(/timed out/i);
      expect(hungWorker.terminate).toHaveBeenCalledTimes(1);

      // The wedged worker is gone -- the next call builds a genuinely new one rather
      // than reusing (or re-awaiting) the stuck reference.
      vi.useRealTimers();
      const result = await ocrPageImage(Buffer.from('fake-png-2'));
      expect(result).toEqual({ text: 'ok', confidence: 0.8 });
      expect(mocks.createWorker).toHaveBeenCalledTimes(2);
      expect(freshWorker.recognize).toHaveBeenCalledTimes(1);
    });

    it('does not discard the worker or delay the result when recognize() resolves well within the timeout', async () => {
      const fakeWorker = {
        recognize: vi.fn(async () => ({ data: { text: 'fast', confidence: 95 } })),
        terminate: vi.fn(async () => {}),
      };
      mocks.createWorker.mockResolvedValue(fakeWorker);

      const result = await ocrPageImage(Buffer.from('fake-png'));

      expect(result).toEqual({ text: 'fast', confidence: 0.95 });
      expect(fakeWorker.terminate).not.toHaveBeenCalled();
      expect(mocks.createWorker).toHaveBeenCalledTimes(1);
    });
  });
});
