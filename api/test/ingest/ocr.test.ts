import { describe, it, expect, afterAll } from 'vitest';
import { renderPdfPages } from '../../src/ingest/pageRender.js';
import { ocrPageImage, terminateOcrWorker } from '../../src/ingest/ocr.js';
import { readSample } from '../fixtures.js';

// Worker startup (loads the WASM engine + local trained data) plus a real
// recognize() pass is slower than vitest's default 5s test timeout.
const OCR_TIMEOUT_MS = 30_000;

describe('ocrPageImage', () => {
  afterAll(async () => {
    await terminateOcrWorker();
  });

  it(
    'produces non-empty text with a confidence in [0, 1] for a scanned page',
    async () => {
      const buf = await readSample('invoice_scanned_01.pdf');
      const [page] = await renderPdfPages(buf);
      const result = await ocrPageImage(page.png);
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    },
    OCR_TIMEOUT_MS,
  );
});
