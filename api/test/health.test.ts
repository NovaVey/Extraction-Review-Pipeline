import { describe, it, expect, vi } from 'vitest';

// The pings below are mocked, so real credentials are never used — but env.ts
// validates process.env eagerly on import, so fill in anything a bare clone
// (no .env yet) wouldn't have, without clobbering real values if present.
process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

vi.mock('../src/db/client.js', () => ({ pingDb: async () => ({ ok: true, latencyMs: 1 }) }));
vi.mock('../src/lib/storage.js', () => ({ pingStorage: async () => ({ ok: true, bucket: { id: 'erp-documents' } }) }));
vi.mock('../src/lib/anthropic.js', () => ({ pingAnthropic: async () => ({ ok: true, model: 'claude-sonnet-5' }) }));

const { buildApp } = await import('../src/app.js');

describe('GET /health', () => {
  it('returns 200 and reports all checks ok when dependencies are healthy', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.db.ok).toBe(true);
    expect(body.checks.storage.ok).toBe(true);
    expect(body.checks.anthropic.ok).toBe(true);
    expect(body.config.extractionModel).toBeDefined();
  });
});

describe('GET /health when a dependency is unhealthy', () => {
  it('returns 503 and reports degraded status', async () => {
    vi.doMock('../src/db/client.js', () => ({ pingDb: async () => ({ ok: false, error: 'connection refused' }) }));
    vi.resetModules();
    const { buildApp: buildAppDegraded } = await import('../src/app.js');
    const app = buildAppDegraded();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('degraded');
  });
});
