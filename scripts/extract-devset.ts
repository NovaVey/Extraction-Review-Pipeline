// Runs extraction over every document flagged inDevSubset=true (10 of the 60-doc
// corpus). Extraction is deliberately restricted to this subset — running it against
// the full corpus would multiply real Anthropic API cost by 6x for no eval benefit.
// Idempotent in the sense that each run creates fresh extractions rows (extraction
// history is additive, not deduped like ingestion) — re-running re-extracts everything.
// Run: npx tsx scripts/extract-devset.ts
import { eq } from 'drizzle-orm';
import { db, pool } from '../api/src/db/client.js';
import { documents } from '../api/src/db/schema.js';
import { extractDocument } from '../api/src/extract/run.js';

async function main() {
  const devSetDocs = await db
    .select({ id: documents.id, filename: documents.filename })
    .from(documents)
    .where(eq(documents.inDevSubset, true));
  console.log(`Found ${devSetDocs.length} dev-subset documents.`);

  let succeeded = 0;
  const failures: Array<{ filename: string; error: string }> = [];

  for (const doc of devSetDocs) {
    try {
      const result = await extractDocument(doc.id);
      succeeded++;
      console.log(`extracted: ${doc.filename} (extractionId=${result.extractionId}, fields=${result.fieldCount})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ filename: doc.filename, error: message });
      console.error(`failed: ${doc.filename} — ${message}`);
    }
  }

  console.log('');
  console.log(`Done. succeeded=${succeeded} failed=${failures.length} total=${devSetDocs.length}`);
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
