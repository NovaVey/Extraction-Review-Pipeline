import { describe, it, expect } from 'vitest';
import { renderPdfPages } from '../../src/ingest/pageRender.js';
import { readSample } from '../fixtures.js';

describe('renderPdfPages', () => {
  it('rasterizes a single-page PDF to one PNG with positive dimensions', async () => {
    const buf = await readSample('invoice_clean_01.pdf');
    const pages = await renderPdfPages(buf);
    expect(pages).toHaveLength(1);
    expect(pages[0].pageNumber).toBe(1);
    expect(pages[0].width).toBeGreaterThan(0);
    expect(pages[0].height).toBeGreaterThan(0);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(pages[0].png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('renders one page per PDF page for a multipage document', async () => {
    const buf = await readSample('invoice_multipage_01.pdf');
    const pages = await renderPdfPages(buf);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((p) => p.pageNumber)).toEqual(pages.map((_, i) => i + 1));
    for (const page of pages) {
      expect(page.width).toBeGreaterThan(0);
      expect(page.height).toBeGreaterThan(0);
    }
  });
});
