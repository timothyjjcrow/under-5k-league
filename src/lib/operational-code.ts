const PRISMA_ERROR_CODE = /^P\d{4}$/;

/**
 * Prisma's documented machine identifiers are safe to retain in diagnostics.
 * Arbitrary library/provider codes are not: a secret-shaped string must not
 * become a log, database, or JSON disclosure channel merely because it is
 * uppercase.
 */
export function prismaErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && PRISMA_ERROR_CODE.test(code) ? code : null;
}
