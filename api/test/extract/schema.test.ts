import { describe, it, expect } from 'vitest';
import { buildExtractionJsonSchema, type FieldSpec } from '../../src/extract/schema.js';

const FIELDS: FieldSpec[] = [
  { key: 'invoice_number', label: 'Invoice Number', type: 'string', required: true, autoAcceptThreshold: 0.95, description: 'The id.' },
  {
    key: 'currency',
    label: 'Currency',
    type: 'enum',
    required: true,
    enumValues: ['USD', 'EUR', 'GBP'],
    autoAcceptThreshold: 0.9,
    description: 'The currency.',
  },
  {
    key: 'line_items',
    label: 'Line Items',
    type: 'table',
    required: true,
    autoAcceptThreshold: 0.9,
    description: 'Itemized products.',
    columns: [
      { key: 'description', label: 'Description', type: 'string', required: true },
      { key: 'quantity', label: 'Quantity', type: 'number', required: true },
      { key: 'unit', label: 'Unit', type: 'enum', required: true, enumValues: ['each', 'case', 'pallet'] },
    ],
  },
];

describe('buildExtractionJsonSchema', () => {
  const schema = buildExtractionJsonSchema(FIELDS) as {
    type: string;
    properties: Record<string, any>;
    required: string[];
    additionalProperties: boolean;
  };

  it('marks every top-level field key as required (present in the response), regardless of nullability', () => {
    expect(schema.required).toEqual(['invoice_number', 'currency', 'line_items']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('makes scalar fields nullable via anyOf, not a type array (the API rejects type:[X,"null"] combined with enum)', () => {
    expect(schema.properties.invoice_number).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'The id.',
    });
  });

  it('keeps enum values inside the non-null branch of anyOf', () => {
    expect(schema.properties.currency).toEqual({
      anyOf: [{ type: 'string', enum: ['USD', 'EUR', 'GBP'] }, { type: 'null' }],
      description: 'The currency.',
    });
  });

  it('builds table fields as a non-nullable array of non-nullable row objects', () => {
    expect(schema.properties.line_items).toEqual({
      type: 'array',
      description: 'Itemized products.',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Description' },
          quantity: { type: 'number', description: 'Quantity' },
          unit: { type: 'string', enum: ['each', 'case', 'pallet'], description: 'Unit' },
        },
        required: ['description', 'quantity', 'unit'],
        additionalProperties: false,
      },
    });
  });

  it('threads a table column\'s own enumValues through — a column has no way to fall back to the parent field\'s, since it has none', () => {
    const columnSchema = (schema.properties.line_items as { items: { properties: Record<string, any> } }).items.properties.unit;
    expect(columnSchema.enum).toEqual(['each', 'case', 'pallet']);
    expect(columnSchema.enum.length).toBeGreaterThan(0); // the regression this guards: an omitted enumValues silently became `enum: []`, unsatisfiable by any string
  });
});
