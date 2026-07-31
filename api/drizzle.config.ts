import { defineConfig } from 'drizzle-kit';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Try every plausible location for the repo-root .env: relative to this
// file (import.meta.url) and relative to process.cwd() (drizzle-kit's
// loader can run this config from either frame of reference depending on
// how it's invoked). dotenv silently skips any path that doesn't exist, so
// passing all of them is safe — whichever one is real gets loaded.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(__dirname, '../.env'),
  path.resolve(process.cwd(), '../.env'),
  path.resolve(process.cwd(), '.env'),
];
loadEnv({ path: candidates });

if (!process.env.DATABASE_URL) {
  throw new Error(
    `DATABASE_URL is not set. Looked for a .env file at:\n${candidates.map((p) => `  - ${p}`).join('\n')}\n` +
      'Create a .env at the repo root (sibling to package.json, not inside /api) with DATABASE_URL set.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
    // Railway's postgres-ssl template image serves a self-signed cert —
    // same reasoning as the rejectUnauthorized:false on pg.Pool in db/client.ts.
    ssl: { rejectUnauthorized: false },
  },
});
