import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// Every :id route param across this API (batches, documents, extract, review,
// pages, exports) is compared directly against a Postgres `uuid` column. Postgres
// rejects a non-UUID literal at the SQL level with SQLSTATE 22P02 ('invalid input
// syntax for type uuid'), which none of those routes catch — it surfaces as an
// opaque 500 with the raw DB error message instead of the 404 a client should get
// for "no such resource". Checked once, globally, rather than repeating a format
// guard in every one of the ~17 route handlers that take an :id param (and risking
// a new one forgetting it).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerUuidParamGuard(app: FastifyInstance): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as Record<string, unknown> | undefined;
    if (params && typeof params.id === 'string' && !UUID_RE.test(params.id)) {
      return reply.code(404).send({ error: 'not_found' });
    }
  });
}
