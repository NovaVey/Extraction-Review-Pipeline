import { describe, it, expect, beforeEach, vi } from 'vitest';
import { batches, extractionSchemas, documents, extractions, fieldValues, fieldValueRows } from '../../src/db/schema.js';

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

const mocks = vi.hoisted(() => ({
  batchesCalls: [] as unknown[][],
  schemasCalls: [] as unknown[][],
  documentsCalls: [] as unknown[][],
  extractionsCalls: [] as unknown[][],
  fieldValuesCalls: [] as unknown[][],
  fieldValueRowsCalls: [] as unknown[][],
}));

// build.ts issues several distinct queries against the same table (one extractions
// lookup and one fieldValues lookup PER document, in a loop) — a FIFO queue per
// table, consumed in the same order build.ts issues the queries, models this.
function nextFrom(queue: unknown[][]): unknown[] {
  return queue.shift() ?? [];
}

function chain(resolveValue: unknown) {
  const obj: Record<string, unknown> = {};
  obj.where = () => obj;
  obj.orderBy = () => obj;
  obj.limit = () => Promise.resolve(resolveValue);
  obj.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(resolveValue).then(resolve, reject);
  return obj;
}

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === batches) return chain(nextFrom(mocks.batchesCalls));
        if (table === extractionSchemas) return chain(nextFrom(mocks.schemasCalls));
        if (table === documents) return chain(nextFrom(mocks.documentsCalls));
        if (table === extractions) return chain(nextFrom(mocks.extractionsCalls));
        if (table === fieldValues) return chain(nextFrom(mocks.fieldValuesCalls));
        if (table === fieldValueRows) return chain(nextFrom(mocks.fieldValueRowsCalls));
        throw new Error('unexpected table in mock select().from()');
      },
    })),
  },
}));

const { buildBatchExportCsv, NotFoundError } = await import('../../src/export/build.js');

const SCHEMA_FIELDS = [
  { key: 'invoice_number', label: 'Invoice Number', description: 'd', type: 'string', required: true, autoAcceptThreshold: 0.9 },
  {
    key: 'line_items',
    label: 'Line Items',
    description: 'd',
    type: 'table',
    required: true,
    autoAcceptThreshold: 0.9,
    columns: [{ key: 'description', label: 'Description', type: 'string', required: true }],
  },
];

beforeEach(() => {
  mocks.batchesCalls = [[{ id: 'batch-1', schemaId: 'schema-1' }]];
  mocks.schemasCalls = [[{ id: 'schema-1', docType: 'invoice', fields: SCHEMA_FIELDS }]];
  mocks.documentsCalls = [];
  mocks.extractionsCalls = [];
  mocks.fieldValuesCalls = [];
  mocks.fieldValueRowsCalls = [];
});

describe('buildBatchExportCsv', () => {
  it('throws NotFoundError for an unknown batch', async () => {
    mocks.batchesCalls = [[]];
    await expect(buildBatchExportCsv('missing', false)).rejects.toThrow(NotFoundError);
  });

  it('exports a resolved scalar field and a resolved table row using their final values', async () => {
    mocks.documentsCalls = [[{ id: 'doc-1', filename: 'inv.pdf', uploadedAt: new Date() }]];
    mocks.extractionsCalls = [[{ id: 'ext-1' }]];
    mocks.fieldValuesCalls = [
      [
        { id: 'fv-1', fieldKey: 'invoice_number', status: 'corrected', finalValue: 'INV-FIXED', normalizedValue: 'INV-1' },
        { id: 'fv-2', fieldKey: 'line_items', status: 'auto_accepted', finalValue: null, normalizedValue: null },
      ],
    ];
    mocks.fieldValueRowsCalls = [[{ rowIndex: 0, status: 'confirmed', cells: { description: 'raw' }, finalCells: { description: 'final' } }]];

    const result = await buildBatchExportCsv('batch-1', false);

    expect(result.rowCount).toBe(1);
    expect(result.skippedDocumentCount).toBe(0);
    expect(result.csv).toContain('doc-1,inv.pdf,invoice,INV-FIXED,');
    expect(result.csv).toContain('"description"');
    expect(result.csv).toContain('""final""'); // finalCells wins over cells, CSV-escaped
    expect(result.csv).not.toContain('""raw""');
    expect(result.csv).toContain(',1,1\r\n'); // resolved_field_count,total_field_count (line_items excluded from the scalar count)
  });

  it('blanks an unresolved scalar field and an unresolved table row by default', async () => {
    mocks.documentsCalls = [[{ id: 'doc-1', filename: 'inv.pdf', uploadedAt: new Date() }]];
    mocks.extractionsCalls = [[{ id: 'ext-1' }]];
    mocks.fieldValuesCalls = [
      [
        { id: 'fv-1', fieldKey: 'invoice_number', status: 'needs_review', finalValue: null, normalizedValue: 'INV-1' },
        { id: 'fv-2', fieldKey: 'line_items', status: 'auto_accepted', finalValue: null, normalizedValue: null },
      ],
    ];
    mocks.fieldValueRowsCalls = [[{ rowIndex: 0, status: 'needs_review', cells: { description: 'raw' }, finalCells: null }]];

    const result = await buildBatchExportCsv('batch-1', false);

    expect(result.csv).toContain('doc-1,inv.pdf,invoice,,'); // invoice_number blanked
    expect(result.csv).toContain('""cells"":null'); // CSV-escaped (the JSON cell itself is quoted)
    expect(result.csv).toContain(',0,1\r\n'); // resolved_field_count is 0
  });

  it('includes unresolved raw values when includeUnresolved is true', async () => {
    mocks.documentsCalls = [[{ id: 'doc-1', filename: 'inv.pdf', uploadedAt: new Date() }]];
    mocks.extractionsCalls = [[{ id: 'ext-1' }]];
    mocks.fieldValuesCalls = [
      [
        { id: 'fv-1', fieldKey: 'invoice_number', status: 'needs_review', finalValue: null, normalizedValue: 'INV-RAW' },
        { id: 'fv-2', fieldKey: 'line_items', status: 'auto_accepted', finalValue: null, normalizedValue: null },
      ],
    ];
    mocks.fieldValueRowsCalls = [[{ rowIndex: 0, status: 'needs_review', cells: { description: 'raw' }, finalCells: null }]];

    const result = await buildBatchExportCsv('batch-1', true);

    expect(result.csv).toContain('INV-RAW');
    expect(result.csv).toContain('""raw""');
  });

  it('skips a document with no extraction at all', async () => {
    mocks.documentsCalls = [[{ id: 'doc-1', filename: 'inv.pdf', uploadedAt: new Date() }]];
    mocks.extractionsCalls = [[]]; // no extraction found

    const result = await buildBatchExportCsv('batch-1', false);

    expect(result.rowCount).toBe(0);
    expect(result.skippedDocumentCount).toBe(1);
    expect(mocks.fieldValuesCalls).toHaveLength(0);
  });

  it('skips a document whose latest extraction produced zero field_values (e.g. status: failed)', async () => {
    mocks.documentsCalls = [[{ id: 'doc-1', filename: 'inv.pdf', uploadedAt: new Date() }]];
    mocks.extractionsCalls = [[{ id: 'ext-1' }]];
    mocks.fieldValuesCalls = [[]];

    const result = await buildBatchExportCsv('batch-1', false);

    expect(result.rowCount).toBe(0);
    expect(result.skippedDocumentCount).toBe(1);
  });

  it('skips an archived document without ever looking up its extraction', async () => {
    mocks.documentsCalls = [[{ id: 'doc-1', filename: 'inv.pdf', uploadedAt: new Date(), archivedAt: new Date() }]];

    const result = await buildBatchExportCsv('batch-1', false);

    expect(result.rowCount).toBe(0);
    expect(result.skippedDocumentCount).toBe(1);
    expect(mocks.extractionsCalls).toHaveLength(0);
  });
});
