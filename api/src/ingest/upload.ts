import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, pages } from '../db/schema.js';
import { uploadObject } from '../lib/storage.js';
import { renderPdfPages } from './pageRender.js';
import { extractPageTexts } from './textLayer.js';
import { ocrPageImage } from './ocr.js';

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function originalPath(batchId: string, sha256: string): string {
  return `batches/${batchId}/${sha256}/original.pdf`;
}

function pageImagePath(batchId: string, sha256: string, pageNumber: number): string {
  return `batches/${batchId}/${sha256}/pages/${pageNumber}.png`;
}

export interface IngestDocumentParams {
  batchId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  inDevSubset?: boolean;
}

export interface IngestResult {
  documentId: string;
  deduped: boolean;
}

export async function ingestDocument(params: IngestDocumentParams): Promise<IngestResult> {
  const sha256 = sha256Hex(params.buffer);

  const [existing] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.batchId, params.batchId), eq(documents.sha256, sha256)))
    .limit(1);
  if (existing) {
    return { documentId: existing.id, deduped: true };
  }

  const storagePath = originalPath(params.batchId, sha256);
  await uploadObject(storagePath, params.buffer, params.mimeType);

  const [renderedPages, pageTexts] = await Promise.all([
    renderPdfPages(params.buffer),
    extractPageTexts(params.buffer),
  ]);
  const hasTextLayer = pageTexts.every((p) => p.hasTextLayer);
  const ocrRequired = pageTexts.some((p) => !p.hasTextLayer);

  const [{ id: documentId }] = await db
    .insert(documents)
    .values({
      batchId: params.batchId,
      filename: params.filename,
      mimeType: params.mimeType,
      storagePath,
      sha256,
      pageCount: renderedPages.length,
      hasTextLayer,
      ocrRequired,
      inDevSubset: params.inDevSubset ?? false,
      status: 'uploaded',
    })
    .returning({ id: documents.id });

  try {
    for (const rendered of renderedPages) {
      const pageText = pageTexts.find((p) => p.pageNumber === rendered.pageNumber);
      let textContent = pageText?.text ?? '';
      let ocrConfidence: number | null = null;
      if (!pageText?.hasTextLayer) {
        const ocr = await ocrPageImage(rendered.png);
        textContent = ocr.text;
        ocrConfidence = ocr.confidence;
      }

      const imagePath = pageImagePath(params.batchId, sha256, rendered.pageNumber);
      await uploadObject(imagePath, rendered.png, 'image/png');
      await db.insert(pages).values({
        documentId,
        pageNumber: rendered.pageNumber,
        width: rendered.width,
        height: rendered.height,
        imagePath,
        textContent,
        ocrConfidence: ocrConfidence === null ? null : ocrConfidence.toString(),
      });
    }

    await db.update(documents).set({ status: 'processed' }).where(eq(documents.id, documentId));
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : String(err);
    await db.update(documents).set({ status: 'failed', failureReason }).where(eq(documents.id, documentId));
    throw err;
  }

  return { documentId, deduped: false };
}
