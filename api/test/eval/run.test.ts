import { describe, it, expect, beforeEach, vi } from 'vitest';
import { documents, extractions, fieldValues, fieldValueRows } from '../../src/db/schema.js';

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

const mocks = vi.hoisted(() => ({
  documentsResult: [] as unknown[],
  extractionsCalls: [] as unknown[][],
  fieldValuesCalls: [] as unknown[][],
  fieldValueRowsCalls: [] as unknown[][],
  goldSet: new Map() as Map<string, unknown>,
}));

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
        if (table === documents) return chain(mocks.documentsResult);
        if (table === extractions) return chain(nextFrom(mocks.extractionsCalls));
        if (table === fieldValues) return chain(nextFrom(mocks.fieldValuesCalls));
        if (table === fieldValueRows) return chain(nextFrom(mocks.fieldValueRowsCalls));
        throw new Error('unexpected table in mock select().from()');
      },
    })),
  },
}));

vi.mock('../../src/eval/goldSet.js', () => ({
  loadGoldSet: vi.fn(() => mocks.goldSet),
}));

const { runEval } = await import('../../src/eval/run.js');

beforeEach(() => {
  mocks.documentsResult = [];
  mocks.extractionsCalls = [];
  mocks.fieldValuesCalls = [];
  mocks.fieldValueRowsCalls = [];
  mocks.goldSet = new Map();
});

const GOLD_INVOICE = {
  filename: 'invoice_clean_01.pdf',
  docType: 'invoice',
  difficultyGroup: 'clean',
  fields: { invoice_number: 'INV-1', vendor_name: 'Acme' },
  lineItems: [],
};

describe('runEval', () => {
  it('counts a matching auto_accepted field toward both auto-accept precision and overall accuracy', async () => {
    mocks.documentsResult = [{ id: 'doc-1', filename: 'invoice_clean_01.pdf' }];
    mocks.goldSet = new Map([['invoice_clean_01.pdf', GOLD_INVOICE]]);
    mocks.extractionsCalls = [[{ id: 'ext-1' }]];
    mocks.fieldValuesCalls = [
      [{ id: 'fv-1', fieldKey: 'invoice_number', fieldType: 'string', status: 'auto_accepted', finalValue: null, normalizedValue: 'INV-1' }],
    ];

    const summary = await runEval();

    expect(summary.documentsEvaluated).toBe(1);
    expect(summary.documentsSkipped).toEqual([]);
    expect(summary.overall.autoAcceptPrecision).toEqual({ matched: 1, total: 1, rate: 1 });
    expect(summary.overall.overallAccuracy).toEqual({ matched: 1, total: 1, rate: 1 });
    expect(summary.overall.automationRate).toEqual({ matched: 1, total: 1, rate: 1 });
  });

  it('excludes a confirmed field from auto-accept precision but includes it in overall accuracy', async () => {
    mocks.documentsResult = [{ id: 'doc-1', filename: 'invoice_clean_01.pdf' }];
    mocks.goldSet = new Map([['invoice_clean_01.pdf', GOLD_INVOICE]]);
    mocks.extractionsCalls = [[{ id: 'ext-1' }]];
    mocks.fieldValuesCalls = [
      [
        // Went through human review (finalValue set, status confirmed) — never an
        // unreviewed auto-accept decision, so it must not count toward that metric.
        { id: 'fv-1', fieldKey: 'invoice_number', fieldType: 'string', status: 'confirmed', finalValue: 'INV-1', normalizedValue: 'INV-1' },
      ],
    ];

    const summary = await runEval();

    expect(summary.overall.autoAcceptPrecision).toEqual({ matched: 0, total: 0, rate: null });
    expect(summary.overall.overallAccuracy).toEqual({ matched: 1, total: 1, rate: 1 });
    expect(summary.overall.automationRate).toEqual({ matched: 0, total: 1, rate: 0 });
  });

  it('counts a wrong auto_accepted value as a real miss (the currency-mismatch scenario)', async () => {
    mocks.documentsResult = [{ id: 'doc-1', filename: 'invoice_clean_01.pdf' }];
    mocks.goldSet = new Map([['invoice_clean_01.pdf', GOLD_INVOICE]]);
    mocks.extractionsCalls = [[{ id: 'ext-1' }]];
    mocks.fieldValuesCalls = [
      [{ id: 'fv-1', fieldKey: 'vendor_name', fieldType: 'string', status: 'auto_accepted', finalValue: null, normalizedValue: 'Wrong Name' }],
    ];

    const summary = await runEval();

    expect(summary.overall.autoAcceptPrecision).toEqual({ matched: 0, total: 1, rate: 0 });
    expect(summary.fields[0].matched).toBe(false);
  });

  it('folds a table field into the same accounting using positional row comparison', async () => {
    const gold = { ...GOLD_INVOICE, fields: {}, lineItems: [{ description: 'Widget', quantity: 1, unit_price: '10.00', amount: '10.00' }] };
    mocks.documentsResult = [{ id: 'doc-1', filename: 'invoice_clean_01.pdf' }];
    mocks.goldSet = new Map([['invoice_clean_01.pdf', gold]]);
    mocks.extractionsCalls = [[{ id: 'ext-1' }]];
    mocks.fieldValuesCalls = [[{ id: 'fv-1', fieldKey: 'line_items', fieldType: 'table', status: 'auto_accepted', finalValue: null, normalizedValue: null }]];
    mocks.fieldValueRowsCalls = [[{ rowIndex: 0, status: 'auto_accepted', cells: { description: 'Widget', quantity: 1, unit_price: '$10.00', amount: '$10.00' }, finalCells: null }]];

    const summary = await runEval();

    expect(summary.fields).toHaveLength(1);
    expect(summary.fields[0].fieldType).toBe('table');
    expect(summary.fields[0].matched).toBe(true);
    expect(summary.fields[0].countsAsAutoAccept).toBe(true);
    expect(summary.overall.autoAcceptPrecision).toEqual({ matched: 1, total: 1, rate: 1 });
  });

  it('regression: excludes a table field from auto-accept precision when its own status is still auto_accepted but a human corrected one row', async () => {
    // This is the exact scenario an independent review found empirically inflating
    // the headline metric: review/actions.ts's row-level accept/correct never
    // touches the parent field_values.status (see review/queue.ts), so a table field
    // can sit at status: 'auto_accepted' forever while one row was, in fact, fixed by
    // a human. Crediting that fix to "the model got this right unsupervised" would
    // silently inflate auto-accept precision on every document with reviewed line
    // items.
    const gold = {
      ...GOLD_INVOICE,
      fields: {},
      lineItems: [{ description: 'Widget', quantity: 1, unit_price: '10.00', amount: '10.00' }],
    };
    mocks.documentsResult = [{ id: 'doc-1', filename: 'invoice_clean_01.pdf' }];
    mocks.goldSet = new Map([['invoice_clean_01.pdf', gold]]);
    mocks.extractionsCalls = [[{ id: 'ext-1' }]];
    // The table field's own status never changed...
    mocks.fieldValuesCalls = [[{ id: 'fv-1', fieldKey: 'line_items', fieldType: 'table', status: 'auto_accepted', finalValue: null, normalizedValue: null }]];
    // ...but the model's raw cells were wrong (amount off), and a human corrected
    // just this row via correctRow, which sets finalCells without touching fv.status.
    mocks.fieldValueRowsCalls = [
      [
        {
          rowIndex: 0,
          status: 'corrected',
          cells: { description: 'Widget', quantity: 1, unit_price: '10.00', amount: '9999.99' }, // model's actual (wrong) output
          finalCells: { description: 'Widget', quantity: 1, unit_price: '10.00', amount: '10.00' }, // human-corrected to match gold
        },
      ],
    ];

    const summary = await runEval();

    expect(summary.fields[0].status).toBe('auto_accepted'); // parent status column, unchanged
    expect(summary.fields[0].matched).toBe(true); // correctly matches gold using the human-corrected value
    expect(summary.fields[0].countsAsAutoAccept).toBe(false); // but must NOT count as an unsupervised auto-accept
    // Excluded from both the numerator and denominator — not present as a (wrongly)
    // matched auto-accept, and not silently absent while still counting toward the
    // denominator either.
    expect(summary.overall.autoAcceptPrecision).toEqual({ matched: 0, total: 0, rate: null });
    // Also excluded from automation rate's numerator — a human did real work here.
    expect(summary.overall.automationRate).toEqual({ matched: 0, total: 1, rate: 0 });
  });

  it('prefers finalCells over cells for a reviewed table row', async () => {
    const gold = { ...GOLD_INVOICE, fields: {}, lineItems: [{ description: 'Widget', quantity: 1, unit_price: '10.00', amount: '10.00' }] };
    mocks.documentsResult = [{ id: 'doc-1', filename: 'invoice_clean_01.pdf' }];
    mocks.goldSet = new Map([['invoice_clean_01.pdf', gold]]);
    mocks.extractionsCalls = [[{ id: 'ext-1' }]];
    mocks.fieldValuesCalls = [[{ id: 'fv-1', fieldKey: 'line_items', fieldType: 'table', status: 'confirmed', finalValue: null, normalizedValue: null }]];
    mocks.fieldValueRowsCalls = [
      [{ rowIndex: 0, status: 'corrected', cells: { description: 'Wrong', quantity: 1, unit_price: '10.00', amount: '10.00' }, finalCells: { description: 'Widget', quantity: 1, unit_price: '10.00', amount: '10.00' } }],
    ];

    const summary = await runEval();

    expect(summary.fields[0].matched).toBe(true);
  });

  it('skips an archived document with reason "archived", before even checking the gold set', async () => {
    mocks.documentsResult = [{ id: 'doc-1', filename: 'invoice_clean_01.pdf', archivedAt: new Date() }];
    mocks.goldSet = new Map([['invoice_clean_01.pdf', GOLD_INVOICE]]);

    const summary = await runEval();

    expect(summary.documentsEvaluated).toBe(0);
    expect(summary.documentsSkipped).toEqual([{ filename: 'invoice_clean_01.pdf', reason: 'archived' }]);
    expect(mocks.extractionsCalls).toHaveLength(0);
  });

  it('skips a document not present in the gold set', async () => {
    mocks.documentsResult = [{ id: 'doc-1', filename: 'unknown.pdf' }];
    mocks.goldSet = new Map([['invoice_clean_01.pdf', GOLD_INVOICE]]);

    const summary = await runEval();

    expect(summary.documentsEvaluated).toBe(0);
    expect(summary.documentsSkipped).toEqual([{ filename: 'unknown.pdf', reason: 'not_in_gold_set' }]);
    expect(mocks.extractionsCalls).toHaveLength(0);
  });

  it('skips a document with no extraction', async () => {
    mocks.documentsResult = [{ id: 'doc-1', filename: 'invoice_clean_01.pdf' }];
    mocks.goldSet = new Map([['invoice_clean_01.pdf', GOLD_INVOICE]]);
    mocks.extractionsCalls = [[]];

    const summary = await runEval();

    expect(summary.documentsSkipped).toEqual([{ filename: 'invoice_clean_01.pdf', reason: 'no_extraction' }]);
  });

  it('skips a document whose latest extraction produced zero field_values', async () => {
    mocks.documentsResult = [{ id: 'doc-1', filename: 'invoice_clean_01.pdf' }];
    mocks.goldSet = new Map([['invoice_clean_01.pdf', GOLD_INVOICE]]);
    mocks.extractionsCalls = [[{ id: 'ext-1' }]];
    mocks.fieldValuesCalls = [[]];

    const summary = await runEval();

    expect(summary.documentsSkipped).toEqual([{ filename: 'invoice_clean_01.pdf', reason: 'extraction_produced_no_fields' }]);
  });

  it('groups stats by docType and difficultyGroup independently of the overall stats', async () => {
    mocks.documentsResult = [
      { id: 'doc-1', filename: 'invoice_clean_01.pdf' },
      { id: 'doc-2', filename: 'receipt_edge_case_02.pdf' },
    ];
    mocks.goldSet = new Map([
      ['invoice_clean_01.pdf', GOLD_INVOICE],
      ['receipt_edge_case_02.pdf', { filename: 'receipt_edge_case_02.pdf', docType: 'receipt', difficultyGroup: 'edge_case', fields: { receipt_number: 'R-1' }, lineItems: [] }],
    ]);
    mocks.extractionsCalls = [[{ id: 'ext-1' }], [{ id: 'ext-2' }]];
    mocks.fieldValuesCalls = [
      [{ id: 'fv-1', fieldKey: 'invoice_number', fieldType: 'string', status: 'auto_accepted', finalValue: null, normalizedValue: 'INV-1' }],
      [{ id: 'fv-2', fieldKey: 'receipt_number', fieldType: 'string', status: 'auto_accepted', finalValue: null, normalizedValue: 'WRONG' }],
    ];

    const summary = await runEval();

    expect(summary.byDocType.invoice.autoAcceptPrecision).toEqual({ matched: 1, total: 1, rate: 1 });
    expect(summary.byDocType.receipt.autoAcceptPrecision).toEqual({ matched: 0, total: 1, rate: 0 });
    expect(summary.byDifficultyGroup.clean.autoAcceptPrecision).toEqual({ matched: 1, total: 1, rate: 1 });
    expect(summary.byDifficultyGroup.edge_case.autoAcceptPrecision).toEqual({ matched: 0, total: 1, rate: 0 });
    // Overall pools both documents together.
    expect(summary.overall.autoAcceptPrecision).toEqual({ matched: 1, total: 2, rate: 0.5 });
  });
});
