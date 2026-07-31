// Seeds the extraction_schemas table with one v1 schema per doc type, from
// the same FIELD_SPECS used to generate the synthetic corpus's ground truth.
// Safe to re-run: an existing name+version is skipped, not duplicated.
// Run: npx tsx scripts/seed-schemas.ts
import { db, pool } from '../api/src/db/client.js';
import { extractionSchemas } from '../api/src/db/schema.js';
import { isUniqueViolation } from '../api/src/lib/pgErrors.js';
import { FIELD_SPECS, type DocType } from './fieldSpecs.js';

const SCHEMA_VERSION = 1;

async function main() {
  for (const docType of Object.keys(FIELD_SPECS) as DocType[]) {
    try {
      const [created] = await db
        .insert(extractionSchemas)
        .values({ name: docType, version: SCHEMA_VERSION, docType, fields: FIELD_SPECS[docType] })
        .returning({ id: extractionSchemas.id });
      console.log(`Created schema "${docType}" v${SCHEMA_VERSION} (id=${created.id})`);
    } catch (err) {
      if (isUniqueViolation(err)) {
        console.log(`Schema "${docType}" v${SCHEMA_VERSION} already exists, skipping`);
        continue;
      }
      throw err;
    }
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
