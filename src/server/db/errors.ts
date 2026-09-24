/** Postgres unique_violation (23505), unwrapping Drizzle's query error wrapper. */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 4; depth++) {
    if (typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "23505") {
      return true;
    }
    e = typeof e === "object" && "cause" in e ? (e as { cause?: unknown }).cause : undefined;
  }
  return false;
}
