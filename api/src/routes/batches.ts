import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { batches, documents } from '../db/schema.js';
import { ingestDocument } from '../ingest/upload.js';
import { isForeignKeyViolation } from '../lib/pgErrors.js';

const CreateBatchBody = z.object({
  name: z.string().min(1),
  schemaId: z.string().uuid(),
  createdBy: z.string().min(1).optional(),
});

// The ingest pipeline only ever reads a PDF's own text layer / rasterizes its
// own pages; there's no path for a directly-uploaded image to go through.
const ALLOWED_MIME_TYPES = new Set(['application/pdf']);

export async function batchRoutes(app: FastifyInstance) {
  app.post('/batches', async (req, reply) => {
    const parsed = CreateBatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }

    try {
      const [created] = await db.insert(batches).values(parsed.data).returning();
      reply.code(201).send(created);
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        return reply.code(400).send({ error: 'unknown_schema_id', details: `No extraction schema with id ${parsed.data.schemaId}` });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/batches/:id', async (req, reply) => {
    const { id } = req.params;
    const [batch] = await db.select().from(batches).where(eq(batches.id, id)).limit(1);
    if (!batch) {
      return reply.code(404).send({ error: 'batch_not_found' });
    }
    const docs = await db.select().from(documents).where(eq(documents.batchId, id));
    reply.send({ ...batch, documents: docs });
  });

  app.post<{ Params: { id: string } }>('/batches/:id/documents', async (req, reply) => {
    const { id } = req.params;
    const [batch] = await db.select({ id: batches.id }).from(batches).where(eq(batches.id, id)).limit(1);
    if (!batch) {
      return reply.code(404).send({ error: 'batch_not_found' });
    }
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: 'expected_multipart' });
    }

    const results: Array<{ filename: string; documentId?: string; deduped?: boolean; error?: string }> = [];
    for await (const part of req.files()) {
      if (!ALLOWED_MIME_TYPES.has(part.mimetype)) {
        await part.toBuffer(); // drain the stream so busboy can advance to the next part
        results.push({ filename: part.filename, error: `unsupported_mime_type:${part.mimetype}` });
        continue;
      }
      try {
        const buffer = await part.toBuffer();
        const result = await ingestDocument({
          batchId: id,
          filename: part.filename,
          mimeType: part.mimetype,
          buffer,
        });
        results.push({ filename: part.filename, documentId: result.documentId, deduped: result.deduped });
      } catch (err) {
        results.push({ filename: part.filename, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (results.length === 0) {
      return reply.code(400).send({ error: 'no_files_uploaded' });
    }
    reply.send({ results });
  });
}
