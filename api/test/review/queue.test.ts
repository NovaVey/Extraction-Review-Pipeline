import { describe, it, expect, beforeEach, vi } from 'vitest';
import { documents, extractions, extractionSchemas, fieldValues, fieldValueRows, pages } from '../../src/db/schema.js';

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

const mocks = vi.hoisted(() => ({
  fieldValueRowsCalls: [] as unknown[][],
  documentsCalls: [] as unknown[][],
  fieldValuesCalls: [] as unknown[][],
  extractionsCalls: [] as unknown[][],
  schemasCalls: [] as unknown[][],
  pagesCalls: [] as unknown[][],
}));

// The real implementation issues several distinct queries against the same table
// (e.g. fieldValueRows is queried once for needs_review row candidates, then again
// for a chosen table field's full row set) — a plain per-table canned value can't
// distinguish those. Instead each table gets a FIFO queue of responses, one entry
// per expected call, consumed in the same order queue.ts issues them.
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
        if (table === fieldValueRows) return chain(nextFrom(mocks.fieldValueRowsCalls));
        if (table === documents) return chain(nextFrom(mocks.documentsCalls));
        if (table === fieldValues) return chain(nextFrom(mocks.fieldValuesCalls));
        if (table === extractions) return chain(nextFrom(mocks.extractionsCalls));
        if (table === extractionSchemas) return chain(nextFrom(mocks.schemasCalls));
        if (table === pages) return chain(nextFrom(mocks.pagesCalls));
        throw new Error('unexpected table in mock select().from()');
      },
    })),
  },
}));

const { getNextReviewItem, getReviewItemForDocument, getReviewQueueStats, getNeedsReviewDocumentIds, getDocumentDisplayNames, NoReviewableFieldError } =
  await import('../../src/review/queue.js');
const { DocumentNotFoundError } = await import('../../src/documents/archive.js');

beforeEach(() => {
  mocks.fieldValueRowsCalls = [];
  mocks.documentsCalls = [];
  mocks.fieldValuesCalls = [];
  mocks.extractionsCalls = [];
  mocks.schemasCalls = [];
  mocks.pagesCalls = [];
});

describe('getNextReviewItem', () => {
  it('returns a plain needs_review scalar field', async () => {
    mocks.fieldValueRowsCalls = [[]]; // no table has any needs_review row
    mocks.fieldValuesCalls = [
      [
        {
          id: 'fv-1',
          documentId: 'doc-1',
          extractionId: 'ext-1',
          fieldKey: 'invoice_number',
          fieldType: 'string',
          rawValue: 'INV-1',
          normalizedValue: 'INV-1',
          confidence: '0.4',
          confidenceParts: { sampleAgreement: 0.4 },
          validatorStatus: 'valid',
          status: 'needs_review',
        },
      ],
    ];
    mocks.extractionsCalls = [[{ id: 'ext-1', schemaId: 'schema-1' }]];
    // Two documents-table calls now: the archived-document exclusion lookup (empty —
    // nothing archived), then the chosen candidate's own document lookup.
    mocks.documentsCalls = [[], [{ id: 'doc-1', filename: 'invoice.pdf', batchId: 'batch-1' }]];
    mocks.schemasCalls = [
      [
        {
          id: 'schema-1',
          fields: [
            { key: 'invoice_number', label: 'Invoice Number', description: 'The invoice number', type: 'string', required: true, autoAcceptThreshold: 0.9 },
          ],
        },
      ],
    ];
    mocks.pagesCalls = [[{ id: 'page-1', pageNumber: 1, width: 100, height: 200 }]];

    const item = await getNextReviewItem();

    expect(item).toEqual({
      fieldValueId: 'fv-1',
      documentId: 'doc-1',
      documentFilename: 'invoice.pdf',
      batchId: 'batch-1',
      fieldKey: 'invoice_number',
      fieldType: 'string',
      label: 'Invoice Number',
      description: 'The invoice number',
      rawValue: 'INV-1',
      normalizedValue: 'INV-1',
      confidence: '0.4',
      confidenceParts: { sampleAgreement: 0.4 },
      validatorStatus: 'valid',
      status: 'needs_review',
      rows: null,
      pages: [{ id: 'page-1', pageNumber: 1, width: 100, height: 200 }],
    });
  });

  it('returns a table field whose own status is auto_accepted but which has one needs_review row, with ALL its rows', async () => {
    mocks.fieldValueRowsCalls = [[{ fieldValueId: 'fv-2' }]];
    mocks.fieldValuesCalls = [
      [
        {
          id: 'fv-2',
          documentId: 'doc-2',
          extractionId: 'ext-2',
          fieldKey: 'line_items',
          fieldType: 'table',
          rawValue: null,
          normalizedValue: null,
          confidence: '0.95',
          confidenceParts: {},
          validatorStatus: 'valid',
          status: 'auto_accepted',
        },
      ],
    ];
    mocks.extractionsCalls = [[{ id: 'ext-2', schemaId: 'schema-2' }]];
    mocks.documentsCalls = [[], [{ id: 'doc-2', filename: 'po.pdf' }]];
    mocks.schemasCalls = [
      [
        {
          id: 'schema-2',
          fields: [
            {
              key: 'line_items',
              label: 'Line Items',
              description: 'Line items',
              type: 'table',
              required: true,
              autoAcceptThreshold: 0.9,
              columns: [
                { key: 'description', label: 'Description', type: 'string', required: true },
                { key: 'amount', label: 'Amount', type: 'money', required: true },
              ],
            },
          ],
        },
      ],
    ];
    mocks.pagesCalls = [[{ id: 'page-2', pageNumber: 1, width: 100, height: 200 }]];
    // The chosen field's full row set — includes an auto_accepted row alongside the
    // needs_review one that made this field a candidate in the first place.
    mocks.fieldValueRowsCalls.push([
      { id: 'row-1', rowIndex: 0, cells: { description: 'Widget', amount: '1.00' }, confidence: '1', confidenceParts: {}, status: 'auto_accepted' },
      { id: 'row-2', rowIndex: 1, cells: { description: 'Gadget', amount: '2.00' }, confidence: '0.3', confidenceParts: {}, status: 'needs_review' },
    ]);

    const item = await getNextReviewItem();

    expect(item?.fieldValueId).toBe('fv-2');
    expect(item?.status).toBe('auto_accepted');
    expect(item?.rows).toHaveLength(2);
    expect(item?.rows?.map((r) => r.status)).toEqual(['auto_accepted', 'needs_review']);
    expect(item?.rows?.[0].columns).toEqual([
      { key: 'description', label: 'Description', type: 'string' },
      { key: 'amount', label: 'Amount', type: 'money' },
    ]);
  });

  it('returns null when there are no candidates at all', async () => {
    mocks.fieldValueRowsCalls = [[]];
    mocks.fieldValuesCalls = [[]];

    const item = await getNextReviewItem();

    expect(item).toBeNull();
  });

  it('never surfaces a needs_review field_value from a superseded (non-latest) extraction', async () => {
    // doc-3 has two extractions: ext-old (superseded) still carries a needs_review
    // field_value that nothing ever resolved; ext-new is the document's current
    // extraction and has no outstanding field. The stale candidate must be
    // discarded rather than returned.
    mocks.fieldValueRowsCalls = [[]];
    mocks.fieldValuesCalls = [
      [
        {
          id: 'fv-old',
          documentId: 'doc-3',
          extractionId: 'ext-old',
          fieldKey: 'total',
          fieldType: 'money',
          rawValue: '100.00',
          normalizedValue: '100.00',
          confidence: '0.3',
          confidenceParts: {},
          validatorStatus: 'valid',
          status: 'needs_review',
        },
      ],
    ];
    // getLatestExtraction resolves the document's actual latest extraction independent
    // of which extraction any given candidate belongs to.
    mocks.extractionsCalls = [[{ id: 'ext-new', schemaId: 'schema-3' }]];

    const item = await getNextReviewItem();

    expect(item).toBeNull();
    // No document/schema/pages lookups should happen once nothing qualifies.
    expect(mocks.documentsCalls).toHaveLength(0);
    expect(mocks.schemasCalls).toHaveLength(0);
    expect(mocks.pagesCalls).toHaveLength(0);
  });

  it('skips a stale candidate (lower confidence, sorted first) and falls through to a valid one from a different document', async () => {
    mocks.fieldValueRowsCalls = [[]];
    mocks.fieldValuesCalls = [
      [
        {
          id: 'fv-stale',
          documentId: 'doc-3',
          extractionId: 'ext-old',
          fieldKey: 'total',
          fieldType: 'money',
          rawValue: '100.00',
          normalizedValue: '100.00',
          confidence: '0.1',
          confidenceParts: {},
          validatorStatus: 'valid',
          status: 'needs_review',
        },
        {
          id: 'fv-valid',
          documentId: 'doc-4',
          extractionId: 'ext-current',
          fieldKey: 'vendor_name',
          fieldType: 'string',
          rawValue: 'Acme',
          normalizedValue: 'Acme',
          confidence: '0.5',
          confidenceParts: {},
          validatorStatus: 'valid',
          status: 'needs_review',
        },
      ],
    ];
    // First lookup: doc-3's latest extraction is ext-new (not ext-old) -> mismatch, skip.
    // Second lookup: doc-4's latest extraction is ext-current -> matches fv-valid.
    mocks.extractionsCalls = [[{ id: 'ext-new', schemaId: 'schema-3' }], [{ id: 'ext-current', schemaId: 'schema-4' }]];
    mocks.documentsCalls = [[], [{ id: 'doc-4', filename: 'good.pdf' }]];
    mocks.schemasCalls = [
      [{ id: 'schema-4', fields: [{ key: 'vendor_name', label: 'Vendor', description: 'd', type: 'string', required: true, autoAcceptThreshold: 0.9 }] }],
    ];
    mocks.pagesCalls = [[{ id: 'page-4', pageNumber: 1, width: 10, height: 20 }]];

    const item = await getNextReviewItem();

    expect(item?.fieldValueId).toBe('fv-valid');
    expect(item?.documentId).toBe('doc-4');
  });

  it('filters to documents in the given batch, short-circuiting to null when the batch has no documents', async () => {
    mocks.fieldValueRowsCalls = [[]];
    mocks.documentsCalls = [[]]; // batch has zero documents

    const item = await getNextReviewItem('batch-empty');

    expect(item).toBeNull();
    // The field_values candidate query should never run once the batch is known-empty.
    expect(mocks.fieldValuesCalls).toHaveLength(0);
  });

  it('applies the batchId filter end-to-end when the batch does have documents', async () => {
    mocks.fieldValueRowsCalls = [[]];
    // Three documents-table calls: the batch-filter lookup, the archived-document
    // exclusion lookup (empty), then the chosen candidate's own document lookup.
    mocks.documentsCalls = [[{ id: 'doc-5' }], [], [{ id: 'doc-5', filename: 'f.pdf' }]];
    mocks.fieldValuesCalls = [
      [
        {
          id: 'fv-5',
          documentId: 'doc-5',
          extractionId: 'ext-5',
          fieldKey: 'x',
          fieldType: 'string',
          rawValue: 'v',
          normalizedValue: 'v',
          confidence: '0.2',
          confidenceParts: {},
          validatorStatus: 'valid',
          status: 'needs_review',
        },
      ],
    ];
    mocks.extractionsCalls = [[{ id: 'ext-5', schemaId: 'schema-5' }]];
    mocks.schemasCalls = [[{ id: 'schema-5', fields: [{ key: 'x', label: 'X', description: 'd', type: 'string', required: true, autoAcceptThreshold: 0.9 }] }]];
    mocks.pagesCalls = [[]];

    const item = await getNextReviewItem('batch-x');

    expect(item?.documentId).toBe('doc-5');
  });

  it('queries for archived documents and still resolves a normal candidate when some exist elsewhere', async () => {
    // This mock harness doesn't evaluate real SQL WHERE clauses (see every other test
    // in this file) — it can't prove notInArray(...) actually excludes the archived
    // document's own field_values from a live query. What it does prove: the archived-
    // document lookup happens, and its result being non-empty doesn't corrupt normal
    // candidate resolution. The SQL-level exclusion itself needs a live-DB check.
    mocks.fieldValueRowsCalls = [[]];
    mocks.documentsCalls = [[{ id: 'doc-archived' }], [{ id: 'doc-1', filename: 'invoice.pdf' }]];
    mocks.fieldValuesCalls = [
      [
        {
          id: 'fv-1',
          documentId: 'doc-1',
          extractionId: 'ext-1',
          fieldKey: 'invoice_number',
          fieldType: 'string',
          rawValue: 'INV-1',
          normalizedValue: 'INV-1',
          confidence: '0.4',
          confidenceParts: {},
          validatorStatus: 'valid',
          status: 'needs_review',
        },
      ],
    ];
    mocks.extractionsCalls = [[{ id: 'ext-1', schemaId: 'schema-1' }]];
    mocks.schemasCalls = [
      [{ id: 'schema-1', fields: [{ key: 'invoice_number', label: 'Invoice Number', description: 'd', type: 'string', required: true, autoAcceptThreshold: 0.9 }] }],
    ];
    mocks.pagesCalls = [[]];

    const item = await getNextReviewItem();

    expect(item?.fieldValueId).toBe('fv-1');
  });
});

describe('getReviewQueueStats', () => {
  it('returns all zeros when there are no extractions at all', async () => {
    mocks.extractionsCalls = [[]];

    const stats = await getReviewQueueStats();

    expect(stats).toEqual({ totalItems: 0, needsReview: 0, autoAccepted: 0, confirmed: 0, corrected: 0 });
    // No further queries once there's nothing to count.
    expect(mocks.fieldValueRowsCalls).toHaveLength(0);
    expect(mocks.fieldValuesCalls).toHaveLength(0);
  });

  it('counts by status, ignores a superseded extraction, and folds a still-pending row into needsReview', async () => {
    mocks.extractionsCalls = [
      [
        { documentId: 'doc-1', id: 'ext-1-old', startedAt: new Date('2026-01-01T00:00:00Z') },
        { documentId: 'doc-1', id: 'ext-1-new', startedAt: new Date('2026-01-02T00:00:00Z') },
        { documentId: 'doc-2', id: 'ext-2', startedAt: new Date('2026-01-01T00:00:00Z') },
      ],
    ];
    mocks.fieldValueRowsCalls = [[{ fieldValueId: 'fv-table' }]];
    // Only what the real inArray(extractionId, [current ids]) filter would actually
    // return — fv-old (belonging to the superseded ext-1-old) is never in this list,
    // the same way the real query would never fetch it.
    mocks.fieldValuesCalls = [
      [
        { id: 'fv-needs', status: 'needs_review' },
        { id: 'fv-auto', status: 'auto_accepted' },
        { id: 'fv-confirmed', status: 'confirmed' },
        { id: 'fv-corrected', status: 'corrected' },
        { id: 'fv-table', status: 'auto_accepted' }, // field-level resolved, but still has a pending row
      ],
    ];

    const stats = await getReviewQueueStats();

    expect(stats).toEqual({ totalItems: 5, needsReview: 2, autoAccepted: 1, confirmed: 1, corrected: 1 });
  });

  it('treats an archived document\'s extraction as nonexistent, short-circuiting to EMPTY_STATS when it is the only one', async () => {
    // Unlike the field_values-level exclusion (SQL-based, not verifiable via this
    // mock — see the getNextReviewItem archived-document test above), this exclusion
    // is plain JS control flow over the already-fetched extractions list, so it's
    // genuinely exercised here: if every extraction belongs to an archived document,
    // currentExtractionIds ends up empty and the function short-circuits before ever
    // querying field_value_rows/field_values, the same way "no extractions at all" does.
    mocks.documentsCalls = [[{ id: 'doc-archived' }]];
    mocks.extractionsCalls = [[{ documentId: 'doc-archived', id: 'ext-archived', startedAt: new Date('2026-01-01T00:00:00Z') }]];

    const stats = await getReviewQueueStats();

    expect(stats).toEqual({ totalItems: 0, needsReview: 0, autoAccepted: 0, confirmed: 0, corrected: 0 });
    expect(mocks.fieldValueRowsCalls).toHaveLength(0);
    expect(mocks.fieldValuesCalls).toHaveLength(0);
  });
});

describe('getNeedsReviewDocumentIds', () => {
  it('returns an empty set when there are no extractions at all', async () => {
    mocks.extractionsCalls = [[]];

    const ids = await getNeedsReviewDocumentIds();

    expect(ids).toEqual(new Set());
    expect(mocks.fieldValueRowsCalls).toHaveLength(0);
    expect(mocks.fieldValuesCalls).toHaveLength(0);
  });

  it('collects documentIds with a needs_review field or a still-pending row, ignoring resolved documents and superseded extractions', async () => {
    mocks.extractionsCalls = [
      [
        { documentId: 'doc-1', id: 'ext-1-old', startedAt: new Date('2026-01-01T00:00:00Z') },
        { documentId: 'doc-1', id: 'ext-1-new', startedAt: new Date('2026-01-02T00:00:00Z') },
        { documentId: 'doc-2', id: 'ext-2', startedAt: new Date('2026-01-01T00:00:00Z') },
        { documentId: 'doc-3', id: 'ext-3', startedAt: new Date('2026-01-01T00:00:00Z') },
      ],
    ];
    mocks.fieldValueRowsCalls = [[{ fieldValueId: 'fv-table' }]];
    // Only what the real inArray(extractionId, [current ids]) filter would actually
    // return — a field_value belonging to the superseded ext-1-old is never in this
    // list, the same way the real query would never fetch it.
    mocks.fieldValuesCalls = [
      [
        { id: 'fv-needs', documentId: 'doc-1', status: 'needs_review' },
        { id: 'fv-auto', documentId: 'doc-2', status: 'auto_accepted' },
        { id: 'fv-table', documentId: 'doc-3', status: 'auto_accepted' }, // field-level resolved, but still has a pending row
      ],
    ];

    const ids = await getNeedsReviewDocumentIds();

    expect(ids).toEqual(new Set(['doc-1', 'doc-3']));
  });

  it('excludes an archived document\'s extraction entirely, even though it would otherwise be its only one', async () => {
    mocks.documentsCalls = [[{ id: 'doc-archived' }]];
    mocks.extractionsCalls = [[{ documentId: 'doc-archived', id: 'ext-archived', startedAt: new Date('2026-01-01T00:00:00Z') }]];

    const ids = await getNeedsReviewDocumentIds();

    expect(ids).toEqual(new Set());
    expect(mocks.fieldValueRowsCalls).toHaveLength(0);
    expect(mocks.fieldValuesCalls).toHaveLength(0);
  });
});

describe('getReviewItemForDocument', () => {
  it('returns the (only) needs_review field, ignoring an already-resolved sibling', async () => {
    mocks.documentsCalls = [[{ id: 'doc-1', filename: 'invoice.pdf', batchId: 'batch-1', archivedAt: null }]];
    mocks.extractionsCalls = [[{ id: 'ext-1', schemaId: 'schema-1' }]];
    mocks.fieldValuesCalls = [
      [
        {
          id: 'fv-resolved',
          documentId: 'doc-1',
          extractionId: 'ext-1',
          fieldKey: 'vendor_name',
          fieldType: 'string',
          rawValue: 'Acme',
          normalizedValue: 'Acme',
          finalValue: 'Acme',
          confidence: '0.99',
          confidenceParts: {},
          validatorStatus: 'valid',
          status: 'confirmed',
        },
        {
          id: 'fv-pending',
          documentId: 'doc-1',
          extractionId: 'ext-1',
          fieldKey: 'invoice_number',
          fieldType: 'string',
          rawValue: 'INV-1',
          normalizedValue: 'INV-1',
          finalValue: null,
          confidence: '0.4',
          confidenceParts: {},
          validatorStatus: 'valid',
          status: 'needs_review',
        },
      ],
    ];
    mocks.fieldValueRowsCalls = [[]]; // no pending rows anywhere
    mocks.schemasCalls = [
      [
        {
          id: 'schema-1',
          fields: [
            { key: 'invoice_number', label: 'Invoice Number', description: 'The invoice number', type: 'string', required: true, autoAcceptThreshold: 0.9 },
            { key: 'vendor_name', label: 'Vendor Name', description: 'd', type: 'string', required: true, autoAcceptThreshold: 0.9 },
          ],
        },
      ],
    ];
    mocks.pagesCalls = [[{ id: 'page-1', pageNumber: 1, width: 100, height: 200 }]];

    const item = await getReviewItemForDocument('doc-1');

    expect(item).toEqual({
      fieldValueId: 'fv-pending',
      documentId: 'doc-1',
      documentFilename: 'invoice.pdf',
      batchId: 'batch-1',
      fieldKey: 'invoice_number',
      fieldType: 'string',
      label: 'Invoice Number',
      description: 'The invoice number',
      rawValue: 'INV-1',
      normalizedValue: 'INV-1',
      finalValue: null,
      confidence: '0.4',
      confidenceParts: {},
      validatorStatus: 'valid',
      status: 'needs_review',
      rows: null,
      pages: [{ id: 'page-1', pageNumber: 1, width: 100, height: 200 }],
    });
  });

  it('picks the lower-confidence field when two candidates are simultaneously needs_review (confidence tie-break)', async () => {
    mocks.documentsCalls = [[{ id: 'doc-1', filename: 'invoice.pdf', batchId: null, archivedAt: null }]];
    mocks.extractionsCalls = [[{ id: 'ext-1', schemaId: 'schema-1' }]];
    mocks.fieldValuesCalls = [
      [
        {
          id: 'fv-higher-confidence',
          documentId: 'doc-1',
          extractionId: 'ext-1',
          fieldKey: 'due_date',
          fieldType: 'date',
          rawValue: '2025-10-20',
          normalizedValue: '2025-10-20',
          finalValue: null,
          confidence: '0.78',
          confidenceParts: {},
          validatorStatus: 'valid',
          status: 'needs_review',
        },
        {
          id: 'fv-lower-confidence',
          documentId: 'doc-1',
          extractionId: 'ext-1',
          fieldKey: 'vendor_name',
          fieldType: 'string',
          rawValue: 'Harrow & Fnch Materials',
          normalizedValue: 'Harrow & Fnch Materials',
          finalValue: null,
          confidence: '0.62',
          confidenceParts: {},
          validatorStatus: 'valid',
          status: 'needs_review',
        },
      ],
    ];
    mocks.fieldValueRowsCalls = [[]];
    mocks.schemasCalls = [
      [{ id: 'schema-1', fields: [{ key: 'vendor_name', label: 'Vendor Name', description: 'd', type: 'string', required: true, autoAcceptThreshold: 0.9 }] }],
    ];
    mocks.pagesCalls = [[]];

    const item = await getReviewItemForDocument('doc-1');

    expect(item.fieldValueId).toBe('fv-lower-confidence'); // 0.62 < 0.78, same asc(confidence) rule as getNextReviewItem
  });

  it('surfaces a table field whose own status is resolved but which has one still-pending row', async () => {
    mocks.documentsCalls = [[{ id: 'doc-2', filename: 'po.pdf', batchId: null, archivedAt: null }]];
    mocks.extractionsCalls = [[{ id: 'ext-2', schemaId: 'schema-2' }]];
    mocks.fieldValuesCalls = [
      [
        {
          id: 'fv-table',
          documentId: 'doc-2',
          extractionId: 'ext-2',
          fieldKey: 'line_items',
          fieldType: 'table',
          rawValue: null,
          normalizedValue: null,
          finalValue: null,
          confidence: '0.95',
          confidenceParts: {},
          validatorStatus: 'valid',
          status: 'auto_accepted',
        },
      ],
    ];
    // needsReviewRows: fv-table has one pending row -> it qualifies as a candidate
    // even though its own field-level status is already resolved.
    mocks.fieldValueRowsCalls = [[{ fieldValueId: 'fv-table' }]];
    mocks.schemasCalls = [
      [
        {
          id: 'schema-2',
          fields: [
            {
              key: 'line_items',
              label: 'Line Items',
              description: 'd',
              type: 'table',
              required: true,
              autoAcceptThreshold: 0.9,
              columns: [{ key: 'description', label: 'Description', type: 'string', required: true }],
            },
          ],
        },
      ],
    ];
    mocks.pagesCalls = [[]];
    // The chosen table field's own full row set, fetched inside buildReviewItem.
    mocks.fieldValueRowsCalls.push([
      { id: 'row-1', rowIndex: 0, cells: { description: 'Widget' }, finalCells: null, confidence: '0.4', confidenceParts: {}, status: 'needs_review' },
    ]);

    const item = await getReviewItemForDocument('doc-2');

    expect(item.fieldValueId).toBe('fv-table');
    expect(item.status).toBe('auto_accepted'); // the field's own status is untouched
    expect(item.rows).toHaveLength(1);
    expect(item.rows?.[0].status).toBe('needs_review');
  });

  it('falls back to the first schema-declared field when the document is fully resolved, including surfacing an already-resolved TABLE field', async () => {
    mocks.documentsCalls = [[{ id: 'doc-2', filename: 'po.pdf', batchId: null, archivedAt: null }]];
    mocks.extractionsCalls = [[{ id: 'ext-2', schemaId: 'schema-2' }]];
    mocks.fieldValuesCalls = [
      [
        {
          id: 'fv-table',
          documentId: 'doc-2',
          extractionId: 'ext-2',
          fieldKey: 'line_items',
          fieldType: 'table',
          rawValue: null,
          normalizedValue: null,
          finalValue: null,
          confidence: '0.95',
          confidenceParts: {},
          validatorStatus: 'valid',
          status: 'auto_accepted',
        },
        {
          id: 'fv-total',
          documentId: 'doc-2',
          extractionId: 'ext-2',
          fieldKey: 'total',
          fieldType: 'money',
          rawValue: '9.00',
          normalizedValue: '9.00',
          finalValue: '9.00',
          confidence: '0.99',
          confidenceParts: {},
          validatorStatus: 'valid',
          status: 'confirmed',
        },
      ],
    ];
    mocks.fieldValueRowsCalls = [[]]; // needsReviewRows: nothing pending anywhere -> fully-resolved fallback branch
    const schemaFixture = {
      id: 'schema-2',
      fields: [
        {
          key: 'line_items',
          label: 'Line Items',
          description: 'd',
          type: 'table',
          required: true,
          autoAcceptThreshold: 0.9,
          columns: [{ key: 'description', label: 'Description', type: 'string', required: true }],
        },
        { key: 'total', label: 'Total', description: 'd', type: 'money', required: true, autoAcceptThreshold: 0.9 },
      ],
    };
    // Queried twice: once by the fallback branch itself (to walk schema field order),
    // once more inside buildReviewItem (for label/description resolution) -- a real
    // but harmless duplicate query, see queue.ts's own comment on this fallback path.
    mocks.schemasCalls = [[schemaFixture], [schemaFixture]];
    mocks.pagesCalls = [[]];
    mocks.fieldValueRowsCalls.push([
      { id: 'row-1', rowIndex: 0, cells: { description: 'Widget' }, finalCells: { description: 'Widget' }, confidence: '1', confidenceParts: {}, status: 'confirmed' },
    ]);

    const item = await getReviewItemForDocument('doc-2');

    // line_items is declared before total, and it's the first with a matching
    // field_value -- so it wins the fallback even though total also qualifies.
    expect(item.fieldValueId).toBe('fv-table');
    expect(item.fieldType).toBe('table');
    expect(item.status).toBe('auto_accepted');
    expect(item.rows).toHaveLength(1);
  });

  // A re-extract can leave the CURRENT extraction with zero field_values (e.g. every
  // sample failed to parse -- see extract/run.ts) while an OLDER, superseded
  // extraction still has a lingering needs_review row nothing ever resolved. This
  // must throw, not silently fall through to that older extraction's stale data --
  // the query is scoped by extractionId specifically to prevent that. (This mock
  // harness can't evaluate the real SQL WHERE clause -- same acknowledged limitation
  // as getNextReviewItem's own archived-document test above -- so what this proves is
  // that an extractionId-scoped query returning nothing is treated as "nothing to
  // review", not silently papered over by falling back to some other data source.)
  it('throws NoReviewableFieldError when the current extraction has zero field values', async () => {
    mocks.documentsCalls = [[{ id: 'doc-1', filename: 'invoice.pdf', batchId: null, archivedAt: null }]];
    mocks.extractionsCalls = [[{ id: 'ext-new', schemaId: 'schema-1' }]];
    mocks.fieldValuesCalls = [[]];

    await expect(getReviewItemForDocument('doc-1')).rejects.toThrow(NoReviewableFieldError);
    expect(mocks.fieldValueRowsCalls).toHaveLength(0);
    expect(mocks.schemasCalls).toHaveLength(0);
  });

  it('throws NoReviewableFieldError when the document has never been extracted', async () => {
    mocks.documentsCalls = [[{ id: 'doc-1', filename: 'invoice.pdf', batchId: null, archivedAt: null }]];
    mocks.extractionsCalls = [[]]; // getLatestExtraction finds nothing

    await expect(getReviewItemForDocument('doc-1')).rejects.toThrow(NoReviewableFieldError);
    expect(mocks.fieldValuesCalls).toHaveLength(0);
  });

  it('throws DocumentNotFoundError when the document does not exist', async () => {
    mocks.documentsCalls = [[]];

    await expect(getReviewItemForDocument('doc-missing')).rejects.toThrow(DocumentNotFoundError);
    expect(mocks.extractionsCalls).toHaveLength(0);
  });

  it('throws DocumentNotFoundError (never NoReviewableFieldError) for an archived document, even though it still has field values', async () => {
    mocks.documentsCalls = [[{ id: 'doc-1', filename: 'invoice.pdf', batchId: null, archivedAt: new Date('2026-01-01T00:00:00Z') }]];

    await expect(getReviewItemForDocument('doc-1')).rejects.toThrow(DocumentNotFoundError);
    expect(mocks.extractionsCalls).toHaveLength(0);
  });
});

describe('getDocumentDisplayNames', () => {
  it('returns an empty map for an empty document list, issuing no queries at all', async () => {
    const names = await getDocumentDisplayNames([], 'schema-1');

    expect(names).toEqual(new Map());
    expect(mocks.schemasCalls).toHaveLength(0);
    expect(mocks.extractionsCalls).toHaveLength(0);
    expect(mocks.fieldValuesCalls).toHaveLength(0);
  });

  it('uses the first declared string field that has a value', async () => {
    mocks.schemasCalls = [
      [
        {
          fields: [
            { key: 'invoice_number', label: 'Invoice Number', description: 'd', type: 'string', required: true, autoAcceptThreshold: 0.9 },
            { key: 'vendor_name', label: 'Vendor Name', description: 'd', type: 'string', required: true, autoAcceptThreshold: 0.9 },
          ],
        },
      ],
    ];
    mocks.extractionsCalls = [[{ documentId: 'doc-1', id: 'ext-1', startedAt: new Date('2026-01-01T00:00:00Z') }]];
    mocks.fieldValuesCalls = [
      [
        { documentId: 'doc-1', fieldKey: 'invoice_number', status: 'needs_review', normalizedValue: 'INV-77', finalValue: null },
        { documentId: 'doc-1', fieldKey: 'vendor_name', status: 'needs_review', normalizedValue: 'Acme', finalValue: null },
      ],
    ];

    const names = await getDocumentDisplayNames(['doc-1'], 'schema-1');

    expect(names.get('doc-1')).toBe('INV-77');
  });

  it('falls through to the second declared string field when the document has no value for the first (the real doc-1 shape: no invoice_number field at all, only vendor_name)', async () => {
    mocks.schemasCalls = [
      [
        {
          fields: [
            { key: 'invoice_number', label: 'Invoice Number', description: 'd', type: 'string', required: true, autoAcceptThreshold: 0.9 },
            { key: 'vendor_name', label: 'Vendor Name', description: 'd', type: 'string', required: true, autoAcceptThreshold: 0.9 },
          ],
        },
      ],
    ];
    mocks.extractionsCalls = [[{ documentId: 'doc-1', id: 'ext-1', startedAt: new Date('2026-01-01T00:00:00Z') }]];
    mocks.fieldValuesCalls = [[{ documentId: 'doc-1', fieldKey: 'vendor_name', status: 'needs_review', normalizedValue: 'Harrow & Fnch Materials', finalValue: null }]];

    const names = await getDocumentDisplayNames(['doc-1'], 'schema-1');

    expect(names.get('doc-1')).toBe('Harrow & Fnch Materials');
  });

  it('prefers finalValue over normalizedValue once the field is resolved', async () => {
    mocks.schemasCalls = [[{ fields: [{ key: 'vendor_name', label: 'Vendor Name', description: 'd', type: 'string', required: true, autoAcceptThreshold: 0.9 }] }]];
    mocks.extractionsCalls = [[{ documentId: 'doc-1', id: 'ext-1', startedAt: new Date('2026-01-01T00:00:00Z') }]];
    mocks.fieldValuesCalls = [[{ documentId: 'doc-1', fieldKey: 'vendor_name', status: 'corrected', normalizedValue: 'Acme Corp', finalValue: 'Acme Corporation' }]];

    const names = await getDocumentDisplayNames(['doc-1'], 'schema-1');

    expect(names.get('doc-1')).toBe('Acme Corporation');
  });

  it('falls back to normalizedValue (never null) for a still-needs_review field, unlike export/build.ts which nulls unresolved data on purpose', async () => {
    mocks.schemasCalls = [[{ fields: [{ key: 'vendor_name', label: 'Vendor Name', description: 'd', type: 'string', required: true, autoAcceptThreshold: 0.9 }] }]];
    mocks.extractionsCalls = [[{ documentId: 'doc-1', id: 'ext-1', startedAt: new Date('2026-01-01T00:00:00Z') }]];
    mocks.fieldValuesCalls = [[{ documentId: 'doc-1', fieldKey: 'vendor_name', status: 'needs_review', normalizedValue: 'Acme Corp', finalValue: null }]];

    const names = await getDocumentDisplayNames(['doc-1'], 'schema-1');

    expect(names.get('doc-1')).toBe('Acme Corp');
  });

  it('returns null for a document whose only fields are non-string (e.g. a table field), without querying extractions or field_values at all', async () => {
    mocks.schemasCalls = [
      [{ fields: [{ key: 'line_items', label: 'Line Items', description: 'd', type: 'table', required: true, autoAcceptThreshold: 0.9, columns: [] }] }],
    ];

    const names = await getDocumentDisplayNames(['doc-2'], 'schema-2');

    expect(names.get('doc-2')).toBeNull();
    expect(mocks.extractionsCalls).toHaveLength(0);
    expect(mocks.fieldValuesCalls).toHaveLength(0);
  });

  it('batches every document into a single extractions query and a single field_values query, not one per document', async () => {
    mocks.schemasCalls = [[{ fields: [{ key: 'vendor_name', label: 'Vendor Name', description: 'd', type: 'string', required: true, autoAcceptThreshold: 0.9 }] }]];
    mocks.extractionsCalls = [
      [
        { documentId: 'doc-1', id: 'ext-1', startedAt: new Date('2026-01-01T00:00:00Z') },
        { documentId: 'doc-2', id: 'ext-2', startedAt: new Date('2026-01-01T00:00:00Z') },
      ],
    ];
    mocks.fieldValuesCalls = [
      [
        { documentId: 'doc-1', fieldKey: 'vendor_name', status: 'needs_review', normalizedValue: 'Acme', finalValue: null },
        { documentId: 'doc-2', fieldKey: 'vendor_name', status: 'needs_review', normalizedValue: 'Globex', finalValue: null },
      ],
    ];

    const names = await getDocumentDisplayNames(['doc-1', 'doc-2'], 'schema-1');

    // Each table's mock queue only holds ONE response. If the implementation queried
    // per-document instead of batching, doc-2's queries would consume the empty
    // fallback (see nextFrom) and its name would come back null instead of 'Globex'.
    expect(names.get('doc-1')).toBe('Acme');
    expect(names.get('doc-2')).toBe('Globex');
  });
});
