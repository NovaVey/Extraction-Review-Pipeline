// One-off: extract a single document by id, explicitly overriding the dev-subset
// restriction. For documents uploaded through the plain HTTP API (which never sets
// inDevSubset — see ingest/upload.ts) or otherwise outside the original 10-doc dev
// subset, extractDocument() refuses by default (extract/run.ts) so the API route can
// never trigger an unbounded spend. This script is the same kind of deliberate,
// explicit exception extract-remaining-corpus.ts uses, scoped to one document you
// name on the command line rather than the whole remaining corpus.
// Run: npx tsx scripts/extract-one.ts <documentId>
import { pool } from '../api/src/db/client.js';
import { extractDocument } from '../api/src/extract/run.js';

const documentId = process.argv[2];
if (!documentId) {
  console.error('Usage: npx tsx scripts/extract-one.ts <documentId>');
  process.exit(1);
}

extractDocument(documentId, { allowOutsideDevSubset: true })
  .then((result) => {
    console.log(`extracted: documentId=${documentId} extractionId=${result.extractionId} fields=${result.fieldCount}`);
    return pool.end();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
