import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, FileCheck2 } from 'lucide-react';
import {
  ApiError,
  acceptField,
  acceptRow,
  correctField,
  correctRow,
  endReviewSessionBeacon,
  fetchNextReviewItem,
  fetchReviewQueueStats,
  startReviewSession,
} from './api';
import { DocViewer } from './components/DocViewer/DocViewer';
import { QueueSidebar } from './components/QueueSidebar/QueueSidebar';
import { ReviewPane } from './components/ReviewPane/ReviewPane';
import type { ActionOutcome, ActionResult, ReviewItem, ReviewQueueStats } from './types';

const REVIEWER_STORAGE_KEY = 'reviewerName';

type QueueState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'loaded'; item: ReviewItem | null };

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
        setTimeout(refetchQueue, 400);
        return { ok: true };
      } catch (err) {
        // Someone/something else already resolved this item (plausible on a
        // shared queue) — it's simply gone now, not a failure worth surfacing.
        if (err instanceof ApiError && err.status === 400 && err.code === 'not_needs_review') {
          refetchQueue();
          refetchStats();
          return { ok: true };
        }
        return { ok: false, message: "That value didn't save — try again." };
      }
    },
    [refetchQueue, refetchStats],
  );

  const handleAcceptField = useCallback(
    (fieldValueId: string) => {
      if (!reviewerName || !reviewSessionId) return Promise.resolve<ActionOutcome>({ ok: false, message: 'Not ready yet.' });
      return runAction(() => acceptField(fieldValueId, reviewerName, reviewSessionId), { reviewed: 1, corrected: 0 });
    },
    [reviewerName, reviewSessionId, runAction],
  );

  const handleCorrectField = useCallback(
    (fieldValueId: string, newValue: string) => {
      if (!reviewerName || !reviewSessionId) return Promise.resolve<ActionOutcome>({ ok: false, message: 'Not ready yet.' });
      return runAction(() => correctField(fieldValueId, reviewerName, newValue, reviewSessionId), { reviewed: 1, corrected: 1 });
    },
    [reviewerName, reviewSessionId, runAction],
  );

  const handleAcceptRow = useCallback(
    (rowId: string) => {
      if (!reviewerName || !reviewSessionId) return Promise.resolve<ActionOutcome>({ ok: false, message: 'Not ready yet.' });
      return runAction(() => acceptRow(rowId, reviewerName, reviewSessionId), { reviewed: 1, corrected: 0 });
    },
    [reviewerName, reviewSessionId, runAction],
  );

  const handleCorrectRow = useCallback(
    (rowId: string, columnKey: string, newValue: string) => {
      if (!reviewerName || !reviewSessionId) return Promise.resolve<ActionOutcome>({ ok: false, message: 'Not ready yet.' });
      return runAction(() => correctRow(rowId, reviewerName, columnKey, newValue, reviewSessionId), { reviewed: 1, corrected: 1 });
    },
    [reviewerName, reviewSessionId, runAction],
  );

  // The one true global hotkey: nothing focused (the resting state if the value
  // input has been blurred, e.g. via Esc) + Enter = accept the top-level field as
  // -is. The common case goes through the value input's own autofocused handler
  // instead (see ReviewPane) — this is the fallback path, not the primary one.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Enter') return;
      if (document.activeElement !== document.body) return;
      if (queueState.status !== 'loaded' || !queueState.item) return;
      if (queueState.item.status !== 'needs_review') return;
      void handleAcceptField(queueState.item.fieldValueId);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [queueState, handleAcceptField]);

  function handleStartReviewing(name: string) {
    localStorage.setItem(REVIEWER_STORAGE_KEY, name);
    setReviewerName(name);
  }

  function handleChangeReviewer() {
    if (reviewSessionId) endReviewSessionBeacon(reviewSessionId);
    localStorage.removeItem(REVIEWER_STORAGE_KEY);
    setReviewerName(null);
    setReviewSessionId(null);
    setSessionError(null);
    setItemsReviewed(0);
    setItemsCorrected(0);
    setQueueState({ status: 'loading' });
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
      <Header reviewerName={reviewerName} itemsReviewed={itemsReviewed} itemsCorrected={itemsCorrected} onChangeReviewer={handleChangeReviewer} />
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
              <DocViewer key={`doc-${queueState.item.fieldValueId}`} pages={queueState.item.pages} />
              <ReviewPane
                key={`review-${queueState.item.fieldValueId}`}
                item={queueState.item}
                onAcceptField={handleAcceptField}
                onCorrectField={handleCorrectField}
                onAcceptRow={handleAcceptRow}
                onCorrectRow={handleCorrectRow}
              />
            </div>
          )}
        </main>
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
