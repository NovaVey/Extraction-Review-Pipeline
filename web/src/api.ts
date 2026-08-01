import type { ActionResult, ReviewItem, ReviewSession } from './types';

// Distinguishes a structured API error (status code + the route's `error` code,
// e.g. 'not_needs_review') from a network failure, so callers can react to
// specific codes (see App.tsx's handling of 400 not_needs_review) instead of
// string-matching a message.
export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, code?: string) {
    super(code ?? `Request failed with status ${status}`);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiError(0, 'network_error');
  }
  if (!res.ok) {
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string };
      code = body.error;
    } catch {
      // Error body wasn't JSON (or was empty) — status alone still tells the caller enough.
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

export function startReviewSession(reviewer: string): Promise<ReviewSession> {
  return request('/api/review-sessions', { method: 'POST', body: JSON.stringify({ reviewer }) });
}

// Fire-and-forget by design (pagehide is not a place to await anything) — a
// plain POST with an empty body, which the route accepts.
export function endReviewSessionBeacon(reviewSessionId: string): void {
  navigator.sendBeacon(`/api/review-sessions/${reviewSessionId}/end`, new Blob([], { type: 'application/json' }));
}

export function fetchNextReviewItem(): Promise<{ item: ReviewItem | null }> {
  return request('/api/review/next');
}

export function acceptField(fieldValueId: string, reviewer: string, reviewSessionId: string): Promise<ActionResult> {
  return request(`/api/review/fields/${fieldValueId}/accept`, {
    method: 'POST',
    body: JSON.stringify({ reviewer, reviewSessionId }),
  });
}

export function correctField(
  fieldValueId: string,
  reviewer: string,
  newValue: string,
  reviewSessionId: string,
): Promise<ActionResult> {
  return request(`/api/review/fields/${fieldValueId}/correct`, {
    method: 'POST',
    body: JSON.stringify({ reviewer, newValue, reviewSessionId }),
  });
}

export function acceptRow(rowId: string, reviewer: string, reviewSessionId: string): Promise<ActionResult> {
  return request(`/api/review/rows/${rowId}/accept`, {
    method: 'POST',
    body: JSON.stringify({ reviewer, reviewSessionId }),
  });
}

export function correctRow(
  rowId: string,
  reviewer: string,
  columnKey: string,
  newValue: string,
  reviewSessionId: string,
): Promise<ActionResult> {
  return request(`/api/review/rows/${rowId}/correct`, {
    method: 'POST',
    body: JSON.stringify({ reviewer, columnKey, newValue, reviewSessionId }),
  });
}
