import Link from "next/link";
import { AnalysisDisclosure } from "@/components/analysis-disclosure";
import { Badge, TeamCrest } from "@/components/ui";
import type { PowerRankingRow } from "@/lib/power-rankings";
import { cn } from "@/lib/utils";

export type PowerRankingTeam = {
  name: string;
  logoUrl: string | null;
  withdrawn: boolean;
};

/**
 * The Elo power rankings on /teams: a second opinion beside the official
 * table, so it sits under the rosters, folded to one line. Only regular-season
 * games feed it, so once the regular season is over (`frozen`) it says so
 * instead of calling its last regular week "the latest".
 */
export function PowerRankingsCard({
  rows,
  teams,
  frozen,
}: {
  rows: PowerRankingRow[];
  teams: Map<string, PowerRankingTeam>;
  frozen: boolean;
}) {
  if (rows.length === 0) return null;
  const leader = rows[0];
  const leaderName = teams.get(leader.teamId)?.name ?? "?";
  const changeScale = Math.max(
    10,
    Math.ceil(Math.max(0, ...rows.map((row) => Math.abs(row.delta))) / 10) * 10,
  );
  const hasMovement = rows.some((row) => row.prevRank > 0);
  const weekName = frozen ? "the final regular-season week" : "the latest week";
  return (
    <AnalysisDisclosure
      id="power-rankings"
      title="Power rankings"
      description={
        frozen
          ? `Frozen at the end of the regular season · ${leaderName} finished top on ${leader.rating}`
          : `Elo rating from regular-season games · ${leaderName} top on ${leader.rating}`
      }
    >
      <p className="text-xs leading-relaxed text-muted">
        Every regular-season game moves both teams&apos; rating, and beating a
        strong team moves it more. Forfeits and tiebreakers don&apos;t count.
        The official order is the standings table.
      </p>
      <ol className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
        {rows.map((row) => {
          const team = teams.get(row.teamId);
          const name = team?.name ?? "?";
          const moved = row.prevRank > 0 ? row.prevRank - row.rank : 0;
          return (
            <li
              key={row.teamId}
              className="min-w-0 rounded-lg border border-line-soft bg-surface-2/35 px-3 py-3 sm:px-4"
            >
              <div className="grid grid-cols-[1.25rem_1.75rem_minmax(0,1fr)_auto] items-center gap-2.5">
                <span
                  className="font-display text-xl tabular-nums text-muted"
                  aria-label={`Power rank ${row.rank}`}
                >
                  {String(row.rank).padStart(2, "0")}
                </span>
                <TeamCrest
                  name={name}
                  seed={row.teamId}
                  logoUrl={team?.logoUrl}
                  size={28}
                  className="shrink-0 rounded-md"
                />
                <div className="min-w-0">
                  <Link
                    href={`/teams/${row.teamId}`}
                    className="inline-flex min-h-11 items-center text-sm font-semibold leading-snug hover:text-info [overflow-wrap:anywhere]"
                  >
                    {name}
                  </Link>
                  {team?.withdrawn ? (
                    <Badge
                      tone="danger"
                      className="mt-1 px-1.5 py-0"
                      title="Withdrawn teams retain played results but cannot qualify for playoffs"
                    >
                      Withdrawn
                    </Badge>
                  ) : null}
                </div>
                <div className="text-right">
                  <span
                    className="font-display text-2xl leading-none tabular-nums text-fg"
                    title="Elo rating: higher is stronger"
                  >
                    {row.rating}
                  </span>
                  <span
                    className={cn(
                      "mt-1 block font-mono text-xs tabular-nums",
                      moved > 0
                        ? "text-cyan-300"
                        : moved < 0
                          ? "text-danger"
                          : "text-muted",
                    )}
                    title={
                      row.prevRank > 0
                        ? `Power rank before ${weekName}: ${row.prevRank}`
                        : "No earlier week to compare"
                    }
                    aria-label={
                      row.prevRank > 0
                        ? `Power rank ${moved > 0 ? "up" : moved < 0 ? "down" : "unchanged"}${moved ? ` ${Math.abs(moved)}` : ""} in ${weekName}`
                        : "No previous rank"
                    }
                  >
                    {moved > 0 ? `▲ ${moved}` : moved < 0 ? `▼ ${-moved}` : "—"}
                  </span>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-[minmax(0,1fr)_2.75rem] items-center gap-3">
                <div
                  role="img"
                  aria-label={
                    row.prevRank > 0
                      ? `Elo change in ${weekName}: ${row.delta > 0 ? "+" : ""}${row.delta}`
                      : "No earlier week to compare"
                  }
                  className="relative h-2 rounded-full bg-bg/80"
                >
                  <span
                    aria-hidden
                    className="absolute -top-1 bottom-[-4px] left-1/2 w-px bg-muted/50"
                  />
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-y-0 rounded-full",
                      row.delta < 0 ? "bg-danger" : "bg-cyan-300",
                    )}
                    style={{
                      left: `${row.delta < 0 ? 50 - (Math.abs(row.delta) / changeScale) * 50 : 50}%`,
                      width: `${(Math.abs(row.delta) / changeScale) * 50}%`,
                    }}
                  />
                </div>
                <span
                  className={cn(
                    "text-right font-mono text-xs font-semibold tabular-nums",
                    row.delta > 0
                      ? "text-cyan-300"
                      : row.delta < 0
                        ? "text-danger"
                        : "text-muted",
                  )}
                >
                  {row.prevRank > 0
                    ? `${row.delta > 0 ? "+" : ""}${row.delta}`
                    : "—"}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      {hasMovement ? (
        // The one legend: what the bars and the arrows measure, and the scale.
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
          <span>Bars: Elo change in {weekName}</span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-danger" aria-hidden />
            lost
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="h-1.5 w-1.5 rounded-full bg-cyan-300"
              aria-hidden
            />
            gained
          </span>
          <span className="font-mono tabular-nums">
            scale −{changeScale} to +{changeScale}
          </span>
        </p>
      ) : (
        <p className="text-[11px] text-muted">
          Weekly movement shows once a second week has results.
        </p>
      )}
    </AnalysisDisclosure>
  );
}
