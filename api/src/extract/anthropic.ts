import Anthropic from '@anthropic-ai/sdk';
import { env } from '../lib/env.js';
import { buildExtractionJsonSchema, type FieldSpec } from './schema.js';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// Bumped whenever SYSTEM_PROMPT or the schema-building logic changes in a way that
// would make old and new extractions non-comparable for eval/gold-set purposes.
export const PROMPT_VERSION = 'v1';

const SYSTEM_PROMPT = `You are extracting structured field values from a business document (an invoice, receipt, or purchase order) for a human-reviewed data pipeline.

Extract exactly what is printed or written on the document. Do not guess, infer, or fill in a plausible-looking value for anything not actually shown. If a field is genuinely not present anywhere on the document, its value is null — that is a normal, expected outcome, not an error.

Each page is provided as both extracted text and an image. The text was produced automatically (OCR or a PDF text layer) and can contain errors, especially on scanned or handwritten content — the image is the ground truth. Where they disagree, trust what you see in the image.`;

export interface ExtractionPageInput {
  pageNumber: number;
  text: string;
  imagePng: Buffer;
}

export interface ExtractionSampleResult {
  parsed: Record<string, unknown> | null;
  rawResponse: unknown; // the full Anthropic Message, stored verbatim in extractions.rawResponses for audit
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export async function extractSample(params: {
  fields: FieldSpec[];
  pages: ExtractionPageInput[];
}): Promise<ExtractionSampleResult> {
  const schema = buildExtractionJsonSchema(params.fields);

  const content: Anthropic.Messages.ContentBlockParam[] = [];
  for (const page of params.pages) {
    content.push({
      type: 'text',
      text: `--- Page ${page.pageNumber} extracted text ---\n${page.text || '(no text layer / OCR text)'}`,
    });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: page.imagePng.toString('base64') },
    });
  }
  content.push({ type: 'text', text: 'Extract the fields defined by the response schema from this document.' });

  try {
    const message = await client.messages.parse({
      model: env.EXTRACTION_MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema } },
    });

    return {
      // parsed_output is statically typed `null` here because we pass a plain JSON
      // Schema rather than a Zod-derived AutoParseableOutputFormat (the SDK can only
      // infer the type from the latter) — but client.messages.parse()'s runtime parser
      // (api/lib/parser.js) falls back to a plain JSON.parse() of the text block for any
      // json_schema format, Zod-derived or not, so this is populated correctly at runtime.
      parsed: message.parsed_output as Record<string, unknown> | null,
      rawResponse: message,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      stopReason: message.stop_reason,
    };
  } catch (err) {
    // client.messages.parse() throws (rather than resolving with parsed_output: null)
    // when its own client-side JSON parse of the model's text output fails — plausible
    // whenever a response gets cut off at the hard-coded max_tokens ceiling above. This
    // is one of N concurrent samples (see extract/run.ts's Promise.all over SAMPLE_COUNT
    // calls) — the whole design tolerates some samples failing to parse, but only if a
    // single throw here doesn't take every other in-flight sample down with it. Reported
    // as a gracefully-failed sample (parsed: null) instead, exactly like a sample whose
    // JSON happened to parse but produced nothing usable — extract/run.ts's
    // hasParsedOutput filter already treats that as "this sample doesn't count".
    const message = err instanceof Error ? err.message : String(err);
    return {
      parsed: null,
      rawResponse: { error: message },
      inputTokens: 0,
      outputTokens: 0,
      stopReason: 'parse_error',
    };
  }
}
