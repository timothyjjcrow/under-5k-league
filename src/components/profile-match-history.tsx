import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { ShowMore } from "@/components/show-more";
import {
  Badge,
  buttonClasses,
  Card,
  CardBody,
  CardHeader,
  FormStrip,
  HeroIcon,
  KDA,
} from "@/components/ui";
import { heroById } from "@/lib/heroes";
import type { PlayerStat } from "@/lib/match-import";
import { formatMatchTime } from "@/lib/match-time";
import type { SeasonHistoryView, SeriesOutcome } from "@/lib/profile-history";
import type { FormResult } from "@/lib/team-matches";
import { cn } from "@/lib/utils";

/** Latest series shown before "Show all". */
const HISTORY_PREVIEW = 5;

type HistorySeries = {
  matchId: string;
  match: { seasonId: string; season: { name: string } };
  games: {
    game: { id: string };
    stat: PlayerStat;
    won: boolean;
  }[];
  outcome: SeriesOutcome;
  opponentName: string;
  round: string;
  playedAt: Date | null;
};

/**
 * The profile's match history: one row per series, latest first, with a
 * season picker once they have played in more than one season.
 */
export function ProfileMatchHistory({
  playerId,
  history,
  recentForm,
}: {
  playerId: string;
  history: SeasonHistoryView<HistorySeries>;
  /** Their last few game results, newest first. */
  recentForm: FormResult[];
}) {
  const visibleSeries = history.visible;
  return (
    <Card id="player-matches" className="scroll-mt-40 overflow-hidden">
      <CardHeader
        title="Match history"
        headingLevel={2}
        subtitle={
          history.selected
            ? history.selected.seasonName
            : history.multiSeason
              ? "All seasons"
              : history.groups[0]?.seasonName
        }
        action={
          recentForm.length > 0 || history.multiSeason ? (
            <div className="flex flex-wrap items-center gap-2">
              {recentForm.length > 0 ? (
                <FormStrip form={recentForm} size={5} />
              ) : null}
              {history.multiSeason ? (
                <form
                  method="get"
                  action={`/players/${playerId}#player-matches`}
                  className="flex items-center gap-2"
                >
                  <label>
                    <span className="sr-only">Show games from season</span>
                    <select
                      name="season"
                      defaultValue={history.selected?.seasonId ?? ""}
                      className="h-10 rounded-lg border border-line bg-surface-2/50 px-2 text-xs text-fg outline-none focus:border-accent/60 sm:h-8"
                    >
                      <option value="">All seasons</option>
                      {history.groups.map((group) => (
                        <option key={group.seasonId} value={group.seasonId}>
                          {group.seasonName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="submit"
                    className={buttonClasses("secondary", "sm")}
                  >
                    View
                  </button>
                </form>
              ) : null}
            </div>
          ) : undefined
        }
      />
      <CardBody className="p-0">
        <SeriesList
          series={visibleSeries.slice(0, HISTORY_PREVIEW)}
          previousSeasonId={null}
          showSeasonHeaders={history.showSeasonHeaders}
          seriesCountBySeason={history.countBySeason}
        />
        {visibleSeries.length > HISTORY_PREVIEW ? (
          <ShowMore
            showLabel={`Show all ${visibleSeries.length} series`}
            hideLabel="Show fewer"
          >
            <SeriesList
              series={visibleSeries.slice(HISTORY_PREVIEW)}
              previousSeasonId={
                visibleSeries[HISTORY_PREVIEW - 1].match.seasonId
              }
              showSeasonHeaders={history.showSeasonHeaders}
              seriesCountBySeason={history.countBySeason}
              className="border-t border-line/60"
            />
          </ShowMore>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * One row per series: the result from their side, the opponent, the week or
 * playoff round and the date, with their hero and KDA for each game beneath.
 * The whole row opens the match page.
 */
function SeriesList({
  series,
  previousSeasonId,
  showSeasonHeaders,
  seriesCountBySeason,
  className,
}: {
  series: HistorySeries[];
  /** Season of the row just above this list, so a header isn't repeated. */
  previousSeasonId: string | null;
  showSeasonHeaders: boolean;
  seriesCountBySeason: ReadonlyMap<string, number>;
  className?: string;
}) {
  return (
    <ul className={cn("divide-y divide-line/60", className)}>
      {series.map((entry, i) => {
        const seasonId = entry.match.seasonId;
        const prior = i > 0 ? series[i - 1].match.seasonId : previousSeasonId;
        const count = seriesCountBySeason.get(seasonId) ?? 0;
        return (
          <li key={entry.matchId}>
            {showSeasonHeaders && seasonId !== prior ? (
              <Link
                href={`/seasons/${seasonId}`}
                className="flex items-center justify-between border-b border-line/60 bg-surface-2/40 px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-muted hover:text-info"
              >
                <span className="truncate">{entry.match.season.name}</span>
                <span className="shrink-0 tabular-nums">{count} series</span>
              </Link>
            ) : null}
            {/* Wide enough (the profile's main column is an @container),
                the games sit beside the opponent instead of under it, so a
                series is one band rather than two. */}
            <Link
              href={`/matches/${entry.matchId}`}
              className="block px-4 py-3 text-sm hover:bg-surface-2/40 @2xl:flex @2xl:items-start @2xl:gap-6"
            >
              <span className="flex items-center gap-3 @2xl:min-w-0 @2xl:flex-1">
                {/* min-w-7 + gap-3 = the pl-10 of the hero lines below, so
                    "vs <team>" and every game line share one left edge
                    whether the badge reads W, L or D (a bare badge's width
                    followed its letter and the column went jagged). */}
                <Badge
                  className="min-w-7 justify-center px-1"
                  tone={
                    entry.outcome.result === "W"
                      ? "success"
                      : entry.outcome.result === "L"
                        ? "danger"
                        : entry.outcome.result === "D"
                          ? "neutral"
                          : "info"
                  }
                >
                  {entry.outcome.result ?? "Live"}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium leading-snug [overflow-wrap:anywhere]">
                    <span className="font-normal text-muted">vs </span>
                    {entry.opponentName}
                  </span>
                  <span className="mt-1 block text-xs text-muted">
                    {entry.outcome.label} · {entry.round}
                    {entry.playedAt ? (
                      <>
                        {" · "}
                        <LocalTime
                          ts={entry.playedAt.getTime()}
                          variant="date"
                          initial={formatMatchTime(entry.playedAt, "date")}
                        />
                      </>
                    ) : null}
                  </span>
                </span>
              </span>
              <span className="mt-2 block space-y-1.5 pl-10 @2xl:mt-0 @2xl:w-72 @2xl:shrink-0 @2xl:pl-0">
                {/* Only the games THEY played, so no "Game 2" numbering: a
                    standin who covered one game of three has one line. */}
                {entry.games.map(({ game, stat, won }) => {
                  const hero = heroById(stat.heroId);
                  return (
                    <span
                      key={game.id}
                      className="flex items-center gap-2 text-xs"
                    >
                      {hero ? <HeroIcon hero={hero} size={22} /> : null}
                      <span className="min-w-0 flex-1 truncate text-muted">
                        {hero?.name ?? `Hero ${stat.heroId}`}
                      </span>
                      <KDA
                        kills={stat.kills}
                        deaths={stat.deaths}
                        assists={stat.assists}
                        className="shrink-0"
                      />
                      <span
                        className={cn(
                          "w-3 shrink-0 text-right font-semibold",
                          won ? "text-success" : "text-danger",
                        )}
                      >
                        <span aria-hidden>{won ? "W" : "L"}</span>
                        <span className="sr-only">{won ? "won" : "lost"}</span>
                      </span>
                    </span>
                  );
                })}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
