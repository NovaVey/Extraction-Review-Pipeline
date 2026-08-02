import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

const ORIGINAL_SECRET = process.env.API_SHARED_SECRET;

function setOrDelete(value: string | undefined) {
  // process.env assignment stringifies: `= undefined` becomes the literal
  // string "undefined", not a deleted key, so unsetting needs a real delete.
  if (value === undefined) {
    delete process.env.API_SHARED_SECRET;
  } else {
    process.env.API_SHARED_SECRET = value;
  }
}

afterEach(() => {
  setOrDelete(ORIGINAL_SECRET);
});

// env.ts parses process.env once at import time, so picking up a per-test
// API_SHARED_SECRET requires a fresh module graph — same technique health.test.ts
// uses to re-import app.js after changing what a dependency mocks to.
async function appWithSecret(secret: string | undefined) {
  setOrDelete(secret);
  vi.resetModules();
  const { registerAuthGate } = await import('../../src/lib/auth.js');
  const app = Fastify();
  registerAuthGate(app);
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/schemas', async () => ({ items: [] }));
  return app;
}

describe('registerAuthGate', () => {
  describe('when API_SHARED_SECRET is unset', () => {
    it('lets requests through with no header', async () => {
      const app = await appWithSecret(undefined);
      const res = await app.inject({ method: 'GET', url: '/schemas' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('when API_SHARED_SECRET is set', () => {
    let app: Awaited<ReturnType<typeof appWithSecret>>;

    beforeEach(async () => {
      app = await appWithSecret('the-real-secret');
    });

    it('rejects a gated route with no x-api-key header', async () => {
      const res = await app.inject({ method: 'GET', url: '/schemas' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
    });

    it('rejects a gated route with the wrong x-api-key header', async () => {
      const res = await app.inject({ method: 'GET', url: '/schemas', headers: { 'x-api-key': 'wrong' } });
      expect(res.statusCode).toBe(401);
    });

    it('allows a gated route with the correct x-api-key header', async () => {
      const res = await app.inject({ method: 'GET', url: '/schemas', headers: { 'x-api-key': 'the-real-secret' } });
      expect(res.statusCode).toBe(200);
    });

    it('exempts /health even with no header', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    });
  });
});
