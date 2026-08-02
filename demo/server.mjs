// Public live-demo server: serves the built web frontend as static files
// plus a self-contained, realistic-but-fake review API. Entirely isolated
// from the real product — no database, no auth, no real documents. State
// resets on a timer so every visitor gets a fresh walkthrough regardless of
// what earlier visitors did.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const STATIC_DIR = path.join(ROOT, '..', 'web', 'dist');
const PAGES_DIR = path.join(ROOT, 'pages');
const PORT = process.env.PORT || 8080;
const RESET_INTERVAL_MS = 10 * 60 * 1000;

const pageA = { id: 'page-1', pageNumber: 1, width: 1224, height: 1584, file: 'invoice_clean_01_p1.png' };
const pageB = { id: 'page-2', pageNumber: 1, width: 1224, height: 1584, file: 'invoice_clean_04_p1.png' };
const pageC = { id: 'page-3', pageNumber: 1, width: 1224, height: 1584, file: 'invoice_scanned_01_p1.png' };

const lineItemColumns = [
  { key: 'description', label: 'Description', type: 'string' },
  { key: 'quantity', label: 'Quantity', type: 'number' },
  { key: 'unit_price', label: 'Unit Price', type: 'money' },
  { key: 'amount', label: 'Amount', type: 'money' },
];

const itemA = {
  fieldValueId: 'fv-vendor-1', documentId: 'doc-1', documentFilename: 'invoice_clean_01.pdf',
  fieldKey: 'vendor_name', fieldType: 'string', label: 'Vendor Name',
  description: 'The name of the company issuing the invoice.',
  rawValue: 'Harrow & Fnch Materials', normalizedValue: 'Harrow & Fnch Materials',
  confidence: '0.62', confidenceParts: { sampleAgreement: 0.67, validatorStatus: 'valid', crossFieldChecks: [] },
  validatorStatus: 'valid', status: 'needs_review', rows: null, pages: [pageA],
};

const itemB = {
  fieldValueId: 'fv-duedate-1', documentId: 'doc-1', documentFilename: 'invoice_clean_01.pdf',
  fieldKey: 'due_date', fieldType: 'date', label: 'Due Date',
  description: 'The date payment is due.',
  rawValue: '2025-10-20', normalizedValue: '2025-10-20',
  confidence: '0.78', confidenceParts: { sampleAgreement: 0.67, validatorStatus: 'valid', crossFieldChecks: [] },
  validatorStatus: 'valid', status: 'needs_review', rows: null, pages: [pageA],
};

const ROW3_INITIAL = {
  cells: { description: 'Pallet wrap, 18in x 1500ft', quantity: 8, unit_price: '$190.42', amount: '$571.26' },
  confidence: '0.55',
  confidenceParts: { sampleAgreement: 0.33, validatorStatus: 'valid', crossFieldChecks: [{ name: 'quantity_times_unit_price_equals_amount', passed: false }] },
  status: 'needs_review',
};

const itemC = {
  fieldValueId: 'fv-lineitems-1', documentId: 'doc-2', documentFilename: 'invoice_clean_04.pdf',
  fieldKey: 'line_items', fieldType: 'table', label: 'Line Items',
  description: 'Itemized products or services billed.',
  rawValue: null, normalizedValue: null,
  confidence: '0.91', confidenceParts: { sampleAgreement: 1, validatorStatus: 'valid', crossFieldChecks: [{ name: 'line_items_sum_equals_subtotal', passed: true }] },
  validatorStatus: 'valid', status: 'auto_accepted',
  rows: [
    { id: 'row-1', rowIndex: 0, cells: { description: 'Disposable coveralls (case of 20)', quantity: 6, unit_price: '$80.77', amount: '$484.62' }, confidence: '1', confidenceParts: { sampleAgreement: 1, validatorStatus: 'valid', crossFieldChecks: [] }, status: 'auto_accepted', columns: lineItemColumns },
    { id: 'row-2', rowIndex: 1, cells: { description: 'Safety gloves, size L (pair)', quantity: 27, unit_price: '$17.46', amount: '$471.42' }, confidence: '1', confidenceParts: { sampleAgreement: 1, validatorStatus: 'valid', crossFieldChecks: [] }, status: 'auto_accepted', columns: lineItemColumns },
    { id: 'row-3', rowIndex: 2, cells: { ...ROW3_INITIAL.cells }, confidence: ROW3_INITIAL.confidence, confidenceParts: ROW3_INITIAL.confidenceParts, status: ROW3_INITIAL.status, columns: lineItemColumns },
    { id: 'row-4', rowIndex: 3, cells: { description: 'Commercial paper towel rolls (case)', quantity: 32, unit_price: '$15.01', amount: '$480.32' }, confidence: '1', confidenceParts: { sampleAgreement: 1, validatorStatus: 'valid', crossFieldChecks: [] }, status: 'auto_accepted', columns: lineItemColumns },
  ],
  pages: [pageB],
};

const itemD = {
  fieldValueId: 'fv-invoicenum-1', documentId: 'doc-3', documentFilename: 'invoice_scanned_01.pdf',
  fieldKey: 'invoice_number', fieldType: 'string', label: 'Invoice Number',
  description: 'The unique identifier printed on the invoice.',
  rawValue: 'INV-22841', normalizedValue: 'INV-22841',
  confidence: '0.58', confidenceParts: { sampleAgreement: 0.5, validatorStatus: 'valid', crossFieldChecks: [] },
  validatorStatus: 'valid', status: 'needs_review', rows: null, pages: [pageC],
};

let itemAStatus, itemBStatus, itemDStatus, archivedDocumentIds;

function resetState() {
  itemAStatus = 'needs_review';
  itemBStatus = 'needs_review';
  itemDStatus = 'needs_review';
  archivedDocumentIds = new Set();
  const row3 = itemC.rows[2];
  row3.cells = { ...ROW3_INITIAL.cells };
  row3.confidence = ROW3_INITIAL.confidence;
  row3.confidenceParts = ROW3_INITIAL.confidenceParts;
  row3.status = ROW3_INITIAL.status;
  console.log('demo state reset');
}
resetState();
setInterval(resetState, RESET_INTERVAL_MS);

function nextUnarchivedItem() {
  if (itemAStatus === 'needs_review' && !archivedDocumentIds.has(itemA.documentId)) return itemA;
  if (itemBStatus === 'needs_review' && !archivedDocumentIds.has(itemB.documentId)) return itemB;
  const stillNeeds = itemC.rows.some((r) => r.status === 'needs_review');
  if (stillNeeds && !archivedDocumentIds.has(itemC.documentId)) return itemC;
  if (itemDStatus === 'needs_review' && !archivedDocumentIds.has(itemD.documentId)) return itemD;
  return null;
}

function computeStats() {
  let needsReview = 0, autoAccepted = 0, confirmed = 0, corrected = 0, totalItems = 0;
  if (!archivedDocumentIds.has(itemA.documentId)) {
    totalItems++;
    if (itemAStatus === 'needs_review') needsReview++;
    else if (itemAStatus === 'confirmed') confirmed++;
    else if (itemAStatus === 'corrected') corrected++;
  }
  if (!archivedDocumentIds.has(itemB.documentId)) {
    totalItems++;
    if (itemBStatus === 'needs_review') needsReview++;
    else if (itemBStatus === 'confirmed') confirmed++;
    else if (itemBStatus === 'corrected') corrected++;
  }
  if (!archivedDocumentIds.has(itemC.documentId)) {
    totalItems++;
    if (itemC.rows.some((r) => r.status === 'needs_review')) needsReview++;
    else autoAccepted++;
  }
  if (!archivedDocumentIds.has(itemD.documentId)) {
    totalItems++;
    if (itemDStatus === 'needs_review') needsReview++;
    else if (itemDStatus === 'confirmed') confirmed++;
    else if (itemDStatus === 'corrected') corrected++;
  }
  return { totalItems, needsReview, autoAccepted, confirmed, corrected };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const resolved = path.normalize(path.join(STATIC_DIR, rel));
  const target = resolved.startsWith(STATIC_DIR) && existsSync(resolved) && !rel.endsWith('/')
    ? resolved
    : path.join(STATIC_DIR, 'index.html'); // SPA fallback
  try {
    const buf = await readFile(target);
    const ext = path.extname(target);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': buf.length });
    res.end(buf);
  } catch {
    sendJson(res, 500, { error: 'static_serve_failed' });
  }
}

async function handleApi(req, res, apiPath) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'POST' && apiPath === '/review-sessions') {
    const body = await readBody(req);
    return sendJson(res, 201, { id: 'sess-1', reviewer: body.reviewer ?? 'demo', batchId: null, startedAt: new Date().toISOString() });
  }
  if (req.method === 'POST' && /^\/review-sessions\/[^/]+\/end$/.test(apiPath)) {
    return sendJson(res, 200, { id: 'sess-1', endedAt: new Date().toISOString() });
  }
  if (req.method === 'GET' && apiPath === '/review/next') {
    return sendJson(res, 200, { item: nextUnarchivedItem() });
  }
  if (req.method === 'GET' && apiPath === '/review/stats') {
    return sendJson(res, 200, computeStats());
  }
  if (req.method === 'POST' && apiPath === '/demo/reset') {
    resetState();
    return sendJson(res, 200, { reset: true });
  }

  const fieldAcceptMatch = apiPath.match(/^\/review\/fields\/([^/]+)\/accept$/);
  if (req.method === 'POST' && fieldAcceptMatch) {
    const id = fieldAcceptMatch[1];
    if (id === itemA.fieldValueId) itemAStatus = 'confirmed';
    else if (id === itemB.fieldValueId) itemBStatus = 'confirmed';
    else if (id === itemD.fieldValueId) itemDStatus = 'confirmed';
    return sendJson(res, 200, { id, status: 'confirmed' });
  }

  const fieldCorrectMatch = apiPath.match(/^\/review\/fields\/([^/]+)\/correct$/);
  if (req.method === 'POST' && fieldCorrectMatch) {
    const id = fieldCorrectMatch[1];
    await readBody(req);
    if (id === itemA.fieldValueId) itemAStatus = 'corrected';
    else if (id === itemB.fieldValueId) itemBStatus = 'corrected';
    else if (id === itemD.fieldValueId) itemDStatus = 'corrected';
    return sendJson(res, 200, { id, status: 'corrected' });
  }

  const rowAcceptMatch = apiPath.match(/^\/review\/rows\/([^/]+)\/accept$/);
  if (req.method === 'POST' && rowAcceptMatch) {
    const row = itemC.rows.find((r) => r.id === rowAcceptMatch[1]);
    if (row) row.status = 'confirmed';
    return sendJson(res, 200, { id: rowAcceptMatch[1], status: 'confirmed' });
  }

  const rowCorrectMatch = apiPath.match(/^\/review\/rows\/([^/]+)\/correct$/);
  if (req.method === 'POST' && rowCorrectMatch) {
    const body = await readBody(req);
    const row = itemC.rows.find((r) => r.id === rowCorrectMatch[1]);
    if (row) { row.cells[body.columnKey] = body.newValue; row.status = 'corrected'; }
    return sendJson(res, 200, { id: rowCorrectMatch[1], status: 'corrected' });
  }

  const fieldUndoMatch = apiPath.match(/^\/review\/fields\/([^/]+)\/undo$/);
  if (req.method === 'POST' && fieldUndoMatch) {
    const id = fieldUndoMatch[1];
    if (id === itemA.fieldValueId) itemAStatus = 'needs_review';
    else if (id === itemB.fieldValueId) itemBStatus = 'needs_review';
    else if (id === itemD.fieldValueId) itemDStatus = 'needs_review';
    return sendJson(res, 200, { id, status: 'needs_review' });
  }

  const rowUndoMatch = apiPath.match(/^\/review\/rows\/([^/]+)\/undo$/);
  if (req.method === 'POST' && rowUndoMatch) {
    const row = itemC.rows.find((r) => r.id === rowUndoMatch[1]);
    if (row) row.status = 'needs_review';
    return sendJson(res, 200, { id: rowUndoMatch[1], status: 'needs_review' });
  }

  const archiveMatch = apiPath.match(/^\/documents\/([^/]+)\/archive$/);
  if (req.method === 'POST' && archiveMatch) {
    archivedDocumentIds.add(archiveMatch[1]);
    return sendJson(res, 200, { id: archiveMatch[1], status: 'archived' });
  }

  const pageImageMatch = apiPath.match(/^\/pages\/([^/]+)\/image$/);
  if (req.method === 'GET' && pageImageMatch) {
    const pg = [pageA, pageB, pageC].find((p) => p.id === pageImageMatch[1]);
    if (!pg) return sendJson(res, 404, { error: 'page_not_found' });
    const buf = await readFile(path.join(PAGES_DIR, pg.file));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
    return res.end(buf);
  }

  sendJson(res, 404, { error: 'not_found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url.pathname.slice(4));
  }
  if (url.pathname === '/healthz') {
    return sendJson(res, 200, { status: 'ok' });
  }
  return serveStatic(req, res);
});

server.listen(PORT, () => console.log(`live demo server on http://localhost:${PORT}`));
