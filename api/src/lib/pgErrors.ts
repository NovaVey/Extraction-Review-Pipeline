// node-postgres throws plain Error objects carrying the server's five-char
// SQLSTATE on `.code` for errors that originate in Postgres itself.
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

function pgCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === PG_UNIQUE_VIOLATION;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return pgCode(err) === PG_FOREIGN_KEY_VIOLATION;
}
