// The Discord post for a break added or removed (season-break-service.ts),
// read and sent after the commit, best-effort: the change stands whatever
// Discord does. Pings only the standins booked on moved fixtures, whose
// booking quoted the old kickoff; everyone else reads the post and the
// season plan.

import { prisma } from "./prisma";
import { MATCH_PHASE, SEASON_STATUS } from "./constants";
import { isPlayoffPhase } from "./league-lifecycle";
import { roundLabelsForPost } from "./playoff-rounds";
import { projectPlayoffField } from "./playoff-field";
import { resolveSeasonFormat, seasonPlan, withBracket } from "./season-format";
import { seasonBreakMessage, sendDiscordMessage, type AdminRetimeMove } from "./discord";
import { mentionUsers } from "./discord-mentions";
import type { SeasonBreakOutcome } from "./season-break-service";

/**
 * Whether the change is worth a post: the season has started (before that,
 * the season-start post names the breaks) and the break skips a night.
 */
export function seasonBreakPostDue(
  outcome: SeasonBreakOutcome,
  seasonStatus: string,
  regularFixtures: number,
): boolean {
  return (
    outcome.night !== null &&
    regularFixtures > 0 &&
    (seasonStatus === SEASON_STATUS.REGULAR_SEASON || seasonStatus === SEASON_STATUS.PLAYOFFS)
  );
}

export async function announceSeasonBreak(outcome: SeasonBreakOutcome): Promise<boolean> {
  try {
    const [season, teams, matches] = await Promise.all([
      prisma.season.findUnique({ where: { id: outcome.seasonId } }),
      prisma.team.findMany({
        where: { seasonId: outcome.seasonId },
        select: { id: true, name: true, groupKey: true, withdrawn: true },
      }),
      prisma.match.findMany({
        where: { seasonId: outcome.seasonId },
        select: {
          id: true,
          seasonId: true,
          week: true,
          phase: true,
          status: true,
          bracketSlot: true,
          bestOf: true,
          homeTeamId: true,
          awayTeamId: true,
          homeScore: true,
          awayScore: true,
          winnerTeamId: true,
          forfeit: true,
          scheduledAt: true,
          standins: { select: { standinUserId: true } },
        },
      }),
    ]);
    if (!season || !outcome.night) return false;
    const regular = matches.filter((match) => match.phase === MATCH_PHASE.REGULAR);
    if (!seasonBreakPostDue(outcome, season.status, regular.length)) return false;
    const teamName = new Map(teams.map((team) => [team.id, team.name]));
    const byId = new Map(matches.map((match) => [match.id, match]));
    const touched = [...outcome.moved.map((m) => m.id), ...outcome.kept.map((k) => k.id)]
      .map((id) => byId.get(id))
      .filter((match) => match !== undefined);
    const labels = await roundLabelsForPost(touched);
    const move = (id: string): AdminRetimeMove | null => {
      const match = byId.get(id);
      if (!match) return null;
      return {
        matchId: match.id,
        homeName: teamName.get(match.homeTeamId) ?? "TBD",
        awayName: teamName.get(match.awayTeamId) ?? "TBD",
        week: match.week,
        isPlayoff: isPlayoffPhase(match.phase),
        isTiebreaker: match.phase === MATCH_PHASE.TIEBREAKER,
        whenMs: match.scheduledAt?.getTime() ?? null,
        roundLabel: labels.get(match.id) ?? null,
      };
    };
    const moves = outcome.moved.flatMap((m) => move(m.id) ?? []);
    const kept = outcome.kept.flatMap((k) => move(k.id) ?? []);

    // What is left of the season after the night, as /schedule's plan
    // prints it (a bracket withdrawals shrank included).
    const format = resolveSeasonFormat(season, teams, true);
    const field = projectPlayoffField(teams, matches, season);
    const plan = format
      ? seasonPlan(
          withBracket(format, field.bracketSize),
          season.firstMatchNight,
          Math.max(...regular.map((match) => match.week)),
          undefined,
          outcome.breaks,
        )
      : [];
    const nightMs = outcome.night.getTime();
    const after = plan.flatMap((step) => {
      if (step.kind === "BREAK" || !step.from || !step.to) return [];
      const fromMs = step.from.getTime();
      const toMs = step.to.getTime();
      if (toMs <= nightMs) return [];
      // A stretch the night falls inside (the regular season) is told by
      // its new last night.
      const label = step.kind === "TIEBREAKER" ? `${step.label} (if needed)` : step.label;
      return fromMs > nightMs
        ? [{ label, fromMs, toMs }]
        : [{ label: `${label} ends`, fromMs: toMs, toMs }];
    });
    const content = seasonBreakMessage({
      change: outcome.change,
      nightMs,
      moves,
      kept,
      clearedRsvps: outcome.rsvps,
      plan: after,
    });
    const mentions = await mentionUsers(
      outcome.moved.flatMap((m) => byId.get(m.id)?.standins.map((s) => s.standinUserId) ?? []),
    );
    return await sendDiscordMessage(content, mentions);
  } catch {
    return false;
  }
}
