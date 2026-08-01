import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getNextReviewItem } from '../review/queue.js';
import {
  acceptField,
  correctField,
  acceptRow,
  correctRow,
  startReviewSession,
  endReviewSession,
  NotFoundError,
  SessionNotFoundError,
  NotNeedsReviewError,
  UnknownColumnKeyError,
} from '../review/actions.js';
import { isForeignKeyViolation } from '../lib/pgErrors.js';

const StartSessionBody = z.object({
  reviewer: z.string().min(1),
  batchId: z.string().uuid().optional(),
});

const NextQuery = z.object({
  batchId: z.string().uuid().optional(),
});

const AcceptFieldBody = z.object({
  reviewer: z.string().min(1),
  reviewSessionId: z.string().uuid().optional(),
});

const CorrectFieldBody = z.object({
  reviewer: z.string().min(1),
  newValue: z.string(),
  reason: z.string().optional(),
  reviewSessionId: z.string().uuid().optional(),
});

const AcceptRowBody = z.object({
  reviewer: z.string().min(1),
  reviewSessionId: z.string().uuid().optional(),
});

const CorrectRowBody = z.object({
  reviewer: z.string().min(1),
  columnKey: z.string().min(1),
  newValue: z.string(),
  reason: z.string().optional(),
  reviewSessionId: z.string().uuid().optional(),
});

export async function reviewRoutes(app: FastifyInstance) {
  app.post('/review-sessions', async (req, reply) => {
    const parsed = StartSessionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    try {
      const session = await startReviewSession(parsed.data.reviewer, parsed.data.batchId);
      reply.code(201).send(session);
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        return reply.code(400).send({ error: 'unknown_batch_id', details: `No batch with id ${parsed.data.batchId}` });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/review-sessions/:id/end', async (req, reply) => {
    try {
      const session = await endReviewSession(req.params.id);
      reply.send(session);
    } catch (err) {
      if (err instanceof NotFoundError) {
        return reply.code(404).send({ error: 'review_session_not_found' });
      }
      throw err;
    }
  });

  app.get<{ Querystring: { batchId?: string } }>('/review/next', async (req, reply) => {
    const parsed = NextQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', details: parsed.error.flatten() });
    }
    const item = await getNextReviewItem(parsed.data.batchId);
    reply.send({ item });
  });

  app.post<{ Params: { id: string } }>('/review/fields/:id/accept', async (req, reply) => {
    const parsed = AcceptFieldBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    try {
      const result = await acceptField(req.params.id, parsed.data.reviewer, parsed.data.reviewSessionId);
      reply.send(result);
    } catch (err) {
      if (err instanceof NotFoundError) return reply.code(404).send({ error: 'field_not_found' });
      if (err instanceof SessionNotFoundError) return reply.code(404).send({ error: 'review_session_not_found' });
      if (err instanceof NotNeedsReviewError) return reply.code(400).send({ error: 'not_needs_review' });
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/review/fields/:id/correct', async (req, reply) => {
    const parsed = CorrectFieldBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    try {
      const result = await correctField(
        req.params.id,
        parsed.data.reviewer,
        parsed.data.newValue,
        parsed.data.reason,
        parsed.data.reviewSessionId,
      );
      reply.send(result);
    } catch (err) {
      if (err instanceof NotFoundError) return reply.code(404).send({ error: 'field_not_found' });
      if (err instanceof SessionNotFoundError) return reply.code(404).send({ error: 'review_session_not_found' });
      if (err instanceof NotNeedsReviewError) return reply.code(400).send({ error: 'not_needs_review' });
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/review/rows/:id/accept', async (req, reply) => {
    const parsed = AcceptRowBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    try {
      const result = await acceptRow(req.params.id, parsed.data.reviewer, parsed.data.reviewSessionId);
      reply.send(result);
    } catch (err) {
      if (err instanceof NotFoundError) return reply.code(404).send({ error: 'review_row_not_found' });
      if (err instanceof SessionNotFoundError) return reply.code(404).send({ error: 'review_session_not_found' });
      if (err instanceof NotNeedsReviewError) return reply.code(400).send({ error: 'not_needs_review' });
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/review/rows/:id/correct', async (req, reply) => {
    const parsed = CorrectRowBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    try {
      const result = await correctRow(
        req.params.id,
        parsed.data.reviewer,
        parsed.data.columnKey,
        parsed.data.newValue,
        parsed.data.reason,
        parsed.data.reviewSessionId,
      );
      reply.send(result);
    } catch (err) {
      if (err instanceof NotFoundError) return reply.code(404).send({ error: 'review_row_not_found' });
      if (err instanceof SessionNotFoundError) return reply.code(404).send({ error: 'review_session_not_found' });
      if (err instanceof NotNeedsReviewError) return reply.code(400).send({ error: 'not_needs_review' });
      if (err instanceof UnknownColumnKeyError) return reply.code(400).send({ error: 'unknown_column_key' });
      throw err;
    }
  });
}
