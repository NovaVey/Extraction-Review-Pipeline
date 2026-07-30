import './lib/env.js';
import { buildApp } from './app.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';

logger.info(`Resolved model=${env.EXTRACTION_MODEL} temperature=${env.EXTRACTION_TEMPERATURE}`);

const app = buildApp();
app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
