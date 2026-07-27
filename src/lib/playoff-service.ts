import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { computeStandings } from "./standings";
import {
  pickBracketSize,
  playoffFirstRound,
  nextRoundPairings,
  upcomingMatchNight,
} from "./schedule";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "./constants";
import { championMessage, sendDiscordMessage } from "./discord";

/**
 * Exactly-once marker for "round N of this season's bracket has been built".
 * Cleared by createPlayoffBracket so Reset playoffs can rebuild from scratch —
 * without that, a reset season could never advance past a round it had already
 * built once.
 */
const playoffRoundKey = (seasonId: string, round: number) =>
  `playoffRoundBuilt:${seasonId}:${round}`;

// Bracket slots are encoded as `R{round}M{match}` e.g. "R0M1".
function parseSlot(slot: string | null): { round: number; match: number } {
  if (!slot) return { round: 0, match: 0 };
  const m = slot.match(/^R(\d+)M(\d+)$/);
  return m ? { round: Number(m[1]), match: Number(m[2]) } : { round: 0, match: 0 };
}

/**
 * Seed the top teams by regular-season standings into a single-elimination
 * bracket and create the first round of playoff matches. Moves the season to
 * PLAYOFFS. Idempotent-ish: clears any prior bracket first.
 */
export async function createPlayoffBracket(seasonId: string) {
  const [season, teams, matches] = await Promise.all([
    prisma.season.findUnique({ where: { id: seasonId } }),
    prisma.team.findMany({ where: { seasonId } }),
    prisma.match.findMany({ where: { seasonId } }),
  ]);
  if (!season) throw new Error("No season");
  if (teams.length < 2) throw new Error("Need at least 2 teams for playoffs");

  const standings = computeStandings(
    teams.map((t) => t.id),
    matches,
  );
  const bracketSize = pickBracketSize(teams.length);
  const seeded = standings.slice(0, bracketSize).map((s) => s.teamId);
  const pairings = playoffFirstRound(seeded, bracketSize);
  const lastRegularWeek = matches
    .filter((m) => m.phase === MATCH_PHASE.REGULAR)
    .reduce((mx, m) => Math.max(mx, m.week), 0);
  const phase = pairings.length === 1 ? MATCH_PHASE.FINAL : MATCH_PHASE.PLAYOFF;
  const bestOf =
    phase === MATCH_PHASE.FINAL ? season.finalBestOf : season.playoffBestOf;

  // SERIALIZABLE, because this is a clear-and-reseed: under READ COMMITTED a
  // concurrent copy (an admin double-clicking "Start playoffs", or Start
  // racing Reset) cannot see the other's uncommitted deleteMany, so both
  // delete nothing of each other's and both insert a full first round —
  // a doubled bracket. Both copies unconditionally update the same Season row
  // below, so that write-write pair is what SSI aborts one of; the loser gets
  // P2034 and is caught as "someone else already built it".
  try {
    await prisma.$transaction([
    // Round markers are per-round exactly-once claims (see playoffRoundKey);
    // a reset must release them or the rebuilt bracket can never advance.
    prisma.setting.deleteMany({
      where: { key: { startsWith: `playoffRoundBuilt:${seasonId}:` } },
    }),
    prisma.match.deleteMany({
      where: {
        seasonId,
        phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
      },
    }),
    prisma.match.createMany({
      data: pairings.map((p, i) => ({
        seasonId,
        week: lastRegularWeek + 1,
        phase,
        homeTeamId: p.home,
        awayTeamId: p.away,
        bracketSlot: `R0M${i}`,
        bestOf,
        // Never stamp a kickoff that has already passed — it would put the
        // match outside its own auto-sync window before anyone plays it.
        scheduledAt: season.firstMatchNight
          ? upcomingMatchNight(
              season.firstMatchNight,
              lastRegularWeek + 1,
              Date.now(),
            )
          : null,
      })),
    }),
    prisma.season.update({
      where: { id: seasonId },
      data: { status: SEASON_STATUS.PLAYOFFS, championTeamId: null },
    }),
    ],
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    // Lost the serialization race — the other copy built the same bracket.
    if ((e as { code?: string }).code === "P2034") return;
    throw e;
  }
}

/**
 * After a playoff result is entered, advance the bracket: if the current
 * (latest) round is fully decided, either create the next round from its
 * winners or — if that round was the final — crown the champion and complete
 * the season. Safe to call after every result; no-ops until a round finishes.
 */
export async function advancePlayoffBracket(seasonId: string) {
  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season || season.status !== SEASON_STATUS.PLAYOFFS) return;

  const playoff = await prisma.match.findMany({
    where: { seasonId, phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] } },
  });
  if (playoff.length === 0) return;

  const maxRound = Math.max(...playoff.map((m) => parseSlot(m.bracketSlot).round));
  const current = playoff
    .filter((m) => parseSlot(m.bracketSlot).round === maxRound)
    .sort(
      (a, b) => parseSlot(a.bracketSlot).match - parseSlot(b.bracketSlot).match,
    );

  const allDecided = current.every(
    (m) => m.status === MATCH_STATUS.COMPLETED && m.winnerTeamId,
  );
  if (!allDecided) return;

  if (current.length === 1) {
    // The final is decided — crown the champion. Conditional write: a manual
    // recordResult racing an auto-import both reach here, and only the call
    // that actually flips PLAYOFFS→COMPLETE may announce (no double ping).
    const crowned = await prisma.season.updateMany({
      where: { id: seasonId, status: SEASON_STATUS.PLAYOFFS },
      data: {
        championTeamId: current[0].winnerTeamId,
        status: SEASON_STATUS.COMPLETE,
      },
    });
    if (crowned.count === 0) return;
    const champion = await prisma.team.findUnique({
      where: { id: current[0].winnerTeamId as string },
    });
    if (champion) {
      await sendDiscordMessage(championMessage(season.name, champion.name));
    }
    return;
  }

  const winners = current.map((m) => m.winnerTeamId as string);
  const pairings = nextRoundPairings(winners);
  const nextRound = maxRound + 1;
  const phase = pairings.length === 1 ? MATCH_PHASE.FINAL : MATCH_PHASE.PLAYOFF;
  const bestOf =
    phase === MATCH_PHASE.FINAL ? season.finalBestOf : season.playoffBestOf;
  const week = Math.max(...playoff.map((m) => m.week)) + 1;

  // Two imports can decide the round's last two series near-simultaneously —
  // both reach here with allDecided true.
  //
  // A findFirst-then-createMany inside a transaction does NOT make that safe,
  // whatever the old comment here claimed: a read matching ZERO rows takes no
  // predicate lock, so on Postgres READ COMMITTED each caller is blind to the
  // other's uncommitted insert and BOTH build the round. Nothing else stops
  // them — Match has no unique constraint on bracketSlot. The damage is worst
  // at the final: two R{n}M0 rows make `current.length === 2`, so the
  // `current.length === 1` crowning branch above becomes unreachable and the
  // season NEVER gets a champion.
  //
  // The fix is the atomic Setting-row CREATE this codebase already uses for
  // exactly-once work (`weekReminder:`, `honorsAnnounced:`, `resultAnnounced:`).
  // It lives in the SAME transaction as the createMany, so a failed insert
  // rolls the marker back too, and P2002 — the only way a second caller can
  // lose — is caught OUTSIDE the callback, because a query error poisons a
  // Postgres transaction and the commit would fail if we swallowed it inside.
  const exists = await prisma.match.findFirst({
    where: { seasonId, bracketSlot: { startsWith: `R${nextRound}M` } },
    select: { id: true },
  });
  if (exists) return; // cheap fast path; the claim below is the real guard
  try {
    await prisma.$transaction(async (tx) => {
      await tx.setting.create({
        data: {
          key: playoffRoundKey(seasonId, nextRound),
          value: new Date().toISOString(),
        },
      });
      await tx.match.createMany({
        data: pairings.map((p, i) => ({
          seasonId,
          week,
          phase,
          homeTeamId: p.home,
          awayTeamId: p.away,
          bracketSlot: `R${nextRound}M${i}`,
          bestOf,
          // Same guard as the first round: a round created after its arithmetic
          // date has passed must roll forward, not be born already stale.
          scheduledAt: season.firstMatchNight
            ? upcomingMatchNight(season.firstMatchNight, week, Date.now())
            : null,
        })),
      });
    });
  } catch (e) {
    // Someone else is building (or already built) this exact round.
    if ((e as { code?: string }).code === "P2002") return;
    throw e;
  }
}
