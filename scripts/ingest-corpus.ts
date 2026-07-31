// Bulk-ingests the full 60-doc synthetic corpus (samples/manifest.json) into
// one batch per doc type, reusing the schemas created by seed-schemas.ts.
// Ingestion itself always covers all 60 docs; only extraction (Phase 3+) is
// restricted to the 10-doc dev subset, via each document's inDevSubset flag
// (carried over here from the manifest, not re-decided).
// Idempotent: re-running reuses existing batches and dedupes already-ingested
// documents by (batchId, sha256) inside ingestDocument itself.
// Run: npx tsx scripts/ingest-corpus.ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../api/src/db/client.js';
import { batches, extractionSchemas } from '../api/src/db/schema.js';
import { ingestDocument } from '../api/src/ingest/upload.js';
import type { DocType } from './fieldSpecs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, '../samples');

interface ManifestDocument {
  filename: string;
  docType: DocType;
  inDevSubset: boolean;
}

interface Manifest {
  documents: ManifestDocument[];
}

async function getOrCreateBatch(docType: DocType): Promise<string> {
  const [schema] = await db
    .select({ id: extractionSchemas.id })
    .from(extractionSchemas)
    .where(eq(extractionSchemas.docType, docType))
    .orderBy(extractionSchemas.version)
    .limit(1);
  if (!schema) {
    throw new Error(`No extraction_schemas row for docType="${docType}" — run scripts/seed-schemas.ts first`);
  }

  const batchName = `${docType} corpus`;
  const [existing] = await db
    .select({ id: batches.id })
    .from(batches)
    .where(and(eq(batches.name, batchName), eq(batches.schemaId, schema.id)))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db.insert(batches).values({ name: batchName, schemaId: schema.id }).returning({ id: batches.id });
  return created.id;
}

async function main() {
  const manifest: Manifest = JSON.parse(await readFile(path.join(SAMPLES_DIR, 'manifest.json'), 'utf8'));

  const batchIdByDocType = new Map<DocType, string>();
  for (const docType of new Set(manifest.documents.map((d) => d.docType))) {
    const batchId = await getOrCreateBatch(docType);
    batchIdByDocType.set(docType, batchId);
    console.log(`Batch for docType="${docType}": ${batchId}`);
  }

  let ingested = 0;
  let deduped = 0;
  const failures: Array<{ filename: string; error: string }> = [];

  for (const doc of manifest.documents) {
    const batchId = batchIdByDocType.get(doc.docType);
    if (!batchId) {
      failures.push({ filename: doc.filename, error: `no batch resolved for docType="${doc.docType}"` });
      continue;
    }
    try {
      const buffer = await readFile(path.join(SAMPLES_DIR, doc.filename));
      const result = await ingestDocument({
        batchId,
        filename: doc.filename,
        mimeType: 'application/pdf',
        buffer,
        inDevSubset: doc.inDevSubset,
      });
      if (result.deduped) deduped++;
      else ingested++;
      console.log(`${result.deduped ? 'deduped' : 'ingested'}: ${doc.filename}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ filename: doc.filename, error: message });
      console.error(`failed: ${doc.filename} — ${message}`);
    }
  }

  console.log('');
  console.log(`Done. ingested=${ingested} deduped=${deduped} failed=${failures.length} total=${manifest.documents.length}`);
  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  ${f.filename}: ${f.error}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
