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

const { getNextReviewItem, getReviewQueueStats, getNeedsReviewDocumentIds } = await import('../../src/review/queue.js');

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
