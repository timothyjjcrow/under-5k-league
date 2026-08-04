import { Prisma } from "@prisma/client";
import { MATCH_STATUS } from "./constants";
import { predictionOpenWhere } from "./pickem";

const ON_POSTGRES = /^(postgres|postgresql):/.test(
  process.env.DATABASE_URL ?? "",
);

type Tx = Prisma.TransactionClient;

/** Prisma wraps raw-query serialization failures as P2010/SQLSTATE 40001. */
export function isSideGameTransactionConflict(error: unknown): boolean {
  const known = error as { code?: string; meta?: { code?: string } };
  return (
    known.code === "P2034" ||
    (known.code === "P2010" && known.meta?.code === "40001")
  );
}

/** Retry a fresh Serializable snapshot for ordinary deadline-burst conflicts. */
export async function retrySideGameTransaction<T>(
  run: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isSideGameTransactionConflict(error) || attempt === attempts - 1) {
        throw error;
      }
    }
  }
  throw lastError;
}

/**
 * Hold a shared lock on the exact Season snapshot that authorizes a side-game
 * write. PostgreSQL `FOR SHARE` lets every legitimate manager proceed together
 * but conflicts with import/phase/archive updates. SQLite has no shared row
 * lock syntax; its single-writer model uses the equivalent guarded no-op write.
 */
export async function claimSideGameSeason(
  tx: Tx,
  season: {
    id: string;
    status: string;
  },
  options: { fantasyUnlocked?: boolean } = {},
): Promise<boolean> {
  if (ON_POSTGRES) {
    const fantasyGuard = options.fantasyUnlocked
      ? Prisma.sql`AND "fantasyLockedAt" IS NULL`
      : Prisma.empty;
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id
      FROM "Season"
      WHERE id = ${season.id}
        AND "isActive" = TRUE
        AND status = ${season.status}
        ${fantasyGuard}
      FOR SHARE
    `);
    return rows.length === 1;
  }

  const claimed = await tx.season.updateMany({
    where: {
      id: season.id,
      isActive: true,
      status: season.status,
      ...(options.fantasyUnlocked ? { fantasyLockedAt: null } : {}),
    },
    data: { status: season.status },
  });
  return claimed.count === 1;
}

/** Shared lifecycle lock for the optional Draft row. */
export async function claimSideGameDraft(
  tx: Tx,
  draft: { id: string; status: string },
): Promise<boolean> {
  if (ON_POSTGRES) {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id
      FROM "Draft"
      WHERE id = ${draft.id}
        AND status = ${draft.status}
      FOR SHARE
    `);
    return rows.length === 1;
  }

  const claimed = await tx.draft.updateMany({
    where: {
      id: draft.id,
      status: draft.status,
    },
    data: { status: draft.status },
  });
  return claimed.count === 1;
}

/**
 * Hold a shared lock on a still-open fixture without overwriting a concurrent
 * reschedule. The deadline is evaluated at claim time, not at the earlier page
 * render or transaction read.
 */
export async function claimOpenPredictionMatch(
  tx: Tx,
  match: { id: string; seasonId: string; scheduledAt: Date | null },
  now = new Date(),
): Promise<boolean> {
  if (ON_POSTGRES) {
    const exactKickoff = match.scheduledAt
      ? Prisma.sql`"scheduledAt" = (${match.scheduledAt}::timestamptz AT TIME ZONE 'UTC')`
      : Prisma.sql`"scheduledAt" IS NULL`;
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id
      FROM "Match"
      WHERE id = ${match.id}
        AND "seasonId" = ${match.seasonId}
        AND status NOT IN (${MATCH_STATUS.LIVE}, ${MATCH_STATUS.COMPLETED})
        AND (${exactKickoff})
        AND (
          "scheduledAt" IS NULL
          OR "scheduledAt" > (${now}::timestamptz AT TIME ZONE 'UTC')
        )
      FOR SHARE
    `);
    return rows.length === 1;
  }

  const claimed = await tx.match.updateMany({
    where: {
      id: match.id,
      seasonId: match.seasonId,
      scheduledAt: match.scheduledAt,
      ...predictionOpenWhere(now),
    },
    // Match has no updatedAt/version column. Rewriting the exact kickoff is
    // SQLite's no-op claim; the matching WHERE prevents a stale overwrite.
    data: { scheduledAt: match.scheduledAt },
  });
  return claimed.count === 1;
}
