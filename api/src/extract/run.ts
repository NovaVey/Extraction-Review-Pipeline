import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, batches, extractionSchemas, pages, extractions, fieldValues, fieldValueRows } from '../db/schema.js';
import { downloadObject } from '../lib/storage.js';
import { env } from '../lib/env.js';
import { extractSample, PROMPT_VERSION, type ExtractionSampleResult } from './anthropic.js';
import { validateValue, stripMoneySymbols, type ValidatorStatus } from '../confidence/validate.js';
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
// (after JSON-stable-keying) becomes the stored value, and the fraction that agreed
// becomes the confidence signal. Works identically for scalars and whole line-item
// arrays — an array is just another value to compare by serialized equality.
export function pickMajority<T>(values: T[]): { value: T; agreement: number } {
  const counts = new Map<string, { value: T; count: number }>();
  for (const v of values) {
    const key = JSON.stringify(v);
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
  agreement: number;
  validatorStatus: ValidatorStatus;
}

type FieldPassResult = ScalarFieldResult | TableFieldResult;

export async function extractDocument(documentId: string): Promise<ExtractDocumentResult> {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) {
    throw new Error(`Document not found: ${documentId}`);
  }
  if (!doc.inDevSubset) {
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
      const sampleArrays = successfulSamples.map((s) => (s.parsed[field.key] as unknown[] | null | undefined) ?? []);
      const { value: majorityRows, agreement } = pickMajority(sampleArrays);
      return {
        kind: 'table',
        field,
        majorityRows: majorityRows as Record<string, unknown>[],
        agreement,
        validatorStatus: majorityRows.length > 0 ? 'valid' : 'missing',
      };
    }
    const sampleValues = successfulSamples.map((s) => {
      const v = s.parsed[field.key];
      return v === null || v === undefined ? null : String(v);
    });
    const { value: rawValue, agreement } = pickMajority(sampleValues);
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
  for (const result of passResults) {
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
      for (let rowIndex = 0; rowIndex < result.majorityRows.length; rowIndex++) {
        const cells = result.majorityRows[rowIndex];

        // Aggregate the row's own validity from its cells: any format-invalid cell
        // taints the whole row (a row can't be "mostly right"); a missing optional
        // cell doesn't, mirroring how a missing-but-not-required scalar field isn't
        // penalized on its own.
        let hasInvalid = false;
        let hasMissingRequired = false;
        for (const column of columns) {
          const cellStatus = validateValue(column.type, undefined, cells[column.key] as string | number | null | undefined);
          if (cellStatus === 'invalid') hasInvalid = true;
          else if (cellStatus === 'missing' && column.required) hasMissingRequired = true;
        }
        const rowValidatorStatus: ValidatorStatus = hasInvalid ? 'invalid' : hasMissingRequired ? 'missing' : 'valid';

        const rowCrossFieldChecks = crossFieldResults.perRowChecks[rowIndex] ?? [];
        const rowConfidence = computeConfidence({
          sampleAgreement: result.agreement,
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
            sampleAgreement: result.agreement,
            validatorStatus: rowValidatorStatus,
            crossFieldChecks: rowCrossFieldChecks,
          },
          status: rowStatus,
        });
      }
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
  }

  return { extractionId: extractionRow.id, fieldCount: fields.length };
}
