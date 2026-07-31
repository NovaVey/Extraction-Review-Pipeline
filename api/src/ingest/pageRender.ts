import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Node has no DOM Worker; pointing at the bundled worker script keeps pdfjs-dist
// from trying (and failing) to spin up a browser-style worker thread.
GlobalWorkerOptions.workerSrc = path.resolve(
  __dirname,
  '../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
);

export interface RenderedPage {
  pageNumber: number;
  width: number;
  height: number;
  png: Buffer;
}

const RENDER_SCALE = 2.0; // ~144 DPI equivalent at a 72pt base page — legible for OCR without huge files.

const STANDARD_FONT_DATA_URL = path.resolve(__dirname, '../../../node_modules/pdfjs-dist/standard_fonts/') + '/';

export async function renderPdfPages(pdfBuffer: Buffer): Promise<RenderedPage[]> {
  const doc = await getDocument({
    data: new Uint8Array(pdfBuffer),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  const pages: RenderedPage[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext('2d');
      await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
      pages.push({
        pageNumber,
        width: canvas.width,
        height: canvas.height,
        png: canvas.toBuffer('image/png'),
      });
      page.cleanup();
    }
  } finally {
    await doc.cleanup();
    await doc.loadingTask.destroy();
  }
  return pages;
}
