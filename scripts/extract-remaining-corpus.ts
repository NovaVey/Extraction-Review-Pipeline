// Runs extraction over every document that does NOT yet have an extraction — the 50
// of 60 documents left over after scripts/extract-devset.ts's original 10-document
// dev subset. Unlike extract-devset.ts (which deliberately re-extracts on every run,
// since the 10-doc subset is meant for cheap iteration), this script skips anything
// already extracted, so re-running it after a partial/failed run only pays for what's
// still missing rather than re-charging for work that already succeeded.
//
// Passes allowOutsideDevSubset: true to extractDocument — that guard exists
// specifically to stop the API route (and any other caller) from accidentally
// triggering a full-corpus spend; this script is the one deliberate exception,
// explicitly authorized (twice, knowing the real cost both times) rather than
// something to route around quietly.
// Run: npx tsx scripts/extract-remaining-corpus.ts
import { db, pool } from '../api/src/db/client.js';
import { documents, extractions } from '../api/src/db/schema.js';
import { extractDocument } from '../api/src/extract/run.js';

async function main() {
  const allDocs = await db.select({ id: documents.id, filename: documents.filename }).from(documents);
  const alreadyExtracted = await db.selectDistinct({ documentId: extractions.documentId }).from(extractions);
  const alreadyExtractedIds = new Set(alreadyExtracted.map((e) => e.documentId));
  const remaining = allDocs.filter((d) => !alreadyExtractedIds.has(d.id));

  console.log(`${allDocs.length} documents total, ${alreadyExtractedIds.size} already extracted, ${remaining.length} remaining.`);

  let succeeded = 0;
  const failures: Array<{ filename: string; error: string }> = [];

  for (const doc of remaining) {
    try {
      const result = await extractDocument(doc.id, { allowOutsideDevSubset: true });
      succeeded++;
      console.log(`extracted: ${doc.filename} (extractionId=${result.extractionId}, fields=${result.fieldCount})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ filename: doc.filename, error: message });
      console.error(`failed: ${doc.filename} — ${message}`);
    }
  }

  console.log('');
  console.log(`Done. succeeded=${succeeded} failed=${failures.length} total=${remaining.length}`);
  if (failures.length > 0) {
    console.log('Failures (re-run this script to retry just these):');
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
