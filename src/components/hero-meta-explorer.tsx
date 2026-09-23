"use client";

import { useId, useMemo, useState } from "react";
import type { Hero } from "@/lib/heroes";
import type { HeroMetaRow } from "@/lib/hero-meta";
import { HeroIcon, PlayerLink } from "@/components/ui";

export type HeroMetaEntry = {
  hero: Hero;
  stats: HeroMetaRow | null;
  topPlayerName: string;
  topPlayerUserId: string | null;
};

type View = "all" | "established" | "early" | "unpicked";
type Sort = "picks" | "winRate" | "assists" | "kda" | "name";

function picksOf(entry: HeroMetaEntry): number {
  return entry.stats?.picks ?? 0;
}

function winFraction(entry: HeroMetaEntry): number {
  return entry.stats ? entry.stats.wins / entry.stats.picks : -1;
}

function Spotlight({
  label,
  entry,
  value,
  detail,
  onExplore,
}: {
  label: string;
  entry: HeroMetaEntry | undefined;
  value: string;
  detail: string;
  onExplore: (entry: HeroMetaEntry) => void;
}) {
  return (
    <div className="relative flex min-h-44 flex-col justify-between overflow-hidden rounded-xl border border-line bg-surface p-4 shadow-sm shadow-black/10 sm:p-5">
      <div className="pointer-events-none absolute -right-10 -top-14 h-36 w-36 rounded-full bg-accent/5 blur-2xl" />
      <p className="relative text-xs font-semibold uppercase tracking-[0.16em] text-accent">
        {label}
      </p>
      {entry ? (
        <>
          <div className="relative mt-4 flex items-center gap-3">
            <HeroIcon hero={entry.hero} size={48} className="rounded-lg" />
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-fg">
                {entry.hero.name}
              </p>
              <p className="font-display text-2xl font-semibold tabular-nums text-fg">
                {value}
              </p>
            </div>
          </div>
          <div className="relative mt-4 flex flex-wrap items-end justify-between gap-2">
            <p className="max-w-56 text-xs leading-relaxed text-muted">
              {detail}
            </p>
            <a
              href="#explore-heroes"
              onClick={() => onExplore(entry)}
              className="rounded-md px-1 py-1 text-xs font-semibold text-info hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Explore →
            </a>
          </div>
        </>
      ) : (
        <div className="relative mt-4">
          <p className="font-display text-xl font-semibold text-fg">
            Still forming
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted">{detail}</p>
        </div>
      )}
    </div>
  );
}

function HeroCard({
  entry,
  games,
  minPicks,
  expanded,
  onToggle,
}: {
  entry: HeroMetaEntry;
  games: number;
  minPicks: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { hero, stats } = entry;
  const detailId = "hero-meta-detail-" + hero.id;
  const isEstablished = Boolean(stats && stats.picks >= minPicks);

  return (
    <article
      className={
        "min-w-0 rounded-xl border bg-surface transition-colors " +
        (expanded ? "border-accent/60" : "border-line hover:border-muted/60")
      }
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={expanded ? detailId : undefined}
        className="block w-full rounded-xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent sm:p-5"
      >
        <span className="flex items-start gap-3">
          <HeroIcon hero={hero} size={44} className="rounded-lg" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-fg">
              {hero.name}
            </span>
            <span className="mt-0.5 block text-xs text-muted">
              {stats
                ? stats.picks +
                  (stats.picks === 1 ? " pick" : " picks") +
                  " · " +
                  stats.pickRate +
                  "% of games"
                : "No recorded picks"}
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block font-display text-2xl font-semibold tabular-nums text-fg">
              {stats ? stats.winRate + "%" : "—"}
            </span>
            <span className="block text-[11px] text-muted">win rate</span>
          </span>
        </span>
        {stats ? (
          <>
            <span className="mt-4 flex items-center justify-between gap-2 text-xs text-muted">
              <span className="tabular-nums">
                {stats.wins} W · {stats.losses} L
              </span>
              <span>
                {isEstablished ? "Established sample" : "Early sample"}
              </span>
            </span>
            <span
              className="mt-2 block h-1.5 overflow-hidden rounded-full bg-surface-3"
              aria-hidden="true"
            >
              <span
                className={
                  "block h-full rounded-full " +
                  (isEstablished ? "bg-accent" : "bg-info")
                }
                style={{
                  width: Math.max(2, stats.pickRate) + "%",
                }}
              />
            </span>
          </>
        ) : (
          <span className="mt-4 block text-xs text-muted">
            Outside the season&apos;s picked pool
          </span>
        )}
        <span className="mt-3 block text-right text-xs font-medium text-info">
          {expanded ? "Hide details ↑" : "View details ↓"}
        </span>
      </button>
      {expanded ? (
        <div
          id={detailId}
          className="border-t border-line-soft px-4 pb-5 pt-4 sm:px-5"
        >
          {stats ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ["Kills / pick", stats.killsPerPick],
                  ["Deaths / pick", stats.deathsPerPick],
                  ["Assists / pick", stats.assistsPerPick],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-surface-2/70 p-2.5">
                    <p className="text-[11px] text-muted">{label}</p>
                    <p className="mt-1 font-display text-lg font-semibold tabular-nums">
                      {Number(value).toFixed(1)}
                    </p>
                  </div>
                ))}
              </div>
              <dl className="mt-4 space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Win rate</dt>
                  <dd className="text-right tabular-nums">
                    {stats.wins} wins / {stats.picks} picks
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Pick rate</dt>
                  <dd className="text-right tabular-nums">
                    {stats.pickRate}% of {games} eligible games
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">KDA ratio</dt>
                  <dd className="text-right tabular-nums">
                    {stats.kda.toFixed(1)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">League players mapped</dt>
                  <dd className="text-right tabular-nums">
                    {stats.mappedPlayers}
                  </dd>
                </div>
              </dl>
              {stats.topPlayer ? (
                <p className="mt-4 border-t border-line-soft pt-3 text-xs leading-relaxed text-muted">
                  Most games on {hero.name}:{" "}
                  {entry.topPlayerUserId ? (
                    <PlayerLink
                      userId={entry.topPlayerUserId}
                      className="font-medium text-fg hover:text-info"
                    >
                      {entry.topPlayerName}
                    </PlayerLink>
                  ) : (
                    <span className="font-medium text-fg">
                      {entry.topPlayerName}
                    </span>
                  )}{" "}
                  · {stats.topPlayer.games}{" "}
                  {stats.topPlayer.games === 1 ? "pick" : "picks"},{" "}
                  {stats.topPlayer.wins} wins
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm leading-relaxed text-muted">
              No eligible game featured {hero.name}. Try the other pool filters
              to see how league picks performed.
            </p>
          )}
        </div>
      ) : null}
    </article>
  );
}

export function HeroMetaExplorer({
  rows,
  games,
  importedGames,
  minPicks,
}: {
  rows: HeroMetaEntry[];
  games: number;
  importedGames: number;
  minPicks: number;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("all");
  const [sort, setSort] = useState<Sort>("picks");
  const [shown, setShown] = useState(12);
  const [expandedHeroId, setExpandedHeroId] = useState<number | null>(null);

  const picked = rows.filter((entry) => entry.stats);
  const established = picked.filter((entry) => picksOf(entry) >= minPicks);
  const early = picked.filter((entry) => picksOf(entry) < minPicks);
  const untouched = rows.length - picked.length;
  const totalPicks = picked.reduce((sum, entry) => sum + picksOf(entry), 0);
  const mostPicked = [...picked].sort(
    (a, b) => picksOf(b) - picksOf(a) || a.hero.name.localeCompare(b.hero.name),
  )[0];
  const bestResult = [...established].sort(
    (a, b) =>
      winFraction(b) - winFraction(a) ||
      picksOf(b) - picksOf(a) ||
      a.hero.name.localeCompare(b.hero.name),
  )[0];
  const assistLeader = [...established].sort(
    (a, b) =>
      (b.stats?.assistsPerPick ?? 0) - (a.stats?.assistsPerPick ?? 0) ||
      picksOf(b) - picksOf(a) ||
      a.hero.name.localeCompare(b.hero.name),
  )[0];

  const matches = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return rows
      .filter((entry) => {
        if (query && !entry.hero.name.toLocaleLowerCase().includes(query)) {
          return false;
        }
        const picks = picksOf(entry);
        if (view === "established") return picks >= minPicks;
        if (view === "early") return picks > 0 && picks < minPicks;
        if (view === "unpicked") return picks === 0;
        return true;
      })
      .sort((a, b) => {
        const aStats = a.stats;
        const bStats = b.stats;
        const primary =
          sort === "name"
            ? a.hero.name.localeCompare(b.hero.name)
            : sort === "winRate"
              ? winFraction(b) - winFraction(a)
              : sort === "assists"
                ? (bStats?.assistsPerPick ?? -1) -
                  (aStats?.assistsPerPick ?? -1)
                : sort === "kda"
                  ? (bStats?.kda ?? -1) - (aStats?.kda ?? -1)
                  : picksOf(b) - picksOf(a);
        return (
          primary ||
          picksOf(b) - picksOf(a) ||
          a.hero.name.localeCompare(b.hero.name)
        );
      });
  }, [rows, search, view, sort, minPicks]);

  function explore(entry: HeroMetaEntry) {
    setSearch(entry.hero.name);
    setView("all");
    setShown(12);
    setExpandedHeroId(entry.hero.id);
  }

  const fieldClasses =
    "min-h-11 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg placeholder:text-muted/70";
  const views: { key: View; label: string; count: number }[] = [
    { key: "all", label: "All heroes", count: rows.length },
    { key: "established", label: "Established", count: established.length },
    { key: "early", label: "Early reads", count: early.length },
    { key: "unpicked", label: "Untouched", count: untouched },
  ];

  return (
    <div className="space-y-8">
      <section
        aria-labelledby="meta-pulse-heading"
        className="overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-surface-3 via-surface to-bg p-5 shadow-lg shadow-black/10 sm:p-7"
      >
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
              Season snapshot
            </p>
            <h2
              id="meta-pulse-heading"
              className="mt-2 font-display text-2xl font-semibold tracking-tight text-fg sm:text-3xl"
            >
              What the league is actually picking
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Follow the popular picks, see which heroes win with a real
              sample, and inspect the numbers behind each result.
            </p>
          </div>
          <a
            href="#explore-heroes"
            className="inline-flex min-h-10 items-center rounded-lg border border-accent/50 bg-accent/10 px-3 text-sm font-semibold text-accent hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Explore heroes ↓
          </a>
        </div>
        <div className="mt-7 grid grid-cols-2 gap-3 border-t border-line/70 pt-5 sm:grid-cols-4">
          <div>
            <p className="font-display text-2xl font-semibold tabular-nums text-fg">
              {games}
              <span className="text-base text-muted"> / {importedGames}</span>
            </p>
            <p className="mt-1 text-xs text-muted">eligible games</p>
          </div>
          <div>
            <p className="font-display text-2xl font-semibold tabular-nums text-fg">
              {picked.length}
              <span className="text-base text-muted"> / {rows.length}</span>
            </p>
            <p className="mt-1 text-xs text-muted">heroes seen</p>
          </div>
          <div>
            <p className="font-display text-2xl font-semibold tabular-nums text-fg">
              {totalPicks}
            </p>
            <p className="mt-1 text-xs text-muted">picks recorded</p>
          </div>
          <div>
            <p className="font-display text-2xl font-semibold tabular-nums text-fg">
              {minPicks}+
            </p>
            <p className="mt-1 text-xs text-muted">picks for win leaders</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="meta-stories-heading">
        <div className="mb-4">
          <h2
            id="meta-stories-heading"
            className="font-display text-xl font-semibold text-fg sm:text-2xl"
          >
            The meta, at a glance
          </h2>
          <p className="mt-1 text-sm text-muted">
            Three ways to read this season beyond a raw win-rate list.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Spotlight
            label="Most in demand"
            entry={mostPicked}
            value={mostPicked?.stats ? mostPicked.stats.picks + " picks" : ""}
            detail={
              mostPicked?.stats
                ? "Featured in " +
                  mostPicked.stats.pickRate +
                  "% of eligible games; " +
                  mostPicked.stats.wins +
                  " wins."
                : "The first imported match will reveal the league favorite."
            }
            onExplore={explore}
          />
          <Spotlight
            label="Best results"
            entry={bestResult}
            value={bestResult?.stats ? bestResult.stats.winRate + "% wins" : ""}
            detail={
              bestResult?.stats
                ? bestResult.stats.wins +
                  " wins in " +
                  bestResult.stats.picks +
                  " picks. Minimum " +
                  minPicks +
                  " picks."
                : "No hero has reached the " + minPicks + "-pick minimum yet."
            }
            onExplore={explore}
          />
          <Spotlight
            label="Assist leader"
            entry={assistLeader}
            value={
              assistLeader?.stats
                ? assistLeader.stats.assistsPerPick.toFixed(1) + " / pick"
                : ""
            }
            detail={
              assistLeader
                ? "Most assists per appearance among heroes with " +
                  minPicks +
                  "+ picks."
                : "Assist leaders need " +
                  minPicks +
                  " picks before appearing here."
            }
            onExplore={explore}
          />
        </div>
      </section>

      <section
        id="explore-heroes"
        aria-labelledby="explore-heroes-heading"
        className="scroll-mt-24"
      >
        <div className="mb-4">
          <h2
            id="explore-heroes-heading"
            className="font-display text-xl font-semibold text-fg sm:text-2xl"
          >
            Explore the hero pool
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
            Search the full catalogue, filter by sample size, and open any hero
            for per-pick combat stats and player context.
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem]">
            <label
              htmlFor={id + "-search"}
              className="block space-y-1.5 text-xs font-medium text-muted"
            >
              <span>Find a hero</span>
              <input
                id={id + "-search"}
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setShown(12);
                }}
                className={fieldClasses}
                placeholder="Search hero name…"
              />
            </label>
            <label
              htmlFor={id + "-sort"}
              className="block space-y-1.5 text-xs font-medium text-muted"
            >
              <span>Sort by</span>
              <select
                id={id + "-sort"}
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value as Sort);
                  setShown(12);
                }}
                className={fieldClasses}
              >
                <option value="picks">Most picked</option>
                <option value="winRate">Win rate</option>
                <option value="assists">Assists per pick</option>
                <option value="kda">KDA</option>
                <option value="name">Hero name</option>
              </select>
            </label>
          </div>
          <div
            role="group"
            aria-label="Hero sample filter"
            className="mt-4 flex flex-wrap gap-2"
          >
            {views.map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={view === option.key}
                onClick={() => {
                  setView(option.key);
                  setShown(12);
                }}
                className={
                  "min-h-10 rounded-lg border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
                  (view === option.key
                    ? "border-accent/60 bg-accent/15 text-accent"
                    : "border-line bg-surface-2 text-muted hover:text-fg")
                }
              >
                {option.label}{" "}
                <span className="ml-1 tabular-nums opacity-75">
                  {option.count}
                </span>
              </button>
            ))}
          </div>
          <p role="status" className="mt-4 text-xs text-muted">
            Showing {Math.min(shown, matches.length)} of {matches.length} matching
            heroes. Established means at least {minPicks} picks.
          </p>
        </div>
        {matches.length ? (
          <>
            <div className="mt-4 grid items-start gap-3 md:grid-cols-2">
              {matches.slice(0, shown).map((entry) => (
                <HeroCard
                  key={entry.hero.id}
                  entry={entry}
                  games={games}
                  minPicks={minPicks}
                  expanded={expandedHeroId === entry.hero.id}
                  onToggle={() =>
                    setExpandedHeroId(
                      expandedHeroId === entry.hero.id ? null : entry.hero.id,
                    )
                  }
                />
              ))}
            </div>
            {shown < matches.length ? (
              <div className="mt-5 text-center">
                <button
                  type="button"
                  onClick={() => setShown((count) => count + 12)}
                  className="min-h-11 rounded-lg border border-line bg-surface-2 px-5 text-sm font-medium text-fg hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Show more heroes ({matches.length - shown} remaining)
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-line bg-surface/60 p-8 text-center">
            <p className="font-medium text-fg">No heroes match these filters</p>
            <p className="mt-1 text-sm text-muted">
              Try a different name or sample group.
            </p>
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setView("all");
              }}
              className="mt-4 min-h-10 rounded-lg border border-line bg-surface-2 px-4 text-sm text-fg hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Clear filters
            </button>
          </div>
        )}
      </section>

      <details className="rounded-xl border border-line-soft bg-surface/60 p-4 text-sm text-muted sm:p-5">
        <summary className="cursor-pointer font-medium text-fg">
          How these numbers are calculated
        </summary>
        <div className="mt-3 space-y-2 leading-relaxed">
          <p>
            Only complete 5v5 box scores whose hero IDs are in the bundled
            catalogue count. {games} of {importedGames} imported games qualify.
            Unmapped player accounts still count toward hero picks and results.
          </p>
          <p>
            Pick rate is the share of eligible games featuring a hero. Win rate
            is winning picks divided by total picks. KDA uses total kills plus
            assists divided by total deaths, with a minimum denominator of one.
            Per-pick numbers average each appearance.
          </p>
          <p>
            Win-rate and assist highlights require at least {minPicks} picks.
            Early results are available in the explorer but may change quickly.
          </p>
        </div>
      </details>
    </div>
  );
}
