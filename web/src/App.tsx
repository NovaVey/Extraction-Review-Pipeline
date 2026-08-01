import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, acceptField, acceptRow, correctField, correctRow, endReviewSessionBeacon, fetchNextReviewItem, startReviewSession } from './api';
import { DocViewer } from './components/DocViewer/DocViewer';
import { ReviewPane } from './components/ReviewPane/ReviewPane';
import type { ActionOutcome, ActionResult, ReviewItem } from './types';

const REVIEWER_STORAGE_KEY = 'reviewerName';

type QueueState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'loaded'; item: ReviewItem | null };

function App() {
  const [reviewerName, setReviewerName] = useState<string | null>(() => localStorage.getItem(REVIEWER_STORAGE_KEY));
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [itemsReviewed, setItemsReviewed] = useState(0);
  const [itemsCorrected, setItemsCorrected] = useState(0);
  const [queueState, setQueueState] = useState<QueueState>({ status: 'loading' });

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
    setQueueState({ status: 'loading' });
    fetchNextReviewItem()
      .then(({ item }) => setQueueState({ status: 'loaded', item }))
      .catch(() => setQueueState({ status: 'error', message: 'Could not reach the review queue.' }));
  }, []);

  useEffect(() => {
    if (reviewSessionId) refetchQueue();
  }, [reviewSessionId, refetchQueue]);

  // Shared by every accept/correct control: bump the right local counters and
  // let the next /review/next call naturally advance the queue, rather than
  // guessing client-side what the next item should be.
  const runAction = useCallback(
    async (action: () => Promise<ActionResult>, delta: { reviewed: number; corrected: number }): Promise<ActionOutcome> => {
      try {
        await action();
        setItemsReviewed((n) => n + delta.reviewed);
        setItemsCorrected((n) => n + delta.corrected);
        refetchQueue();
        return { ok: true };
      } catch (err) {
        // Someone/something else already resolved this item (plausible on a
        // shared queue) — it's simply gone now, not a failure worth surfacing.
        if (err instanceof ApiError && err.status === 400 && err.code === 'not_needs_review') {
          refetchQueue();
          return { ok: true };
        }
        return { ok: false, message: "That value didn't save — try again." };
      }
    },
    [refetchQueue],
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

  // The one true global hotkey: nothing focused (the resting state right after
  // a new item loads) + Enter = accept the top-level field as-is. Deliberately
  // narrow — every input's own onKeyDown stops Enter from bubbling here, so a
  // keypress inside a field never double-fires this.
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
    <div className="flex min-h-screen flex-col bg-[#FCFCFD] text-[#101114]">
      <Header reviewerName={reviewerName} itemsReviewed={itemsReviewed} itemsCorrected={itemsCorrected} onChangeReviewer={handleChangeReviewer} />
      <main className="flex-1 p-4">
        {sessionError && !reviewSessionId ? (
          <ErrorState message={sessionError} onRetry={handleRetry} />
        ) : queueState.status === 'loading' ? (
          <LoadingState />
        ) : queueState.status === 'error' ? (
          <ErrorState message={queueState.message} onRetry={handleRetry} />
        ) : queueState.item === null ? (
          <EmptyState />
        ) : (
          <div className="grid h-[calc(100vh-6.5rem)] grid-cols-1 gap-4 lg:grid-cols-2">
            <DocViewer key={queueState.item.fieldValueId} pages={queueState.item.pages} />
            <ReviewPane
              key={queueState.item.fieldValueId}
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
        <span className="text-sm font-semibold">Extraction Review</span>
        <span className="text-xs text-[#6B7280]">
          {itemsReviewed} reviewed, {itemsCorrected} corrected
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="hidden text-xs text-[#6B7280] sm:inline">Enter to accept · Tab to edit a value, Enter to save · Esc to reset</span>
        <span className="text-xs text-[#6B7280]">
          Reviewing as {reviewerName}{' '}
          <button type="button" onClick={onChangeReviewer} className="text-[#101114] underline">
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
      <form onSubmit={handleSubmit} className="flex w-72 flex-col gap-3 rounded border border-[#E5E7EB] bg-white p-6 text-center">
        <h1 className="text-lg font-semibold">Extraction Review</h1>
        <p className="text-sm text-[#6B7280]">Enter your name to start reviewing.</p>
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
          className="rounded border border-[#E5E7EB] px-3 py-1.5 text-sm"
        />
        <button type="submit" className="rounded border border-[#101114] bg-[#101114] px-3 py-1.5 text-sm font-medium text-white">
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
  return <div className="flex h-64 items-center justify-center text-sm text-[#6B7280]">Loading…</div>;
}

function EmptyState() {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-1 text-center">
      <p className="text-base font-medium">All caught up</p>
      <p className="text-sm text-[#6B7280]">Nothing needs review right now.</p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm text-red-600">{message}</p>
      <button type="button" onClick={onRetry} className="rounded border border-[#101114] bg-[#101114] px-3 py-1.5 text-sm font-medium text-white">
        Retry
      </button>
    </div>
  );
}

export default App;
