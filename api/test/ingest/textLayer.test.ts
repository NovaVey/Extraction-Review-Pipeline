import { describe, it, expect } from 'vitest';
import { extractPageTexts } from '../../src/ingest/textLayer.js';
import { readSample } from '../fixtures.js';

describe('extractPageTexts', () => {
  it('detects a real text layer on a clean, digitally-generated PDF', async () => {
    const buf = await readSample('invoice_clean_01.pdf');
    const pages = await extractPageTexts(buf);
    expect(pages).toHaveLength(1);
    expect(pages[0].hasTextLayer).toBe(true);
    expect(pages[0].text.length).toBeGreaterThan(5);
  });

  it('reports no text layer on an image-only scanned PDF', async () => {
    const buf = await readSample('invoice_scanned_01.pdf');
    const pages = await extractPageTexts(buf);
    expect(pages).toHaveLength(1);
    expect(pages[0].hasTextLayer).toBe(false);
  });

  it('extracts one entry per page for a multipage document', async () => {
    const buf = await readSample('invoice_multipage_01.pdf');
    const pages = await extractPageTexts(buf);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((p) => p.pageNumber)).toEqual(pages.map((_, i) => i + 1));
  });
});
