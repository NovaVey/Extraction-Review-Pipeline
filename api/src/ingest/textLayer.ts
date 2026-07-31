import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STANDARD_FONT_DATA_URL = path.resolve(__dirname, '../../../node_modules/pdfjs-dist/standard_fonts/') + '/';

export interface PageText {
  pageNumber: number;
  text: string;
  hasTextLayer: boolean;
}

// A handful of stray characters (e.g. a lone page-number artifact) shouldn't
// count as a real text layer — require a small minimum before trusting it.
const MIN_CHARS_FOR_TEXT_LAYER = 5;

export async function extractPageTexts(pdfBuffer: Buffer): Promise<PageText[]> {
  const doc = await getDocument({
    data: new Uint8Array(pdfBuffer),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  const pages: PageText[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pages.push({ pageNumber, text, hasTextLayer: text.length >= MIN_CHARS_FOR_TEXT_LAYER });
      page.cleanup();
    }
  } finally {
    await doc.cleanup();
    await doc.loadingTask.destroy();
  }
  return pages;
}
