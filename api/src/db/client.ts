import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { env } from '../lib/env.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,
});

export const db = drizzle(pool, { schema });

export async function pingDb() {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true as const, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}
