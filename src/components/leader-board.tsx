"use client";

// One /leaders board, made explorable: top 5 by default with a "show all"
// toggle, the signed-in viewer's row highlighted — and pinned below the top 5
// (with their real rank) when they didn't crack it. The server precomputes
// every row and label; this component only expands/collapses.

import { useState } from "react";
import {
  Avatar,
  Card,
  CardBody,
  CardHeader,
  PlayerLink,
  RankBadge,
} from "@/components/ui";
import { cn } from "@/lib/utils";

export type LeaderBoardRow = {
  id: string;
  name: string;
  avatar: string | null;
  rankTier: number | null;
  value: number;
  valueLabel: string;
  hint: string;
  isViewer: boolean;
  /** The player's team this season, when known — shown as a muted suffix. */
  team?: string | null;
};

const TOP = 5;

export function LeaderBoard({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle?: string;
  rows: LeaderBoardRow[];
}) {
  const [showAll, setShowAll] = useState(false);
  const max = rows.length ? Math.max(...rows.map((r) => r.value)) : 0;
  const visible = showAll ? rows : rows.slice(0, TOP);
  const viewerIdx = rows.findIndex((r) => r.isViewer);
  const pinnedViewer =
    !showAll && viewerIdx >= TOP ? rows[viewerIdx] : undefined;

  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <CardBody className="p-0">
        {rows.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">Not enough games yet.</p>
        ) : (
          <>
            <ul className="divide-y divide-line/60">
              {visible.map((r, i) => (
                <BoardRow key={r.id} row={r} rank={i + 1} max={max} />
              ))}
              {pinnedViewer ? (
                <>
                  <li
                    aria-hidden
                    className="px-5 py-0.5 text-center text-[10px] tracking-[0.3em] text-muted"
                  >
                    ⋯
                  </li>
                  <BoardRow
                    row={pinnedViewer}
                    rank={viewerIdx + 1}
                    max={max}
                  />
                </>
              ) : null}
            </ul>
            {rows.length > TOP ? (
              <button
                type="button"
                aria-expanded={showAll}
                onClick={() => setShowAll((v) => !v)}
                className="w-full border-t border-line/60 px-5 py-2 text-center text-xs text-muted transition-colors hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
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
  const pct = max > 0 ? Math.max(4, Math.round((r.value / max) * 100)) : 0;
  return (
    <li
      className={cn(
        "px-5 py-2.5 text-sm",
        rank === 1 && "bg-accent/5",
        r.isViewer && "bg-info/[0.07]",
      )}
    >
      <div className="flex items-center gap-3">
        <LeaderRank rank={rank} />
        <Avatar name={r.name} src={r.avatar} size={26} />
        <span className="min-w-0 flex-1 truncate">
          <PlayerLink
            userId={r.id}
            className={cn("font-medium", rank === 1 && "font-semibold")}
          >
            {r.name}
          </PlayerLink>
          {r.isViewer ? (
            <span className="ml-1.5 rounded bg-info/20 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-info">
              You
            </span>
          ) : null}
          <RankBadge rankTier={r.rankTier} className="ml-1.5" />
          {r.team ? (
            <span className="ml-1.5 text-xs text-muted">· {r.team}</span>
          ) : null}
        </span>
        <span className="shrink-0 text-right">
          <span className="font-display text-base font-bold tabular-nums">
            {r.valueLabel}
          </span>
          <span className="block text-xs text-muted">{r.hint}</span>
        </span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn(
            "bar-fill h-full rounded-full",
            rank === 1
              ? "bg-accent"
              : rank <= 3
                ? "bg-accent/60"
                : "bg-brand/45",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </li>
  );
}

// Top-3 get a colored medal rank (gold/silver/bronze); the rest a plain number.
function LeaderRank({ rank }: { rank: number }) {
  if (rank > 3) {
    return (
      <span className="w-6 shrink-0 text-center text-xs text-muted">{rank}</span>
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
