import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

type DatabaseTimestamp = Date | string;

function timestampDate(value: DatabaseTimestamp | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value !== "string") return null;

  // PostgreSQL is decoded as Date by Prisma. SQLite returns UTC text without
  // an offset (`YYYY-MM-DD HH:mm:ss`), which JavaScript would otherwise parse
  // in the host's local timezone on some runtimes.
  const serialized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(
    value,
  )
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = new Date(serialized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Read the database's clock for comparisons against database-defaulted
 * timestamps. Using the application host's clock can make a freshly committed
 * outbox row look scheduled in the future when the two machines differ by
 * even a millisecond. Fail closed if the provider returns an unknown shape:
 * callers leave durable work pending and surface the database error.
 */
export async function databaseNow(): Promise<Date> {
  // PostgreSQL stores the outbox clocks as TIMESTAMP(3). Requesting its raw
  // microsecond clock and decoding it through JavaScript's millisecond Date
  // can truncate the comparison just below a freshly rounded availableAt.
  // Prisma materializes SQLite @default(now()) values with milliseconds even
  // though SQLite's CURRENT_TIMESTAMP keyword is whole-second; strftime keeps
  // the database clock at matching precision so a new row is immediately due.
  const query = (process.env.DATABASE_URL ?? "").startsWith("file:")
    ? Prisma.sql`SELECT STRFTIME('%Y-%m-%d %H:%M:%f', 'now') AS "now"`
    : Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS "now"`;
  const rows = await prisma.$queryRaw<Array<{ now: DatabaseTimestamp }>>(query);
  const now = timestampDate(rows[0]?.now);
  if (!now) throw new Error("Database returned an invalid current timestamp");
  return now;
}
