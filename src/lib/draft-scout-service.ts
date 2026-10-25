import { REGISTRATION_STATUS, REGISTRATION_TYPE } from "./constants";
import type { AppearanceFacts } from "./appearance-careers";
import {
  buildDraftScoutInfo,
  type DraftScoutInfo,
} from "./draft-scout";
import { loadInhouseLadder } from "./inhouse-ladder";
import { buildPoolInhouseInfo } from "./player-pool";
import { loadPoolLastSeasons } from "./pool-history";
import { prisma } from "./prisma";
import { createShortLivedMemo } from "./short-lived-memo";

/** How long one process keeps a season's map. Nothing on it can move while
 *  the auction runs except an inhouse result or a typed about edit, which a
 *  draft-night card may show a minute late. */
export const DRAFT_SCOUT_TTL_MS = 60_000;

// One map per season, the same for every viewer (it holds only what /players
// shows any visitor: no contact, no account ids), so it reads no cookie,
// session or header. Module scope, one copy per process, which the
// per-instance cache rule allows. Concurrent misses share one load: Start
// refreshes every tab in the room within about 5s, and the box builds the map
// once per process for all of them.
const maps = createShortLivedMemo<DraftScoutInfo>({
  ttlMs: DRAFT_SCOUT_TTL_MS,
  maxEntries: 2,
});

/**
 * The draft room's scouting map for the season's ACTIVE PLAYER signups minus
 * its captains (who can never be nominated). Drafted players stay in: Undo
 * and a voided lot put them back in the pool without a status move that
 * would refresh the page. Built by the /draft page render, never the poll:
 * a cache miss is one registration read (display fields only), the inhouse
 * ladder's own memo, and the /players last-season read.
 *
 * Best-effort: a failed read logs a fixed event code (never the database
 * error, which can carry connection details) and returns null, and the room
 * then shows what it showed before scouting existed. `readFacts` is the test
 * seam for the career facts cache, which needs a Next request.
 */
export async function loadDraftScoutInfo(
  season: { id: string; createdAt: Date },
  options: { nowMs?: number; readFacts?: () => Promise<AppearanceFacts> } = {},
): Promise<DraftScoutInfo | null> {
  const nowMs = options.nowMs ?? Date.now();
  try {
    return await maps.get(season.id, nowMs, () =>
      readDraftScoutInfo(season, nowMs, options.readFacts),
    );
  } catch {
    console.error("[draft-scout] read unavailable");
    return null;
  }
}

async function readDraftScoutInfo(
  season: { id: string; createdAt: Date },
  nowMs: number,
  readFacts: (() => Promise<AppearanceFacts>) | undefined,
): Promise<DraftScoutInfo> {
  const registrations = await prisma.registration.findMany({
    where: {
      seasonId: season.id,
      status: REGISTRATION_STATUS.ACTIVE,
      type: REGISTRATION_TYPE.PLAYER,
      user: { captainedTeams: { none: { seasonId: season.id } } },
    },
    orderBy: [{ mmr: "desc" }, { userId: "asc" }],
    select: {
      userId: true,
      favoriteHeroes: true,
      captainNote: true,
      statement: true,
      user: { select: { pubStats: true, pubStatsAt: true } },
    },
  });
  const userIds = registrations.map((r) => r.userId);
  const [ladder, lastSeasons] = await Promise.all([
    loadInhouseLadder(nowMs),
    loadPoolLastSeasons(season, userIds, readFacts),
  ]);
  return buildDraftScoutInfo({
    registrations: registrations.map((r) => ({
      userId: r.userId,
      favoriteHeroes: r.favoriteHeroes,
      captainNote: r.captainNote,
      statement: r.statement,
      pubStats: r.user.pubStats,
      pubStatsAt: r.user.pubStatsAt,
    })),
    inhouse: buildPoolInhouseInfo(ladder, userIds),
    lastSeasons,
  });
}
