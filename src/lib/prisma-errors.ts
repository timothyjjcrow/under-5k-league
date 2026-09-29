/**
 * The Prisma error codes this app branches on, in one place.
 *
 * Every mutation that runs a Serializable transaction has to tell "the
 * database says retry" apart from a real failure, and every create-or-claim
 * has to tell "someone else already made this row" apart from a real failure.
 * Those checks used to be hand-written at each call site, and only a couple
 * of them knew that a RAW query (`$queryRaw`/`$executeRaw`) reports the same
 * serialization failure differently: Prisma wraps it as P2010 carrying the
 * Postgres SQLSTATE 40001 instead of raising P2034. A raw query added inside
 * any other transaction would then have surfaced its conflicts as a generic
 * error instead of "reload and try again".
 *
 * These are plain predicates: they never throw, whatever they are handed
 * (null, a string, a plain Error), so they are safe in any `catch`.
 */

type PrismaErrorShape = { code?: unknown; meta?: { code?: unknown } | null };

function codeOf(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (error as PrismaErrorShape).code;
}

/**
 * True for a transaction the database aborted to keep it serializable — the
 * loser of a write conflict or an SSI read/write cycle. The same request can
 * succeed against a fresh snapshot, so callers either retry or tell the user
 * to reload and try again.
 *
 * P2034 is Prisma's own code for it. A raw query reports it as P2010 with the
 * Postgres SQLSTATE 40001 (serialization_failure) in `meta.code`.
 */
export function isSerializationConflict(error: unknown): boolean {
  const code = codeOf(error);
  if (code === "P2034") return true;
  if (code !== "P2010") return false;
  const meta = (error as PrismaErrorShape).meta;
  return !!meta && typeof meta === "object" && meta.code === "40001";
}

/** True when a unique constraint refused the write (P2002): the row exists. */
export function isUniqueViolation(error: unknown): boolean {
  return codeOf(error) === "P2002";
}

/**
 * True when a write that requires an existing row found none (P2025) — for
 * example an `update`/`delete` by id after a rival already deleted the row.
 */
export function isRecordNotFound(error: unknown): boolean {
  return codeOf(error) === "P2025";
}
