"use client";

// The server precomputes every value and rank. This client component only
// handles the local find-player and expand controls.

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

const DEFAULT_PREVIEW_COUNT = 5;

export function LeaderBoard({
  id,
  title,
  subtitle,
  rows,
  headingLevel = 3,
  scaleMax,
  valueUnit,
  previewCount = DEFAULT_PREVIEW_COUNT,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  rows: LeaderBoardRow[];
  headingLevel?: 2 | 3;
  /** Fixed upper bound for percentages; count metrics compare to the leader. */
  scaleMax?: number;
  /** Short context displayed with every value, e.g. "team kills". */
  valueUnit?: string;
  /** How many leaders appear before the board expands. */
  previewCount?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const listId = useId();
  const searchId = useId();
  const max =
    scaleMax ?? (rows.length ? Math.max(...rows.map((r) => r.value)) : 0);
  const ranks = competitionRanks(rows.map((row) => row.rankValue ?? row.value));
  const matchedIndexes = query.trim()
    ? rows.flatMap((row, index) =>
        `${row.name} ${row.team ?? ""}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())
          ? [index]
          : [],
      )
    : [];
  const visibleIndexes = query.trim()
    ? matchedIndexes
    : showAll
      ? rows.map((_, index) => index)
      : rows.slice(0, previewCount).map((_, index) => index);
  const viewerIdx = rows.findIndex((r) => r.isViewer);
  const pinnedViewer =
    !query.trim() && !showAll && viewerIdx >= previewCount
      ? rows[viewerIdx]
      : undefined;

  return (
    <Card id={id} className="min-w-0 scroll-mt-24 overflow-hidden">
      <CardHeader
        title={title}
        subtitle={subtitle}
        headingLevel={headingLevel}
        action={
          rows.length > previewCount ? (
            <button
              type="button"
              aria-expanded={showSearch}
              aria-controls={searchId}
              onClick={() => {
                setShowSearch((open) => !open);
                setQuery("");
              }}
              className="min-h-11 rounded-lg border border-line px-3 text-xs font-medium text-muted transition-colors hover:border-info/50 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
            >
              {showSearch ? "Close search" : "Find player"}
            </button>
          ) : undefined
        }
      />
      <CardBody className="p-0">
        <div
          id={searchId}
          hidden={!showSearch}
          className="border-b border-line-soft bg-surface-2/25 px-4 py-3 sm:px-5"
        >
          <label
            htmlFor={`${searchId}-input`}
            className="mb-1.5 block text-xs font-medium text-muted"
          >
            Find a player or team in {title.toLocaleLowerCase()}
          </label>
          <input
            id={`${searchId}-input`}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or team"
            className="min-h-11 w-full rounded-lg border border-line bg-bg px-3 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
          />
          {query.trim() ? (
            <p className="mt-1.5 text-xs text-muted" aria-live="polite">
              {matchedIndexes.length}{" "}
              {matchedIndexes.length === 1 ? "player" : "players"} found ·
              original season ranks shown
            </p>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">
            No eligible players for this metric yet.
          </p>
        ) : (
          <>
            <ul id={listId} className="divide-y divide-line-soft">
              {visibleIndexes.map((index) => (
                <BoardRow
                  key={rows[index].id}
                  row={rows[index]}
                  rank={ranks[index]}
                  max={max}
                  valueUnit={valueUnit}
                />
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
                    valueUnit={valueUnit}
                  />
                </>
              ) : null}
            </ul>
            {query.trim() && visibleIndexes.length === 0 ? (
              <p className="px-5 py-5 text-sm text-muted">
                No player or team matches that search.
              </p>
            ) : null}
            {rows.length > previewCount && !query.trim() ? (
              <button
                type="button"
                aria-expanded={showAll}
                aria-controls={listId}
                aria-label={`${showAll ? `Show top ${previewCount}` : `Show all ${rows.length}`} ${title} leaders`}
                onClick={() => setShowAll((v) => !v)}
                className="min-h-11 w-full border-t border-line-soft bg-surface-2/20 px-5 py-2 text-center text-xs font-medium text-muted transition-colors hover:bg-surface-2/60 hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
              >
                {showAll ? `Show top ${previewCount} ↑` : `Show all ${rows.length} ↓`}
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
  valueUnit,
}: {
  row: LeaderBoardRow;
  rank: number;
  max: number;
  valueUnit?: string;
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
          {valueUnit ? (
            <span className="mt-0.5 block text-[10px] leading-tight text-muted">
              {valueUnit}
            </span>
          ) : null}
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
      <p className="mt-1.5 text-right text-[11px] leading-relaxed text-muted [overflow-wrap:anywhere]">
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
        <span className="sr-only">Rank </span>{rank}
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
      <span className="sr-only">Rank </span>{rank}
    </span>
  );
}
