export type PrismaLogLevel = "error" | "warn";

/**
 * Production errors are handled by application boundaries and platform
 * observability. Prisma's direct stdout logger can serialize query/schema
 * detail before those boundaries redact it, so it is development-only.
 */
export function prismaLogLevels(nodeEnv: string | undefined): PrismaLogLevel[] {
  return nodeEnv === "development" ? ["error", "warn"] : [];
}
