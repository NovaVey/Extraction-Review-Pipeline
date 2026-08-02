import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { CheckCircle2, FileCheck2, RotateCcw } from 'lucide-react';
import {
  ApiError,
  acceptField,
  acceptRow,
  archiveDocument,
  correctField,
  correctRow,
  endReviewSessionBeacon,
  fetchNextReviewItem,
  fetchReviewQueueStats,
  startReviewSession,
  undoField,
  undoRow,
} from './api';
import { DocViewer } from './components/DocViewer/DocViewer';
import { QueueSidebar } from './components/QueueSidebar/QueueSidebar';
import { ReviewPane } from './components/ReviewPane/ReviewPane';
import type { ActionOutcome, ActionResult, ReviewItem, ReviewQueueStats } from './types';

const REVIEWER_STORAGE_KEY = 'reviewerName';

type QueueState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'loaded'; item: ReviewItem | null };

const UNDO_WINDOW_MS = 8000;

interface LastAction {
  kind: 'field' | 'row';
  id: string;
  label: string;
  deltaReviewed: number;
  deltaCorrected: number;
}

function App() {
  const [reviewerName, setReviewerName] = useState<string | null>(() => localStorage.getItem(REVIEWER_STORAGE_KEY));
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [itemsReviewed, setItemsReviewed] = useState(0);
  const [itemsCorrected, setItemsCorrected] = useState(0);
  const [queueState, setQueueState] = useState<QueueState>({ status: 'loading' });
  // True while a refetch is in flight after an already-resolved item — the two-pane
  // layout stays mounted and dimmed rather than getting torn down, so a fast
  // accept/correct doesn't visibly flash to a blank loading screen on every keystroke.
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [stats, setStats] = useState<ReviewQueueStats | null>(null);
  // Which fieldValueId was just accepted via the global "nothing focused" shortcut —
  // ReviewPane's own accept/correct handlers set their own local "Saved" state
  // directly, but that path is bypassed entirely when this global listener is what
  // fired, so without this the confirmation never shows for that (very common)
  // interaction. Explicitly cleared on every refetchQueue success (see below) rather
  // than left to "naturally" stop matching — an Undo can resurface this exact
  // fieldValueId, and without the explicit clear it would render as falsely "Saved".
  const [globallyAcceptedId, setGloballyAcceptedId] = useState<string | null>(null);
  // Guards the global shortcut against re-firing on a field that was *just*
  // resolved but hasn't been replaced by the next queue item yet (queueState.item
  // is never optimistically updated, so its .status still reads needs_review during
  // that window) — without this, disabling the input/buttons right after a save
  // returns focus to document.body, which is exactly the resting state this
  // shortcut treats as "accept the current field." Also set after a *row*-level
  // accept/correct, not just field-level ones: resolving one row of a table field
  // now disables (via `locked`) every other still-focused row control too, which
  // blurs to body the same way — without this a stray Enter right after finishing
  // one row would fire the global shortcut's handleAcceptField on the *whole*
  // table field, which bulk-resolves every remaining row from its last-saved cell
  // values, silently discarding an in-progress edit in another row's input.
  const justResolvedFieldValueIdRef = useRef<string | null>(null);
  const refetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the "change reviewer" confirmation dialog is open. A native
  // window.confirm() was tried first and rejected by adversarial review: Enter
  // both activates the "change" button *and* is bound to a native confirm
  // dialog's default "OK" action, so a key-repeat or double-tap Enter (exactly
  // what this app's own Enter-driven UX trains reviewers to do) opens and
  // immediately auto-accepts the dialog, silently wiping the session — the very
  // failure the confirmation was meant to prevent. A custom dialog whose default
  // focus is "Cancel" (see ConfirmChangeReviewerDialog) means a stray extra Enter
  // lands on the safe action instead.
  const [confirmingChangeReviewer, setConfirmingChangeReviewer] = useState(false);
  // The document targeted by the "remove this document" confirmation dialog, if
  // open — null means closed. Captured once, at request time (see
  // handleRequestRemoveDocument), not re-read from queueState when the dialog is
  // confirmed: the queue's own debounced refetch (runAction's 400ms timeout) can
  // fire and swap queueState.item out from under an open dialog, and re-reading it
  // at confirm-time would then archive whatever document happens to be showing at
  // that later moment instead of the one the reviewer actually clicked Remove on.
  const [removingDocument, setRemovingDocument] = useState<{ id: string; filename: string } | null>(null);
  // The most recent genuinely-resolved (non-noop) accept/correct, kept just long
  // enough to offer an Undo — cleared by its own timeout, by firing Undo, or by
  // changing reviewers (a stale toast shouldn't survive into a different session).
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const lastActionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped at the START of every accept/correct call (field or row), before awaiting
  // the network round trip. Two actions can genuinely be in flight at once (e.g. two
  // different rows accepted in quick succession) and resolve out of order — without
  // this, an earlier-started-but-slower call finishing LAST would silently overwrite
  // a newer action's already-armed Undo toast with itself, so clicking Undo would
  // revert the wrong thing. Each handler only arms the toast if its own captured
  // sequence number still matches the latest one when it resolves — i.e. only the
  // most recently *started* action ever gets to offer Undo.
  const actionSeqRef = useRef(0);

  const beginSession = useCallback((reviewer: string) => {
    setSessionError(null);
    startReviewSession(reviewer)
      .then((session) => setReviewSessionId(session.id))
      .catch(() => setSessionError('Could not start a review session.'));
  }, []);

  useEffect(() => {
    if (reviewerName && !reviewSessionId) beginSession(reviewerName);
  }, [reviewerName, reviewSessionId, beginSession]);

  useEffect(() => {
    function handlePageHide() {
      // sendBeacon is fire-and-forget by design — nothing to await on the way out.
      if (reviewSessionId) endReviewSessionBeacon(reviewSessionId);
    }
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, [reviewSessionId]);

  const refetchQueue = useCallback(() => {
    // Only blank the screen for a true first load (or after an error) — once
    // something is already showing, keep it on screen (marked "transitioning")
    // while the next item loads instead of unmounting the whole two-pane layout.
    setQueueState((prev) => {
      if (prev.status === 'loaded') {
        setIsTransitioning(true);
        return prev;
      }
      return { status: 'loading' };
    });
    fetchNextReviewItem()
      .then(({ item }) => {
        setQueueState({ status: 'loaded', item });
        setIsTransitioning(false);
        justResolvedFieldValueIdRef.current = null;
        // globallyAcceptedId is only meaningful for the item that was showing when it
        // was set — it stops mattering the instant the queue moves on to a genuinely
        // different item, since the render-time comparison against the new item's
        // fieldValueId naturally goes false. But an Undo can put the SAME fieldValueId
        // back into the queue (confidence-ordered, so a just-reverted item can resurface
        // immediately) — without clearing this here, that field would render as
        // falsely "Saved" and fully disabled (globallyAccepted feeds into ReviewPane's
        // busy flag) despite genuinely needing review again.
        setGloballyAcceptedId(null);
      })
      .catch(() => {
        setQueueState({ status: 'error', message: 'Could not reach the review queue.' });
        setIsTransitioning(false);
      });
  }, []);

  useEffect(() => {
    if (reviewSessionId) refetchQueue();
  }, [reviewSessionId, refetchQueue]);

  // Supplementary to the review flow itself — a failed stats fetch shouldn't block
  // or interrupt reviewing, so it's swallowed rather than surfaced as an ErrorState.
  const refetchStats = useCallback(() => {
    fetchReviewQueueStats()
      .then(setStats)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (reviewSessionId) refetchStats();
  }, [reviewSessionId, refetchStats]);

  const armLastAction = useCallback((action: LastAction) => {
    if (lastActionTimeoutRef.current !== null) clearTimeout(lastActionTimeoutRef.current);
    setLastAction(action);
    lastActionTimeoutRef.current = setTimeout(() => setLastAction(null), UNDO_WINDOW_MS);
  }, []);

  // Shared by every accept/correct control: bump the right local counters and
  // let the next /review/next call naturally advance the queue, rather than
  // guessing client-side what the next item should be. The short delay before
  // refetchQueue gives the caller (ReviewPane/RowTable) a brief window to show a
  // "Saved" confirmation on the still-fully-rendered item before it transitions.
  const runAction = useCallback(
    async (action: () => Promise<ActionResult>, delta: { reviewed: number; corrected: number }): Promise<ActionOutcome> => {
      try {
        await action();
        setItemsReviewed((n) => n + delta.reviewed);
        setItemsCorrected((n) => n + delta.corrected);
        refetchStats();
        if (refetchTimeoutRef.current !== null) clearTimeout(refetchTimeoutRef.current);
        refetchTimeoutRef.current = setTimeout(refetchQueue, 400);
        return { ok: true };
      } catch (err) {
        // Someone/something else already resolved this item (plausible on a
        // shared queue) — it's simply gone now, not a failure worth surfacing.
        // noop: true so callers know NOT to arm an Undo affordance for a mutation
        // that didn't actually happen through this call.
        if (err instanceof ApiError && err.status === 400 && err.code === 'not_needs_review') {
          refetchQueue();
          refetchStats();
          return { ok: true, noop: true };
        }
        return { ok: false, message: "That value didn't save — try again." };
      }
    },
    [refetchQueue, refetchStats],
  );

  const handleAcceptField = useCallback(
    (fieldValueId: string) => {
      if (!reviewerName || !reviewSessionId) return Promise.resolve<ActionOutcome>({ ok: false, message: 'Not ready yet.' });
      const label = queueState.status === 'loaded' ? (queueState.item?.label ?? queueState.item?.fieldKey) : undefined;
      // A table field's own Accept bulk-resolves every outstanding row underneath it
      // (see review/actions.ts's acceptField) — undoField only ever reverts the field
      // itself, not the rows it swept, so offering Undo here would silently under-
      // deliver on what it claims to do. Scalar fields (the common case) are unaffected.
      const isTableFieldAccept = queueState.status === 'loaded' && queueState.item?.fieldType === 'table';
      const mySeq = ++actionSeqRef.current;
      return runAction(() => acceptField(fieldValueId, reviewerName, reviewSessionId), { reviewed: 1, corrected: 0 }).then((outcome) => {
        if (outcome.ok) {
          justResolvedFieldValueIdRef.current = fieldValueId;
          if (!outcome.noop && !isTableFieldAccept && actionSeqRef.current === mySeq) {
            armLastAction({ kind: 'field', id: fieldValueId, label: label ?? 'field', deltaReviewed: 1, deltaCorrected: 0 });
          }
        }
        return outcome;
      });
    },
    [reviewerName, reviewSessionId, runAction, queueState, armLastAction],
  );

  const handleCorrectField = useCallback(
    (fieldValueId: string, newValue: string) => {
      if (!reviewerName || !reviewSessionId) return Promise.resolve<ActionOutcome>({ ok: false, message: 'Not ready yet.' });
      const label = queueState.status === 'loaded' ? (queueState.item?.label ?? queueState.item?.fieldKey) : undefined;
      const mySeq = ++actionSeqRef.current;
      return runAction(() => correctField(fieldValueId, reviewerName, newValue, reviewSessionId), { reviewed: 1, corrected: 1 }).then(
        (outcome) => {
          if (outcome.ok) {
            justResolvedFieldValueIdRef.current = fieldValueId;
            if (!outcome.noop && actionSeqRef.current === mySeq) {
              armLastAction({ kind: 'field', id: fieldValueId, label: label ?? 'field', deltaReviewed: 1, deltaCorrected: 1 });
            }
          }
          return outcome;
        },
      );
    },
    [reviewerName, reviewSessionId, runAction, queueState, armLastAction],
  );

  const handleAcceptRow = useCallback(
    (rowId: string) => {
      if (!reviewerName || !reviewSessionId) return Promise.resolve<ActionOutcome>({ ok: false, message: 'Not ready yet.' });
      // Same guard field-level actions set — a row resolving also disables (via
      // `locked`) every other still-focused row control, which blurs to body just
      // like a field-level save does, so the global shortcut needs the same
      // protection against re-firing on the parent field.
      const fieldValueId = queueState.status === 'loaded' ? (queueState.item?.fieldValueId ?? null) : null;
      const label = queueState.status === 'loaded' ? queueState.item?.label : undefined;
      const mySeq = ++actionSeqRef.current;
      return runAction(() => acceptRow(rowId, reviewerName, reviewSessionId), { reviewed: 1, corrected: 0 }).then((outcome) => {
        if (outcome.ok && fieldValueId) {
          justResolvedFieldValueIdRef.current = fieldValueId;
          if (!outcome.noop && actionSeqRef.current === mySeq) {
            armLastAction({ kind: 'row', id: rowId, label: `${label ?? 'field'} row`, deltaReviewed: 1, deltaCorrected: 0 });
          }
        }
        return outcome;
      });
    },
    [reviewerName, reviewSessionId, runAction, queueState, armLastAction],
  );

  const handleCorrectRow = useCallback(
    (rowId: string, columnKey: string, newValue: string) => {
      if (!reviewerName || !reviewSessionId) return Promise.resolve<ActionOutcome>({ ok: false, message: 'Not ready yet.' });
      const fieldValueId = queueState.status === 'loaded' ? (queueState.item?.fieldValueId ?? null) : null;
      const label = queueState.status === 'loaded' ? queueState.item?.label : undefined;
      const mySeq = ++actionSeqRef.current;
      return runAction(() => correctRow(rowId, reviewerName, columnKey, newValue, reviewSessionId), { reviewed: 1, corrected: 1 }).then(
        (outcome) => {
          if (outcome.ok && fieldValueId) {
            justResolvedFieldValueIdRef.current = fieldValueId;
            if (!outcome.noop && actionSeqRef.current === mySeq) {
              armLastAction({ kind: 'row', id: rowId, label: `${label ?? 'field'} row`, deltaReviewed: 1, deltaCorrected: 1 });
            }
          }
          return outcome;
        },
      );
    },
    [reviewerName, reviewSessionId, runAction, queueState, armLastAction],
  );

  // The one true global hotkey: nothing focused (the resting state if the value
  // input has been blurred, e.g. via Esc, or because it just got disabled after a
  // save) + Enter = accept the top-level field as-is. The common case goes through
  // the value input's own autofocused handler instead (see ReviewPane) — this is
  // the fallback path, not the primary one.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Enter') return;
      if (document.activeElement !== document.body) return;
      if (queueState.status !== 'loaded' || !queueState.item) return;
      if (queueState.item.status !== 'needs_review') return;
      // queueState.item is never optimistically updated, so its .status can still
      // read needs_review for a field that was *just* resolved a moment ago (the
      // disable-on-save that follows returns focus to document.body, which is
      // exactly this handler's trigger condition) — without this check a second
      // stray Enter re-fires accept on the same, already-resolved field.
      if (queueState.item.fieldValueId === justResolvedFieldValueIdRef.current) return;
      setGloballyAcceptedId(queueState.item.fieldValueId);
      void handleAcceptField(queueState.item.fieldValueId);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [queueState, handleAcceptField]);

  function handleStartReviewing(name: string) {
    localStorage.setItem(REVIEWER_STORAGE_KEY, name);
    setReviewerName(name);
  }

  // "change reviewer" is reachable via ordinary keyboard flow (it's first in tab
  // order, and several normal actions — a save disabling its own controls, Esc
  // resetting a field — return focus to document.body, one Tab away from here) —
  // a confirmation is the actual fix, not just autofocusing the value input
  // elsewhere, which only prevented one specific repro of the same underlying gap.
  function handleRequestChangeReviewer() {
    setConfirmingChangeReviewer(true);
  }

  function handleCancelChangeReviewer() {
    setConfirmingChangeReviewer(false);
  }

  function handleConfirmChangeReviewer() {
    setConfirmingChangeReviewer(false);
    if (refetchTimeoutRef.current !== null) {
      clearTimeout(refetchTimeoutRef.current);
      refetchTimeoutRef.current = null;
    }
    // A pending Undo toast refers to an action taken in the session that's about to
    // end — letting it survive into a new reviewer's session would offer to revert
    // someone else's work with no context.
    if (lastActionTimeoutRef.current !== null) {
      clearTimeout(lastActionTimeoutRef.current);
      lastActionTimeoutRef.current = null;
    }
    setLastAction(null);
    if (reviewSessionId) endReviewSessionBeacon(reviewSessionId);
    localStorage.removeItem(REVIEWER_STORAGE_KEY);
    setReviewerName(null);
    setReviewSessionId(null);
    setSessionError(null);
    setItemsReviewed(0);
    setItemsCorrected(0);
    setQueueState({ status: 'loading' });
  }

  async function handleUndo() {
    if (!lastAction || !reviewerName || !reviewSessionId) return;
    if (lastActionTimeoutRef.current !== null) {
      clearTimeout(lastActionTimeoutRef.current);
      lastActionTimeoutRef.current = null;
    }
    const action = lastAction;
    setLastAction(null);
    try {
      if (action.kind === 'field') await undoField(action.id, reviewerName, reviewSessionId);
      else await undoRow(action.id, reviewerName, reviewSessionId);
      setItemsReviewed((n) => Math.max(0, n - action.deltaReviewed));
      setItemsCorrected((n) => Math.max(0, n - action.deltaCorrected));
      refetchQueue();
      refetchStats();
    } catch {
      // Best-effort — if the undo call itself fails (network, or the item was
      // already touched again by something else in the meantime), there's nothing
      // coherent left to roll back to; the toast is already dismissed.
    }
  }

  function handleRequestRemoveDocument() {
    if (queueState.status !== 'loaded' || !queueState.item) return;
    setRemovingDocument({ id: queueState.item.documentId, filename: queueState.item.documentFilename });
  }

  function handleCancelRemoveDocument() {
    setRemovingDocument(null);
  }

  async function handleConfirmRemoveDocument() {
    if (!reviewerName || !removingDocument) return;
    const target = removingDocument;
    setRemovingDocument(null);
    try {
      await archiveDocument(target.id, reviewerName);
    } catch {
      // Best-effort — leaves the document in the queue; the reviewer can retry
      // from the same control since it's still showing.
      return;
    }
    if (refetchTimeoutRef.current !== null) {
      clearTimeout(refetchTimeoutRef.current);
      refetchTimeoutRef.current = null;
    }
    refetchQueue();
    refetchStats();
  }

  function handleRetry() {
    if (!reviewerName) return;
    if (!reviewSessionId) {
      beginSession(reviewerName);
      return;
    }
    refetchQueue();
  }

  if (!reviewerName) {
    return <ReviewerGate onSubmit={handleStartReviewing} />;
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#FCFCFD] text-[#101114]">
      <Header reviewerName={reviewerName} itemsReviewed={itemsReviewed} itemsCorrected={itemsCorrected} onChangeReviewer={handleRequestChangeReviewer} />
      <div className="flex min-h-0 flex-1">
        <QueueSidebar stats={stats} />
        <main className="min-h-0 flex-1 overflow-y-auto p-4">
          {sessionError && !reviewSessionId ? (
            <ErrorState message={sessionError} onRetry={handleRetry} />
          ) : queueState.status === 'loading' ? (
            <LoadingState />
          ) : queueState.status === 'error' ? (
            <ErrorState message={queueState.message} onRetry={handleRetry} />
          ) : queueState.item === null ? (
            <EmptyState itemsReviewed={itemsReviewed} itemsCorrected={itemsCorrected} />
          ) : (
            <div
              className={`grid h-full grid-cols-1 gap-4 transition-opacity duration-150 lg:grid-cols-2 ${isTransitioning ? 'pointer-events-none opacity-50' : ''}`}
            >
              <DocViewer
                key={`doc-${queueState.item.fieldValueId}`}
                pages={queueState.item.pages}
                locked={isTransitioning}
                onRemoveDocument={handleRequestRemoveDocument}
              />
              <ReviewPane
                key={`review-${queueState.item.fieldValueId}`}
                item={queueState.item}
                onAcceptField={handleAcceptField}
                onCorrectField={handleCorrectField}
                onAcceptRow={handleAcceptRow}
                onCorrectRow={handleCorrectRow}
                locked={isTransitioning}
                globallyAccepted={globallyAcceptedId === queueState.item.fieldValueId}
              />
            </div>
          )}
        </main>
      </div>
      {/* Suppressed while either confirm dialog is open — the dialog's own z-50
          overlay already fully covers the z-40 toast, so it'd be invisible and
          unclickable anyway; not rendering it is just honest about that rather than
          leaving something present-but-unreachable in the DOM. Its timer isn't
          paused (it keeps counting down underneath), same as before this change. */}
      {lastAction && !confirmingChangeReviewer && !removingDocument && <UndoToast label={lastAction.label} onUndo={() => void handleUndo()} />}
      {confirmingChangeReviewer && (
        <ConfirmDialog
          title="Change reviewer?"
          body="This will end your current review session."
          confirmLabel="Change reviewer"
          onConfirm={handleConfirmChangeReviewer}
          onCancel={handleCancelChangeReviewer}
        />
      )}
      {removingDocument && (
        <ConfirmDialog
          title="Remove this document?"
          body={`"${removingDocument.filename}" is excluded from the review queue, exports, and accuracy reports from then on. Nothing is deleted — its data and files stay intact. Any unsaved edit in the field you're currently looking at will be discarded.`}
          confirmLabel="Remove document"
          onConfirm={() => void handleConfirmRemoveDocument()}
          onCancel={handleCancelRemoveDocument}
        />
      )}
    </div>
  );
}

// A brief toast rather than an inline control — the item being undone has usually
// already scrolled out of view by the time a reviewer notices and clicks Undo (the
// queue advances to the next item within ~400ms of the original action), so this
// lives outside the transitioning two-pane layout and stays reachable regardless of
// what's currently on screen.
function UndoToast({ label, onUndo }: { label: string; onUndo: () => void }) {
  return (
    <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-[#101114] bg-[#101114] px-4 py-2.5 text-sm text-white shadow-lg">
      <span>Saved: {label}</span>
      <button type="button" onClick={onUndo} className="flex items-center gap-1 font-medium text-indigo-300 hover:text-white">
        <RotateCcw size={14} /> Undo
      </button>
    </div>
  );
}

// Default focus sits on Cancel, not the destructive action — a native
// window.confirm() binds Enter to "OK", so a key-repeat or double-tap Enter
// right after opening it (exactly what this app's own Enter-driven UX trains
// reviewers to do) would silently accept it. Landing an extra stray Enter on
// this dialog instead just re-clicks Cancel, which is safe. Shared by both
// destructive confirmations in this app (change reviewer, remove document) —
// only one is ever open at a time (enforced by the Tab trap below: with nothing
// left in the DOM reachable by keyboard while a dialog is open, there's no path
// left to trigger a second one), so a single static heading id is fine.
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Only two focusable elements ever live in this dialog, so trapping Tab is just
  // toggling between them — without this, Tab past the last button escapes to
  // whatever's still in the DOM underneath the (visually-covering-only) overlay,
  // e.g. the header's "change" reviewer link, which could then open a SECOND
  // dialog on top of this one via nothing but the keyboard.
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    event.preventDefault();
    (document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current)?.focus();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" onKeyDown={handleKeyDown}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" className="w-full max-w-sm rounded-xl border border-[#E5E7EB] bg-white p-5 shadow-lg">
        <p id="confirm-dialog-title" className="text-sm font-semibold text-[#101114]">
          {title}
        </p>
        <p className="mt-1 text-sm text-[#4B5563]">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            autoFocus
            className="rounded-md border border-[#D1D5DB] bg-white px-3 py-1.5 text-sm font-medium text-[#101114] hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="rounded-md border border-red-600 bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Logo({ size = 18 }: { size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-md bg-brand text-white" style={{ width: size + 10, height: size + 10 }}>
      <FileCheck2 size={size} strokeWidth={2.25} />
    </span>
  );
}

function Header({
  reviewerName,
  itemsReviewed,
  itemsCorrected,
  onChangeReviewer,
}: {
  reviewerName: string;
  itemsReviewed: number;
  itemsCorrected: number;
  onChangeReviewer: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E5E7EB] bg-white px-4 py-2">
      <div className="flex items-center gap-3">
        <Logo size={15} />
        <span className="text-sm font-semibold tracking-tight">Extraction Review</span>
        <span className="text-xs font-medium text-[#4B5563]">
          {itemsReviewed} reviewed, {itemsCorrected} corrected
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="hidden text-xs text-[#4B5563] sm:inline">Enter to accept · start typing to edit, Enter to save · Esc to reset</span>
        <span className="text-xs text-[#4B5563]">
          Reviewing as {reviewerName}{' '}
          <button type="button" onClick={onChangeReviewer} className="text-brand underline">
            change
          </button>
        </span>
      </div>
    </header>
  );
}

function ReviewerGate({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [name, setName] = useState('');

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length > 0) onSubmit(trimmed);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FCFCFD] text-[#101114]">
      <form onSubmit={handleSubmit} className="flex w-80 flex-col items-center gap-3 rounded-xl border border-[#E5E7EB] bg-white p-8 text-center shadow-sm">
        <Logo size={22} />
        <h1 className="text-xl font-semibold tracking-tight">Extraction Review</h1>
        <p className="text-sm text-[#4B5563]">Verify extracted invoice, receipt, and PO data before it hits your books.</p>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // Submitting this form also fires Enter on document (bubbling isn't
            // stopped by the form's preventDefault) — currently harmless only
            // because the global "nothing focused" shortcut's own queueState
            // guard can't be true yet at this point, which is an accident of
            // state ordering, not something this input should rely on.
            if (e.key === 'Enter') e.stopPropagation();
          }}
          placeholder="Your name"
          autoFocus
          className="mt-2 w-full rounded-md border border-[#D1D5DB] px-3 py-1.5 text-sm"
        />
        <button type="submit" className="w-full rounded-md border border-brand bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover">
          Start reviewing
        </button>
      </form>
    </div>
  );
}

function LoadingState() {
  const [showSpinner, setShowSpinner] = useState(false);

  useEffect(() => {
    // Avoids a flash of "Loading…" on fetches that resolve almost instantly.
    const timer = setTimeout(() => setShowSpinner(true), 200);
    return () => clearTimeout(timer);
  }, []);

  if (!showSpinner) return null;
  return (
    <div role="status" aria-live="polite" className="flex h-64 items-center justify-center text-sm text-[#4B5563]">
      Loading…
    </div>
  );
}

function EmptyState({ itemsReviewed, itemsCorrected }: { itemsReviewed: number; itemsCorrected: number }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-[#E5E7EB] bg-white px-10 py-8 shadow-sm">
        <CheckCircle2 className="text-green-600" size={40} strokeWidth={1.75} />
        <div>
          <p className="text-base font-semibold">All caught up</p>
          <p className="text-sm text-[#4B5563]">Nothing needs review right now.</p>
        </div>
        {itemsReviewed > 0 && (
          <p className="mt-1 text-xs text-[#4B5563]">
            This session: <span className="font-medium text-[#101114]">{itemsReviewed} reviewed</span>, {itemsCorrected} corrected.
          </p>
        )}
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex h-64 flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm text-red-600">{message}</p>
      <button type="button" onClick={onRetry} className="rounded-md border border-brand bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover">
        Retry
      </button>
    </div>
  );
}

export default App;
