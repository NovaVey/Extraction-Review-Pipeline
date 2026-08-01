import { describe, it, expect, vi, beforeEach } from 'vitest';
import { documents, batches, extractionSchemas, pages, extractions, fieldValues, fieldValueRows } from '../../src/db/schema.js';
import type { FieldSpec } from '../../src/extract/schema.js';

const FIELDS: FieldSpec[] = [
  { key: 'invoice_number', label: 'Invoice Number', type: 'string', required: true, autoAcceptThreshold: 0.95, description: 'x' },
  { key: 'vendor_name', label: 'Vendor Name', type: 'string', required: true, autoAcceptThreshold: 0.9, description: 'x' },
  {
    key: 'line_items',
    label: 'Line Items',
    type: 'table',
    required: true,
    autoAcceptThreshold: 0.9,
    description: 'x',
    columns: [
      { key: 'description', label: 'Description', type: 'string', required: true },
      { key: 'quantity', label: 'Quantity', type: 'number', required: true },
      { key: 'unit_price', label: 'Unit Price', type: 'money', required: true },
      { key: 'amount', label: 'Amount', type: 'money', required: true },
    ],
  },
  { key: 'subtotal', label: 'Subtotal', type: 'money', required: true, autoAcceptThreshold: 0.9, description: 'x' },
  { key: 'tax', label: 'Tax', type: 'money', required: true, autoAcceptThreshold: 0.9, description: 'x' },
  { key: 'total', label: 'Total', type: 'money', required: true, autoAcceptThreshold: 0.9, description: 'x' },
];

const mocks = vi.hoisted(() => ({
  mockDocument: null as any,
  mockBatch: null as any,
  mockSchema: null as any,
  mockPages: [] as any[],
  insertedExtractions: [] as any[],
  insertedFieldValues: [] as any[],
  insertedFieldValueRows: [] as any[],
  extractSample: vi.fn(),
  downloadObject: vi.fn(async () => Buffer.from('fake-png')),
}));

function selectChain(resolveValue: unknown) {
  const obj: Record<string, unknown> = {};
  obj.where = () => obj;
  obj.limit = () => Promise.resolve(resolveValue);
  obj.orderBy = () => Promise.resolve(resolveValue);
  return obj;
}

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === documents) return selectChain(mocks.mockDocument ? [mocks.mockDocument] : []);
        if (table === batches) return selectChain(mocks.mockBatch ? [mocks.mockBatch] : []);
        if (table === extractionSchemas) return selectChain(mocks.mockSchema ? [mocks.mockSchema] : []);
        if (table === pages) return selectChain(mocks.mockPages);
        throw new Error('unexpected table in mock select().from()');
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: unknown) => {
        if (table === extractions) {
          mocks.insertedExtractions.push(values);
          return { returning: () => Promise.resolve([{ id: 'extraction-1' }]) };
        }
        if (table === fieldValues) {
          mocks.insertedFieldValues.push(values);
          const id = `fv-${mocks.insertedFieldValues.length}`;
          // Scalar fields await the values() call directly (no .returning()); table
          // fields chain .returning() to get the new row's id for field_value_rows.
          return {
            returning: () => Promise.resolve([{ id }]),
            then: (resolve: (v: undefined) => void) => resolve(undefined),
          };
        }
        if (table === fieldValueRows) {
          mocks.insertedFieldValueRows.push(values);
          return Promise.resolve(undefined);
        }
        throw new Error('unexpected table in mock insert()');
      },
    })),
  },
}));

vi.mock('../../src/lib/storage.js', () => ({
  downloadObject: mocks.downloadObject,
}));

vi.mock('../../src/extract/anthropic.js', () => ({
  extractSample: mocks.extractSample,
  PROMPT_VERSION: 'v1-test',
}));

const { extractDocument, pickMajority, validateField } = await import('../../src/extract/run.js');

describe('pickMajority', () => {
  it('picks the value most samples agree on and reports the agreement fraction', () => {
    const result = pickMajority(['INV-1', 'INV-1', 'INV-2']);
    expect(result).toEqual({ value: 'INV-1', agreement: 2 / 3 });
  });

  it('reports full agreement when every sample matches', () => {
    expect(pickMajority(['USD', 'USD', 'USD'])).toEqual({ value: 'USD', agreement: 1 });
  });

  it('compares arrays by serialized value, so identical line-item arrays count as agreement', () => {
    const a = [{ description: 'x', quantity: 1 }];
    const b = [{ description: 'x', quantity: 1 }];
    const c = [{ description: 'y', quantity: 2 }];
    expect(pickMajority([a, b, c])).toEqual({ value: a, agreement: 2 / 3 });
  });
});

describe('validateField', () => {
  const dateField: FieldSpec = { key: 'd', label: 'd', type: 'date', required: true, autoAcceptThreshold: 0.9, description: 'x' };
  const moneyField: FieldSpec = { key: 'm', label: 'm', type: 'money', required: true, autoAcceptThreshold: 0.9, description: 'x' };
  const enumField: FieldSpec = {
    key: 'e',
    label: 'e',
    type: 'enum',
    required: true,
    enumValues: ['USD', 'EUR'],
    autoAcceptThreshold: 0.9,
    description: 'x',
  };

  it('reports missing for a null value regardless of type', () => {
    expect(validateField(dateField, null)).toBe('missing');
  });

  it('validates date-parseable strings and rejects garbage', () => {
    expect(validateField(dateField, '2025-09-19')).toBe('valid');
    expect(validateField(dateField, 'not a date')).toBe('invalid');
  });

  it('validates numeric-after-stripping-symbols money values', () => {
    expect(validateField(moneyField, '$1,234.56')).toBe('valid');
    expect(validateField(moneyField, 'not money')).toBe('invalid');
  });

  it('validates enum membership', () => {
    expect(validateField(enumField, 'USD')).toBe('valid');
    expect(validateField(enumField, 'JPY')).toBe('invalid');
  });
});

describe('extractDocument', () => {
  beforeEach(() => {
    mocks.mockDocument = { id: 'doc-1', batchId: 'batch-1', inDevSubset: true };
    mocks.mockBatch = { id: 'batch-1', schemaId: 'schema-1' };
    mocks.mockSchema = { id: 'schema-1', docType: 'invoice', fields: FIELDS };
    mocks.mockPages = [{ pageNumber: 1, textContent: 'some text', imagePath: 'batches/x/y/pages/1.png' }];
    mocks.insertedExtractions.length = 0;
    mocks.insertedFieldValues.length = 0;
    mocks.insertedFieldValueRows.length = 0;
    mocks.extractSample.mockReset();
    mocks.downloadObject.mockClear();
  });

  it('refuses to extract a document outside the dev subset without calling the model', async () => {
    mocks.mockDocument.inDevSubset = false;
    await expect(extractDocument('doc-1')).rejects.toThrow(/dev subset/);
    expect(mocks.extractSample).not.toHaveBeenCalled();
  });

  it('stores the majority value and sample-agreement confidence across samples', async () => {
    mocks.extractSample
      .mockResolvedValueOnce({
        parsed: { invoice_number: 'INV-1', line_items: [{ description: 'widget', quantity: 1, unit_price: '9.99', amount: '9.99' }] },
        rawResponse: { id: 'r1' },
        inputTokens: 100,
        outputTokens: 20,
        stopReason: 'end_turn',
      })
      .mockResolvedValueOnce({
        parsed: { invoice_number: 'INV-1', line_items: [{ description: 'widget', quantity: 1, unit_price: '9.99', amount: '9.99' }] },
        rawResponse: { id: 'r2' },
        inputTokens: 100,
        outputTokens: 20,
        stopReason: 'end_turn',
      })
      .mockResolvedValueOnce({
        parsed: { invoice_number: 'INV-2', line_items: [{ description: 'widget', quantity: 1, unit_price: '9.99', amount: '9.99' }] },
        rawResponse: { id: 'r3' },
        inputTokens: 100,
        outputTokens: 20,
        stopReason: 'end_turn',
      });

    const result = await extractDocument('doc-1');

    expect(result).toEqual({ extractionId: 'extraction-1', fieldCount: FIELDS.length });
    expect(mocks.insertedExtractions[0]).toMatchObject({ status: 'completed', sampleCount: expect.any(Number) });

    const invoiceNumberRow = mocks.insertedFieldValues.find((v) => v.fieldKey === 'invoice_number');
    expect(invoiceNumberRow).toMatchObject({ rawValue: 'INV-1', confidence: (2 / 3).toString() });

    const lineItemsRow = mocks.insertedFieldValues.find((v) => v.fieldKey === 'line_items');
    expect(lineItemsRow).toMatchObject({ confidence: '1', validatorStatus: 'valid' });
    expect(mocks.insertedFieldValueRows).toHaveLength(1);
    expect(mocks.insertedFieldValueRows[0]).toMatchObject({ cells: { description: 'widget' }, rowIndex: 0 });
  });

  it('records a failed extraction and throws when every sample fails to parse', async () => {
    mocks.extractSample.mockResolvedValue({
      parsed: null,
      rawResponse: { id: 'r1' },
      inputTokens: 50,
      outputTokens: 0,
      stopReason: 'max_tokens',
    });

    await expect(extractDocument('doc-1')).rejects.toThrow(/failed to produce parseable output/);
    expect(mocks.insertedExtractions).toHaveLength(1);
    expect(mocks.insertedExtractions[0]).toMatchObject({ status: 'failed' });
    expect(mocks.insertedFieldValues).toHaveLength(0);
  });

  it('scores a required scalar field with a null majority value as needs_review with zero confidence', async () => {
    // No sample sets vendor_name, so every sample's value is null — unanimous
    // agreement (1) that the field is absent, but it's required, so confidence must
    // still be forced to 0 rather than rewarded for the agreement.
    mocks.extractSample.mockResolvedValue({
      parsed: { invoice_number: 'INV-1', line_items: [], subtotal: '100.00', tax: '8.00', total: '108.00' },
      rawResponse: { id: 'r' },
      inputTokens: 100,
      outputTokens: 20,
      stopReason: 'end_turn',
    });

    await extractDocument('doc-1');

    const vendorNameRow = mocks.insertedFieldValues.find((v) => v.fieldKey === 'vendor_name');
    expect(vendorNameRow).toMatchObject({ confidence: '0', validatorStatus: 'missing', status: 'needs_review' });
  });

  it('auto-accepts total when it reconciles with subtotal + tax within the field autoAcceptThreshold', async () => {
    mocks.extractSample.mockResolvedValue({
      parsed: {
        invoice_number: 'INV-1',
        vendor_name: 'Acme Co',
        line_items: [],
        subtotal: '100.00',
        tax: '8.00',
        total: '108.00',
      },
      rawResponse: { id: 'r' },
      inputTokens: 100,
      outputTokens: 20,
      stopReason: 'end_turn',
    });

    await extractDocument('doc-1');

    const totalRow = mocks.insertedFieldValues.find((v) => v.fieldKey === 'total');
    expect(totalRow).toMatchObject({ confidence: '1', validatorStatus: 'valid', status: 'auto_accepted' });
  });

  it('sends total to needs_review when it does not reconcile with subtotal + tax', async () => {
    mocks.extractSample.mockResolvedValue({
      parsed: {
        invoice_number: 'INV-1',
        vendor_name: 'Acme Co',
        line_items: [],
        subtotal: '100.00',
        tax: '8.00',
        total: '500.00',
      },
      rawResponse: { id: 'r' },
      inputTokens: 100,
      outputTokens: 20,
      stopReason: 'end_turn',
    });

    await extractDocument('doc-1');

    // Full sample agreement (1) halved once for the one failing cross-field check:
    // 1 * 0.5 = 0.5, below the field's 0.9 autoAcceptThreshold.
    const totalRow = mocks.insertedFieldValues.find((v) => v.fieldKey === 'total');
    expect(totalRow).toMatchObject({ confidence: '0.5', validatorStatus: 'valid', status: 'needs_review' });
  });

  it('auto-accepts a line item row whose quantity * unit_price reconciles with amount', async () => {
    mocks.extractSample.mockResolvedValue({
      parsed: {
        invoice_number: 'INV-1',
        vendor_name: 'Acme Co',
        line_items: [{ description: 'widget', quantity: 2, unit_price: '10.00', amount: '20.00' }],
        subtotal: '20.00',
        tax: '0',
        total: '20.00',
      },
      rawResponse: { id: 'r' },
      inputTokens: 100,
      outputTokens: 20,
      stopReason: 'end_turn',
    });

    await extractDocument('doc-1');

    expect(mocks.insertedFieldValueRows).toHaveLength(1);
    expect(mocks.insertedFieldValueRows[0]).toMatchObject({ confidence: '1', status: 'auto_accepted' });
    expect(mocks.insertedFieldValueRows[0].confidenceParts.validatorStatus).toBe('valid');
  });

  it('sends a line item row to needs_review when quantity * unit_price does not reconcile with amount', async () => {
    mocks.extractSample.mockResolvedValue({
      parsed: {
        invoice_number: 'INV-1',
        vendor_name: 'Acme Co',
        // 2 * 10 = 20, but amount claims 999 — the row's own arithmetic doesn't add up.
        line_items: [{ description: 'widget', quantity: 2, unit_price: '10.00', amount: '999.00' }],
        subtotal: '20.00',
        tax: '0',
        total: '20.00',
      },
      rawResponse: { id: 'r' },
      inputTokens: 100,
      outputTokens: 20,
      stopReason: 'end_turn',
    });

    await extractDocument('doc-1');

    // Full sample agreement (1) halved once for the one failing per-row check: 1 * 0.5 = 0.5.
    expect(mocks.insertedFieldValueRows[0]).toMatchObject({ confidence: '0.5', status: 'needs_review' });
    expect(mocks.insertedFieldValueRows[0].confidenceParts.validatorStatus).toBe('valid');
  });

  it('taints a line item row invalid, forcing zero confidence, when a cell fails its own format check', async () => {
    mocks.extractSample.mockResolvedValue({
      parsed: {
        invoice_number: 'INV-1',
        vendor_name: 'Acme Co',
        // quantity isn't a real number — the row is invalid regardless of sample agreement.
        line_items: [{ description: 'widget', quantity: 'a lot', unit_price: '10.00', amount: '20.00' }],
        subtotal: '20.00',
        tax: '0',
        total: '20.00',
      },
      rawResponse: { id: 'r' },
      inputTokens: 100,
      outputTokens: 20,
      stopReason: 'end_turn',
    });

    await extractDocument('doc-1');

    expect(mocks.insertedFieldValueRows[0]).toMatchObject({ confidence: '0', status: 'needs_review' });
    expect(mocks.insertedFieldValueRows[0].confidenceParts.validatorStatus).toBe('invalid');
  });
});
