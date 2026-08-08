import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { registerAuthGate } from './lib/auth.js';
import { registerUuidParamGuard } from './lib/uuidParamGuard.js';
import { healthRoutes } from './routes/health.js';
import { schemaRoutes } from './routes/schemas.js';
import { batchRoutes } from './routes/batches.js';
import { extractRoutes } from './routes/extract.js';
import { documentRoutes } from './routes/documents.js';
import { reviewRoutes } from './routes/review.js';
import { pageRoutes } from './routes/pages.js';
import { exportRoutes } from './routes/exports.js';

// Matches the 20MB file_size_limit configured on the Supabase Storage bucket
// (see PROGRESS.md, Phase 0) so oversized uploads are rejected the same way
// at both layers.
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export function buildApp() {
  const app = Fastify({ logger: true });
  app.register(multipart, { limits: { fileSize: MAX_FILE_SIZE_BYTES } });
  registerAuthGate(app);
  registerUuidParamGuard(app);
  app.register(healthRoutes);
  app.register(schemaRoutes);
  app.register(batchRoutes);
  app.register(extractRoutes);
  app.register(documentRoutes);
  app.register(reviewRoutes);
  app.register(pageRoutes);
  app.register(exportRoutes);
  return app;
}
