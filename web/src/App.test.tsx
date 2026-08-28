import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type {
  ActionResult,
  BatchWithDocuments,
  ReviewItem,
  ReviewItemRow,
  ReviewQueueStats,
  ReviewSession,
} from './types';

// Regression coverage for the race-condition bugs documented in PROGRESS.md
// (Phase 12/13), all originally found by ad-hoc adversarial testing rather than an
// automated suite -- these lock in the fixes so none of them can quietly regress.
//
// The `./api` module (every network call App.tsx makes) is mocked below; `ApiError`
// is kept as the REAL class via importOriginal, since App.tsx does `instanceof`
// checks against it.
//
// App.tsx schedules real timers of its own (runAction's 400ms debounced refetch,
// UNDO_WINDOW_MS's 8s auto-dismiss) that this file deliberately never lets fire --
// every wait below is `flush()` (draining microtasks through a couple of zero-delay
// setTimeout boundaries, well short of either real delay) rather than testing-
// library's timer-based `waitFor`/`findBy*`, so a background timer can never race a
// test and consume a mock response meant for something else.

const mocks = vi.hoisted(() => ({
  startReviewSession: vi.fn(),
  fetchNextReviewItem: vi.fn(),
  fetchReviewItemForField: vi.fn(),
  fetchReviewQueueStats: vi.fn(),
  fetchBatch: vi.fn(),
  acceptField: vi.fn(),
  correctField: vi.fn(),
  acceptRow: vi.fn(),
  correctRow: vi.fn(),
  undoField: vi.fn(),
  undoRow: vi.fn(),
  archiveDocument: vi.fn(),
  endReviewSessionBeacon: vi.fn(),
}));

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    startReviewSession: mocks.startReviewSession,
    fetchNextReviewItem: mocks.fetchNextReviewItem,
    fetchReviewItemForField: mocks.fetchReviewItemForField,
    fetchReviewQueueStats: mocks.fetchReviewQueueStats,
    fetchBatch: mocks.fetchBatch,
    acceptField: mocks.acceptField,
    correctField: mocks.correctField,
    acceptRow: mocks.acceptRow,
    correctRow: mocks.correctRow,
    undoField: mocks.undoField,
    undoRow: mocks.undoRow,
    archiveDocument: mocks.archiveDocument,
    endReviewSessionBeacon: mocks.endReviewSessionBeacon,
  };
});

const { default: App } = await import('./App');

const STATS: ReviewQueueStats = { totalItems: 10, needsReview: 2, autoAccepted: 5, confirmed: 2, corrected: 1 };
const EMPTY_BATCH: BatchWithDocuments = { id: 'batch-1', name: 'Batch 1', status: 'open', documents: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Drains the microtask queue (promise .then chains -- fetch mocks resolving,
// runAction's own await, armLastAction, etc.) through a couple of zero-delay
// setTimeout boundaries, wrapped in act() so React processes every resulting state
// update and re-render. A handful of 0ms timers still fire long before App.tsx's
// real 400ms/8s timers could ever become eligible to.
async function flush() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function makeReviewItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    fieldValueId: 'fv-1',
    documentId: 'doc-1',
    documentFilename: 'invoice_clean_01.pdf',
    batchId: 'batch-1',
    fieldKey: 'vendor_name',
    fieldType: 'string',
    label: 'Vendor Name',
    description: '',
    rawValue: 'Acme Co',
    normalizedValue: 'Acme Co',
    finalValue: null,
    confidence: '0.5',
    confidenceParts: { sampleAgreement: 0.5, validatorStatus: 'valid', crossFieldChecks: [] },
    validatorStatus: 'valid',
    status: 'needs_review',
    rows: null,
    pages: [],
    ...overrides,
  };
}

function makeRow(overrides: Partial<ReviewItemRow> = {}): ReviewItemRow {
  return {
    id: 'row-1',
    rowIndex: 0,
    cells: { description: 'Widget', amount: '1.00' },
    finalCells: null,
    confidence: '0.5',
    confidenceParts: { sampleAgreement: 0.5, validatorStatus: 'valid', crossFieldChecks: [] },
    status: 'needs_review',
    columns: [
      { key: 'description', label: 'Description', type: 'string' },
      { key: 'amount', label: 'Amount', type: 'money' },
    ],
    ...overrides,
  };
}

function makeTableItem(rows: ReviewItemRow[], overrides: Partial<ReviewItem> = {}): ReviewItem {
  return makeReviewItem({ fieldKey: 'line_items', fieldType: 'table', label: 'Line Items', rows, ...overrides });
}

const SESSION: ReviewSession = { id: 'session-1', reviewer: 'alice', batchId: null, startedAt: new Date(0).toISOString() };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('reviewerName', 'alice');
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.startReviewSession.mockResolvedValue(SESSION);
  // Safety-net default (tests override the specific calls they care about with
  // mockResolvedValueOnce) -- never leaves a stray call resolving to `undefined`
  // (which would crash on `.then(...)`) if one ever slips through unaccounted for.
  mocks.fetchNextReviewItem.mockResolvedValue({ item: null });
  mocks.fetchReviewQueueStats.mockResolvedValue(STATS);
  mocks.fetchBatch.mockResolvedValue(EMPTY_BATCH);
  mocks.endReviewSessionBeacon.mockReturnValue(undefined);
});

// Renders <App/> and flushes through session start + the initial queue fetch.
async function renderApp() {
  render(<App />);
  await flush();
}

describe('App: actionSeqRef (Undo targets the most recently STARTED action)', () => {
  // Regression: two different rows accepted in quick succession can resolve out of
  // order. Before actionSeqRef, an earlier-started-but-slower-resolving call would
  // re-arm the Undo toast with itself after a later-started-but-faster call had
  // already armed it correctly -- so clicking Undo would revert the wrong row.
  it('keeps Undo pointed at the most recently started action, even when an earlier action resolves later', async () => {
    const row1 = makeRow({ id: 'row-1', rowIndex: 0 });
    const row2 = makeRow({ id: 'row-2', rowIndex: 1, cells: { description: 'Gadget', amount: '2.00' } });
    mocks.fetchNextReviewItem.mockResolvedValueOnce({ item: makeTableItem([row1, row2]) });

    await renderApp();
    expect(screen.getByText('Line Items')).toBeInTheDocument();

    const acceptButtons = screen.getAllByRole('button', { name: 'Accept row' });
    expect(acceptButtons).toHaveLength(2);

    const deferredRow1 = deferred<ActionResult>();
    const deferredRow2 = deferred<ActionResult>();
    mocks.acceptRow.mockImplementation((rowId: string) => (rowId === 'row-1' ? deferredRow1.promise : deferredRow2.promise));

    // row-1 starts first (seq 1)...
    fireEvent.click(acceptButtons[0]);
    // ...row-2 starts second (seq 2), while row-1 is still pending.
    fireEvent.click(acceptButtons[1]);

    // row-2 (started SECOND) resolves FIRST -- arms the toast correctly.
    deferredRow2.resolve({ id: 'row-2', status: 'confirmed' });
    await flush();
    expect(screen.getByText(/^Saved:/)).toBeInTheDocument();

    // row-1 (started FIRST) resolves LAST -- must NOT re-arm the toast with itself.
    deferredRow1.resolve({ id: 'row-1', status: 'confirmed' });
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    await flush();

    expect(mocks.undoRow).toHaveBeenCalledWith('row-2', 'alice', 'session-1');
    expect(mocks.undoRow).not.toHaveBeenCalledWith('row-1', expect.anything(), expect.anything());
  });
});

describe('App: globallyAcceptedId reset on refetch', () => {
  // Regression, two bugs guarded by the same scenario:
  // 1. globallyAcceptedId is set (optimistically) the instant the global "nothing
  //    focused + Enter" shortcut fires, so the "Saved" confirmation shows
  //    immediately. An Undo can put the SAME fieldValueId right back into the
  //    queue -- without clearing this on every successful refetch, that field
  //    would render as permanently, falsely "Saved" and disabled despite
  //    genuinely needing review again.
  // 2. Found writing THIS test, not in PROGRESS.md: applyFetchedItem used to call
  //    setIsTransitioning(true) from INSIDE a functional setQueueState(prev => ...)
  //    updater. React can defer invoking that updater until it actually needs the
  //    new state, which can land AFTER a fast-enough-resolving fetch's own
  //    .then(...) has already called setIsTransitioning(false) -- silently
  //    flipping it back to true with nothing left to ever undo it, permanently
  //    disabling the pane via ReviewPane's `locked` prop. Normal network latency
  //    hid this in practice (the render always beat a real round trip), but a
  //    same-tick-resolving mock here reproduces it every time. Fixed by reading a
  //    plain ref instead of nesting a setState call inside another one's updater.
  it('does not leave a field stuck showing "Saved" (or disabled) when Undo resurfaces the exact field the global shortcut just accepted', async () => {
    mocks.fetchNextReviewItem.mockResolvedValueOnce({
      item: makeReviewItem({ fieldValueId: 'fv-1', label: 'Vendor Name', status: 'needs_review' }),
    });

    await renderApp();
    expect(screen.getByText('Vendor Name')).toBeInTheDocument();

    // The value input autofocuses itself on load -- blur it to reach the global
    // shortcut's "nothing focused" resting state, the same way a disabled-after-save
    // input's browser-driven blur does in production.
    (document.activeElement as HTMLElement | null)?.blur();

    const deferredAccept = deferred<ActionResult>();
    mocks.acceptField.mockReturnValueOnce(deferredAccept.promise);

    fireEvent.keyDown(document, { key: 'Enter' });
    await flush();
    // globallyAcceptedId is set synchronously, before the network call resolves.
    expect(screen.getByRole('button', { name: /saved/i })).toBeInTheDocument();

    deferredAccept.resolve({ id: 'fv-1', status: 'confirmed' });
    await flush();
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();

    // Undo puts the identical fieldValueId back into the queue, genuinely
    // needs_review again.
    mocks.undoField.mockResolvedValueOnce({ id: 'fv-1', status: 'needs_review' });
    mocks.fetchNextReviewItem.mockResolvedValueOnce({
      item: makeReviewItem({ fieldValueId: 'fv-1', label: 'Vendor Name', status: 'needs_review' }),
    });

    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    await flush();

    expect(mocks.undoField).toHaveBeenCalledWith('fv-1', 'alice', 'session-1');

    // The resurfaced field must be genuinely interactive again, not stuck showing
    // the stale "Saved" state from the accept this exact field just went through.
    expect(screen.getByRole('textbox')).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /^saved$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
  });
});

describe('App: Cancel refocuses the value input', () => {
  // Regression: clicking Cancel used to leave focus wherever the browser's default
  // blur-on-disable behavior put it (document.body, the global shortcut's own
  // trigger condition) -- a stray habitual Enter right after Cancel would then
  // silently re-accept the just-reverted value via the blind global path, with no
  // visible confirmation of what was actually being accepted.
  it('leaves focus on the value input (not document.body) after Cancel, with the edit reverted', async () => {
    mocks.fetchNextReviewItem.mockResolvedValueOnce({
      item: makeReviewItem({ fieldValueId: 'fv-1', label: 'Vendor Name', normalizedValue: 'Acme Co', status: 'needs_review' }),
    });

    await renderApp();
    expect(screen.getByText('Vendor Name')).toBeInTheDocument();

    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Acme Corp Edited' } });
    expect(input.value).toBe('Acme Corp Edited');

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(input.value).toBe('Acme Co');
    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(document.body);

    // With focus correctly back on the input, a subsequent Enter goes through its
    // own visible accept path exactly once -- not the blind global fallback, which
    // only ever fires when nothing is focused.
    const deferredAccept = deferred<ActionResult>();
    mocks.acceptField.mockReturnValueOnce(deferredAccept.promise);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mocks.acceptField).toHaveBeenCalledWith('fv-1', 'alice', 'session-1');
    expect(mocks.acceptField).toHaveBeenCalledTimes(1);
  });
});

describe('App: Remove-document dialog captures its target at click time', () => {
  // Regression: removingDocument used to be re-read from queueState at CONFIRM
  // time rather than captured when Remove was clicked -- the queue's own debounced
  // refetch can swap the current document out from under a still-open dialog, and
  // re-reading at confirm-time would then archive whatever document happens to be
  // showing at that later moment instead of the one the reviewer actually clicked
  // Remove on.
  it('archives the document that was showing when Remove was clicked, even if the queue moves to a different document before Confirm', async () => {
    // At least one page, so DocViewer renders its toolbar (Remove button included)
    // instead of the "no page images" placeholder.
    const onePage = [{ id: 'page-1', pageNumber: 1, width: 100, height: 100 }];
    const itemA = makeReviewItem({
      fieldValueId: 'fv-A',
      documentId: 'doc-A',
      documentFilename: 'invoice_clean_01.pdf',
      label: 'Vendor Name',
      pages: onePage,
    });
    const itemB = makeReviewItem({
      fieldValueId: 'fv-B',
      documentId: 'doc-B',
      documentFilename: 'invoice_clean_04.pdf',
      fieldKey: 'invoice_number',
      label: 'Invoice Number',
      pages: onePage,
    });
    mocks.fetchNextReviewItem.mockResolvedValueOnce({ item: itemA });
    mocks.fetchBatch.mockResolvedValue({
      id: 'batch-1',
      name: 'Batch 1',
      status: 'open',
      documents: [
        {
          id: 'doc-A',
          filename: 'invoice_clean_01.pdf',
          status: 'processed',
          needsReview: true,
          displayName: null,
          fields: [{ fieldValueId: 'fv-A', fieldKey: 'vendor_name', label: 'Vendor Name', status: 'needs_review' }],
        },
        {
          id: 'doc-B',
          filename: 'invoice_clean_04.pdf',
          status: 'processed',
          needsReview: true,
          displayName: null,
          fields: [{ fieldValueId: 'fv-B', fieldKey: 'invoice_number', label: 'Invoice Number', status: 'needs_review' }],
        },
      ],
    } satisfies BatchWithDocuments);

    await renderApp();
    // The batch-documents sidebar fetch is a separate effect from the queue-item
    // one -- flush once more so it's settled before the sidebar is interacted with.
    await flush();
    expect(screen.getByText('Vendor Name')).toBeInTheDocument();

    // Click Remove on document A, the one currently showing.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(/Remove this document\?/)).toBeInTheDocument();
    expect(screen.getByText(/invoice_clean_01\.pdf/)).toBeInTheDocument();

    // While the dialog is still open, jump to a DIFFERENT document via the sidebar
    // -- simulating the queue swapping the current item out from under it.
    mocks.fetchReviewItemForField.mockResolvedValueOnce({ item: itemB });
    fireEvent.click(screen.getByText('Needs review'));
    const region = screen.getByRole('region', { name: 'Needs review fields in this batch' });
    fireEvent.click(within(region).getByText(/Invoice Number/));
    await flush();
    expect(screen.getByRole('heading', { name: 'Invoice Number' })).toBeInTheDocument();

    // The dialog is untouched by the item swap underneath it -- still open, still
    // naming document A.
    expect(screen.getByText(/Remove this document\?/)).toBeInTheDocument();
    expect(screen.getByText(/invoice_clean_01\.pdf/)).toBeInTheDocument();

    mocks.archiveDocument.mockResolvedValueOnce({ id: 'doc-A', status: 'archived' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove document' }));
    await flush();

    expect(mocks.archiveDocument).toHaveBeenCalledWith('doc-A', 'alice');
    expect(mocks.archiveDocument).not.toHaveBeenCalledWith('doc-B', expect.anything());
  });
});
