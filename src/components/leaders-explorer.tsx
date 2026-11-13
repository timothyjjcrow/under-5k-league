"use client";

// /leaders' rankings: one list of players that any stat can rank. The server
// works out every value, its minimum and who may rank (leader-table.ts); this
// component only picks the stat, filters and opens a player's card. It
// replaces nine separate boards that each showed three rows: the same players
// nine times over, and no way to see one player's whole line.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "@/components/app-link";
import {
  Avatar,
  Card,
  LinkArrow,
  PlayerLink,
  RankBadge,
  textLink,
} from "@/components/ui";
import { HeroIcon } from "@/components/hero-icon";
import type { Hero } from "@/lib/heroes";
import { rankByCell } from "@/lib/leader-ranking";
import type { LeaderCell, LeaderStat } from "@/lib/leader-table";
import { cn } from "@/lib/utils";

export type LeadersExplorerPlayer = {
  id: string;
  name: string;
  avatar: string | null;
  rankTier: number | null;
  /** False for a historical line whose User row no longer exists. */
  hasProfile: boolean;
  /** The player's team this season, when rostered. */
  team: string | null;
  isViewer: boolean;
  /** One per stat, in the stats' order; null where they have no value. */
  cells: (LeaderCell | null)[];
  heroes: { hero: Hero; games: number; wins: number }[];
};

/** Leaders shown before the list expands. */
const PREVIEW_COUNT = 10;

/**
 * One row's grid. Below xl: rank, avatar, the name, the ranked stat, the
 * card toggle. From xl every stat gets a column (`--stat-cols` of them), so
 * a player's whole line reads across.
 */
const ROW_GRID =
  "grid items-center gap-x-2 grid-cols-[1.5rem_1.75rem_minmax(0,1fr)_auto_2.75rem] xl:grid-cols-[1.75rem_1.75rem_minmax(0,1fr)_repeat(var(--stat-cols),minmax(0,4.75rem))_2.75rem]";

const FIELD =
  "h-11 min-w-0 rounded-lg border border-line bg-surface-2/50 px-3 text-sm text-fg outline-none focus:border-accent/60 sm:h-10";

export function LeadersExplorer({
  stats,
  players,
  initialStat = 0,
  compareWith,
}: {
  stats: LeaderStat[];
  players: LeadersExplorerPlayer[];
  /** Index into `stats` the page opens on (the `?stat=` link). */
  initialStat?: number;
  /** The viewer's id when they have a career to compare; null otherwise. */
  compareWith: string | null;
}) {
  const [statIndex, setStatIndex] = useState(initialStat);
  const [team, setTeam] = useState("");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const listId = useId();
  // A phone scrolls the tiles sideways: keep the ranked one on screen (a
  // `?stat=` link can open on a tile past the edge). Only the strip's own
  // scroll moves, never the page.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = strip.current;
    const tile = box?.children[statIndex] as HTMLElement | undefined;
    if (!box || !tile) return;
    const left = tile.offsetLeft - box.offsetLeft;
    if (left < box.scrollLeft || left + tile.offsetWidth > box.scrollLeft + box.clientWidth) {
      box.scrollLeft = Math.max(0, left - 8);
    }
  }, [statIndex]);

  // Every stat's ranking, once: the list's order, the tiles' leaders and each
  // player's place in the stats that aren't on screen.
  const rankings = useMemo(
    () =>
      stats.map((_, index) => {
        const order = rankByCell(players, (player) => player.cells[index]);
        return {
          order,
          rankOf: new Map(order.map(({ row, rank }) => [row.id, rank])),
        };
      }),
    [stats, players],
  );
  const teams = useMemo(
    () =>
      [...new Set(players.flatMap((player) => (player.team ? [player.team] : [])))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [players],
  );

  const stat = stats[statIndex];
  const ranking = rankings[statIndex];
  const needle = query.trim().toLowerCase();
  const filtering = team !== "" || needle !== "";
  const matches = (player: LeadersExplorerPlayer) =>
    (team === "" || player.team === team) &&
    (needle === "" || player.name.toLowerCase().includes(needle));

  const ranked = ranking.order
    .filter(({ row }) => matches(row))
    .map(({ row, rank }) => ({ player: row, rank: rank as number | null }));
  // Players under the stat's minimum follow the ranking, unplaced: a search
  // for one of them must not come back empty.
  const unranked = players
    .filter((player) => !ranking.rankOf.has(player.id) && matches(player))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((player) => ({ player, rank: null as number | null }));
  const everyone = [...ranked, ...unranked];
  const expanded = showAll || filtering;
  const visible = expanded ? everyone : ranked.slice(0, PREVIEW_COUNT);
  const viewerEntry = ranked.find(({ player }) => player.isViewer);
  const pinnedViewer =
    !expanded && viewerEntry && !visible.includes(viewerEntry)
      ? viewerEntry
      : null;
  const scale =
    stat.scaleMax ?? ranking.order[0]?.row.cells[statIndex]?.value ?? 0;

  function pickStat(index: number) {
    setStatIndex(index);
    // Keep the choice in the address, so a ranking can be linked.
    const url = new URL(window.location.href);
    if (index === 0) url.searchParams.delete("stat");
    else url.searchParams.set("stat", stats[index].key);
    window.history.replaceState(null, "", url);
  }

  const row = (entry: { player: LeadersExplorerPlayer; rank: number | null }) => (
    <PlayerRow
      key={entry.player.id}
      player={entry.player}
      rank={entry.rank}
      stats={stats}
      statIndex={statIndex}
      scale={scale}
      rankings={rankings}
      open={openId === entry.player.id}
      onToggle={() =>
        setOpenId((current) =>
          current === entry.player.id ? null : entry.player.id,
        )
      }
      compareWith={compareWith}
    />
  );

  return (
    <div
      className="space-y-3"
      style={{ "--stat-cols": stats.length } as React.CSSProperties}
    >
      {/* One tile per stat, naming its leader: the page's "who leads what",
          and the control that ranks the list. A phone scrolls the strip
          sideways (ten tiles in rows of three would be 300px); from sm they
          wrap and stretch to fill each row. */}
      <div className="overflow-hidden">
        <div
          ref={strip}
          role="group"
          aria-label="Rank players by"
          className="flex gap-2 overflow-x-auto p-px pb-1.5 [scrollbar-width:thin] sm:flex-wrap sm:overflow-visible sm:pb-px"
        >
          {stats.map((option, index) => {
            const leaders = rankings[index].order.filter(
              ({ rank }) => rank === 1,
            );
            const lead = leaders[0]?.row;
            const active = index === statIndex;
            return (
              <button
                key={option.key}
                type="button"
                aria-pressed={active}
                onClick={() => pickStat(index)}
                className={cn(
                  "min-w-0 shrink-0 basis-[6.75rem] rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none sm:flex-[1_1_6.75rem]",
                  active
                    ? "border-accent/60 bg-surface-3 ring-1 ring-inset ring-accent/40"
                    : "border-line bg-surface hover:border-muted/60 hover:bg-surface-2/70",
                )}
              >
                <span
                  className={cn(
                    "block truncate text-[11px] font-semibold uppercase tracking-wide",
                    active ? "text-accent" : "text-muted",
                  )}
                >
                  {option.label}
                </span>
                <span className="block font-display text-xl font-semibold leading-tight tabular-nums text-fg">
                  {lead?.cells[index]?.label ?? "–"}
                </span>
                <span className="block truncate text-xs text-muted">
                  {leaders.length === 0
                    ? "No one yet"
                    : leaders.length === 1
                      ? lead.name
                      : `${leaders.length} tied`}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-line-soft px-4 py-3">
          <div className="min-w-0 flex-1 basis-64">
            <h3
              id={`${listId}-title`}
              className="text-[0.9375rem] font-semibold leading-snug text-fg"
            >
              {stat.title}
            </h3>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
              {stat.description}
              {stat.minimum ? ` ${stat.minimum}.` : ""}
            </p>
          </div>
          <div className="flex min-w-0 flex-1 basis-64 gap-2 sm:max-w-md">
            {teams.length > 1 ? (
              <select
                aria-label="Team"
                value={team}
                onChange={(event) => setTeam(event.target.value)}
                className={cn(FIELD, "flex-1")}
              >
                <option value="">All teams</option>
                {teams.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : null}
            <input
              type="search"
              aria-label="Find a player"
              placeholder="Find a player"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={cn(FIELD, "flex-1 placeholder:text-muted/70")}
            />
          </div>
        </div>

        {/* Column headings, from xl: each one ranks the list by its stat. */}
        <div
          className={cn(
            ROW_GRID,
            "hidden border-b border-line bg-surface-2/60 px-4 py-1 text-xs text-muted xl:grid",
          )}
        >
          <span className="col-span-3 font-medium">Player</span>
          {stats.map((option, index) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={index === statIndex}
              aria-label={`Rank by ${option.title}`}
              title={option.title}
              onClick={() => pickStat(index)}
              className={cn(
                "inline-flex min-h-8 min-w-0 items-center justify-end gap-0.5 rounded px-1 text-right font-medium leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                index === statIndex ? "text-accent" : "hover:text-fg",
              )}
            >
              <span className="min-w-0">{option.label}</span>
              {index === statIndex ? <span aria-hidden="true">↓</span> : null}
            </button>
          ))}
          <span />
        </div>

        {everyone.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">
            {filtering
              ? "No player matches that. Clear the team or the search to see everyone."
              : "No eligible players for this ranking yet."}
          </p>
        ) : (
          <ol
            id={listId}
            aria-labelledby={`${listId}-title`}
            className="divide-y divide-line-soft"
          >
            {ranked.length === 0 && !expanded ? (
              <li className="px-4 py-3 text-sm text-muted">
                Nobody has reached this ranking&apos;s minimum yet.
              </li>
            ) : null}
            {visible.map((entry, index) => (
              <FragmentWithDivider
                key={entry.player.id}
                divider={
                  entry.rank === null &&
                  (index === 0 || visible[index - 1].rank !== null)
                }
              >
                {row(entry)}
              </FragmentWithDivider>
            ))}
            {pinnedViewer ? (
              <>
                <li
                  aria-hidden
                  className="bg-surface-2/25 px-4 py-1 text-center text-[10px] tracking-[0.3em] text-muted"
                >
                  ⋯
                </li>
                {row(pinnedViewer)}
              </>
            ) : null}
          </ol>
        )}

        {!filtering && everyone.length > PREVIEW_COUNT ? (
          <button
            type="button"
            aria-expanded={showAll}
            aria-controls={listId}
            onClick={() => setShowAll((value) => !value)}
            className="min-h-11 w-full border-t border-line-soft bg-surface-2/20 px-4 py-2 text-center text-sm font-medium text-muted transition-colors hover:bg-surface-2/60 hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-info/60 sm:min-h-10"
          >
            {showAll
              ? `Show top ${PREVIEW_COUNT} ↑`
              : `Show all ${everyone.length} players ↓`}
          </button>
        ) : null}
      </Card>
      <p className="text-xs leading-relaxed text-muted">
        From complete 5v5 box scores. Equal values share a place, and a dimmed
        figure is below its ranking&apos;s minimum, so it holds no place there.
      </p>
    </div>
  );
}

function FragmentWithDivider({
  divider,
  children,
}: {
  divider: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      {divider ? (
        <li className="bg-surface-2/40 px-4 py-1.5 text-xs font-medium text-muted">
          Below this ranking&apos;s minimum
        </li>
      ) : null}
      {children}
    </>
  );
}

type Rankings = {
  order: { row: LeadersExplorerPlayer; rank: number }[];
  rankOf: Map<string, number>;
}[];

function PlayerRow({
  player,
  rank,
  stats,
  statIndex,
  scale,
  rankings,
  open,
  onToggle,
  compareWith,
}: {
  player: LeadersExplorerPlayer;
  /** Their place in the ranked stat; null below its minimum. */
  rank: number | null;
  stats: LeaderStat[];
  statIndex: number;
  scale: number;
  rankings: Rankings;
  open: boolean;
  onToggle: () => void;
  compareWith: string | null;
}) {
  const panelId = useId();
  const cell = player.cells[statIndex];
  const percent =
    cell && rank !== null && scale > 0
      ? Math.max(0, Math.min(100, (cell.value / scale) * 100))
      : 0;
  return (
    <li
      className={cn(
        "transition-colors motion-reduce:transition-none",
        rank === 1 && "bg-accent/[0.035]",
        player.isViewer && "bg-info/[0.07]",
      )}
    >
      <div className={cn(ROW_GRID, "px-3 py-2 text-sm sm:px-4")}>
        <PlaceMark rank={rank} />
        <Avatar name={player.name} src={player.avatar} size={28} />
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
            {player.hasProfile ? (
              <PlayerLink
                userId={player.id}
                className="min-w-6 font-semibold leading-snug [overflow-wrap:anywhere]"
              >
                {player.name}
              </PlayerLink>
            ) : (
              <span className="min-w-0 font-semibold leading-snug [overflow-wrap:anywhere]">
                {player.name}
              </span>
            )}
            {player.isViewer ? (
              <span className="rounded bg-info/15 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-info-soft">
                You
              </span>
            ) : null}
            <RankBadge rankTier={player.rankTier} />
          </div>
          {/* "Team · hint", one part per "·" segment: each part carries its
              dot in its own left padding and the line is pulled left by that
              width and clipped, so a wrapped part starts clean. From xl the
              columns carry the numbers, so only the team stays. */}
          <div className="mt-0.5 overflow-hidden text-[11px] leading-snug text-muted">
            <div className="-ml-3 flex flex-wrap">
              {[player.team, ...(cell ? cell.hint.split(" · ") : [])].map(
                (part, index) =>
                  part ? (
                    <span
                      key={index}
                      className={cn(
                        "relative min-w-0 pl-3 tabular-nums [overflow-wrap:anywhere] before:absolute before:left-0 before:w-3 before:text-center before:content-['·']",
                        index > 0 && "xl:hidden",
                      )}
                    >
                      {part}
                    </span>
                  ) : null,
              )}
            </div>
          </div>
          <div
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3/65"
            aria-hidden
          >
            <div
              // Keyed by the stat, so the bar grows again on a new ranking.
              key={statIndex}
              className={cn(
                "bar-fill h-full rounded-full",
                rank === 1
                  ? "bg-gradient-to-r from-accent/60 to-accent"
                  : "bg-gradient-to-r from-info/65 to-cyan-300",
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
        {stats.map((option, index) => {
          const value = player.cells[index];
          const active = index === statIndex;
          return (
            <span
              key={option.key}
              className={cn(
                "min-w-0 text-right tabular-nums",
                active ? "pl-1 xl:pl-0" : "hidden xl:block",
              )}
            >
              <span className="sr-only">{option.title}: </span>
              <span
                className={cn(
                  active
                    ? "font-display text-xl font-semibold leading-none"
                    : "text-sm",
                  !value || !value.ranked
                    ? "text-muted/60"
                    : active
                      ? rank === 1
                        ? "text-accent"
                        : "text-fg"
                      : "text-fg/85",
                )}
              >
                {value?.label ?? "–"}
              </span>
              {active ? (
                <span className="mt-0.5 block text-[10px] leading-tight text-muted xl:hidden">
                  {option.unit}
                </span>
              ) : null}
            </span>
          );
        })}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${open ? "Hide" : "Show"} ${player.name}'s full line`}
          onClick={onToggle}
          className="grid h-11 w-11 place-items-center justify-self-end rounded-lg text-muted hover:bg-surface-2/70 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            fill="none"
            className={cn(
              "h-4 w-4 transition-transform motion-reduce:transition-none",
              open && "rotate-180",
            )}
          >
            <path
              d="m4 6 4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {open ? (
        <div
          id={panelId}
          className="space-y-3 border-t border-line-soft bg-surface-2/30 px-4 py-3"
        >
          {/* The player's whole line with their place in each ranking: on a
              phone this is the only place the other stats show. */}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
            {stats.map((option, index) => {
              const value = player.cells[index];
              const place = rankings[index].rankOf.get(player.id);
              return (
                <div key={option.key} className="min-w-0">
                  <dt className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted">
                    {option.label}
                  </dt>
                  <dd className="mt-0.5">
                    <span className="font-display text-lg font-semibold leading-none tabular-nums text-fg">
                      {value?.label ?? "–"}
                    </span>
                    <span className="ml-1.5 text-xs text-muted">
                      {place !== undefined
                        ? `#${place} of ${rankings[index].order.length}`
                        : value
                          ? "below the minimum"
                          : "no data"}
                    </span>
                    {value ? (
                      <span className="mt-0.5 block text-xs leading-snug text-muted [overflow-wrap:anywhere]">
                        {value.hint}
                      </span>
                    ) : null}
                  </dd>
                </div>
              );
            })}
          </dl>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line-soft pt-3">
            {player.heroes.length > 0 ? (
              <ul
                aria-label={`${player.name}'s most-played heroes`}
                className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted"
              >
                {player.heroes.map(({ hero, games, wins }) => (
                  <li key={hero.id} className="flex min-w-0 items-center gap-1.5">
                    <span aria-hidden="true" className="flex shrink-0">
                      <HeroIcon hero={hero} size={22} className="rounded" />
                    </span>
                    <span className="min-w-0 truncate text-fg">{hero.name}</span>
                    <span className="shrink-0 tabular-nums">
                      {wins}–{games - wins}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {player.hasProfile ? (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                <Link
                  href={
                    compareWith && compareWith !== player.id
                      ? `/players/compare?${new URLSearchParams({ a: compareWith, b: player.id })}`
                      : `/players/compare?${new URLSearchParams({ a: player.id })}`
                  }
                  className={textLink("font-medium")}
                >
                  {compareWith && compareWith !== player.id
                    ? "Compare with you"
                    : "Compare with a player"}{" "}
                  <LinkArrow />
                </Link>
                <Link
                  href={`/players/${player.id}`}
                  prefetch={false}
                  className={textLink("font-medium")}
                >
                  Full profile <LinkArrow />
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** Top three get a medal (gold, silver, bronze); a null rank holds no place. */
function PlaceMark({ rank }: { rank: number | null }) {
  if (rank === null) {
    return (
      <span className="w-6 shrink-0 text-center text-xs text-muted">
        <span className="sr-only">Unranked</span>
        <span aria-hidden="true">–</span>
      </span>
    );
  }
  if (rank > 3) {
    return (
      <span className="w-6 shrink-0 text-center text-xs text-muted">
        <span className="sr-only">Rank </span>
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
      <span className="sr-only">Rank </span>
      {rank}
    </span>
  );
}
