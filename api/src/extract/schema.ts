// Shape of extraction_schemas.fields (jsonb). Mirrors scripts/fieldSpecs.ts structurally
// but is declared independently — /api must stay deployable without /scripts, and jsonb
// columns come back untyped from the DB regardless of where the type lives.
export type FieldType = 'string' | 'number' | 'money' | 'date' | 'enum' | 'table';

export interface ColumnSpec {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
}

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  enumValues?: string[];
  autoAcceptThreshold: number;
  description: string;
  columns?: ColumnSpec[];
}

// fieldValues.rawValue/normalizedValue are TEXT columns, so every scalar field is
// extracted as a JSON string regardless of its semantic type (money stays a string to
// avoid float rounding on currency; date stays a string rather than assuming a parseable
// format up front). "number" is the one exception, used only by table columns like
// quantity where there's no precision concern and downstream arithmetic checks want a
// real number.
// A `type: [X, "null"]` array is rejected by the API's structured-output validator
// when paired with `enum` ("Enum value 'USD' does not match declared type" — confirmed
// against the live API, not assumed). `anyOf: [{type: X, ...}, {type: "null"}]` is the
// form the validator actually accepts for "nullable X".
function scalarSchema(type: FieldType, enumValues: string[] | undefined, nullable: boolean): Record<string, unknown> {
  const base: Record<string, unknown> =
    type === 'number' ? { type: 'number' } : type === 'enum' ? { type: 'string', enum: enumValues ?? [] } : { type: 'string' };
  return nullable ? { anyOf: [base, { type: 'null' }] } : base;
}

// Every field key is marked "required" (must be present in the response object), but
// scalar fields are nullable — the model must always state a determination, and "not
// present on the document" is a legitimate determination (see the missing_required_field
// synthetic edge case), not a schema violation to route around.
export function buildExtractionJsonSchema(fields: FieldSpec[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of fields) {
    required.push(field.key);

    if (field.type === 'table') {
      const columns = field.columns ?? [];
      const rowProperties: Record<string, unknown> = {};
      const rowRequired: string[] = [];
      for (const column of columns) {
        rowProperties[column.key] = { ...scalarSchema(column.type, undefined, false), description: column.label };
        rowRequired.push(column.key);
      }
      properties[field.key] = {
        type: 'array',
        description: field.description,
        items: {
          type: 'object',
          properties: rowProperties,
          required: rowRequired,
          additionalProperties: false,
        },
      };
    } else {
      properties[field.key] = { ...scalarSchema(field.type, field.enumValues, true), description: field.description };
    }
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}
