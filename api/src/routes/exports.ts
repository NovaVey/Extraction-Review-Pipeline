import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { exportsTable } from '../db/schema.js';
import { uploadObject, downloadObject } from '../lib/storage.js';
import { isUniqueViolation, isForeignKeyViolation } from '../lib/pgErrors.js';
import { buildBatchExportCsv, NotFoundError } from '../export/build.js';

const CreateExportBody = z.object({
  target: z.literal('csv'),
  idempotencyKey: z.string().min(1),
  includeUnresolved: z.boolean().optional().default(false),
});

export async function exportRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>('/batches/:id/export', async (req, reply) => {
    const parsed = CreateExportBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const batchId = req.params.id;
    const { target, idempotencyKey, includeUnresolved } = parsed.data;

    // Claim the idempotency key via the insert itself (not a pre-check-then-insert)
    // so two concurrent requests with the same key can't both proceed — the unique
    // constraint is the actual source of truth, not a race-prone application check.
    let exportRow: typeof exportsTable.$inferSelect;
    try {
      [exportRow] = await db.insert(exportsTable).values({ batchId, target, idempotencyKey, status: 'processing' }).returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Retrying with the same key returns whatever already happened rather than
        // erroring — that's the point of an idempotency key, not a real conflict.
        const [existing] = await db.select().from(exportsTable).where(eq(exportsTable.idempotencyKey, idempotencyKey)).limit(1);
        return reply.code(200).send(existing);
      }
      if (isForeignKeyViolation(err)) {
        return reply.code(400).send({ error: 'unknown_batch_id', details: `No batch with id ${batchId}` });
      }
      throw err;
    }

    try {
      const { csv, rowCount, skippedDocumentCount } = await buildBatchExportCsv(batchId, includeUnresolved);
      const filePath = `exports/${batchId}/${exportRow.id}.csv`;
      await uploadObject(filePath, Buffer.from(csv, 'utf8'), 'text/csv');

      const [updated] = await db
        .update(exportsTable)
        .set({ status: 'completed', rowCount, filePath, completedAt: new Date() })
        .where(eq(exportsTable.id, exportRow.id))
        .returning();
      reply.code(201).send({ ...updated, skippedDocumentCount });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(exportsTable)
        .set({ status: 'failed', error: message, completedAt: new Date() })
        .where(eq(exportsTable.id, exportRow.id));
      // NotFoundError (schema missing for an already-FK-validated batch) shouldn't be
      // reachable in practice, but is handled rather than falling through to a 500.
      if (err instanceof NotFoundError) {
        return reply.code(404).send({ error: 'batch_not_found' });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/exports/:id', async (req, reply) => {
    const [row] = await db.select().from(exportsTable).where(eq(exportsTable.id, req.params.id)).limit(1);
    if (!row) return reply.code(404).send({ error: 'export_not_found' });
    reply.send(row);
  });

  app.get<{ Params: { id: string } }>('/exports/:id/download', async (req, reply) => {
    const [row] = await db.select().from(exportsTable).where(eq(exportsTable.id, req.params.id)).limit(1);
    if (!row) return reply.code(404).send({ error: 'export_not_found' });
    if (row.status !== 'completed' || !row.filePath) {
      return reply.code(400).send({ error: 'export_not_ready', details: `status: ${row.status}` });
    }
    const buffer = await downloadObject(row.filePath);
    reply.header('content-disposition', `attachment; filename="export-${row.id}.csv"`);
    reply.type('text/csv').send(buffer);
  });
}
