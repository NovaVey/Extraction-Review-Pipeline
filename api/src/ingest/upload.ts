import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, pages } from '../db/schema.js';
import { uploadObject } from '../lib/storage.js';
import { isUniqueViolation } from '../lib/pgErrors.js';
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
    .select({ id: documents.id, status: documents.status })
    .from(documents)
    .where(and(eq(documents.batchId, params.batchId), eq(documents.sha256, sha256)))
    .limit(1);
  if (existing && existing.status !== 'failed') {
    return { documentId: existing.id, deduped: true };
  }
  if (existing) {
    // existing.status === 'failed': a previous ingest of these exact bytes failed
    // partway through (see the catch block below) — that's not a successful
    // dedupe hit, it's a document that was never actually usable. Retry cleanly
    // instead of reporting false success. Deleting the old row first (rather than
    // reusing its id) cascades to any partial `pages` rows it left behind
    // (pages.documentId has onDelete: 'cascade' — see db/schema.ts), so the insert
    // below starts from a clean slate rather than colliding with them.
    await db.delete(documents).where(eq(documents.id, existing.id));
  }

  const storagePath = originalPath(params.batchId, sha256);
  await uploadObject(storagePath, params.buffer, params.mimeType);

  const [renderedPages, pageTexts] = await Promise.all([
    renderPdfPages(params.buffer),
    extractPageTexts(params.buffer),
  ]);
  const hasTextLayer = pageTexts.every((p) => p.hasTextLayer);
  const ocrRequired = pageTexts.some((p) => !p.hasTextLayer);

  let documentId: string;
  try {
    const [inserted] = await db
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
    documentId = inserted.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Two concurrent uploads of the identical bytes to the same batch (a client
      // retry fired before the first request finished — plausible since a large
      // multi-page OCR ingest can take many seconds) both pass the dedupe check
      // above before either has inserted. The unique index on (batch_id, sha256)
      // is the actual source of truth for that race, not the earlier SELECT — the
      // loser reports a normal dedupe hit against whichever request won, same as
      // if it had simply arrived a moment later.
      const [winner] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.batchId, params.batchId), eq(documents.sha256, sha256)))
        .limit(1);
      if (winner) return { documentId: winner.id, deduped: true };
    }
    throw err;
  }

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
