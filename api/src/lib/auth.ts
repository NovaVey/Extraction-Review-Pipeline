import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// Only gates requests when API_SHARED_SECRET is configured, so local dev and
// every existing test (neither of which sets it) keep working unauthenticated.
// Deployments reachable from the public internet should set it.
export function registerAuthGate(app: FastifyInstance) {
  const secret = env.API_SHARED_SECRET;
  if (!secret) {
    app.log.warn('API_SHARED_SECRET not set — all routes are unauthenticated');
    return;
  }
  app.addHook('onRequest', async (req, reply) => {
    // Exempt so Railway's own health checks (which can't send custom headers) still pass.
    if (req.url.split('?')[0] === '/health') return;
    const provided = req.headers['x-api-key'];
    if (typeof provided !== 'string' || !safeEqual(provided, secret)) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });
}
