// node-postgres throws plain Error objects carrying the server's five-char
// SQLSTATE on `.code` for errors that originate in Postgres itself. Drizzle
// (as of the version bump in Phase 6 — see PROGRESS.md) wraps that in a
// DrizzleQueryError and puts the original pg error on `.cause` instead of
// re-throwing it directly, so `.code` has to be looked for anywhere in the
// cause chain, not just on the outermost error.
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

function pgCode(err: unknown): string | undefined {
  let current: unknown = err;
  while (current instanceof Error) {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = current.cause;
  }
  return undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === PG_UNIQUE_VIOLATION;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return pgCode(err) === PG_FOREIGN_KEY_VIOLATION;
}
