"use client";

import { useState } from "react";
import type { Hero } from "@/lib/heroes";
import { HeroIcon, PlayerLink } from "@/components/ui";

export type HeroMetaTableRow = {
  hero: Hero;
  picks: number;
  wins: number;
  losses: number;
  /** Whole-number percent of picks that won. */
  winRate: number;
  /** The league player with the most games on this hero. `userId` is null
   *  for a player whose profile is gone. */
  topPlayer: { userId: string | null; name: string; games: number } | null;
};

type SortKey = "picks" | "winRate" | "name";

function compare(sort: SortKey, a: HeroMetaTableRow, b: HeroMetaTableRow) {
  const byName = a.hero.name.localeCompare(b.hero.name);
  if (sort === "name") return byName;
  if (sort === "winRate") {
    // Exact wins/picks, then the bigger sample, so a 1-0 hero sits under 5-0.
    return (
      b.wins * a.picks - a.wins * b.picks || b.picks - a.picks || byName
    );
  }
  return b.picks - a.picks || b.winRate - a.winRate || byName;
}

function gamesLabel(games: number) {
  return `${games} ${games === 1 ? "game" : "games"}`;
}

function SortHeader({
  sortKey,
  label,
  align,
  sort,
  onSort,
}: {
  sortKey: SortKey;
  label: string;
  align: "left" | "right";
  sort: SortKey;
  onSort: (key: SortKey) => void;
}) {
  const active = sort === sortKey;
  return (
    <th
      scope="col"
      aria-sort={
        active ? (sortKey === "name" ? "ascending" : "descending") : undefined
      }
      className={`py-1.5 font-medium ${align === "right" ? "px-2 text-right" : "pl-4 pr-2 text-left"}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`-mx-1 inline-flex min-h-8 items-center gap-1 rounded px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active ? "text-fg" : "hover:text-fg"}`}
      >
        {label}
        <span aria-hidden="true" className="w-2.5 text-center">
          {active ? (sortKey === "name" ? "↑" : "↓") : ""}
        </span>
      </button>
    </th>
  );
}

/** Every picked hero in one short table, sortable by picks, win % or name. */
export function HeroMetaTable({ rows }: { rows: HeroMetaTableRow[] }) {
  const [sort, setSort] = useState<SortKey>("picks");
  const sorted = [...rows].sort((a, b) => compare(sort, a, b));

  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-line bg-surface">
      <table className="w-full table-fixed text-sm">
        <caption className="sr-only">
          Heroes picked this season. Choose a column heading to sort.
        </caption>
        {/* Widths live on the cols (see StandingsTable): the phone keeps
            hero, picks and win %, with the record and top player folded
            into those cells. A display:none cell drops out of its row and
            the cells after it slide one <col> left, so on phones Win % sits
            on the THIRD col and the last two are the empty ones. */}
        <colgroup>
          <col />
          <col className="w-16 sm:w-20" />
          <col className="w-[4.5rem] sm:w-20" />
          <col className="w-0 sm:w-20" />
          <col className="w-0 sm:w-[34%]" />
        </colgroup>
        <thead className="border-b border-line bg-surface-2/60 text-xs text-muted">
          <tr>
            <SortHeader sortKey="name" label="Hero" align="left" sort={sort} onSort={setSort} />
            <SortHeader sortKey="picks" label="Picks" align="right" sort={sort} onSort={setSort} />
            <th scope="col" className="hidden px-2 py-1.5 text-right font-medium sm:table-cell">
              W–L
            </th>
            <SortHeader sortKey="winRate" label="Win %" align="right" sort={sort} onSort={setSort} />
            <th scope="col" className="hidden px-4 py-1.5 text-left font-medium sm:table-cell">
              Most played by
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {sorted.map((row) => (
            <tr key={row.hero.id}>
              <th scope="row" className="py-2 pl-4 pr-2 text-left font-normal">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span aria-hidden="true" className="flex shrink-0">
                    <HeroIcon hero={row.hero} size={28} className="rounded" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-fg">{row.hero.name}</p>
                    {row.topPlayer ? (
                      <p className="truncate text-xs text-muted sm:hidden">
                        {`Top: ${row.topPlayer.name} · ${gamesLabel(row.topPlayer.games)}`}
                      </p>
                    ) : null}
                  </div>
                </div>
              </th>
              <td className="px-2 py-2 text-right tabular-nums">{row.picks}</td>
              <td className="hidden px-2 py-2 text-right tabular-nums text-muted sm:table-cell">
                {`${row.wins}–${row.losses}`}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {row.winRate}%
                <span className="block text-xs text-muted sm:hidden">
                  {`${row.wins}–${row.losses}`}
                </span>
              </td>
              <td className="hidden px-4 py-2 sm:table-cell">
                {row.topPlayer ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    {row.topPlayer.userId ? (
                      <PlayerLink userId={row.topPlayer.userId} className="truncate font-medium">
                        {row.topPlayer.name}
                      </PlayerLink>
                    ) : (
                      <span className="truncate font-medium text-muted">{row.topPlayer.name}</span>
                    )}
                    <span className="shrink-0 text-xs text-muted">· {gamesLabel(row.topPlayer.games)}</span>
                  </span>
                ) : (
                  <span className="text-xs text-muted">No linked player</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
