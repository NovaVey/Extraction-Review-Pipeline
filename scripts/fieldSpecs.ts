// Mirrors the `extraction_schemas.fields` jsonb shape from the schema (see
// api/src/db/schema.ts). Used now by the synthetic corpus generator to know
// what fields each doc type has and to produce ground-truth gold labels;
// later phases insert this same shape as real `extraction_schemas` rows.

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

export type DocType = 'invoice' | 'receipt' | 'purchase_order';

const LINE_ITEM_COLUMNS: ColumnSpec[] = [
  { key: 'description', label: 'Description', type: 'string', required: true },
  { key: 'quantity', label: 'Quantity', type: 'number', required: true },
  { key: 'unit_price', label: 'Unit Price', type: 'money', required: true },
  { key: 'amount', label: 'Amount', type: 'money', required: true },
];

export const FIELD_SPECS: Record<DocType, FieldSpec[]> = {
  invoice: [
    { key: 'invoice_number', label: 'Invoice Number', type: 'string', required: true, autoAcceptThreshold: 0.95, description: 'The unique invoice identifier printed on the document.' },
    { key: 'vendor_name', label: 'Vendor Name', type: 'string', required: true, autoAcceptThreshold: 0.9, description: 'The name of the company issuing the invoice.' },
    { key: 'invoice_date', label: 'Invoice Date', type: 'date', required: true, autoAcceptThreshold: 0.9, description: 'The date the invoice was issued.' },
    { key: 'due_date', label: 'Due Date', type: 'date', required: true, autoAcceptThreshold: 0.9, description: 'The date payment is due.' },
    { key: 'currency', label: 'Currency', type: 'enum', required: true, enumValues: ['USD', 'EUR', 'GBP'], autoAcceptThreshold: 0.9, description: 'The currency the invoice amounts are denominated in.' },
    { key: 'line_items', label: 'Line Items', type: 'table', required: true, autoAcceptThreshold: 0.9, description: 'Itemized products or services billed.', columns: LINE_ITEM_COLUMNS },
    { key: 'subtotal', label: 'Subtotal', type: 'money', required: true, autoAcceptThreshold: 0.95, description: 'Sum of line item amounts before tax.' },
    { key: 'tax', label: 'Tax', type: 'money', required: true, autoAcceptThreshold: 0.95, description: 'Tax amount applied to the subtotal.' },
    { key: 'total', label: 'Total', type: 'money', required: true, autoAcceptThreshold: 0.95, description: 'Subtotal plus tax; the total amount due.' },
  ],
  receipt: [
    { key: 'receipt_number', label: 'Receipt Number', type: 'string', required: true, autoAcceptThreshold: 0.95, description: 'The unique receipt/transaction identifier.' },
    { key: 'merchant_name', label: 'Merchant Name', type: 'string', required: true, autoAcceptThreshold: 0.9, description: 'The name of the merchant that issued the receipt.' },
    { key: 'transaction_date', label: 'Transaction Date', type: 'date', required: true, autoAcceptThreshold: 0.9, description: 'The date of the purchase.' },
    { key: 'payment_method', label: 'Payment Method', type: 'enum', required: true, enumValues: ['cash', 'credit_card', 'debit_card'], autoAcceptThreshold: 0.9, description: 'How the purchase was paid for.' },
    { key: 'line_items', label: 'Line Items', type: 'table', required: true, autoAcceptThreshold: 0.9, description: 'Itemized products purchased.', columns: LINE_ITEM_COLUMNS },
    { key: 'subtotal', label: 'Subtotal', type: 'money', required: true, autoAcceptThreshold: 0.95, description: 'Sum of line item amounts before tax.' },
    { key: 'tax', label: 'Tax', type: 'money', required: true, autoAcceptThreshold: 0.95, description: 'Tax amount applied to the subtotal.' },
    { key: 'total', label: 'Total', type: 'money', required: true, autoAcceptThreshold: 0.95, description: 'Subtotal plus tax; the total amount charged.' },
  ],
  purchase_order: [
    { key: 'po_number', label: 'PO Number', type: 'string', required: true, autoAcceptThreshold: 0.95, description: 'The unique purchase order identifier.' },
    { key: 'vendor_name', label: 'Vendor Name', type: 'string', required: true, autoAcceptThreshold: 0.9, description: 'The name of the vendor the order is placed with.' },
    { key: 'order_date', label: 'Order Date', type: 'date', required: true, autoAcceptThreshold: 0.9, description: 'The date the purchase order was created.' },
    { key: 'delivery_date', label: 'Delivery Date', type: 'date', required: true, autoAcceptThreshold: 0.9, description: 'The requested delivery date.' },
    { key: 'line_items', label: 'Line Items', type: 'table', required: true, autoAcceptThreshold: 0.9, description: 'Itemized products or services ordered.', columns: LINE_ITEM_COLUMNS },
    { key: 'subtotal', label: 'Subtotal', type: 'money', required: true, autoAcceptThreshold: 0.95, description: 'Sum of line item amounts before tax.' },
    { key: 'total', label: 'Total', type: 'money', required: true, autoAcceptThreshold: 0.95, description: 'The total order amount.' },
    { key: 'approved_by', label: 'Approved By', type: 'string', required: false, autoAcceptThreshold: 0.9, description: 'The name of the person who approved the order, if signed off.' },
  ],
};
