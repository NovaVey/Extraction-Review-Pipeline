import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../../../.env') });

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  STORAGE_BUCKET: z.string().min(1).default('documents'),
  ANTHROPIC_API_KEY: z.string().min(1),
  REDIS_URL: z.string().optional(),
  EXTRACTION_MODEL: z.string().min(1),
  EXTRACTION_TEMPERATURE: z.coerce.number(),
  SAMPLE_COUNT: z.coerce.number().int().positive().default(3),
  SUBSET_SIZE: z.coerce.number().int().positive().default(10),
  RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  PORT: z.coerce.number().int().positive().default(3000),
});

export const env = EnvSchema.parse(process.env);
