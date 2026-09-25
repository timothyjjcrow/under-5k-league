import { Prisma } from "@prisma/client";
import type { OpenDotaMatch, OpenDotaPlayer } from "./dota";
import { prisma } from "./prisma";

export const IMPORT_CANDIDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const IMPORT_CANDIDATE_MAX_ATTEMPTS = 8;
export const IMPORT_COMMIT_RESERVE_MS = 5_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const CLEANUP_BATCH = 100;

export function hasFinalImportDetails(
  match: OpenDotaMatch,
  expectedMatchId: number,
): boolean {
  return (
    match?.match_id === expectedMatchId &&
    Number.isFinite(match.start_time) && match.start_time > 0 &&
    Number.isFinite(match.duration) && match.duration > 0 &&
    typeof match.radiant_win === "boolean" &&
    Array.isArray(match.players) && match.players.length === 10
  );
}

/** Retain only evidence already used by classification and the public boxscore. */
export function serializeImportEvidence(match: OpenDotaMatch): string {
  const players: OpenDotaPlayer[] = match.players.map((p) => ({
    account_id: p.account_id,
    player_slot: p.player_slot,
    hero_id: p.hero_id,
    isRadiant: p.isRadiant,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    personaname: typeof p.personaname === "string" ? p.personaname.slice(0, 128) : null,
    net_worth: p.net_worth,
    last_hits: p.last_hits,
    gold_per_min: p.gold_per_min,
    xp_per_min: p.xp_per_min,
    denies: p.denies,
    level: p.level,
    hero_damage: p.hero_damage,
    tower_damage: p.tower_damage,
    hero_healing: p.hero_healing,
    benchmarks: p.benchmarks && typeof p.benchmarks === "object"
      ? Object.fromEntries(Object.entries(p.benchmarks).slice(0, 20).map(([key, value]) => [
          key.slice(0, 80),
          { raw: typeof value?.raw === "number" ? value.raw : null,
            pct: typeof value?.pct === "number" ? value.pct : null },
        ]))
      : null,
  }));
  const payload = JSON.stringify({
    match_id: match.match_id,
    radiant_win: match.radiant_win,
    duration: match.duration,
    start_time: match.start_time,
    radiant_score: match.radiant_score,
    dire_score: match.dire_score,
    leagueid: match.leagueid,
    players,
  } satisfies OpenDotaMatch);
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Import evidence exceeds the bounded payload limit");
  }
  return payload;
}

export function readImportEvidence(payload: string | null, id: string): OpenDotaMatch | null {
  if (!payload || Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) return null;
  try {
    const parsed = JSON.parse(payload) as OpenDotaMatch;
    return hasFinalImportDetails(parsed, Number(id)) ? parsed : null;
  } catch {
    return null;
  }
}

export async function expireImportCandidates(now = new Date()) {
  const expired = await prisma.importCandidate.findMany({
    where: { expiresAt: { lte: now } },
    orderBy: { expiresAt: "asc" },
    take: CLEANUP_BATCH,
    select: { id: true },
  });
  if (expired.length) {
    // Recheck expiry so a concurrent successful refresh cannot be deleted.
    await prisma.importCandidate.deleteMany({
      where: { id: { in: expired.map((row) => row.id) }, expiresAt: { lte: now } },
    });
  }
}

export async function loadImportCandidates(seasonId: string, ids: string[]) {
  return prisma.importCandidate.findMany({
    where: { seasonId, dotaMatchId: { in: ids }, expiresAt: { gt: new Date() } },
  });
}

export async function saveImportEvidence(
  seasonId: string,
  details: OpenDotaMatch,
  observed?: ImportCandidateSnapshot,
) {
  const now = new Date();
  const dotaMatchId = String(details.match_id);
  const data = {
    payload: serializeImportEvidence(details),
    status: "READY",
    reason: null,
    attempts: 0,
    fetchedAt: now,
    nextAttemptAt: null,
    expiresAt: new Date(now.getTime() + IMPORT_CANDIDATE_TTL_MS),
  };
  const key = { seasonId_dotaMatchId: { seasonId, dotaMatchId } };
  const existing = observed ?? await prisma.importCandidate.findUnique({ where: key });
  if (await prisma.importSuppression.findUnique({ where: key })) return null;
  let saved: ImportCandidateSnapshot | null;
  if (existing) {
    // A provider call may finish after an administrator ignored/retried it.
    // Never overwrite the newer decision using the old discovery snapshot.
    const changed = await prisma.importCandidate.updateMany({
      where: { id: existing.id, revision: existing.revision },
      data: { ...data, revision: { increment: 1 } },
    });
    if (changed.count !== 1) return null;
    saved = await prisma.importCandidate.findUnique({ where: key });
    if (saved?.revision !== existing.revision + 1) return null;
  } else {
    saved = await prisma.importCandidate.upsert({
      where: key,
      create: { seasonId, dotaMatchId, ...data },
      // A concurrent creator owns its snapshot; this fetch must not reset it.
      update: {},
    });
    if (saved.status !== "READY" || saved.payload !== data.payload) return null;
  }
  // Close late-fetch-after-import/removal gaps without extending a database
  // transaction over network IO. The competing mutation also clears/marks
  // candidate state in its own transaction.
  const [claim, suppression] = await Promise.all([
    prisma.dotaMatchClaim.findUnique({ where: { dotaMatchId }, select: { dotaMatchId: true } }),
    prisma.importSuppression.findUnique({ where: key, select: { id: true } }),
  ]);
  if (saved && claim) {
    await prisma.importCandidate.deleteMany({ where: { id: saved.id, revision: saved.revision } });
    return null;
  }
  if (saved && suppression) {
    await prisma.importCandidate.updateMany({
      where: { id: saved.id, revision: saved.revision },
      data: { status: "IGNORED", reason: "ADMIN_SUPPRESSED", payload: null, nextAttemptAt: null, revision: { increment: 1 } },
    });
    return null;
  }
  return saved;
}

/** Provider failure cannot replace payload evidence saved by a concurrent fetch. */
export async function recordImportFetchFailure(seasonId: string, dotaMatchId: string, reason: string) {
  // Provider IO is already finished. This short transaction orders retry
  // bookkeeping against Ignore/removal and a concurrent successful import.
  // Neither a stale failure nor exhausted transaction retries authorizes an
  // exclusion or resurrects work for an already assigned game.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        const key = { seasonId_dotaMatchId: { seasonId, dotaMatchId } };
        const [suppression, game, scrimGame, claim] = await Promise.all([
          tx.importSuppression.findUnique({ where: key, select: { id: true } }),
          tx.game.findUnique({ where: { dotaMatchId }, select: { id: true } }),
          tx.scrimGame.findUnique({ where: { dotaMatchId }, select: { id: true } }),
          tx.dotaMatchClaim.findUnique({ where: { dotaMatchId }, select: { dotaMatchId: true } }),
        ]);
        if (game || scrimGame || claim) {
          await tx.importCandidate.deleteMany({ where: { seasonId, dotaMatchId } });
          return;
        }
        if (suppression) return;
        const row = await tx.importCandidate.upsert({
          where: key,
          create: { seasonId, dotaMatchId, status: "PENDING", expiresAt: new Date(now.getTime() + IMPORT_CANDIDATE_TTL_MS) },
          update: {},
        });
        if (readImportEvidence(row.payload, dotaMatchId) && row.expiresAt > now) return;
        const attempts = Math.min(IMPORT_CANDIDATE_MAX_ATTEMPTS, row.attempts + 1);
        const review = attempts >= IMPORT_CANDIDATE_MAX_ATTEMPTS;
        await tx.importCandidate.updateMany({
          where: { id: row.id, revision: row.revision },
          data: {
            payload: null,
            revision: { increment: 1 },
            status: review ? "NEEDS_REVIEW" : "RETRYABLE",
            reason,
            attempts,
            nextAttemptAt: review ? null : new Date(now.getTime() + (attempts === 1 ? 0 : Math.min(30 * 60_000, 30_000 * 2 ** (attempts - 2)))),
            expiresAt: new Date(now.getTime() + IMPORT_CANDIDATE_TTL_MS),
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return;
    } catch (error) {
      if (!["P2034", "P2002"].includes((error as { code?: string }).code ?? "")) throw error;
      // A contended bookkeeping update can safely wait for the next pass.
      // Never turn this transient failure into an import suppression.
    }
  }
}

export type ImportCandidateSnapshot = Awaited<ReturnType<typeof loadImportCandidates>>[number];

export async function recordImportDecision(
  snapshot: ImportCandidateSnapshot | undefined,
  reason: string,
  retryable = false,
) {
  if (!snapshot) return;
  await prisma.importCandidate.updateMany({
    where: { id: snapshot.id, revision: snapshot.revision },
    data: {
      revision: { increment: 1 },
      status: retryable ? "RETRYABLE" : "IGNORED",
      reason,
      nextAttemptAt: new Date(Date.now() + (retryable ? 5_000 : 60 * 60_000)),
    },
  });
}

type SuppressionDb = Pick<Prisma.TransactionClient, "importSuppression" | "importCandidate" | "setting">;
const legacyImportSkipKey = (seasonId: string) => `importSkip:${seasonId}`;

export async function loadImportSuppressions(seasonId: string, db: SuppressionDb = prisma): Promise<Set<string>> {
  const [legacy, rows] = await Promise.all([
    db.setting.findUnique({ where: { key: legacyImportSkipKey(seasonId) }, select: { value: true } }),
    db.importSuppression.findMany({ where: { seasonId }, select: { dotaMatchId: true } }),
  ]);
  // A corrupt legacy value is an operational error, never permission to undo
  // an administrator's correction. Reads and database errors fail closed.
  const parsed: unknown = JSON.parse(legacy?.value ?? "[]");
  if (!Array.isArray(parsed)) throw new Error("Invalid legacy import suppression memory");
  return new Set([...parsed.map(String), ...rows.map((row) => row.dotaMatchId)]);
}

export async function rememberImportSuppression(
  seasonId: string,
  dotaMatchId: string,
  db: SuppressionDb = prisma,
) {
  await db.importSuppression.upsert({
    where: { seasonId_dotaMatchId: { seasonId, dotaMatchId } },
    create: { seasonId, dotaMatchId, reason: "ADMIN_REMOVAL" },
    update: {},
  });
  await db.importCandidate.updateMany({
    where: { seasonId, dotaMatchId },
    data: { status: "IGNORED", reason: "ADMIN_SUPPRESSED", payload: null, nextAttemptAt: null, revision: { increment: 1 } },
  });
}
