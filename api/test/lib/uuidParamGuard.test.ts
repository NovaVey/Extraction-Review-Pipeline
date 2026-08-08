import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerUuidParamGuard } from '../../src/lib/uuidParamGuard.js';

function buildTestApp() {
  const app = Fastify();
  registerUuidParamGuard(app);
  app.get<{ Params: { id: string } }>('/things/:id', async (req) => ({ id: req.params.id }));
  app.get('/no-id-param', async () => ({ ok: true }));
  return app;
}

describe('registerUuidParamGuard', () => {
  // Regression: a malformed :id used to reach the route handler, which passed it
  // straight into a `uuid`-typed Drizzle column comparison — Postgres rejects the
  // literal with SQLSTATE 22P02, surfacing as a raw 500 instead of a 404.
  it('returns 404 not_found for a malformed :id, without reaching the route handler', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/things/not-a-uuid' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('lets a well-formed UUID through to the route handler', async () => {
    const app = buildTestApp();
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const res = await app.inject({ method: 'GET', url: `/things/${uuid}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: uuid });
  });

  it('accepts an uppercase UUID (RFC 4122 is case-insensitive)', async () => {
    const app = buildTestApp();
    const uuid = '123E4567-E89B-12D3-A456-426614174000';
    const res = await app.inject({ method: 'GET', url: `/things/${uuid}` });
    expect(res.statusCode).toBe(200);
  });

  it('does not interfere with a route that has no :id param', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/no-id-param' });
    expect(res.statusCode).toBe(200);
  });
});
