import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { extractionSchemas } from '../db/schema.js';
import { isUniqueViolation } from '../lib/pgErrors.js';

const FIELD_TYPES = ['string', 'number', 'money', 'date', 'enum', 'table'] as const;

const ColumnSpecSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  enumValues: z.array(z.string()).optional(),
});

const FieldSpecSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  enumValues: z.array(z.string()).optional(),
  autoAcceptThreshold: z.number().min(0).max(1),
  description: z.string().min(1),
  columns: z.array(ColumnSpecSchema).optional(),
});

const CreateSchemaBody = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  docType: z.string().min(1),
  fields: z.array(FieldSpecSchema).min(1),
});

export async function schemaRoutes(app: FastifyInstance) {
  app.post('/schemas', async (req, reply) => {
    const parsed = CreateSchemaBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }

    try {
      const [created] = await db.insert(extractionSchemas).values(parsed.data).returning();
      reply.code(201).send(created);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: 'schema_already_exists', details: `${parsed.data.name} v${parsed.data.version} already exists` });
      }
      throw err;
    }
  });
}
