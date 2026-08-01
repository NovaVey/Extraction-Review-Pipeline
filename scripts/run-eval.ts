// Compares the current (post-review) state of every dev-subset document's latest
// extraction against samples/manifest.json's ground truth, and reports auto-accept
// precision — the headline metric this project is built around: of the fields the
// system decided NOT to send to a human, how many were actually right.
// Run: npx tsx scripts/run-eval.ts
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pool } from '../api/src/db/client.js';
import { runEval } from '../api/src/eval/run.js';
import type { RateStat } from '../api/src/eval/run.js';

function formatRate(label: string, stat: RateStat): string {
  if (stat.rate === null) return `${label}: no data (0 fields)`;
  return `${label}: ${(stat.rate * 100).toFixed(1)}% (${stat.matched}/${stat.total})`;
}

async function main() {
  const summary = await runEval();

  console.log(`Evaluated ${summary.documentsEvaluated} documents (${summary.documentsSkipped.length} skipped).`);
  for (const skipped of summary.documentsSkipped) {
    console.log(`  skipped ${skipped.filename}: ${skipped.reason}`);
  }
  console.log('');
  console.log(formatRate('Auto-accept precision', summary.overall.autoAcceptPrecision));
  console.log(formatRate('Automation rate', summary.overall.automationRate));
  console.log(formatRate('Overall accuracy', summary.overall.overallAccuracy));

  console.log('\nBy doc type:');
  for (const [docType, stats] of Object.entries(summary.byDocType)) {
    console.log(`  ${docType}: ${formatRate('auto-accept precision', stats.autoAcceptPrecision)}`);
  }

  console.log('\nBy difficulty group:');
  for (const [group, stats] of Object.entries(summary.byDifficultyGroup)) {
    console.log(`  ${group}: ${formatRate('auto-accept precision', stats.autoAcceptPrecision)}`);
  }

  const mismatches = summary.fields.filter((f) => !f.matched);
  if (mismatches.length > 0) {
    console.log(`\n${mismatches.length} mismatch(es):`);
    for (const m of mismatches) {
      console.log(`  ${m.documentFilename} [${m.difficultyGroup}] ${m.fieldKey} (status=${m.status})`);
    }
  }

  const outPath = path.resolve(process.cwd(), 'eval-results.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nFull results written to ${outPath}`);

  if (summary.documentsSkipped.length > 0) process.exitCode = 1;
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
