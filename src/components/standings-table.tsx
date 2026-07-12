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
}) {
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [desc, setDesc] = useState(false);

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
  // Only draw the cut line when some teams actually miss the bracket, and
  // only while the table is in league order.
  const hasCut =
    leagueOrder &&
    !desc &&
    playoffCut != null &&
    playoffCut > 0 &&
    playoffCut < (totalTeams ?? rows.length);
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
          "rounded font-medium uppercase transition-colors hover:text-fg",
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

  return (
    // table-fixed + explicit column widths via <colgroup>: the Team column
    // absorbs whatever is left and truncates, so long names can't widen the
    // page. Widths MUST live on <col> — fixed layout still hands display:none
    // th/td columns an equal share of the leftover, starving Team on phones.
    <table className="w-full table-fixed text-sm">
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
        <tr className="border-b border-line text-left text-xs uppercase text-muted">
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
          const inCut = hasCut && row.rank <= playoffCut!;
          return (
            <Fragment key={row.teamId}>
              <tr
                className={cn(
                  "border-b border-line/50 transition-colors last:border-0 hover:bg-surface-2/40",
                  inCut && "bg-success/[0.04]",
                  row.teamId === viewerTeamId && "bg-info/[0.07]",
                )}
              >
                <td
                  className={cn(
                    "px-3 py-2.5 sm:px-5",
                    inCut ? "font-medium text-success/80" : "text-muted",
                  )}
                >
                  <span className="whitespace-nowrap">
                    {row.rank}
                    {/* Weekly movement reads against league order only. */}
                    {leagueOrder && row.move !== 0 ? (
                      <span
                        role="img"
                        aria-label={`${row.move > 0 ? "up" : "down"} ${Math.abs(row.move)} from last week`}
                        title={`${row.move > 0 ? "Up" : "Down"} ${Math.abs(row.move)} from last week`}
                        className={cn(
                          "ml-0.5 align-middle text-[9px] font-semibold",
                          row.move > 0 ? "text-success" : "text-danger/80",
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
                <td className="px-2 py-2.5 font-medium">
                  <Link
                    href={`/teams/${row.teamId}`}
                    className="flex min-w-0 items-center gap-2 hover:text-info"
                  >
                    <TeamCrest
                      name={row.name}
                      seed={row.teamId}
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
                  </Link>
                </td>
                <td className="px-1 py-2.5 text-center sm:px-2">{row.wins}</td>
                <td className="px-1 py-2.5 text-center text-muted sm:px-2">
                  {row.draws}
                </td>
                <td className="px-1 py-2.5 text-center sm:px-2">{row.losses}</td>
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
                <td className="px-3 py-2.5 text-right font-semibold sm:px-5">
                  {row.points}
                </td>
              </tr>
              {hasCut && row.rank === playoffCut ? (
                <tr aria-hidden className="bg-success/[0.03]">
                  <td colSpan={cols} className="px-5 py-1">
                    <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-success/80">
                      <span className="h-px flex-1 bg-gradient-to-r from-transparent to-success/40" />
                      Playoff cut
                      <span className="h-px flex-1 bg-gradient-to-l from-transparent to-success/40" />
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
        clinched ? "text-success" : "text-danger/70",
      )}
    >
      <span aria-hidden>{clinched ? "✓" : "✗"}</span>
    </span>
  );
}
