import { prisma } from "./prisma";
import { computeStandings } from "./standings";
import {
  pickBracketSize,
  playoffFirstRound,
  nextRoundPairings,
  matchNightForWeek,
} from "./schedule";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "./constants";
import { championMessage, sendDiscordMessage } from "./discord";

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

  await prisma.$transaction([
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
        scheduledAt: season.firstMatchNight
          ? matchNightForWeek(season.firstMatchNight, lastRegularWeek + 1)
          : null,
      })),
    }),
    prisma.season.update({
      where: { id: seasonId },
      data: { status: SEASON_STATUS.PLAYOFFS, championTeamId: null },
    }),
  ]);
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
    // The final is decided — crown the champion.
    await prisma.season.update({
      where: { id: seasonId },
      data: {
        championTeamId: current[0].winnerTeamId,
        status: SEASON_STATUS.COMPLETE,
      },
    });
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

  await prisma.match.createMany({
    data: pairings.map((p, i) => ({
      seasonId,
      week,
      phase,
      homeTeamId: p.home,
      awayTeamId: p.away,
      bracketSlot: `R${nextRound}M${i}`,
      bestOf,
      scheduledAt: season.firstMatchNight
        ? matchNightForWeek(season.firstMatchNight, week)
        : null,
    })),
  });
}
