import Link from "next/link";
import type { MatchLike, TeamStanding } from "@/lib/standings";
import { resultFor } from "@/lib/team-matches";
import { cn } from "@/lib/utils";
import { Card, CardBody, CardHeader, TeamCrest } from "@/components/ui";

type ResultMatch = MatchLike & { id: string; week: number };

/** A season's actual series, in week order. Every tile opens its match. */
export function LeagueResultsMap({
  standings,
  matches,
  teamName,
  teamLogoUrl,
  className,
}: {
  standings: TeamStanding[];
  matches: ResultMatch[];
  teamName: Map<string, string>;
  teamLogoUrl: Map<string, string | null>;
  className?: string;
}) {
  const regular = matches.filter((match) => match.phase === "REGULAR");
  const weeks = [...new Set(regular.map((match) => match.week))].sort(
    (a, b) => a - b,
  );
  if (!weeks.length || !standings.length) return null;
  const meetings = new Map<string, ResultMatch[]>();
  for (const match of regular) {
    for (const id of [match.homeTeamId, match.awayTeamId]) {
      const key = `${id}:${match.week}`;
      meetings.set(key, [...(meetings.get(key) ?? []), match]);
    }
  }
  return (
    <Card className={cn("flex min-w-0 flex-col overflow-hidden", className)}>
      <CardHeader
        headingLevel={2}
        title="The season, week by week"
        action={
          <div
            className="flex flex-wrap gap-3 text-xs text-muted"
            aria-label="Series result legend"
          >
            <span>
              <i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-success" />
              Win
            </span>
            <span>
              <i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-accent" />
              Draw
            </span>
            <span>
              <i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-danger" />
              Loss
            </span>
          </div>
        }
      />
      <CardBody
        className="flex-1 overflow-x-auto p-0"
        tabIndex={0}
        aria-label="Weekly series results; scroll for more weeks"
      >
        <table
          className="w-full border-separate border-spacing-0 text-sm"
          aria-label="Weekly series results"
        >
          <caption className="sr-only">
            Each team&apos;s regular-season results, from earliest to latest
            week. Open a result for the opponent and match details. A dash means
            no fixture; F marks a forfeit.
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 min-w-36 border-b border-line-soft bg-surface px-4 py-3 text-left text-xs font-medium text-muted sm:min-w-52"
              >
                Team
              </th>
              {weeks.map((week) => (
                <th
                  key={week}
                  scope="col"
                  className="min-w-[4.5rem] border-b border-line-soft px-2 py-3 text-center text-xs font-medium text-muted sm:min-w-20"
                >
                  W<span className="sr-only">eek </span>
                  {week}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {standings.map((team, rank) => (
              <tr key={team.teamId} className="group/result-row">
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-line-soft bg-surface px-3 py-2 text-left font-medium sm:px-4"
                >
                  <Link
                    href={`/teams/${team.teamId}`}
                    className="flex min-h-11 w-32 items-center gap-2 hover:text-info sm:w-44"
                  >
                    <span className="w-3 shrink-0 text-xs tabular-nums text-muted">
                      {rank + 1}
                    </span>
                    <TeamCrest
                      name={teamName.get(team.teamId) ?? "?"}
                      seed={team.teamId}
                      logoUrl={teamLogoUrl.get(team.teamId)}
                      size={22}
                      className="shrink-0 rounded-md"
                    />
                    <span className="min-w-0 text-xs leading-snug [overflow-wrap:anywhere] sm:text-sm">
                      {teamName.get(team.teamId) ?? "?"}
                    </span>
                  </Link>
                </th>
                {weeks.map((week) => (
                  <td
                    key={week}
                    className="border-b border-line-soft px-1.5 py-2 text-center group-hover/result-row:bg-surface-2/30"
                  >
                    <div className="flex flex-col gap-1.5">
                      {(meetings.get(`${team.teamId}:${week}`) ?? []).map(
                        (match) => {
                          const home = match.homeTeamId === team.teamId;
                          const opponent =
                            teamName.get(
                              home ? match.awayTeamId : match.homeTeamId,
                            ) ?? "?";
                          const score = home
                            ? `${match.homeScore}–${match.awayScore}`
                            : `${match.awayScore}–${match.homeScore}`;
                          const done = match.status === "COMPLETED";
                          const live = match.status === "LIVE";
                          const result = done
                            ? resultFor(team.teamId, match)
                            : null;
                          const state = done
                            ? `${result === "W" ? "Won" : result === "L" ? "Lost" : "Drew"} ${score}${match.forfeit ? " by forfeit" : ""}`
                            : live
                              ? `Live, ${score}`
                              : "Not final";
                          const label = `${teamName.get(team.teamId)} vs ${opponent}, week ${week}: ${state}`;
                          return (
                            <Link
                              key={match.id}
                            href={`/matches/${match.id}`}
                            prefetch={false}
                              aria-label={label}
                              title={label}
                              className={cn(
                                "flex min-h-11 flex-col items-center justify-center rounded-md border px-2 py-1 transition-colors hover:border-fg/60",
                                result === "W"
                                  ? "border-success/25 bg-success/15 text-success"
                                  : result === "L"
                                    ? "border-danger/20 bg-danger/10 text-danger"
                                    : result === "D"
                                      ? "border-accent/25 bg-accent/10 text-accent"
                                      : live
                                        ? "border-danger/50 bg-danger/10 text-danger"
                                        : "border-dashed border-line bg-surface-2/20 text-muted",
                              )}
                            >
                              <span className="text-[10px] font-semibold uppercase tracking-wide">
                                {done
                                  ? `${result}${match.forfeit ? " · F" : ""}`
                                  : live
                                    ? "Live"
                                    : "Open"}
                              </span>
                              <span className="font-mono text-xs tabular-nums">
                                {done || live ? score : "vs"}
                              </span>
                            </Link>
                          );
                        },
                      )}
                      {!meetings.has(`${team.teamId}:${week}`) ? (
                        <span className="text-muted" aria-label="No fixture">
                          —
                        </span>
                      ) : null}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </CardBody>
      <div className="flex justify-between gap-3 px-4 py-2.5 text-[11px] text-muted">
        <span>Series scores · F = forfeit</span>
        <span>Open any result ↗</span>
      </div>
    </Card>
  );
}
