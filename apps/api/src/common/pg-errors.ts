const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

function pgCode(error: unknown): string | undefined {
  // Drizzle wraps driver errors in DrizzleQueryError; the pg error is its `cause`.
  for (let current = error, depth = 0; current && depth < 3; depth++) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return pgCode(error) === UNIQUE_VIOLATION;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return pgCode(error) === FOREIGN_KEY_VIOLATION;
}
