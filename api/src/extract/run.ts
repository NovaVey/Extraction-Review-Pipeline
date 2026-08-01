import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, batches, extractionSchemas, pages, extractions, fieldValues, fieldValueRows } from '../db/schema.js';
import { downloadObject } from '../lib/storage.js';
import { env } from '../lib/env.js';
import { extractSample, PROMPT_VERSION, type ExtractionSampleResult } from './anthropic.js';
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

// Basic type-format sanity check, not business-rule validation (e.g. no
// subtotal+tax=total cross-field checks) — that composition belongs to a later
// confidence-scoring phase. This just answers "is what we got shaped like what we
// asked for," which field_values.validatorStatus (NOT NULL) needs populated regardless.
export function validateField(field: FieldSpec, rawValue: string | null): string {
  if (rawValue === null) return 'missing';
  switch (field.type) {
    case 'date':
      return Number.isNaN(Date.parse(rawValue)) ? 'invalid' : 'valid';
    case 'money': {
      const numeric = rawValue.replace(/[^0-9.-]/g, '');
      return numeric.length > 0 && !Number.isNaN(Number(numeric)) ? 'valid' : 'invalid';
    }
    case 'enum':
      return (field.enumValues ?? []).includes(rawValue) ? 'valid' : 'invalid';
    default:
      return rawValue.trim().length > 0 ? 'valid' : 'invalid';
  }
}

// The model transcribes money fields as literally printed ("$106.81"), matching the
// document — but the gold-set ground truth (manifest.json) stores the stripped form
// ("106.81"), confirmed by a live smoke test against a real sample. Strip here so
// normalizedValue is comparable to gold-set values later; rawValue keeps the original.
function normalizeValue(type: FieldType, rawValue: string | null): string | null {
  if (rawValue === null || type !== 'money') return rawValue;
  const stripped = rawValue.replace(/[^0-9.-]/g, '');
  return stripped.length > 0 ? stripped : rawValue;
}

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

  for (const field of fields) {
    if (field.type === 'table') {
      const sampleArrays = successfulSamples.map((s) => (s.parsed[field.key] as unknown[] | null | undefined) ?? []);
      const { value: majorityRows, agreement } = pickMajority(sampleArrays);

      const [fvRow] = await db
        .insert(fieldValues)
        .values({
          extractionId: extractionRow.id,
          documentId,
          fieldKey: field.key,
          fieldType: field.type,
          rawValue: null,
          normalizedValue: null,
          confidence: agreement.toString(),
          confidenceParts: { sampleAgreement: agreement },
          validatorStatus: majorityRows.length > 0 ? 'valid' : 'missing',
          status: 'pending',
        })
        .returning({ id: fieldValues.id });

      for (let rowIndex = 0; rowIndex < majorityRows.length; rowIndex++) {
        await db.insert(fieldValueRows).values({
          fieldValueId: fvRow.id,
          rowIndex,
          cells: majorityRows[rowIndex] as Record<string, unknown>,
          confidence: agreement.toString(),
          confidenceParts: { sampleAgreement: agreement },
          status: 'pending',
        });
      }
    } else {
      const sampleValues = successfulSamples.map((s) => {
        const v = s.parsed[field.key];
        return v === null || v === undefined ? null : String(v);
      });
      const { value: rawValue, agreement } = pickMajority(sampleValues);

      await db.insert(fieldValues).values({
        extractionId: extractionRow.id,
        documentId,
        fieldKey: field.key,
        fieldType: field.type,
        rawValue,
        normalizedValue: normalizeValue(field.type, rawValue),
        confidence: agreement.toString(),
        confidenceParts: { sampleAgreement: agreement },
        validatorStatus: validateField(field, rawValue),
        status: 'pending',
      });
    }
  }

  return { extractionId: extractionRow.id, fieldCount: fields.length };
}
