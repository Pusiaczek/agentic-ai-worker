/** Postgres SQLSTATE `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * True if `err` is a unique violation of the given constraint or unique index. Drizzle wraps
 * driver errors in `DrizzleQueryError` with the original error in `cause`; both node-postgres and
 * PGlite errors expose `code` and `constraint`.
 */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pgError = err instanceof Error && err.cause !== undefined ? err.cause : err;
  return (
    typeof pgError === 'object' &&
    pgError !== null &&
    'code' in pgError &&
    pgError.code === UNIQUE_VIOLATION &&
    'constraint' in pgError &&
    pgError.constraint === constraint
  );
}
