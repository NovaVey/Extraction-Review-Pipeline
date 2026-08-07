// A field/row counts as "resolved" once a human decision (confirm/correct) or an
// auto-accept has settled it — i.e. it's no longer sitting in the review queue.
// 'needs_review' and 'pending' (the latter shouldn't occur post-Phase-4, but isn't
// assumed away) are not. Shared by export and eval so "what counts as resolved" is
// a single business rule, not two copies that can silently drift apart.
export const RESOLVED_STATUSES = new Set(['auto_accepted', 'confirmed', 'corrected']);
