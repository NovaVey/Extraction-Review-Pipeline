import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, batches, extractionSchemas, pages, extractions, fieldValues, fieldValueRows } from '../db/schema.js';
import { downloadObject } from '../lib/storage.js';
import { env } from '../lib/env.js';
import { extractSample, PROMPT_VERSION, type ExtractionSampleResult } from './anthropic.js';
import { validateValue, stripMoneySymbols, type ValidatorStatus } from '../confidence/validate.js';
import { canonicalizeValue } from '../confidence/canonicalize.js';
import { computeConfidence, decideStatus } from '../confidence/score.js';
import { computeCrossFieldChecks, type CrossFieldCheckResults } from '../confidence/crossFieldChecks.js';
import type { FieldSpec, FieldType } from './schema.js';

export interface ExtractDocumentResult {
  extractionId: string;
  fieldCount: number;
}

function hasParsedOutput(s: ExtractionSampleResult): s is ExtractionSampleResult & { parsed: Record<string, unknown> } {
  return s.parsed !== null;
}

// Self-consistency voting across the N samples: the value most samples agree on
// becomes the stored value, and the fraction that agreed becomes the confidence
// signal. Two samples are "the same" per keyFn, which defaults to JSON-stable-keying
// (works for scalars and whole line-item arrays alike, comparing by serialized
// equality) — callers that care about semantic rather than literal agreement (e.g.
// "$1,234.00" and "1,234" being the same money value) pass a canonicalizing keyFn
// instead; the returned value is always one of the original, unnormalized inputs, so
// audit/display always shows exactly what a sample actually said.
export function pickMajority<T>(values: T[], keyFn: (v: T) => string = (v) => JSON.stringify(v)): { value: T; agreement: number } {
  const counts = new Map<string, { value: T; count: number }>();
  for (const v of values) {
    const key = keyFn(v);
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { value: v, count: 1 });
  }
  let best: { value: T; count: number } = { value: values[0], count: 0 };
  for (const entry of counts.values()) {
    if (entry.count > best.count) best = entry;
  }
  return { value: best.value, agreement: best.count / values.length };
}

// Thin wrapper kept for callers that already have a FieldSpec in hand — the actual
// format-check logic lives in confidence/validate.ts so it can also validate
// individual line-item cell values with the same rules.
export function validateField(field: FieldSpec, rawValue: string | null): ValidatorStatus {
  return validateValue(field.type, field.enumValues, rawValue);
}

// The model transcribes money fields as literally printed ("$106.81"), matching the
// document — but the gold-set ground truth (manifest.json) stores the stripped form
// ("106.81"), confirmed by a live smoke test against a real sample. Strip here so
// normalizedValue is comparable to gold-set values later; rawValue keeps the original.
function normalizeValue(type: FieldType, rawValue: string | null): string | null {
  if (rawValue === null || type !== 'money') return rawValue;
  const stripped = stripMoneySymbols(rawValue);
  return stripped.length > 0 ? stripped : rawValue;
}

interface ScalarFieldResult {
  kind: 'scalar';
  field: FieldSpec;
  rawValue: string | null;
  normalizedValue: string | null;
  agreement: number;
  validatorStatus: ValidatorStatus;
}

interface TableFieldResult {
  kind: 'table';
  field: FieldSpec;
  majorityRows: Record<string, unknown>[];
  // Each row's OWN agreement, independent of every other row -- index-aligned with
  // majorityRows. Fixes the bug where one divergent row used to drag down every
  // other row's confidence by forcing them all to share a single whole-table number.
  rowAgreements: number[];
  // A representative agreement for the table as a whole (used for the field-level
  // fieldValues row, not any individual row) -- see extractDocument for how it's
  // derived.
  agreement: number;
  validatorStatus: ValidatorStatus;
}

type FieldPassResult = ScalarFieldResult | TableFieldResult;

export interface ExtractDocumentOptions {
  // Default false: extraction is restricted to the dev subset so the API route and
  // any future caller can't accidentally trigger a full-corpus (60-doc, ~180-sample)
  // Anthropic spend. scripts/extract-remaining-corpus.ts is the one deliberate,
  // user-authorized exception — it passes true explicitly, nothing else should.
  allowOutsideDevSubset?: boolean;
}

export async function extractDocument(documentId: string, options?: ExtractDocumentOptions): Promise<ExtractDocumentResult> {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) {
    throw new Error(`Document not found: ${documentId}`);
  }
  if (!doc.inDevSubset && !options?.allowOutsideDevSubset) {
    throw new Error(
      `Document ${documentId} is not in the dev subset — extraction is restricted to the dev subset to control API costs`,
    );
  }

  const [batch] = await db.select().from(batches).where(eq(batches.id, doc.batchId)).limit(1);
  if (!batch) {
    throw new Error(`Batch not found for document ${documentId}: ${doc.batchId}`);
  }
  const [schemaRow] = await db.select().from(extractionSchemas).where(eq(extractionSchemas.id, batch.schemaId)).limit(1);
  if (!schemaRow) {
    throw new Error(`Schema not found for batch ${batch.id}: ${batch.schemaId}`);
  }
  const fields = schemaRow.fields as FieldSpec[];

  const pageRows = await db.select().from(pages).where(eq(pages.documentId, documentId)).orderBy(pages.pageNumber);
  if (pageRows.length === 0) {
    throw new Error(`No pages found for document ${documentId} — has it been ingested?`);
  }

  const pageInputs = await Promise.all(
    pageRows.map(async (p) => ({
      pageNumber: p.pageNumber,
      text: p.textContent ?? '',
      imagePng: await downloadObject(p.imagePath),
    })),
  );

  const startedAt = new Date();
  const samples = await Promise.all(
    Array.from({ length: env.SAMPLE_COUNT }, () => extractSample({ fields, pages: pageInputs })),
  );
  const finishedAt = new Date();
  const successfulSamples = samples.filter(hasParsedOutput);

  const [extractionRow] = await db
    .insert(extractions)
    .values({
      documentId,
      schemaId: schemaRow.id,
      model: env.EXTRACTION_MODEL,
      // The configured value, kept for audit — claude-sonnet-5 rejects a non-default
      // temperature parameter with a 400, so this is never actually sent to the API.
      // Sample diversity instead comes from adaptive thinking's implicit variance.
      temperature: env.EXTRACTION_TEMPERATURE.toString(),
      outputMode: 'json_schema',
      promptVersion: PROMPT_VERSION,
      sampleCount: env.SAMPLE_COUNT,
      rawResponses: samples.map((s) => s.rawResponse),
      inputTokens: samples.reduce((sum, s) => sum + s.inputTokens, 0),
      outputTokens: samples.reduce((sum, s) => sum + s.outputTokens, 0),
      startedAt,
      finishedAt,
      status: successfulSamples.length > 0 ? 'completed' : 'failed',
    })
    .returning({ id: extractions.id });

  if (successfulSamples.length === 0) {
    throw new Error(`All ${samples.length} extraction samples failed to produce parseable output for document ${documentId}`);
  }

  // Pass 1: majority-vote + format-validate every field without touching the DB yet —
  // cross-field checks (pass 1.5) need every field's value available at once, so nothing
  // can be inserted until the whole schema has been resolved.
  const passResults: FieldPassResult[] = fields.map((field) => {
    if (field.type === 'table') {
      const sampleArrays = successfulSamples.map((s) => (s.parsed[field.key] as Record<string, unknown>[] | null | undefined) ?? []);
      const columns = field.columns ?? [];
      const rowCounts = sampleArrays.map((a) => a.length);
      const rowCountsAgree = rowCounts.every((c) => c === rowCounts[0]);

      let majorityRows: Record<string, unknown>[];
      let rowAgreements: number[];
      let agreement: number;

      if (rowCountsAgree && rowCounts[0] === 0) {
        // Every sample agrees the table is empty -- unanimous, nothing to vote on.
        majorityRows = [];
        rowAgreements = [];
        agreement = 1;
      } else if (rowCountsAgree) {
        // Vote independently per row-position, per-column, rather than on the whole
        // serialized array: previously, ANY single differing cell anywhere (a
        // transcription difference, whitespace, a formatting quirk) made the whole
        // array unique, collapsing agreement to the same low number for every row --
        // including rows the samples had actually agreed on perfectly. Per-cell
        // voting means a row's own confidence reflects only its own cells.
        const rowCount = rowCounts[0];
        majorityRows = [];
        rowAgreements = [];
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
          const cells: Record<string, unknown> = {};
          let minCellAgreement = 1;
          for (const column of columns) {
            const cellSamples = sampleArrays.map((arr) => arr[rowIndex]?.[column.key]);
            const picked = pickMajority(cellSamples, (v) => canonicalizeValue(column.type, v));
            cells[column.key] = picked.value;
            // A row can't be "mostly right" -- the same reasoning already applied to
            // format-validity below (one invalid cell taints the row) applies to
            // agreement too, so the row's own agreement is capped by its weakest cell.
            minCellAgreement = Math.min(minCellAgreement, picked.agreement);
          }
          majorityRows.push(cells);
          rowAgreements.push(minCellAgreement);
        }
        // The field-level row represents the table as a whole; capped by its weakest
        // row for the same "one bad spot taints the aggregate" reasoning, so the
        // table-level field never reads as auto-acceptable while a row within it is
        // genuinely in dispute.
        agreement = Math.min(...rowAgreements);
      } else {
        // Samples disagree on row COUNT itself -- table structure, not just cell
        // content, is in dispute. Aligning rows one-to-one across a different number
        // of them per sample needs a fuzzy matching strategy (e.g. by a stable key
        // like description+amount) this function doesn't attempt; fall back to
        // voting on the whole serialized (canonicalized) array, exactly as before
        // per-row voting existed, so this rarer case is still a well-defined
        // majority-of-N decision rather than a guessed alignment.
        // \x01/\x02 (rather than a plain comma or space) so a cell value that
        // happens to contain the separator can't make two different rows collide.
        const canonicalizeRow = (row: Record<string, unknown> | undefined) =>
          columns.map((c) => canonicalizeValue(c.type, row?.[c.key])).join('\x02');
        const canonicalizeArray = (rows: Record<string, unknown>[]) => rows.map(canonicalizeRow).join('\x01');
        const picked = pickMajority(sampleArrays, canonicalizeArray);
        majorityRows = picked.value;
        agreement = picked.agreement;
        // No independent per-row signal is available in this fallback -- the whole-
        // table agreement applies uniformly to every row, same as the pre-per-row-
        // voting behavior.
        rowAgreements = majorityRows.map(() => picked.agreement);
      }

      return {
        kind: 'table',
        field,
        majorityRows,
        rowAgreements,
        agreement,
        validatorStatus: majorityRows.length > 0 ? 'valid' : 'missing',
      };
    }
    const sampleValues = successfulSamples.map((s) => {
      const v = s.parsed[field.key];
      return v === null || v === undefined ? null : String(v);
    });
    // Same reasoning as the table branch above: vote on the field-type-aware
    // canonical form so "$1,234.00" vs "1,234" (still the same money value) counts
    // as agreement instead of silently defeating auto-accept on formatting noise.
    const { value: rawValue, agreement } = pickMajority(sampleValues, (v) => canonicalizeValue(field.type, v));
    return {
      kind: 'scalar',
      field,
      rawValue,
      normalizedValue: normalizeValue(field.type, rawValue),
      agreement,
      validatorStatus: validateField(field, rawValue),
    };
  });

  const scalars = new Map<string, { normalizedValue: string | null; validatorStatus: ValidatorStatus }>();
  for (const result of passResults) {
    if (result.kind === 'scalar') {
      scalars.set(result.field.key, { normalizedValue: result.normalizedValue, validatorStatus: result.validatorStatus });
    }
  }
  const tableResult = passResults.find((r): r is TableFieldResult => r.kind === 'table');
  const lineItemRows = tableResult ? tableResult.majorityRows : null;
  const crossFieldResults: CrossFieldCheckResults = computeCrossFieldChecks(scalars, lineItemRows);

  // Pass 2: score confidence (sample agreement, softened/zeroed by validatorStatus and
  // cross-field checks resolved above), decide auto_accepted vs needs_review, and insert.
  // Each field's write is independent of every other field's, so they run concurrently
  // rather than one-at-a-time — the only real ordering constraint is within a single
  // table field, whose row inserts need that field's own fieldValues.id first (those
  // rows are independent of *each other*, so they're concurrent too, just gated behind
  // their own field's insert).
  await Promise.all(
    passResults.map(async (result) => {
      const crossFieldChecks = crossFieldResults.perFieldChecks.get(result.field.key) ?? [];
      const confidence = computeConfidence({
        sampleAgreement: result.agreement,
        validatorStatus: result.validatorStatus,
        required: result.field.required,
        crossFieldChecks,
      });
      const status = decideStatus(confidence, result.field.autoAcceptThreshold);

      if (result.kind === 'table') {
        const [fvRow] = await db
          .insert(fieldValues)
          .values({
            extractionId: extractionRow.id,
            documentId,
            fieldKey: result.field.key,
            fieldType: result.field.type,
            rawValue: null,
            normalizedValue: null,
            confidence: confidence.toString(),
            confidenceParts: { sampleAgreement: result.agreement, validatorStatus: result.validatorStatus, crossFieldChecks },
            validatorStatus: result.validatorStatus,
            status,
          })
          .returning({ id: fieldValues.id });

        const columns = result.field.columns ?? [];
        await Promise.all(
          result.majorityRows.map(async (cells, rowIndex) => {
            // Aggregate the row's own validity from its cells: any format-invalid cell
            // taints the whole row (a row can't be "mostly right"); a missing optional
            // cell doesn't, mirroring how a missing-but-not-required scalar field isn't
            // penalized on its own.
            let hasInvalid = false;
            let hasMissingRequired = false;
            for (const column of columns) {
              const cellStatus = validateValue(column.type, column.enumValues, cells[column.key] as string | number | null | undefined);
              if (cellStatus === 'invalid') hasInvalid = true;
              else if (cellStatus === 'missing' && column.required) hasMissingRequired = true;
            }
            const rowValidatorStatus: ValidatorStatus = hasInvalid ? 'invalid' : hasMissingRequired ? 'missing' : 'valid';

            // The row's OWN agreement (from its own cells), not the whole table's --
            // see the table-branch comments above for why sharing one number across
            // every row was the bug this replaces.
            const rowAgreement = result.rowAgreements[rowIndex] ?? result.agreement;
            const rowCrossFieldChecks = crossFieldResults.perRowChecks[rowIndex] ?? [];
            const rowConfidence = computeConfidence({
              sampleAgreement: rowAgreement,
              validatorStatus: rowValidatorStatus,
              required: true,
              crossFieldChecks: rowCrossFieldChecks,
            });
            const rowStatus = decideStatus(rowConfidence, result.field.autoAcceptThreshold);

            await db.insert(fieldValueRows).values({
              fieldValueId: fvRow.id,
              rowIndex,
              cells,
              confidence: rowConfidence.toString(),
              confidenceParts: {
                sampleAgreement: rowAgreement,
                validatorStatus: rowValidatorStatus,
                crossFieldChecks: rowCrossFieldChecks,
              },
              status: rowStatus,
            });
          }),
        );
      } else {
        await db.insert(fieldValues).values({
          extractionId: extractionRow.id,
          documentId,
          fieldKey: result.field.key,
          fieldType: result.field.type,
          rawValue: result.rawValue,
          normalizedValue: result.normalizedValue,
          confidence: confidence.toString(),
          confidenceParts: { sampleAgreement: result.agreement, validatorStatus: result.validatorStatus, crossFieldChecks },
          validatorStatus: result.validatorStatus,
          status,
        });
      }
    }),
  );

  return { extractionId: extractionRow.id, fieldCount: fields.length };
}
