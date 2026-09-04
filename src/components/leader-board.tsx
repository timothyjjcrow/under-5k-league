"use client";

// One /leaders board, made explorable: top 5 by default with a "show all"
// toggle, the signed-in viewer's row highlighted — and pinned below the top 5
// (with their real rank) when they didn't crack it. The server precomputes
// every row and label; this component only expands/collapses.

import { useId, useState } from "react";
import {
  Avatar,
  Card,
  CardBody,
  CardHeader,
  PlayerLink,
  RankBadge,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { competitionRanks } from "@/lib/leader-ranking";

export type LeaderBoardRow = {
  id: string;
  name: string;
  avatar: string | null;
  rankTier: number | null;
  value: number;
  /** Value at the same precision as valueLabel, used for visible ties. */
  rankValue?: number;
  valueLabel: string;
  hint: string;
  isViewer: boolean;
  /** The player's team this season, when known — shown below their name. */
  team?: string | null;
  /** False for a historical line whose User row no longer exists. */
  hasProfile?: boolean;
};

const TOP = 5;

export function LeaderBoard({
  id,
  title,
  subtitle,
  rows,
  headingLevel = 3,
  scaleMax,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  rows: LeaderBoardRow[];
  headingLevel?: 2 | 3;
  /** Fixed upper bound for percentages; count metrics compare to the leader. */
  scaleMax?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const max =
    scaleMax ?? (rows.length ? Math.max(...rows.map((r) => r.value)) : 0);
  const visible = showAll ? rows : rows.slice(0, TOP);
  const ranks = competitionRanks(rows.map((row) => row.rankValue ?? row.value));
  const viewerIdx = rows.findIndex((r) => r.isViewer);
  const pinnedViewer =
    !showAll && viewerIdx >= TOP ? rows[viewerIdx] : undefined;

  return (
    <Card id={id} className="min-w-0 scroll-mt-24 overflow-hidden">
      <CardHeader
        title={title}
        subtitle={subtitle}
        headingLevel={headingLevel}
      />
      <CardBody className="p-0">
        {rows.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">Not enough games yet.</p>
        ) : (
          <>
            <ul id={listId} className="divide-y divide-line-soft">
              {visible.map((r, i) => (
                <BoardRow key={r.id} row={r} rank={ranks[i]} max={max} />
              ))}
              {pinnedViewer ? (
                <>
                  <li
                    aria-hidden
                    className="bg-surface-2/25 px-5 py-1 text-center text-[10px] tracking-[0.3em] text-muted"
                  >
                    ⋯
                  </li>
                  <BoardRow
                    row={pinnedViewer}
                    rank={ranks[viewerIdx]}
                    max={max}
                  />
                </>
              ) : null}
            </ul>
            {rows.length > TOP ? (
              <button
                type="button"
                aria-expanded={showAll}
                aria-controls={listId}
                aria-label={`${showAll ? "Show top 5" : `Show all ${rows.length}`} ${title} leaders`}
                onClick={() => setShowAll((v) => !v)}
                className="min-h-11 w-full border-t border-line-soft bg-surface-2/20 px-5 py-2 text-center text-xs font-medium text-muted transition-colors hover:bg-surface-2/60 hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
              >
                {showAll ? "Show top 5 ↑" : `Show all ${rows.length} ↓`}
              </button>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function BoardRow({
  row: r,
  rank,
  max,
}: {
  row: LeaderBoardRow;
  rank: number;
  max: number;
}) {
  const pct = max > 0 ? Math.max(0, (r.value / max) * 100) : 0;
  return (
    <li
      className={cn(
        "group/leader min-w-0 px-4 py-3 text-sm transition-colors hover:bg-surface-2/45 sm:px-5",
        rank === 1 && "bg-accent/[0.035]",
        r.isViewer && "bg-info/[0.07]",
      )}
    >
      <div className="grid min-w-0 grid-cols-[1.5rem_1.75rem_minmax(0,1fr)_auto] items-center gap-x-2">
        <LeaderRank rank={rank} />
        <Avatar name={r.name} src={r.avatar} size={28} />
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
            {r.hasProfile === false ? (
              <span className="inline-flex min-h-11 min-w-0 items-center py-1 font-semibold leading-snug [overflow-wrap:anywhere]">
                {r.name}
              </span>
            ) : (
              <PlayerLink
                userId={r.id}
                className="inline-flex min-h-11 min-w-0 items-center py-1 font-semibold leading-snug [overflow-wrap:anywhere]"
              >
                {r.name}
              </PlayerLink>
            )}
            {r.isViewer ? (
              <span className="rounded bg-info/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-info">
                You
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {r.team ? (
              <span className="min-w-0 text-[11px] leading-snug text-muted [overflow-wrap:anywhere]">
                {r.team}
              </span>
            ) : null}
            <RankBadge rankTier={r.rankTier} />
          </div>
        </div>
        <span className="min-w-0 pl-1 text-right">
          <span
            className={cn(
              "font-display text-2xl font-semibold leading-none tabular-nums",
              rank === 1 && "text-accent",
            )}
          >
            {r.valueLabel}
          </span>
        </span>
      </div>
      <div
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-3/65"
        aria-hidden
      >
        <div
          className={cn(
            "bar-fill h-full rounded-full",
            rank === 1
              ? "bg-gradient-to-r from-accent/60 to-accent"
              : "bg-gradient-to-r from-info/65 to-cyan-300",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1.5 text-right text-[10px] leading-relaxed text-muted [overflow-wrap:anywhere]">
        {r.hint}
      </p>
    </li>
  );
}

// Top-3 get a colored medal rank (gold/silver/bronze); the rest a plain number.
function LeaderRank({ rank }: { rank: number }) {
  if (rank > 3) {
    return (
      <span className="w-6 shrink-0 text-center text-xs text-muted">
        {rank}
      </span>
    );
  }
  const tone =
    rank === 1
      ? "bg-amber-400/20 text-amber-300 ring-amber-400/40"
      : rank === 2
        ? "bg-slate-300/15 text-slate-200 ring-slate-300/40"
        : "bg-orange-500/15 text-orange-300 ring-orange-500/40";
  return (
    <span
      className={cn(
        "grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ring-1",
        tone,
      )}
    >
      {rank}
    </span>
  );
}
