import type { ComponentProps } from "react";
import { InhouseCareerCard } from "@/components/inhouse-career-card";
import { ProfileMatchSpotlight } from "@/components/profile-match-spotlight";
import { Stat } from "@/components/ui";
import type { PlayerSummary } from "@/lib/player-stats";
import { seriesRecordText, type SeriesRecordCounts } from "@/lib/team-matches";
import { cn } from "@/lib/utils";

/**
 * The profile's first band: their league form in four tiles, the match worth
 * opening next, and (for a player whose only record is inhouse) the inhouse
 * card. With no league games the heading is the one status line.
 */
export function ProfileOverview({
  hasLeagueGames,
  hasSeasonGames,
  seasonName,
  seasonSummary,
  careerSummary,
  streakLabel,
  team,
  featured,
  inhouseUserId,
}: {
  hasLeagueGames: boolean;
  /** League games this active season, so the tiles show it over career. */
  hasSeasonGames: boolean;
  seasonName: string | undefined;
  seasonSummary: PlayerSummary;
  careerSummary: PlayerSummary;
  streakLabel: string | undefined;
  /** Their team this season, if drafted: the fourth tile. */
  team: {
    rank: number;
    row: (SeriesRecordCounts & { points: number }) | undefined;
    /** Their playoff run, once the season has a bracket. */
    playoffTile: { value: string; hint: string } | null;
  } | null;
  featured: ComponentProps<typeof ProfileMatchSpotlight> | null;
  /** Set when the inhouse card leads the page instead of the career band. */
  inhouseUserId: string | null;
}) {
  // Stat tiles show the active season once it has games, career otherwise —
  // so veterans keep a record during SIGNUPS/DRAFT of a new season.
  const tiles = hasSeasonGames ? seasonSummary : careerSummary;
  const overviewItems =
    (hasLeagueGames ? 1 : 0) + (featured ? 1 : 0) + (inhouseUserId ? 1 : 0);
  return (
    <section
      id="player-overview"
      aria-label="Player overview"
      className="scroll-mt-40 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* With no league games the heading IS the one status line: the
            signup details, pub form and inhouse record around it are what
            they do have. */}
        <h2 className="font-display text-xl font-semibold">
          {!hasLeagueGames
            ? "No league games yet"
            : hasSeasonGames
              ? "Season form"
              : "Career form"}
        </h2>
        {hasLeagueGames ? (
          <span className="text-xs text-muted">
            {hasSeasonGames ? seasonName : "All league seasons"}
          </span>
        ) : null}
      </div>
      {overviewItems > 0 ? (
        <div
          className={cn(
            "grid grid-cols-1 gap-4",
            overviewItems >= 2 && "lg:grid-cols-2",
          )}
        >
          {hasLeagueGames ? (
            <div className="grid min-w-0 grid-cols-2 gap-3">
              {/* Games won and lost, not series: "Game record" keeps it
                  apart from the team's series record beside it. */}
              <Stat
                label={hasSeasonGames ? "Game record" : "Career game record"}
                value={`${tiles.wins}–${tiles.losses}`}
                hint={
                  hasSeasonGames && careerSummary.games > seasonSummary.games
                    ? `${tiles.winRate}% · career ${careerSummary.wins}–${careerSummary.losses}`
                    : `${tiles.winRate}% win rate`
                }
              />
              <Stat label="Games" value={tiles.games} hint={streakLabel} />
              <Stat
                label="Avg KDA"
                value={`${tiles.avgKills}/${tiles.avgDeaths}/${tiles.avgAssists}`}
                hint={`${tiles.kda} ratio`}
              />
              {team && team.playoffTile ? (
                <Stat
                  label="Playoffs"
                  value={team.playoffTile.value}
                  hint={team.playoffTile.hint}
                  // md: a round name ("Quarterfinal") at text-3xl overflows
                  // a half-width tile on a phone.
                  size="md"
                />
              ) : team ? (
                <Stat
                  label="Team rank"
                  value={team.rank > 0 ? `#${team.rank}` : "—"}
                  hint={
                    team.row
                      ? `${seriesRecordText(team.row)} · ${team.row.points} pts`
                      : undefined
                  }
                />
              ) : (
                <Stat
                  label="Hero pool"
                  value={careerSummary.topHeroes.length}
                  hint="heroes played"
                />
              )}
            </div>
          ) : null}

          {featured ? <ProfileMatchSpotlight {...featured} /> : null}
          {inhouseUserId ? <InhouseCareerCard userId={inhouseUserId} /> : null}
        </div>
      ) : null}
    </section>
  );
}
