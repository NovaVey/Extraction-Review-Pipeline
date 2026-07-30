// Generates the 60-document synthetic corpus for Phase 1. Every document,
// vendor name, and dollar amount here is fabricated for testing — see
// README.md's "Synthetic data" section. Run: npm run gen:samples
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { FIELD_SPECS, type DocType } from './fieldSpecs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, '../samples');

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;

type DifficultyGroup = 'clean' | 'scanned' | 'multipage' | 'edge_case';
type EdgeCaseKind = 'handwriting' | 'two_currencies' | 'missing_required_field' | 'near_duplicate_vendor';

interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

interface DocData {
  docType: DocType;
  fields: Record<string, string>;
  lineItems: LineItem[];
  omitFieldKey?: string;
  mixedCurrencyLineIndex?: number;
}

// ---- Deterministic-ish random helpers (seeded per-call via Math.random is
// fine here — this is a one-shot local script, not a Workflow script) ----
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randomMoney(min: number, max: number): number {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}
function fmtMoney(n: number, symbol = '$'): string {
  return `${symbol}${n.toFixed(2)}`;
}
function fmtDateISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function fmtDateDisplay(d: Date): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
}
function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}
function randomRecentDate(): Date {
  const start = new Date('2025-09-01').getTime();
  const end = new Date('2026-07-01').getTime();
  return new Date(start + Math.random() * (end - start));
}

// ---- Data pools (all fabricated) ----
const VENDOR_NAMES = [
  'Blackwood Supply Co.',
  'Blackwood Supply Company',
  'Cinderpath Logistics',
  'Harrow & Finch Materials',
  'Nortonvale Industrial',
  'Rivermark Distribution',
  'Sable Ridge Traders',
  'Thistledown Wholesale',
  'Ashgrove Manufacturing',
  'Ashgrove Manufacturing Inc.',
  'Copperline Fabrication',
  'Millbrook Office Supply',
  'Windward Freight Group',
  'Greystone Hardware',
  'Ferncrest Packaging',
  'Oakhollow Electrical',
];
const MERCHANT_NAMES = [
  'Corner Market Deli',
  'Pinehill Coffee Roasters',
  'Union Street Hardware',
  'Brightside Office Depot',
  'Lantern & Vine Grocers',
  'Cobblestone Print Shop',
  'Harborview Fuel Stop',
  'Maple & Co. Bakery',
  'Redwood Auto Parts',
  'Northgate Pharmacy',
];
const CUSTOMER_NAMES = ['Jordan Ellery', 'Priya Nandakumar', 'Marcus Whitfield', 'Ingrid Solberg', 'Tobias Reinholt'];
const PRODUCTS = [
  'Corrugated shipping boxes (case of 25)',
  '1/2in galvanized steel bolts (box of 100)',
  'Industrial-strength packing tape (roll)',
  'Safety gloves, size L (pair)',
  '4ft LED shop light fixture',
  'Pallet wrap, 18in x 1500ft',
  'Stainless steel hex nuts (box of 200)',
  'Warehouse floor marking tape (roll)',
  'Heavy-duty zip ties (pack of 100)',
  'Anti-static bubble wrap (100ft roll)',
  'Cordless drill battery pack',
  'Reinforced work gloves (pair)',
  'Aluminum extrusion, 6ft length',
  'Commercial paper towel rolls (case)',
  'Hex key set, metric',
  'Disposable coveralls (case of 20)',
  'Loading dock bumper pads',
  'Forklift replacement forks',
  'Warehouse shelving bracket set',
  'Cable management conduit, 10ft',
];

function randomLineItems(count: number): LineItem[] {
  const items: LineItem[] = [];
  for (let i = 0; i < count; i++) {
    const quantity = randomInt(1, 40);
    const unitPrice = randomMoney(4, 220);
    items.push({
      description: pick(PRODUCTS),
      quantity,
      unitPrice,
      amount: Math.round(quantity * unitPrice * 100) / 100,
    });
  }
  return items;
}

function sum(items: LineItem[]): number {
  return Math.round(items.reduce((acc, i) => acc + i.amount, 0) * 100) / 100;
}

// ---- Content generators (ground truth is whatever we put here) ----
function generateInvoiceData(lineItemCount: number): DocData {
  const vendor = pick(VENDOR_NAMES);
  const issueDate = randomRecentDate();
  const dueDate = addDays(issueDate, randomInt(15, 45));
  const lineItems = randomLineItems(lineItemCount);
  const subtotal = sum(lineItems);
  const tax = Math.round(subtotal * 0.08 * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  return {
    docType: 'invoice',
    fields: {
      invoice_number: `INV-${randomInt(10000, 99999)}`,
      vendor_name: vendor,
      invoice_date: fmtDateISO(issueDate),
      due_date: fmtDateISO(dueDate),
      currency: 'USD',
      subtotal: subtotal.toFixed(2),
      tax: tax.toFixed(2),
      total: total.toFixed(2),
    },
    lineItems,
  };
}

function generateReceiptData(lineItemCount: number): DocData {
  const merchant = pick(MERCHANT_NAMES);
  const txnDate = randomRecentDate();
  const lineItems = randomLineItems(lineItemCount);
  const subtotal = sum(lineItems);
  const tax = Math.round(subtotal * 0.07 * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  return {
    docType: 'receipt',
    fields: {
      receipt_number: `RCPT-${randomInt(100000, 999999)}`,
      merchant_name: merchant,
      transaction_date: fmtDateISO(txnDate),
      payment_method: pick(['cash', 'credit_card', 'debit_card']),
      subtotal: subtotal.toFixed(2),
      tax: tax.toFixed(2),
      total: total.toFixed(2),
    },
    lineItems,
  };
}

function generatePoData(lineItemCount: number): DocData {
  const vendor = pick(VENDOR_NAMES);
  const orderDate = randomRecentDate();
  const deliveryDate = addDays(orderDate, randomInt(7, 30));
  const lineItems = randomLineItems(lineItemCount);
  const subtotal = sum(lineItems);
  const total = subtotal;
  return {
    docType: 'purchase_order',
    fields: {
      po_number: `PO-${randomInt(1000, 9999)}`,
      vendor_name: vendor,
      order_date: fmtDateISO(orderDate),
      delivery_date: fmtDateISO(deliveryDate),
      subtotal: subtotal.toFixed(2),
      total: total.toFixed(2),
      approved_by: pick(CUSTOMER_NAMES),
    },
    lineItems,
  };
}

function generateData(docType: DocType, lineItemCount: number): DocData {
  if (docType === 'invoice') return generateInvoiceData(lineItemCount);
  if (docType === 'receipt') return generateReceiptData(lineItemCount);
  return generatePoData(lineItemCount);
}

const DOC_TITLES: Record<DocType, string> = {
  invoice: 'INVOICE',
  receipt: 'RECEIPT',
  purchase_order: 'PURCHASE ORDER',
};

// ---- Shared layout drawing (used for clean, multipage, and as the source
// content for the scanned/handwriting canvas renders) ----
interface DrawOptions {
  omitFieldKey?: string;
  handwrittenFieldKey?: string;
  mixedCurrencyLineIndex?: number;
}

function fieldLabel(docType: DocType, key: string): string {
  const spec = FIELD_SPECS[docType].find((f) => f.key === key);
  return spec?.label ?? key;
}

function scalarFieldOrder(docType: DocType): string[] {
  return FIELD_SPECS[docType].filter((f) => f.type !== 'table').map((f) => f.key);
}

/** Draws one document's content onto a pdf-lib document, paginating the line-item table as needed. Returns the finished PDFDocument. */
async function drawPdf(data: DocData, opts: DrawOptions = {}): Promise<PDFDocument> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const drawHeader = () => {
    page.drawText(DOC_TITLES[data.docType], { x: MARGIN, y, size: 22, font: bold, color: rgb(0.1, 0.1, 0.12) });
    y -= 34;
  };
  drawHeader();

  for (const key of scalarFieldOrder(data.docType)) {
    if (key === opts.omitFieldKey) continue; // simulate a missing required field
    const value = data.fields[key];
    if (value === undefined) continue;
    const label = fieldLabel(data.docType, key);
    page.drawText(`${label}:`, { x: MARGIN, y, size: 10, font: bold, color: rgb(0.3, 0.3, 0.3) });
    if (key === opts.handwrittenFieldKey) {
      // Render this one field as a rasterized, italic "handwritten" snippet
      // instead of real PDF text — embedded as an image at the same spot.
      const imgBytes = renderHandwrittenSnippet(value);
      const img = await pdf.embedPng(imgBytes);
      const scale = 16 / img.height;
      page.drawImage(img, { x: MARGIN + 150, y: y - 4, width: img.width * scale, height: img.height * scale });
    } else {
      page.drawText(value, { x: MARGIN + 150, y, size: 10, font, color: rgb(0, 0, 0) });
    }
    y -= 16;
  }
  y -= 12;

  // Line items table
  const cols = [
    { key: 'description', label: 'Description', x: MARGIN, width: 260 },
    { key: 'quantity', label: 'Qty', x: MARGIN + 270, width: 40 },
    { key: 'unit_price', label: 'Unit Price', x: MARGIN + 320, width: 80 },
    { key: 'amount', label: 'Amount', x: MARGIN + 410, width: 80 },
  ];
  const drawTableHeader = () => {
    for (const c of cols) page.drawText(c.label, { x: c.x, y, size: 9, font: bold, color: rgb(0.3, 0.3, 0.3) });
    y -= 4;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
    y -= 14;
  };
  drawTableHeader();

  data.lineItems.forEach((item, idx) => {
    if (y < MARGIN + 100) {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
      page.drawText(`${DOC_TITLES[data.docType]} (cont.)`, { x: MARGIN, y, size: 12, font: bold, color: rgb(0.3, 0.3, 0.3) });
      y -= 26;
      drawTableHeader();
    }
    const useEuro = idx === opts.mixedCurrencyLineIndex;
    page.drawText(item.description, { x: cols[0].x, y, size: 9, font, color: rgb(0, 0, 0) });
    page.drawText(String(item.quantity), { x: cols[1].x, y, size: 9, font, color: rgb(0, 0, 0) });
    page.drawText(fmtMoney(item.unitPrice, useEuro ? '€' : '$'), { x: cols[2].x, y, size: 9, font, color: rgb(0, 0, 0) });
    page.drawText(fmtMoney(item.amount, useEuro ? '€' : '$'), { x: cols[3].x, y, size: 9, font, color: rgb(0, 0, 0) });
    y -= 14;
  });

  return pdf;
}

function renderHandwrittenSnippet(text: string): Buffer {
  const canvas = createCanvas(260, 30);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#1a1a2e';
  ctx.font = 'italic 16px serif';
  ctx.save();
  ctx.translate(4, 20);
  ctx.rotate((-2 * Math.PI) / 180);
  ctx.fillText(text, 0, 0);
  ctx.restore();
  return canvas.toBuffer('image/png');
}

/** Renders a document to a single skewed, noisy raster image (simulating a scan) and embeds it as an image-only PDF page with no text layer. */
async function drawScannedPdf(data: DocData): Promise<PDFDocument> {
  const canvas = createCanvas(PAGE_WIDTH, PAGE_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const angle = (Math.random() * 5 - 2.5) * (Math.PI / 180);
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(angle);
  ctx.translate(-canvas.width / 2, -canvas.height / 2);

  ctx.fillStyle = '#0f0f14';
  ctx.font = 'bold 22px sans-serif';
  let y = PAGE_HEIGHT - MARGIN;
  ctx.fillText(DOC_TITLES[data.docType], MARGIN, y);
  y -= 34;

  ctx.font = '10px sans-serif';
  for (const key of scalarFieldOrder(data.docType)) {
    const value = data.fields[key];
    if (value === undefined) continue;
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText(`${fieldLabel(data.docType, key)}:`, MARGIN, y);
    ctx.font = '10px sans-serif';
    ctx.fillText(value, MARGIN + 150, y);
    y -= 16;
  }
  y -= 12;
  ctx.font = 'bold 9px sans-serif';
  ctx.fillText('Description', MARGIN, y);
  ctx.fillText('Qty', MARGIN + 270, y);
  ctx.fillText('Unit Price', MARGIN + 320, y);
  ctx.fillText('Amount', MARGIN + 410, y);
  y -= 14;
  ctx.font = '9px sans-serif';
  for (const item of data.lineItems.slice(0, 18)) {
    ctx.fillText(item.description, MARGIN, y);
    ctx.fillText(String(item.quantity), MARGIN + 270, y);
    ctx.fillText(fmtMoney(item.unitPrice), MARGIN + 320, y);
    ctx.fillText(fmtMoney(item.amount), MARGIN + 410, y);
    y -= 14;
  }
  ctx.restore();

  // Light speckle noise to emulate scan artifacts.
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = imageData.data;
  for (let i = 0; i < px.length; i += 4) {
    if (Math.random() < 0.02) {
      const jitter = randomInt(-25, 25);
      px[i] = Math.min(255, Math.max(0, px[i] + jitter));
      px[i + 1] = Math.min(255, Math.max(0, px[i + 1] + jitter));
      px[i + 2] = Math.min(255, Math.max(0, px[i + 2] + jitter));
    }
  }
  ctx.putImageData(imageData, 0, 0);

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const png = await pdf.embedPng(canvas.toBuffer('image/png'));
  page.drawImage(png, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  return pdf;
}

// ---- Manifest entry shape ----
interface ManifestEntry {
  filename: string;
  docType: DocType;
  difficultyGroup: DifficultyGroup;
  inDevSubset: boolean;
  notes: string | null;
  fields: Record<string, string | null>;
  lineItems: { description: string; quantity: number; unit_price: string; amount: string }[];
}

const DOC_TYPES: DocType[] = ['invoice', 'receipt', 'purchase_order'];
const EDGE_CASE_KINDS: EdgeCaseKind[] = ['handwriting', 'two_currencies', 'missing_required_field', 'near_duplicate_vendor'];

function toManifestFields(data: DocData): Record<string, string | null> {
  const out: Record<string, string | null> = { ...data.fields };
  if (data.omitFieldKey) out[data.omitFieldKey] = null;
  return out;
}

function toManifestLineItems(data: DocData) {
  return data.lineItems.map((li) => ({
    description: li.description,
    quantity: li.quantity,
    unit_price: li.unitPrice.toFixed(2),
    amount: li.amount.toFixed(2),
  }));
}

async function buildGroup(
  group: DifficultyGroup,
  count: number,
  subsetCount: number,
  makePdf: (docType: DocType, index: number) => Promise<{ pdf: PDFDocument; data: DocData; notes: string | null }>,
): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  for (let i = 0; i < count; i++) {
    const docType = DOC_TYPES[i % DOC_TYPES.length];
    const { pdf, data, notes } = await makePdf(docType, i);
    const filename = `${docType}_${group}_${String(i + 1).padStart(2, '0')}.pdf`;
    const bytes = await pdf.save();
    await writeFile(path.join(SAMPLES_DIR, filename), bytes);
    entries.push({
      filename,
      docType,
      difficultyGroup: group,
      inDevSubset: i < subsetCount,
      notes,
      fields: toManifestFields(data),
      lineItems: toManifestLineItems(data),
    });
  }
  return entries;
}

async function main() {
  await rm(SAMPLES_DIR, { recursive: true, force: true });
  await mkdir(SAMPLES_DIR, { recursive: true });

  const clean = await buildGroup('clean', 15, 3, async (docType) => {
    const data = generateData(docType, randomInt(3, 6));
    const pdf = await drawPdf(data);
    return { pdf, data, notes: null };
  });

  const scanned = await buildGroup('scanned', 15, 3, async (docType) => {
    const data = generateData(docType, randomInt(3, 6));
    const pdf = await drawScannedPdf(data);
    return { pdf, data, notes: 'Image-only page (simulated scan, skewed + speckled) — no native text layer.' };
  });

  const multipage = await buildGroup('multipage', 15, 2, async (docType) => {
    const data = generateData(docType, randomInt(28, 42));
    const pdf = await drawPdf(data);
    return { pdf, data, notes: 'Line items intentionally long enough to span multiple pages.' };
  });

  const edgeCase = await buildGroup('edge_case', 15, 2, async (docType, i) => {
    const kind = EDGE_CASE_KINDS[i % EDGE_CASE_KINDS.length];
    const data = generateData(docType, randomInt(3, 6));
    switch (kind) {
      case 'handwriting': {
        const candidateKeys = ['approved_by', 'vendor_name', 'merchant_name'];
        const fieldKey = candidateKeys.find((k) => data.fields[k] !== undefined) ?? scalarFieldOrder(docType)[1];
        const pdf = await drawPdf(data, { handwrittenFieldKey: fieldKey });
        return { pdf, data, notes: `Field "${fieldKey}" rendered as a handwritten-style image snippet, not extractable text.` };
      }
      case 'two_currencies': {
        const idx = randomInt(0, data.lineItems.length - 1);
        const pdf = await drawPdf(data, { mixedCurrencyLineIndex: idx });
        return {
          pdf,
          data,
          notes: `Header currency is "${data.fields.currency ?? 'USD'}" but line item ${idx} is printed in EUR (€) — deliberate currency inconsistency.`,
        };
      }
      case 'missing_required_field': {
        const required = FIELD_SPECS[docType].filter((f) => f.required && f.type !== 'table').map((f) => f.key);
        const omit = required[randomInt(0, required.length - 1)];
        data.omitFieldKey = omit;
        const pdf = await drawPdf(data, { omitFieldKey: omit });
        return { pdf, data, notes: `Required field "${omit}" is not printed anywhere on the document (genuinely absent).` };
      }
      case 'near_duplicate_vendor': {
        const vendorKey = data.fields.vendor_name !== undefined ? 'vendor_name' : 'merchant_name';
        const base = vendorKey === 'vendor_name' ? 'Blackwood Supply Co.' : 'Corner Market Deli';
        const variant = vendorKey === 'vendor_name' ? 'Blackwood Supply Co, Inc.' : 'Corner Market Deli LLC';
        data.fields[vendorKey] = pick([base, variant]);
        const pdf = await drawPdf(data);
        return { pdf, data, notes: `Vendor name is a near-duplicate variant ("${data.fields[vendorKey]}") of another vendor in the corpus — tests dedup/matching.` };
      }
    }
  });

  const all = [...clean, ...scanned, ...multipage, ...edgeCase];
  const subsetSize = Number(process.env.SUBSET_SIZE ?? 10);
  const actualSubsetCount = all.filter((e) => e.inDevSubset).length;

  const manifest = {
    generatedAt: new Date().toISOString(),
    totalDocuments: all.length,
    subsetSize,
    devSubsetCount: actualSubsetCount,
    documents: all,
  };
  await writeFile(path.join(SAMPLES_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`Generated ${all.length} synthetic documents in ${SAMPLES_DIR}`);
  console.log(`  clean=${clean.length} scanned=${scanned.length} multipage=${multipage.length} edge_case=${edgeCase.length}`);
  console.log(`  in_dev_subset=${actualSubsetCount} (target ${subsetSize})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
