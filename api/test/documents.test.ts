import { describe, it, expect, vi, beforeEach } from 'vitest';
import { documents, extractions, fieldValues, fieldValueRows } from '../src/db/schema.js';

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

const mocks = vi.hoisted(() => ({
  mockDocument: null as { id: string } | null,
  mockExtraction: null as Record<string, unknown> | null,
  mockFieldValues: [] as Array<Record<string, unknown>>,
  mockFieldValueRows: [] as Array<Record<string, unknown>>,
}));

function chain(resolveValue: unknown) {
  const obj: Record<string, unknown> = {};
  obj.where = () => obj;
  obj.orderBy = () => obj;
  obj.limit = () => Promise.resolve(resolveValue);
  // fieldValues is awaited directly after .where(), with no .limit()/.orderBy() call,
  // so the chain itself has to be thenable.
  obj.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(resolveValue).then(resolve, reject);
  return obj;
}

vi.mock('../src/db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === documents) return chain(mocks.mockDocument ? [mocks.mockDocument] : []);
        if (table === extractions) return chain(mocks.mockExtraction ? [mocks.mockExtraction] : []);
        if (table === fieldValues) return chain(mocks.mockFieldValues);
        if (table === fieldValueRows) return chain(mocks.mockFieldValueRows);
        throw new Error('unexpected table in mock select().from()');
      },
    })),
  },
}));

const { buildApp } = await import('../src/app.js');

beforeEach(() => {
  mocks.mockDocument = null;
  mocks.mockExtraction = null;
  mocks.mockFieldValues = [];
  mocks.mockFieldValueRows = [];
});

describe('GET /documents/:id/extraction', () => {
  it('returns 404 document_not_found when the document does not exist', async () => {
    mocks.mockDocument = null;

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/documents/doc-missing/extraction' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'document_not_found' });
  });

  it('returns 404 no_extraction_found when the document exists but has no extraction', async () => {
    mocks.mockDocument = { id: 'doc-1' };
    mocks.mockExtraction = null;

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/documents/doc-1/extraction' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no_extraction_found' });
  });

  it('returns 200 with extraction, scalar field, and table field + rows in the expected shape', async () => {
    mocks.mockDocument = { id: 'doc-1' };
    mocks.mockExtraction = {
      id: 'extraction-1',
      documentId: 'doc-1',
      model: 'claude-sonnet-5',
      temperature: '0.8',
      outputMode: 'json_schema',
      promptVersion: 'v1',
      sampleCount: 3,
      rawResponses: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
      inputTokens: 4098,
      outputTokens: 398,
      status: 'completed',
      startedAt: '2026-07-30T00:00:00.000Z',
      finishedAt: '2026-07-30T00:00:05.000Z',
    };
    mocks.mockFieldValues = [
      {
        id: 'fv-invoice-number',
        extractionId: 'extraction-1',
        fieldKey: 'invoice_number',
        fieldType: 'string',
        rawValue: 'INV-17087',
        normalizedValue: 'INV-17087',
        confidence: '1',
        confidenceParts: { sampleAgreement: 1 },
        validatorStatus: 'valid',
        status: 'pending',
      },
      {
        id: 'fv-line-items',
        extractionId: 'extraction-1',
        fieldKey: 'line_items',
        fieldType: 'table',
        rawValue: null,
        normalizedValue: null,
        confidence: '1',
        confidenceParts: { sampleAgreement: 1 },
        validatorStatus: 'valid',
        status: 'pending',
      },
    ];
    mocks.mockFieldValueRows = [
      {
        id: 'row-1',
        fieldValueId: 'fv-line-items',
        rowIndex: 0,
        cells: { description: 'Widget', quantity: 1, unit_price: '$1.00', amount: '$1.00' },
        confidence: '1',
        status: 'pending',
      },
      {
        id: 'row-2',
        fieldValueId: 'fv-line-items',
        rowIndex: 1,
        cells: { description: 'Gadget', quantity: 2, unit_price: '$2.00', amount: '$4.00' },
        confidence: '1',
        status: 'pending',
      },
    ];

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/documents/doc-1/extraction' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      documentId: 'doc-1',
      extraction: {
        id: 'extraction-1',
        model: 'claude-sonnet-5',
        temperature: '0.8',
        outputMode: 'json_schema',
        promptVersion: 'v1',
        sampleCount: 3,
        sampleResponseCount: 3,
        inputTokens: 4098,
        outputTokens: 398,
        status: 'completed',
        startedAt: '2026-07-30T00:00:00.000Z',
        finishedAt: '2026-07-30T00:00:05.000Z',
      },
      fields: [
        {
          fieldKey: 'invoice_number',
          fieldType: 'string',
          rawValue: 'INV-17087',
          normalizedValue: 'INV-17087',
          confidence: '1',
          confidenceParts: { sampleAgreement: 1 },
          validatorStatus: 'valid',
          status: 'pending',
          rows: null,
        },
        {
          fieldKey: 'line_items',
          fieldType: 'table',
          rawValue: null,
          normalizedValue: null,
          confidence: '1',
          confidenceParts: { sampleAgreement: 1 },
          validatorStatus: 'valid',
          status: 'pending',
          rows: [
            { rowIndex: 0, cells: { description: 'Widget', quantity: 1, unit_price: '$1.00', amount: '$1.00' }, confidence: '1', status: 'pending' },
            { rowIndex: 1, cells: { description: 'Gadget', quantity: 2, unit_price: '$2.00', amount: '$4.00' }, confidence: '1', status: 'pending' },
          ],
        },
      ],
    });
  });
});
