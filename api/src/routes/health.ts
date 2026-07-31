import type { FastifyInstance } from 'fastify';
import { pingDb } from '../db/client.js';
import { pingStorage } from '../lib/storage.js';
import { pingAnthropic } from '../lib/anthropic.js';
import { env } from '../lib/env.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    const [db, storage, anthropic] = await Promise.all([pingDb(), pingStorage(), pingAnthropic()]);
    const allOk = db.ok && storage.ok && anthropic.ok;
    reply.code(allOk ? 200 : 503).send({
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: {
        db: { ok: db.ok, latencyMs: 'latencyMs' in db ? db.latencyMs : undefined, error: 'error' in db ? db.error : undefined },
        storage: { ok: storage.ok, bucket: env.STORAGE_BUCKET, error: 'error' in storage ? storage.error : undefined },
        anthropic: {
          ok: anthropic.ok,
          model: 'model' in anthropic ? anthropic.model : undefined,
          error: 'error' in anthropic ? anthropic.error : undefined,
        },
      },
      config: { extractionModel: env.EXTRACTION_MODEL, extractionTemperature: env.EXTRACTION_TEMPERATURE },
    });
  });
}
