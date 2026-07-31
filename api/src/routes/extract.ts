import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents } from '../db/schema.js';
import { extractDocument } from '../extract/run.js';

export async function extractRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>('/documents/:id/extract', async (req, reply) => {
    const { id } = req.params;
    const [doc] = await db.select({ id: documents.id }).from(documents).where(eq(documents.id, id)).limit(1);
    if (!doc) {
      return reply.code(404).send({ error: 'document_not_found' });
    }

    try {
      const result = await extractDocument(id);
      reply.code(201).send(result);
    } catch (err) {
      reply.code(400).send({ error: 'extraction_failed', details: err instanceof Error ? err.message : String(err) });
    }
  });
}
