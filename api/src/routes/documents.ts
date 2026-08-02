import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, extractions, fieldValues, fieldValueRows } from '../db/schema.js';
import { archiveDocument, unarchiveDocument, DocumentNotFoundError } from '../documents/archive.js';

const ArchiveDocumentBody = z.object({
  reviewer: z.string().min(1),
});

export async function documentRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/documents/:id/extraction', async (req, reply) => {
    const { id } = req.params;
    const [doc] = await db.select({ id: documents.id }).from(documents).where(eq(documents.id, id)).limit(1);
    if (!doc) {
      return reply.code(404).send({ error: 'document_not_found' });
    }

    const [extraction] = await db
      .select()
      .from(extractions)
      .where(eq(extractions.documentId, id))
      .orderBy(desc(extractions.startedAt))
      .limit(1);
    if (!extraction) {
      return reply.code(404).send({ error: 'no_extraction_found' });
    }

    const fields = await db.select().from(fieldValues).where(eq(fieldValues.extractionId, extraction.id));

    // Only table-type fields (e.g. line_items) have child rows to fetch. There's
    // usually just one, but fetch any/all of them concurrently rather than in a
    // sequential loop.
    const tableFields = fields.filter((f) => f.fieldType === 'table');
    const rowsByFieldValueId = new Map(
      await Promise.all(
        tableFields.map(async (f) => {
          const rows = await db
            .select()
            .from(fieldValueRows)
            .where(eq(fieldValueRows.fieldValueId, f.id))
            .orderBy(fieldValueRows.rowIndex);
          return [f.id, rows] as const;
        }),
      ),
    );

    reply.send({
      documentId: id,
      extraction: {
        id: extraction.id,
        model: extraction.model,
        temperature: extraction.temperature,
        outputMode: extraction.outputMode,
        promptVersion: extraction.promptVersion,
        sampleCount: extraction.sampleCount,
        // Cheap confirmation that all N samples were actually stored, without
        // shipping the full (potentially large) raw Anthropic responses per request.
        // rawResponses is an untyped jsonb column — guard rather than assume it's an
        // array, so a malformed/hand-edited row degrades to null instead of a 500.
        sampleResponseCount: Array.isArray(extraction.rawResponses) ? extraction.rawResponses.length : null,
        inputTokens: extraction.inputTokens,
        outputTokens: extraction.outputTokens,
        status: extraction.status,
        startedAt: extraction.startedAt,
        finishedAt: extraction.finishedAt,
      },
      fields: fields.map((f) => ({
        fieldKey: f.fieldKey,
        fieldType: f.fieldType,
        rawValue: f.rawValue,
        normalizedValue: f.normalizedValue,
        confidence: f.confidence,
        confidenceParts: f.confidenceParts,
        validatorStatus: f.validatorStatus,
        status: f.status,
        rows:
          f.fieldType === 'table'
            ? (rowsByFieldValueId.get(f.id) ?? []).map((r) => ({
                rowIndex: r.rowIndex,
                cells: r.cells,
                confidence: r.confidence,
                status: r.status,
              }))
            : null,
      })),
    });
  });

  app.post<{ Params: { id: string } }>('/documents/:id/archive', async (req, reply) => {
    const parsed = ArchiveDocumentBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    try {
      const result = await archiveDocument(req.params.id, parsed.data.reviewer);
      reply.send(result);
    } catch (err) {
      if (err instanceof DocumentNotFoundError) return reply.code(404).send({ error: 'document_not_found' });
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/documents/:id/unarchive', async (req, reply) => {
    try {
      const result = await unarchiveDocument(req.params.id);
      reply.send(result);
    } catch (err) {
      if (err instanceof DocumentNotFoundError) return reply.code(404).send({ error: 'document_not_found' });
      throw err;
    }
  });
}
