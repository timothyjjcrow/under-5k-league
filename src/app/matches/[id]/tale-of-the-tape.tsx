import Link from "next/link";
import { seedsFromFirstRound } from "@/lib/bracket-view";
import { isPlayoffPhase } from "@/lib/league-lifecycle";
import { projectPlayoffField } from "@/lib/playoff-field";
import { playoffRoad, playoffRoadTitle, type PlayoffRoadStep } from "@/lib/playoff-run";
import { prisma } from "@/lib/prisma";
import {
  ordinalPlace,
  taleOfTheTape,
  type TapeRow,
  type TapeValue,
} from "@/lib/tale-of-the-tape";
import { teamHueVar } from "@/lib/team-hues";
import { cn } from "@/lib/utils";
import { Card, CardHeader, TeamCrest } from "@/components/ui";
import type { MatchPageMatch } from "./load";

type SeasonTeam = {
  id: string;
  name: string;
  logoUrl: string | null;
  withdrawn: boolean;
};

type SeasonMatch = Parameters<typeof projectPlayoffField>[1][number] & {
  id: string;
  week: number;
  bracketSlot: string | null;
};

/**
 * Both teams' season side by side before kickoff, fight-night style: record
 * and place, games won, roster MMR and box-score averages, each with bars in
 * the team's own colour. A knockout series adds each side's road through the
 * bracket. Renders nothing until there are two numbers to compare, so week
 * one's preview goes straight to the rosters.
 */
export async function TaleOfTheTape({
  match,
  roundLabel,
  seasonMatches,
  teams,
  mmrs,
}: {
  match: MatchPageMatch;
  /** matchRoundLabel of this fixture ("Semifinal", "Grand final"). */
  roundLabel: string;
  /** The season's matches, from MatchPreview's one read. */
  seasonMatches: SeasonMatch[];
  teams: SeasonTeam[];
  /** Each roster's signup MMRs. */
  mmrs: { home: number[]; away: number[] };
}) {
  const sides = [match.homeTeamId, match.awayTeamId];
  // The two teams' games this season, sides and box scores. Direct, like
  // every read in the preview: a cached wrapper hung its Suspense stream.
  const games = await prisma.game.findMany({
    where: {
      match: { seasonId: match.seasonId },
      OR: [
        { radiantTeamId: { in: sides } },
        { direTeamId: { in: sides } },
      ],
    },
    select: {
      radiantTeamId: true,
      direTeamId: true,
      radiantWin: true,
      durationSecs: true,
      players: true,
    },
  });

  const postseason = isPlayoffPhase(match.phase);
  const standing = (teamId: string): string | null => {
    if (postseason) {
      const seed = seedsFromFirstRound(
        seasonMatches.filter((m) => isPlayoffPhase(m.phase)),
      ).get(teamId);
      return seed ? `Seed ${seed}` : null;
    }
    const played = seasonMatches.some(
      (m) => m.phase === "REGULAR" && m.status === "COMPLETED",
    );
    if (!played) return null;
    const table = projectPlayoffField(teams, seasonMatches).standings;
    const place = table.findIndex((row) => row.teamId === teamId);
    return place < 0 ? null : `${ordinalPlace(place + 1)} of ${table.length}`;
  };
  const rows = taleOfTheTape({
    homeTeamId: match.homeTeamId,
    awayTeamId: match.awayTeamId,
    matches: seasonMatches,
    games,
    mmrs,
    standing: {
      home: standing(match.homeTeamId),
      away: standing(match.awayTeamId),
    },
    postseason,
  });
  const road = postseason
    ? {
        home: playoffRoad(match.homeTeamId, match, seasonMatches),
        away: playoffRoad(match.awayTeamId, match, seasonMatches),
      }
    : null;
  const hasRoad = !!road && road.home.length + road.away.length > 0;
  if (rows.length < 2 && !hasRoad) return null;

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const home = {
    id: match.homeTeamId,
    name: match.homeTeam.name,
    logoUrl: match.homeTeam.logoUrl,
  };
  const away = {
    id: match.awayTeamId,
    name: match.awayTeam.name,
    logoUrl: match.awayTeam.logoUrl,
  };

  return (
    <Card id="match-tape" className="scroll-mt-24 overflow-hidden">
      <CardHeader
        title="Tale of the tape"
        headingLevel={2}
        subtitle={
          postseason
            ? "The season so far, playoffs included"
            : "The season so far, side by side"
        }
      />
      {rows.length >= 2 ? (
        <table className="mx-auto w-full max-w-3xl table-fixed border-collapse text-sm">
          <caption className="sr-only">
            {home.name} and {away.name} this season
          </caption>
          <colgroup>
            <col />
            <col className="w-[6.5rem] sm:w-36" />
            <col />
          </colgroup>
          <thead>
            <tr className="border-b border-line-soft">
              <th scope="col" className="px-3 py-2.5 text-left sm:px-4">
                <span className="flex min-w-0 items-center gap-2">
                  <TeamCrest
                    name={home.name}
                    seed={home.id}
                    logoUrl={home.logoUrl}
                    size={22}
                    className="rounded-md"
                  />
                  <span className="line-clamp-2 min-w-0 font-semibold leading-tight [overflow-wrap:anywhere]">
                    {home.name}
                  </span>
                </span>
              </th>
              <th scope="col" className="py-2.5">
                <span className="sr-only">Stat</span>
              </th>
              <th scope="col" className="px-3 py-2.5 text-right sm:px-4">
                <span className="flex min-w-0 flex-row-reverse items-center gap-2">
                  <TeamCrest
                    name={away.name}
                    seed={away.id}
                    logoUrl={away.logoUrl}
                    size={22}
                    className="rounded-md"
                  />
                  <span className="line-clamp-2 min-w-0 font-semibold leading-tight [overflow-wrap:anywhere]">
                    {away.name}
                  </span>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                className="border-b border-line-soft/60 last:border-0"
              >
                <TapeCell side="home" teamId={home.id} row={row} />
                <th
                  scope="row"
                  className="px-1 py-2 text-center text-[11px] font-medium uppercase leading-tight tracking-wider text-muted"
                >
                  {row.label}
                </th>
                <TapeCell side="away" teamId={away.id} row={row} />
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {road && hasRoad ? (
        <section
          aria-labelledby="match-road-title"
          className="border-t border-line-soft px-3 py-3 sm:px-4"
        >
          <h3
            id="match-road-title"
            className="mb-2.5 text-center text-[11px] font-semibold uppercase tracking-[0.2em] text-muted"
          >
            {playoffRoadTitle(roundLabel)}
          </h3>
          <div className="mx-auto grid max-w-3xl grid-cols-2 gap-3">
            <RoadColumn side="home" team={home} steps={road.home} teamById={teamById} />
            <RoadColumn side="away" team={away} steps={road.away} teamById={teamById} />
          </div>
        </section>
      ) : null}
    </Card>
  );
}

/**
 * One side's number, with the bar growing from the middle column outwards:
 * the home bar is anchored on its right, the away bar on its left.
 */
function TapeCell({
  side,
  teamId,
  row,
}: {
  side: "home" | "away";
  teamId: string;
  row: TapeRow;
}) {
  const value: TapeValue = row[side];
  const leads = row.edge === side;
  const trails = row.edge !== null && !leads;
  const bar = row.bars?.[side];
  return (
    <td
      className={cn(
        "px-3 py-2 align-top sm:px-4",
        side === "home" ? "text-left" : "text-right",
      )}
    >
      <span
        aria-hidden={value.spoken ? true : undefined}
        className={cn(
          "block font-display text-base leading-tight tabular-nums",
          leads ? "font-semibold text-fg" : trails ? "text-muted" : "text-fg",
        )}
      >
        {value.text}
      </span>
      {value.spoken ? <span className="sr-only">{value.spoken}</span> : null}
      {value.sub ? (
        <span className="block text-[11px] leading-snug text-muted">
          {value.sub}
        </span>
      ) : null}
      {bar != null ? (
        <span
          aria-hidden
          className={cn(
            "mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-line/50",
            side === "home" ? "justify-end" : "justify-start",
          )}
        >
          <span
            data-team-hue={teamId}
            className={cn("h-full rounded-full", trails && "opacity-45")}
            style={{
              width: `${Math.max(4, Math.round(bar * 100))}%`,
              backgroundColor: `hsl(${teamHueVar(teamId)} 70% 52%)`,
            }}
          />
        </span>
      ) : null}
    </td>
  );
}

/** One team's completed series before this round, each linking to its match. */
function RoadColumn({
  side,
  team,
  steps,
  teamById,
}: {
  side: "home" | "away";
  team: { id: string; name: string };
  steps: PlayoffRoadStep[];
  teamById: Map<string, SeasonTeam>;
}) {
  return (
    <ol
      aria-label={`${team.name}'s road`}
      className={cn("min-w-0 space-y-2", side === "away" && "text-right")}
    >
      {steps.length === 0 ? (
        <li className="py-1 text-xs text-muted">Straight into this round</li>
      ) : (
        steps.map((step) => {
          const opponent = teamById.get(step.opponentId);
          const opponentName = opponent?.name ?? "?";
          return (
            <li key={step.matchId} className="min-w-0">
              <Link
                href={`/matches/${step.matchId}`}
                className={cn(
                  "flex min-h-11 min-w-0 flex-col justify-center rounded-lg border border-line-soft bg-surface-2/40 px-2.5 py-1.5 transition-colors hover:border-info/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                  side === "away" && "items-end",
                )}
              >
                <span className="sr-only">
                  {step.round}: {step.wonSeries ? "beat" : "lost to"}{" "}
                  {opponentName} {step.won}–{step.lost}
                </span>
                <span
                  aria-hidden
                  className="text-[10px] uppercase tracking-wider text-muted"
                >
                  {step.round}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "flex min-w-0 max-w-full items-center gap-1.5 text-sm",
                    side === "away" && "flex-row-reverse",
                  )}
                >
                  <span
                    className={cn(
                      "shrink-0 font-semibold tabular-nums",
                      step.wonSeries ? "text-success" : "text-danger-soft",
                    )}
                  >
                    {step.won}–{step.lost}
                  </span>
                  <TeamCrest
                    name={opponentName}
                    seed={step.opponentId}
                    logoUrl={opponent?.logoUrl}
                    size={16}
                    className="rounded"
                  />
                  <span className="line-clamp-2 min-w-0 leading-tight [overflow-wrap:anywhere]">
                    {opponentName}
                  </span>
                </span>
              </Link>
            </li>
          );
        })
      )}
    </ol>
  );
}
