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
const pageC = { id: 'page-3', pageNumber: 1, width: 1224, height: 1584, file: 'invoice_clean_07_p1.png' };

// All three demo documents live in one fake batch, so the "This Batch" sidebar
// (QueueSidebar) has something to show — every item below carries this same id.
const DEMO_BATCH_ID = 'batch-demo-1';

const lineItemColumns = [
  { key: 'description', label: 'Description', type: 'string' },
  { key: 'quantity', label: 'Quantity', type: 'number' },
  { key: 'unit_price', label: 'Unit Price', type: 'money' },
  { key: 'amount', label: 'Amount', type: 'money' },
];

const itemA = {
  fieldValueId: 'fv-vendor-1', documentId: 'doc-1', documentFilename: 'invoice_clean_01.pdf', batchId: DEMO_BATCH_ID,
  fieldKey: 'vendor_name', fieldType: 'string', label: 'Vendor Name',
  description: 'The name of the company issuing the invoice.',
  rawValue: 'Harrow & Fnch Materials', normalizedValue: 'Harrow & Fnch Materials',
  confidence: '0.62', confidenceParts: { sampleAgreement: 0.67, validatorStatus: 'valid', crossFieldChecks: [] },
  validatorStatus: 'valid', status: 'needs_review', finalValue: null, rows: null, pages: [pageA],
};

const itemB = {
  fieldValueId: 'fv-duedate-1', documentId: 'doc-1', documentFilename: 'invoice_clean_01.pdf', batchId: DEMO_BATCH_ID,
  fieldKey: 'due_date', fieldType: 'date', label: 'Due Date',
  description: 'The date payment is due.',
  rawValue: '2025-10-20', normalizedValue: '2025-10-20',
  confidence: '0.78', confidenceParts: { sampleAgreement: 0.67, validatorStatus: 'valid', crossFieldChecks: [] },
  validatorStatus: 'valid', status: 'needs_review', finalValue: null, rows: null, pages: [pageA],
};

const ROW3_INITIAL = {
  cells: { description: 'Pallet wrap, 18in x 1500ft', quantity: 8, unit_price: '$190.42', amount: '$571.26' },
  confidence: '0.55',
  confidenceParts: { sampleAgreement: 0.33, validatorStatus: 'valid', crossFieldChecks: [{ name: 'quantity_times_unit_price_equals_amount', passed: false }] },
  status: 'needs_review',
};

const itemC = {
  fieldValueId: 'fv-lineitems-1', documentId: 'doc-2', documentFilename: 'invoice_clean_04.pdf', batchId: DEMO_BATCH_ID,
  fieldKey: 'line_items', fieldType: 'table', label: 'Line Items',
  description: 'Itemized products or services billed.',
  rawValue: null, normalizedValue: null,
  confidence: '0.91', confidenceParts: { sampleAgreement: 1, validatorStatus: 'valid', crossFieldChecks: [{ name: 'line_items_sum_equals_subtotal', passed: true }] },
  validatorStatus: 'valid', status: 'auto_accepted', finalValue: null,
  rows: [
    { id: 'row-1', rowIndex: 0, cells: { description: 'Disposable coveralls (case of 20)', quantity: 6, unit_price: '$80.77', amount: '$484.62' }, confidence: '1', confidenceParts: { sampleAgreement: 1, validatorStatus: 'valid', crossFieldChecks: [] }, status: 'auto_accepted', columns: lineItemColumns },
    { id: 'row-2', rowIndex: 1, cells: { description: 'Safety gloves, size L (pair)', quantity: 27, unit_price: '$17.46', amount: '$471.42' }, confidence: '1', confidenceParts: { sampleAgreement: 1, validatorStatus: 'valid', crossFieldChecks: [] }, status: 'auto_accepted', columns: lineItemColumns },
    { id: 'row-3', rowIndex: 2, cells: { ...ROW3_INITIAL.cells }, confidence: ROW3_INITIAL.confidence, confidenceParts: ROW3_INITIAL.confidenceParts, status: ROW3_INITIAL.status, columns: lineItemColumns },
    { id: 'row-4', rowIndex: 3, cells: { description: 'Commercial paper towel rolls (case)', quantity: 32, unit_price: '$15.01', amount: '$480.32' }, confidence: '1', confidenceParts: { sampleAgreement: 1, validatorStatus: 'valid', crossFieldChecks: [] }, status: 'auto_accepted', columns: lineItemColumns },
  ],
  pages: [pageB],
};

const itemD = {
  fieldValueId: 'fv-invoicenum-1', documentId: 'doc-3', documentFilename: 'invoice_clean_07.pdf', batchId: DEMO_BATCH_ID,
  fieldKey: 'invoice_number', fieldType: 'string', label: 'Invoice Number',
  description: 'The unique identifier printed on the invoice.',
  rawValue: 'INV-31S87', normalizedValue: 'INV-31S87',
  confidence: '0.58', confidenceParts: { sampleAgreement: 0.5, validatorStatus: 'valid', crossFieldChecks: [] },
  validatorStatus: 'valid', status: 'needs_review', finalValue: null, rows: null, pages: [pageC],
};

// Snapshotted once, right after itemC.rows is built above and before any request
// can possibly mutate it — every row (not just row-3) is reachable and mutable via
// the unguarded /api/review/rows/:id/{accept,correct,undo} handlers below (they
// look up any row by id with no status-transition guard, unlike the real backend's
// acceptRow/correctRow), so every row needs its own restore point, not just the one
// that starts out needing review.
const ROWS_INITIAL = new Map(
  itemC.rows.map((r) => [r.id, { cells: { ...r.cells }, confidence: r.confidence, confidenceParts: r.confidenceParts, status: r.status }]),
);

let itemAStatus, itemBStatus, itemDStatus, archivedDocumentIds;
// Real finalValue, mirroring api/src/review/actions.ts: set to the (possibly
// edited) value on accept/correct, cleared back to null on undo. Needed because
// GET /review/documents/:id (unlike /review/next) can return itemA/B/D in ANY
// status, not just needs_review -- without this, jumping back to an
// already-corrected document via the batch dropdown would show the stale
// pre-correction value with editing controls still enabled, silently discarding
// the very correction the dropdown feature exists to let a reviewer confirm.
let itemAFinal, itemBFinal, itemDFinal;

function resetState() {
  itemAStatus = 'needs_review';
  itemBStatus = 'needs_review';
  itemDStatus = 'needs_review';
  itemAFinal = null;
  itemBFinal = null;
  itemDFinal = null;
  archivedDocumentIds = new Set();
  // Previously only row-3 (the one that starts needs_review) was restored — rows
  // 1, 2, and 4 start auto_accepted but a stray request could still flip any of
  // them to confirmed/corrected/needs_review, and those mutations were never
  // reset, permanently corrupting the shared demo state for every visitor after.
  for (const row of itemC.rows) {
    const initial = ROWS_INITIAL.get(row.id);
    row.cells = { ...initial.cells };
    row.confidence = initial.confidence;
    row.confidenceParts = initial.confidenceParts;
    row.status = initial.status;
  }
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

// Mirrors the real API's GET /batches/:id shape (routes/batches.ts) — a trimmed,
// needsReview-badged view of the batch's active (non-archived) documents, now with
// a per-field breakdown (mirroring getBatchFieldSummaries) so the dropdown can show
// one entry per FIELD, not per document -- doc-1 alone has two (vendor_name, due_date),
// which is the exact "3 documents but 4 fields" undercount this feature exists to fix.
//
// displayName mirrors getDocumentDisplayNames's real logic: the first declared
// *string* schema field with a value, preferring the live finalValue once
// resolved (queue.ts's RESOLVED_STATUSES.has(status) ? finalValue ?? normalizedValue
// : normalizedValue) so correcting a vendor name updates the dropdown label, not
// just the field itself. doc-1 only has vendor_name (itemA) as a string candidate
// -- due_date (itemB) is type 'date', never a naming candidate. doc-2 (itemC) has
// no scalar string field at all (line_items is type 'table'), so it's always null.
function batchDocuments() {
  const docs = [
    {
      id: itemA.documentId, filename: itemA.documentFilename, status: 'processed',
      needsReview: itemAStatus === 'needs_review' || itemBStatus === 'needs_review',
      displayName: itemAFinal ?? itemA.normalizedValue,
      fields: [
        { fieldValueId: itemA.fieldValueId, fieldKey: itemA.fieldKey, label: itemA.label, needsReview: itemAStatus === 'needs_review' },
        { fieldValueId: itemB.fieldValueId, fieldKey: itemB.fieldKey, label: itemB.label, needsReview: itemBStatus === 'needs_review' },
      ],
    },
    {
      id: itemC.documentId, filename: itemC.documentFilename, status: 'processed',
      needsReview: itemC.rows.some((r) => r.status === 'needs_review'), displayName: null,
      fields: [
        { fieldValueId: itemC.fieldValueId, fieldKey: itemC.fieldKey, label: itemC.label, needsReview: itemC.rows.some((r) => r.status === 'needs_review') },
      ],
    },
    {
      id: itemD.documentId, filename: itemD.documentFilename, status: 'processed',
      needsReview: itemDStatus === 'needs_review',
      displayName: itemDFinal ?? itemD.normalizedValue,
      fields: [
        { fieldValueId: itemD.fieldValueId, fieldKey: itemD.fieldKey, label: itemD.label, needsReview: itemDStatus === 'needs_review' },
      ],
    },
  ];
  return docs.filter((d) => !archivedDocumentIds.has(d.id));
}

// Overlays live status/finalValue onto a static item fixture (itemA/B/D) without
// mutating the shared object -- see the itemAFinal comment above for why this is
// needed at all, and why nextUnarchivedItem() (used by GET /review/next) doesn't
// need the same treatment: it only ever returns one of these while its status IS
// still needs_review, so the object's own (never-mutated) `status`/`finalValue`
// literals already agree with reality at the one moment they're actually read.
function liveItem(item, status, finalValue) {
  return { ...item, status, finalValue };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('error', reject);
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        // A rejection here propagates up through handleApi's await into the
        // server's own request-handler try/catch below, which turns it into a 400
        // instead of an uncaught SyntaxError. Node's `req.on('end', ...)` callback
        // has no caller to catch a thrown error — an uncaught throw there used to
        // crash this whole shared demo process for every concurrent visitor, not
        // just fail the one malformed request.
        reject(new Error('invalid_json'));
      }
    });
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
  // Boundary-checked, not just a string prefix check — `resolved.startsWith(STATIC_DIR)`
  // alone would also match a sibling directory whose name happens to start with the
  // same string (e.g. a future "dist-backup" next to "dist").
  const withinStaticDir = resolved === STATIC_DIR || resolved.startsWith(STATIC_DIR + path.sep);
  const target = withinStaticDir && existsSync(resolved) && !rel.endsWith('/')
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
  const reviewDocumentMatch = apiPath.match(/^\/review\/documents\/([^/]+)$/);
  if (req.method === 'GET' && reviewDocumentMatch) {
    const id = reviewDocumentMatch[1];
    if (archivedDocumentIds.has(id)) return sendJson(res, 404, { error: 'document_not_found' });
    if (id === itemA.documentId) {
      // Mirrors getReviewItemForDocument: prefer whichever of itemA/itemB is still
      // needs_review; itemA wins when both are (lower confidence, 0.62 vs 0.78,
      // same asc(confidence) tie-break as the real backend), and itemA also wins
      // the fully-resolved fallback (it's the schema-order-first field -- vendor_name
      // before due_date). itemB only wins the one remaining case: it's still
      // needs_review while itemA is already resolved.
      const showB = itemBStatus === 'needs_review' && itemAStatus !== 'needs_review';
      const item = showB ? liveItem(itemB, itemBStatus, itemBFinal) : liveItem(itemA, itemAStatus, itemAFinal);
      return sendJson(res, 200, { item });
    }
    if (id === itemC.documentId) return sendJson(res, 200, { item: itemC });
    if (id === itemD.documentId) return sendJson(res, 200, { item: liveItem(itemD, itemDStatus, itemDFinal) });
    return sendJson(res, 404, { error: 'document_not_found' });
  }
  // Mirrors getReviewItemForField: a direct id lookup (no candidate selection, no
  // tie-break), unlike /review/documents/:id above -- powers the batch dropdown's
  // per-field rows and the in-place Undo button's post-undo refresh. The owning
  // document's archived state is checked FIRST (matching the real route's
  // document_not_found-takes-precedence shape), so an archived document's field ids
  // 404 document_not_found even though the field id itself is still "known".
  const reviewFieldMatch = apiPath.match(/^\/review\/fields\/([^/]+)$/);
  if (req.method === 'GET' && reviewFieldMatch) {
    const id = reviewFieldMatch[1];
    const owningDocumentId =
      id === itemA.fieldValueId || id === itemB.fieldValueId
        ? itemA.documentId
        : id === itemC.fieldValueId
          ? itemC.documentId
          : id === itemD.fieldValueId
            ? itemD.documentId
            : null;
    if (owningDocumentId === null) return sendJson(res, 404, { error: 'field_not_found' });
    if (archivedDocumentIds.has(owningDocumentId)) return sendJson(res, 404, { error: 'document_not_found' });
    if (id === itemA.fieldValueId) return sendJson(res, 200, { item: liveItem(itemA, itemAStatus, itemAFinal) });
    if (id === itemB.fieldValueId) return sendJson(res, 200, { item: liveItem(itemB, itemBStatus, itemBFinal) });
    if (id === itemC.fieldValueId) return sendJson(res, 200, { item: itemC });
    return sendJson(res, 200, { item: liveItem(itemD, itemDStatus, itemDFinal) });
  }
  if (req.method === 'GET' && apiPath === '/review/stats') {
    return sendJson(res, 200, computeStats());
  }
  const batchMatch = apiPath.match(/^\/batches\/([^/]+)$/);
  if (req.method === 'GET' && batchMatch) {
    return sendJson(res, 200, { id: batchMatch[1], name: 'Demo batch', status: 'open', documents: batchDocuments() });
  }
  if (req.method === 'POST' && apiPath === '/demo/reset') {
    resetState();
    return sendJson(res, 200, { reset: true });
  }

  const fieldAcceptMatch = apiPath.match(/^\/review\/fields\/([^/]+)\/accept$/);
  if (req.method === 'POST' && fieldAcceptMatch) {
    const id = fieldAcceptMatch[1];
    // finalValue = the field's own (unedited) normalizedValue on accept, matching
    // review/actions.ts's acceptField: `finalValue: field.normalizedValue`.
    if (id === itemA.fieldValueId) { itemAStatus = 'confirmed'; itemAFinal = itemA.normalizedValue; }
    else if (id === itemB.fieldValueId) { itemBStatus = 'confirmed'; itemBFinal = itemB.normalizedValue; }
    else if (id === itemD.fieldValueId) { itemDStatus = 'confirmed'; itemDFinal = itemD.normalizedValue; }
    return sendJson(res, 200, { id, status: 'confirmed' });
  }

  const fieldCorrectMatch = apiPath.match(/^\/review\/fields\/([^/]+)\/correct$/);
  if (req.method === 'POST' && fieldCorrectMatch) {
    const id = fieldCorrectMatch[1];
    const body = await readBody(req);
    // finalValue = the reviewer's typed newValue, matching correctField's
    // `finalValue: newValue` -- previously the body was read (to drain the request
    // and reject invalid JSON) but silently discarded, so a correction was never
    // actually retrievable anywhere past this response.
    if (id === itemA.fieldValueId) { itemAStatus = 'corrected'; itemAFinal = body.newValue; }
    else if (id === itemB.fieldValueId) { itemBStatus = 'corrected'; itemBFinal = body.newValue; }
    else if (id === itemD.fieldValueId) { itemDStatus = 'corrected'; itemDFinal = body.newValue; }
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
    // finalValue cleared back to null, matching undoField's `finalValue: null`.
    if (id === itemA.fieldValueId) { itemAStatus = 'needs_review'; itemAFinal = null; }
    else if (id === itemB.fieldValueId) { itemBStatus = 'needs_review'; itemBFinal = null; }
    else if (id === itemD.fieldValueId) { itemDStatus = 'needs_review'; itemDFinal = null; }
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
  // No error boundary at all here used to mean ANY handler throwing (readBody's
  // JSON.parse being the concrete case, but not the only possible one) surfaced as
  // an unhandled rejection in this async callback — Node treats that as fatal by
  // default and crashes the whole shared process, taking down the demo for every
  // other concurrent visitor along with the one request that actually misbehaved.
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url.pathname.slice(4));
    }
    if (url.pathname === '/healthz') {
      return sendJson(res, 200, { status: 'ok' });
    }
    return await serveStatic(req, res);
  } catch (err) {
    console.error('request handler error:', err);
    if (res.headersSent) return;
    if (err instanceof Error && err.message === 'invalid_json') {
      return sendJson(res, 400, { error: 'invalid_json' });
    }
    return sendJson(res, 500, { error: 'internal_error' });
  }
});

server.listen(PORT, () => console.log(`live demo server on http://localhost:${PORT}`));
