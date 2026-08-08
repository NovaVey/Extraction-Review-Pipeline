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

vi.mock('../src/documents/archive.js', () => ({
  archiveDocument: vi.fn(),
  unarchiveDocument: vi.fn(),
  DocumentNotFoundError: class DocumentNotFoundError extends Error {},
}));

const { buildApp } = await import('../src/app.js');
const { archiveDocument, unarchiveDocument, DocumentNotFoundError } = await import('../src/documents/archive.js');

beforeEach(() => {
  mocks.mockDocument = null;
  mocks.mockExtraction = null;
  mocks.mockFieldValues = [];
  mocks.mockFieldValueRows = [];
  vi.mocked(archiveDocument).mockReset();
  vi.mocked(unarchiveDocument).mockReset();
});

describe('GET /documents/:id/extraction', () => {
  it('returns 404 document_not_found when the document does not exist', async () => {
    mocks.mockDocument = null;

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/documents/88888888-8888-8888-8888-888888888888/extraction' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'document_not_found' });
  });

  it('returns 404 no_extraction_found when the document exists but has no extraction', async () => {
    mocks.mockDocument = { id: '11111111-1111-1111-1111-111111111111' };
    mocks.mockExtraction = null;

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/documents/11111111-1111-1111-1111-111111111111/extraction' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no_extraction_found' });
  });

  it('returns 200 with extraction, scalar field, and table field + rows in the expected shape', async () => {
    mocks.mockDocument = { id: '11111111-1111-1111-1111-111111111111' };
    mocks.mockExtraction = {
      id: 'extraction-1',
      documentId: '11111111-1111-1111-1111-111111111111',
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
    const res = await app.inject({ method: 'GET', url: '/documents/11111111-1111-1111-1111-111111111111/extraction' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      documentId: '11111111-1111-1111-1111-111111111111',
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

describe('POST /documents/:id/archive', () => {
  it('round trips a successful archive', async () => {
    vi.mocked(archiveDocument).mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', status: 'archived' });
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/documents/11111111-1111-1111-1111-111111111111/archive', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: '11111111-1111-1111-1111-111111111111', status: 'archived' });
    expect(archiveDocument).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', 'alice');
  });

  it('returns 404 document_not_found when the document does not exist', async () => {
    vi.mocked(archiveDocument).mockRejectedValue(new DocumentNotFoundError('no such document'));
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/documents/99999999-9999-9999-9999-999999999999/archive', payload: { reviewer: 'alice' } });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'document_not_found' });
  });

  it('returns 400 invalid_body when reviewer is missing', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/documents/11111111-1111-1111-1111-111111111111/archive', payload: {} });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
    expect(archiveDocument).not.toHaveBeenCalled();
  });
});

describe('POST /documents/:id/unarchive', () => {
  it('round trips a successful unarchive', async () => {
    vi.mocked(unarchiveDocument).mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', status: 'active' });
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/documents/11111111-1111-1111-1111-111111111111/unarchive' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: '11111111-1111-1111-1111-111111111111', status: 'active' });
  });

  it('returns 404 document_not_found when the document does not exist', async () => {
    vi.mocked(unarchiveDocument).mockRejectedValue(new DocumentNotFoundError('no such document'));
    const app = buildApp();

    const res = await app.inject({ method: 'POST', url: '/documents/99999999-9999-9999-9999-999999999999/unarchive' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'document_not_found' });
  });
});
