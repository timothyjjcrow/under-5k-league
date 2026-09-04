"use client";

// The standings table, sortable: click W/D/L/Diff/Pts to re-rank the rows.
// The # column always shows each team's real league rank, so a re-sort reads
// as "who leads this stat", not a new table. The playoff-cut divider and row
// shading only make sense in league order, so they hide under other sorts.

import { useState } from "react";
import Link from "next/link";
import { Fragment } from "react";
import { EmptyState, FormStrip, TeamCrest } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { FormResult } from "@/lib/team-matches";
import type { ClinchStatus } from "@/lib/standings";

export type StandingsRowView = {
  teamId: string;
  name: string;
  logoUrl?: string | null;
  /** 1-based league rank in points order (the default sort). */
  rank: number;
  wins: number;
  draws: number;
  losses: number;
  gameDiff: number;
  points: number;
  form: FormResult[] | null;
  clinch: ClinchStatus;
  /** Places moved vs. before the latest completed week (positive = up). */
  move: number;
  /** Order vs. a neighbour fell to the team-id fallback — a dead heat. */
  idDecided: boolean;
  /** Quit mid-season — remaining fixtures forfeited, out of seeding. */
  withdrawn: boolean;
  /** One-based playoff seed, or null when below the cut / ineligible. */
  playoffSeed: number | null;
};

type SortKey = "rank" | "wins" | "draws" | "losses" | "gameDiff" | "points";

const SORTS: Record<
  Exclude<SortKey, "rank">,
  (r: StandingsRowView) => number
> = {
  wins: (r) => r.wins,
  draws: (r) => r.draws,
  losses: (r) => r.losses,
  gameDiff: (r) => r.gameDiff,
  points: (r) => r.points,
};

export function StandingsTableClient({
  rows,
  playoffCut,
  viewerTeamId,
  totalTeams,
  eligibleTeams,
  overview = false,
}: {
  rows: StandingsRowView[];
  /** How many top teams make playoffs — draws a "playoff cut" line when set. */
  playoffCut?: number;
  /** The signed-in viewer's team — its row gets a subtle highlight. */
  viewerTeamId?: string | null;
  /**
   * League size before any slicing — the dashboard shows only the top 8, so
   * "does anyone miss the bracket?" must be judged against the full field,
   * not the rows on screen.
   */
  totalTeams?: number;
  /** Non-withdrawn teams competing for the playoff places. */
  eligibleTeams?: number;
  overview?: boolean;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [desc, setDesc] = useState(false);
  const [detailed, setDetailed] = useState(false);

  if (rows.length === 0) {
    return (
      <div className="p-5">
        <EmptyState title="No standings yet" description="Play some matches!" />
      </div>
    );
  }

  const leagueOrder = sortKey === "rank";
  const sorted = leagueOrder
    ? desc
      ? [...rows].reverse()
      : rows
    : [...rows].sort((a, b) => {
        const va = SORTS[sortKey](a);
        const vb = SORTS[sortKey](b);
        return (desc ? vb - va : va - vb) || a.rank - b.rank;
      });

  const hasForm = rows.some((r) => r.form !== null);
  const hasSeedProjection =
    playoffCut != null && rows.some((row) => row.playoffSeed != null);
  // Only draw the cut line when some teams actually miss the bracket, and
  // only while the table is in league order.
  const hasCut =
    leagueOrder &&
    !desc &&
    playoffCut != null &&
    playoffCut > 0 &&
    playoffCut < (eligibleTeams ?? totalTeams ?? rows.length);
  const cols = hasForm ? 8 : 7;

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setDesc((d) => !d);
    } else {
      setSortKey(key);
      // Stat columns start with the biggest number on top; rank starts at #1.
      setDesc(key !== "rank");
    }
  };
  const ariaSort = (key: SortKey) =>
    key === sortKey ? (desc ? "descending" : "ascending") : undefined;

  const header = (
    key: SortKey,
    label: string,
    className: string,
    spoken?: string,
  ) => (
    <th className={className} aria-sort={ariaSort(key)}>
      <button
        type="button"
        onClick={() => onSort(key)}
        title={`Sort by ${spoken ?? label}`}
        className={cn(
          "inline-block min-w-6 rounded px-1 py-1.5 -my-1.5 font-medium uppercase transition-colors hover:text-fg",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60",
          key === sortKey && "text-fg",
        )}
      >
        {label}
        <span aria-hidden className="ml-0.5 inline-block w-2 text-[9px]">
          {key === sortKey ? (desc ? "▼" : "▲") : ""}
        </span>
      </button>
    </th>
  );

  const table = (
    // table-fixed + explicit column widths via <colgroup>: the Team column
    // absorbs whatever is left and truncates, so long names can't widen the
    // page. Widths MUST live on <col> — fixed layout still hands display:none
    // th/td columns an equal share of the leftover, starving Team on phones.
    <table className="w-full table-fixed text-sm">
      <caption className="caption-bottom border-t border-line/60 px-4 py-3 text-left text-xs leading-relaxed text-muted sm:px-5">
        <span className="font-medium text-fg">Scoring:</span> win 3 · draw 1 ·
        loss 0. <span className="font-medium text-fg">Tiebreaks:</span> game
        differential · series wins · head-to-head mini-table. A forfeit or
        ruling uses its recorded score for game differential. A “tied” badge
        means every tiebreak is level and the displayed order is only a stable
        fallback. Withdrawn teams keep their results in the table but cannot
        occupy a playoff seed.
        {hasSeedProjection
          ? " Each qualifying row is announced with its current playoff seed."
          : ""}
      </caption>
      <colgroup>
        <col className="w-10 sm:w-12" />
        <col />
        <col className="w-8 sm:w-10" />
        <col className="w-8 sm:w-10" />
        <col className="w-8 sm:w-10" />
        <col className="w-0 sm:w-11" />
        {hasForm ? <col className="w-0 sm:w-28" /> : null}
        <col className="w-12 sm:w-16" />
      </colgroup>
      <thead>
        <tr className="border-b border-line bg-surface-2/35 text-left text-[10px] uppercase tracking-wider text-muted">
          {header("rank", "#", "px-3 py-2.5 sm:px-5", "league rank")}
          <th className="px-2 py-2.5 font-medium">Team</th>
          {header("wins", "W", "px-1 py-2.5 text-center sm:px-2", "wins")}
          {header("draws", "D", "px-1 py-2.5 text-center sm:px-2", "draws")}
          {header("losses", "L", "px-1 py-2.5 text-center sm:px-2", "losses")}
          {/* Diff hides on phones — the Team column needs the width more. */}
          {header(
            "gameDiff",
            "Diff",
            "hidden px-1 py-2.5 text-center sm:table-cell sm:px-2",
            "game differential",
          )}
          {hasForm ? (
            <th className="hidden px-2 py-2.5 text-center font-medium sm:table-cell">
              Form
            </th>
          ) : null}
          {header("points", "Pts", "px-3 py-2.5 text-right sm:px-5", "points")}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => {
          const inCut = hasCut && row.playoffSeed != null;
          return (
            <Fragment key={row.teamId}>
              <tr
                className={cn(
                  "border-b border-line-soft transition-colors last:border-0 hover:bg-surface-2/60",
                  inCut && "bg-success/[0.04]",
                  row.teamId === viewerTeamId && "bg-info/[0.07]",
                )}
              >
                <td
                  className={cn(
                    "px-3 py-2.5 font-display text-lg tabular-nums sm:px-5",
                    inCut ? "font-medium text-success/80" : "text-muted",
                  )}
                >
                  <span className="whitespace-nowrap">
                    {row.rank}
                    {hasSeedProjection ? (
                      <span className="sr-only">
                        {row.playoffSeed != null
                          ? `, current playoff seed ${row.playoffSeed}`
                          : row.withdrawn
                            ? ", withdrawn and excluded from playoff seeding"
                            : ", outside the current playoff field"}
                      </span>
                    ) : null}
                    {row.playoffSeed != null && row.playoffSeed !== row.rank ? (
                      <span
                        aria-hidden
                        title={`Current playoff seed ${row.playoffSeed}`}
                        className="block text-[9px] font-semibold uppercase leading-tight text-success/80"
                      >
                        seed {row.playoffSeed}
                      </span>
                    ) : null}
                    {/* Weekly movement reads against league order only. */}
                    {leagueOrder && row.move !== 0 ? (
                      <span
                        role="img"
                        aria-label={`${row.move > 0 ? "up" : "down"} ${Math.abs(row.move)} from last week`}
                        title={`${row.move > 0 ? "Up" : "Down"} ${Math.abs(row.move)} from last week`}
                        className={cn(
                          "ml-0.5 align-middle text-[9px] font-semibold",
                          row.move > 0 ? "text-success" : "text-danger",
                        )}
                      >
                        <span aria-hidden>
                          {row.move > 0 ? "▲" : "▼"}
                          {Math.abs(row.move)}
                        </span>
                      </span>
                    ) : null}
                  </span>
                </td>
                <th scope="row" className="px-2 py-2.5 text-left font-medium">
                  <Link
                    href={`/teams/${row.teamId}`}
                    className="-my-1 flex min-h-11 min-w-0 items-center gap-2 py-1 hover:text-info"
                  >
                    <TeamCrest
                      name={row.name}
                      seed={row.teamId}
                      logoUrl={row.logoUrl}
                      size={22}
                      className="rounded-md shrink-0"
                    />
                    <span className="truncate">{row.name}</span>
                    {row.teamId === viewerTeamId ? (
                      <span className="shrink-0 rounded bg-info/20 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-info">
                        You
                      </span>
                    ) : null}
                    {/* Marks only mean something when a team can miss the
                        bracket — with everyone qualifying they'd all be ✓. */}
                    <ClinchMark status={row.clinch} />
                    {row.withdrawn ? (
                      <span
                        role="img"
                        aria-label="Withdrew from the season — remaining fixtures forfeited, excluded from playoff seeding"
                        title="Withdrew from the season — remaining fixtures were forfeited to the opponents; excluded from playoff seeding"
                        className="shrink-0 rounded bg-surface-2 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted"
                      >
                        withdrew
                      </span>
                    ) : null}
                    {row.idDecided ? (
                      <span
                        role="img"
                        aria-label="Fully tied with a neighbouring team — this order is arbitrary"
                        title="Fully tied — points, game diff, series wins and head-to-head all level with a neighbouring team; this order is arbitrary"
                        className="shrink-0 rounded bg-accent/15 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent"
                      >
                        tied
                      </span>
                    ) : null}
                  </Link>
                </th>
                <td className="px-1 py-2.5 text-center font-mono tabular-nums sm:px-2">
                  {row.wins}
                </td>
                <td className="px-1 py-2.5 text-center font-mono tabular-nums text-muted sm:px-2">
                  {row.draws}
                </td>
                <td className="px-1 py-2.5 text-center font-mono tabular-nums sm:px-2">
                  {row.losses}
                </td>
                <td className="hidden px-1 py-2.5 text-center text-muted sm:table-cell sm:px-2">
                  {row.gameDiff > 0 ? `+${row.gameDiff}` : row.gameDiff}
                </td>
                {hasForm ? (
                  <td className="hidden px-2 py-2.5 sm:table-cell">
                    <span className="flex justify-center">
                      <FormStrip form={row.form ?? []} size={5} />
                    </span>
                  </td>
                ) : null}
                <td className="px-2 py-2.5 text-right font-display text-xl font-semibold tabular-nums sm:px-5">
                  <span className="inline-block min-w-6 rounded-md bg-info/[0.08] py-1 text-fg">
                    {row.points}
                  </span>
                </td>
              </tr>
              {hasCut && row.playoffSeed === playoffCut ? (
                <tr className="bg-success/[0.03]">
                  <td colSpan={cols} className="px-5 py-1">
                    <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-success/80">
                      <span
                        aria-hidden
                        className="h-px flex-1 bg-gradient-to-r from-transparent to-success/40"
                      />
                      Playoff cut
                      <span
                        aria-hidden
                        className="h-px flex-1 bg-gradient-to-l from-transparent to-success/40"
                      />
                      <span className="sr-only">
                        . Eligible teams after this row are outside the current
                        playoff field.
                      </span>
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
  if (!overview) return table;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-3 sm:px-5">
        <div
          role="img"
          aria-label="Series points: win 3, draw 1, loss 0"
          className="flex items-center gap-2 text-[11px] tabular-nums text-muted"
        >
          <span aria-hidden className="mr-0.5 font-medium text-fg">
            Points
          </span>
          <span aria-hidden>
            <span className="font-semibold text-success">W</span> 3
          </span>
          <span aria-hidden className="text-line">
            /
          </span>
          <span aria-hidden>
            <span className="font-semibold text-accent">D</span> 1
          </span>
          <span aria-hidden className="text-line">
            /
          </span>
          <span aria-hidden>
            <span className="font-semibold text-danger">L</span> 0
          </span>
        </div>
        <button
          type="button"
          aria-pressed={detailed}
          onClick={() => setDetailed((value) => !value)}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface-2/70 px-3 text-xs font-medium text-fg transition-colors hover:border-info/50 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            fill="none"
            className="h-3.5 w-3.5 text-info"
          >
            <path
              d="M2 3h12M2 8h12M2 13h12M5 3v10M11 3v10"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
          {detailed ? "Simple standings" : "Detailed statistics"}
        </button>
      </div>
      {detailed ? (
        table
      ) : (
        <StandingsOverview
          rows={rows}
          viewerTeamId={viewerTeamId}
          playoffCut={playoffCut}
          showPlayoffCut={
            playoffCut != null &&
            playoffCut > 0 &&
            playoffCut < (eligibleTeams ?? totalTeams ?? rows.length)
          }
        />
      )}
    </div>
  );
}

function StandingsOverview({
  rows,
  viewerTeamId,
  playoffCut,
  showPlayoffCut,
}: {
  rows: StandingsRowView[];
  viewerTeamId?: string | null;
  playoffCut?: number;
  showPlayoffCut: boolean;
}) {
  const leadingPoints = Math.max(...rows.map((row) => row.points), 1);
  const hasForm = rows.some((row) => row.form !== null);
  const columns = hasForm ? 5 : 4;

  return (
    <table
      className="w-full table-fixed text-sm"
      aria-label="League standings overview"
    >
      <caption className="sr-only">
        Teams in league order. Each bar shows points relative to the highest
        points total in this table. W, D and L mean series wins, draws and
        losses. Recent form reads newest first. A seed is the current playoff
        position; qualified means a playoff place is secured. Fully tied teams
        have an arbitrary displayed order. Withdrawn teams retain their results
        but are excluded from playoff seeding.
      </caption>
      <colgroup>
        <col className="w-10 sm:w-14" />
        <col />
        <col className="w-0 sm:w-24" />
        {hasForm ? <col className="w-0 md:w-32" /> : null}
        <col className="w-14 sm:w-20" />
      </colgroup>
      <thead>
        <tr className="border-b border-line-soft bg-surface-2/35 text-[10px] uppercase tracking-[0.12em] text-muted">
          <th className="px-3 py-3 text-left font-medium sm:px-5">
            <span aria-hidden>#</span>
            <span className="sr-only">Rank</span>
          </th>
          <th className="px-2 py-3 text-left font-medium">Team</th>
          <th className="hidden px-2 py-3 text-center font-medium sm:table-cell">
            W · D · L
          </th>
          {hasForm ? (
            <th className="hidden px-2 py-3 text-center font-medium md:table-cell">
              Last five
            </th>
          ) : null}
          <th className="px-3 py-3 text-right font-medium sm:px-5">Points</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const isViewer = row.teamId === viewerTeamId;
          const recordLabel = `${row.wins} wins, ${row.draws} draws, ${row.losses} losses`;
          return (
            <Fragment key={row.teamId}>
              <tr
                className={cn(
                  "group/standing border-b border-line-soft transition-colors last:border-0 hover:bg-surface-2/55",
                  isViewer && "bg-info/[0.07]",
                )}
              >
                <td className="px-3 py-3 align-top sm:px-5 sm:py-4">
                  <span
                    className={cn(
                      "block pt-1 font-display text-xl leading-none tabular-nums",
                      row.rank === 1 ? "text-accent" : "text-muted",
                    )}
                  >
                    {row.rank < 10 ? `0${row.rank}` : row.rank}
                  </span>
                  {row.move !== 0 ? (
                    <span
                      role="img"
                      aria-label={`${row.move > 0 ? "up" : "down"} ${Math.abs(row.move)} from last week`}
                      title={`${row.move > 0 ? "Up" : "Down"} ${Math.abs(row.move)} from last week`}
                      className={cn(
                        "mt-2 block whitespace-nowrap text-[9px] font-semibold",
                        row.move > 0 ? "text-success" : "text-danger",
                      )}
                    >
                      <span aria-hidden>
                        {row.move > 0 ? "↑" : "↓"}
                        {Math.abs(row.move)}
                      </span>
                    </span>
                  ) : null}
                  <span className="sr-only">
                    {row.playoffSeed != null
                      ? `, current playoff seed ${row.playoffSeed}`
                      : ""}
                  </span>
                </td>
                <th
                  scope="row"
                  className="px-2 py-3 text-left font-normal sm:py-4"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <TeamCrest
                      name={row.name}
                      seed={row.teamId}
                      logoUrl={row.logoUrl}
                      size={30}
                      className="shrink-0 rounded-lg"
                    />
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/teams/${row.teamId}`}
                        className="-my-1 inline-flex min-h-11 items-center py-1 text-sm font-semibold leading-snug transition-colors [overflow-wrap:anywhere] hover:text-info"
                      >
                        {row.name}
                        <span
                          aria-hidden
                          className="ml-1 hidden shrink-0 text-info opacity-0 transition-opacity group-hover/standing:opacity-100 sm:inline"
                        >
                          ↗
                        </span>
                      </Link>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-medium">
                        <OverviewStatus row={row} playoffCut={playoffCut} />
                        {isViewer ? (
                          <span className="text-info">Your team</span>
                        ) : null}
                        {row.idDecided ? (
                          <span
                            role="img"
                            aria-label="Fully tied with a neighbouring team — this order is arbitrary"
                            title="Fully tied — all tiebreaks are level; displayed order is arbitrary"
                            className="rounded bg-accent/10 px-1.5 py-0.5 text-accent"
                          >
                            Tied
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2.5 flex items-center gap-2">
                    <div
                      aria-hidden
                      className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3/65"
                    >
                      <span
                        className={cn(
                          "absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-info/65 to-cyan-300",
                          row.withdrawn && "from-muted/35 to-muted/70",
                        )}
                        style={{
                          width: `${Math.max(0, row.points / leadingPoints) * 100}%`,
                        }}
                      />
                    </div>
                    <span
                      role="img"
                      aria-label={recordLabel}
                      className="shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums sm:hidden"
                    >
                      <span aria-hidden>
                        <span className="text-success">{row.wins}W</span>
                        <span className="mx-1 text-muted">{row.draws}D</span>
                        <span className="text-danger">{row.losses}L</span>
                      </span>
                    </span>
                  </div>
                </th>
                <td className="hidden px-2 py-4 text-center sm:table-cell">
                  <span
                    role="img"
                    aria-label={recordLabel}
                    className="whitespace-nowrap font-mono text-xs tabular-nums"
                  >
                    <span aria-hidden>
                      <span className="text-success">{row.wins}</span>
                      <span className="mx-1.5 text-muted">{row.draws}</span>
                      <span className="text-danger">{row.losses}</span>
                    </span>
                  </span>
                  <RecordBar row={row} />
                </td>
                {hasForm ? (
                  <td className="hidden px-2 py-4 md:table-cell">
                    <span className="flex justify-center">
                      {row.form?.length ? (
                        <FormStrip form={row.form.slice(0, 5)} size={4} />
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </span>
                  </td>
                ) : null}
                <td className="px-3 py-4 text-right sm:px-5">
                  <span
                    className={cn(
                      "font-display text-3xl leading-none tabular-nums",
                      row.rank === 1 ? "text-accent" : "text-fg",
                    )}
                  >
                    {row.points}
                  </span>
                </td>
              </tr>
              {showPlayoffCut && row.playoffSeed === playoffCut ? (
                <tr className="bg-accent/[0.04]">
                  <td colSpan={columns} className="px-4 py-2 sm:px-5">
                    <div className="flex items-center gap-3 text-[9px] font-semibold uppercase tracking-[0.15em] text-accent">
                      <span
                        aria-hidden
                        className="h-px flex-1 border-t border-dashed border-accent/35"
                      />
                      Playoff cut · {playoffCut} places
                      <span
                        aria-hidden
                        className="h-px flex-1 border-t border-dashed border-accent/35"
                      />
                      <span className="sr-only">
                        . Eligible teams below this line are outside the current
                        playoff field.
                      </span>
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function OverviewStatus({
  row,
  playoffCut,
}: {
  row: StandingsRowView;
  playoffCut?: number;
}) {
  if (row.withdrawn) {
    return (
      <span
        title="Withdrawn — remaining fixtures forfeited; excluded from playoff seeding"
        className="text-muted"
      >
        Withdrawn
      </span>
    );
  }
  if (row.clinch === "CLINCHED") {
    return (
      <span title="Playoff place secured" className="text-success">
        <span aria-hidden>✓ </span>Qualified
        {row.playoffSeed != null && row.playoffSeed !== row.rank
          ? ` · seed ${row.playoffSeed}`
          : ""}
      </span>
    );
  }
  if (row.clinch === "ELIMINATED") {
    return (
      <span title="Out of playoff contention" className="text-muted">
        Eliminated
      </span>
    );
  }
  if (playoffCut != null && row.playoffSeed != null) {
    return (
      <span
        title={`Currently in playoff position — seed ${row.playoffSeed}`}
        className="text-muted"
      >
        Seed {row.playoffSeed}
      </span>
    );
  }
  if (playoffCut != null) {
    return (
      <span title="Currently outside playoff positions" className="text-muted">
        Outside cut
      </span>
    );
  }
  return null;
}

function RecordBar({ row }: { row: StandingsRowView }) {
  const played = row.wins + row.draws + row.losses;
  return (
    <span
      aria-hidden
      className="mx-auto mt-2 flex h-1.5 max-w-16 gap-px overflow-hidden rounded-full bg-surface-3/65"
    >
      {played > 0 ? (
        <>
          {row.wins > 0 ? (
            <span
              className="bg-success/80"
              style={{ width: `${(row.wins / played) * 100}%` }}
            />
          ) : null}
          {row.draws > 0 ? (
            <span
              className="bg-accent/80"
              style={{ width: `${(row.draws / played) * 100}%` }}
            />
          ) : null}
          {row.losses > 0 ? (
            <span
              className="bg-danger/65"
              style={{ width: `${(row.losses / played) * 100}%` }}
            />
          ) : null}
        </>
      ) : null}
    </span>
  );
}

/** ✓/✗ mark for a locked playoff fate — screen readers get the full phrase. */
function ClinchMark({ status }: { status: ClinchStatus }) {
  if (!status) return null;
  const clinched = status === "CLINCHED";
  const label = clinched ? "Clinched playoffs" : "Eliminated from playoffs";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "shrink-0 text-xs font-semibold",
        clinched ? "text-success" : "text-danger",
      )}
    >
      <span aria-hidden>{clinched ? "✓" : "✗"}</span>
    </span>
  );
}
