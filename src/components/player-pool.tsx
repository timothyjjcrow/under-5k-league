"use client";

import Link from "@/components/app-link";
import { useSearchParams } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { SAVE_LIST_CONTEXT_EVENT } from "@/lib/navigation-context";
import {
  Avatar,
  Badge,
  EmptyState,
  HeroList,
  LinkArrow,
  PlayerLink,
  RankBadge,
  RankMedal,
  RoleBadges,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { DraftPlayerCard } from "@/components/draft-player-card";
import { PubHeroStrip } from "@/components/pub-hero-strip";
import { heroesForPlayerSearch } from "@/lib/heroes";
import { DOTA_ROLES } from "@/lib/roles";
import {
  EMPTY_POOL_FILTER,
  filterPoolPage,
  inhouseTitle,
  inhouseToken,
  lastSeasonTitle,
  lastSeasonToken,
  mmrRangeLabel,
  NO_DISCORD_TITLE,
  normalizeMmrRange,
  parseMmrInput,
  POOL_MMR_BANDS,
  poolFacetCounts,
  poolFilterActive,
  poolHeroMatches,
  poolPanelFilterCount,
  poolParamsQuery,
  poolRowFacts,
  PUB_QUIET_TITLE,
  pubHeroTitle,
  pubQuietToken,
  pubTitle,
  pubToken,
  readPoolParams,
  recentHeroTitle,
  sortPoolPage,
  type MmrRange,
  type PoolFacetCounts,
  type PoolFilterGates,
  type PoolPageFilter,
  type PoolPageSort,
  type PoolPlayer,
  type PoolRowFacts,
  type PoolScout,
  type PoolScoutInfo,
} from "@/lib/player-pool";
import type { DraftScout } from "@/lib/draft-scout";
import { pubHasWindow, pubLastPlayed } from "@/lib/pub-stats";
import {
  pubColumn,
  scoutingRowParts,
  scoutingTitle,
  type ScoutContext,
  type ScoutPart,
} from "@/lib/pub-scout";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { aboutText } from "@/lib/about-you";
import { averageMmr } from "@/lib/pool-stats";
import { cn, hasText } from "@/lib/utils";
import { DiscordTag } from "@/components/discord-tag";
import { usePersistedFlag } from "@/components/room-clock";

/** Which team drafted a player, keyed by userId (parallel to the frozen
 * PoolPlayer type). `price` is null for captains — no draft price shown.
 * `captain` comes from the roster row, never from the price: a captain keeps
 * a nonzero price after transferCaptaincy. */
export type PoolDraftInfo = Record<
  string,
  {
    teamId: string;
    teamName: string;
    teamLogoUrl?: string | null;
    price: number | null;
    captain?: boolean;
  }
>;

/** The Filters panel's id: the sidebar from xl, a fold-out panel below. */
const PANEL_ID = "pool-filters";

/**
 * The /players pool: a toolbar (search, positions, status), a filter
 * sidebar beside the list from xl (a fold-out panel under the toolbar
 * below it), and one compact row per player. A row opens the draft room's
 * scouting card under it (`DraftPlayerCard`), one at a time.
 *
 * Every filter and the sort live in the address bar (`readPoolParams`,
 * `poolParamsQuery`); row density ("Scouting details") and the card's
 * "Full scouting" are the reader's own, kept on their device. The rules are
 * in docs/features/pages-and-ui.md ("The player pool").
 */
export function PlayerPool({
  players,
  standinIds,
  showDraftStatus,
  captainSelectionOpen = false,
  draftInfo,
  scout,
  now,
  showContact = false,
  signedUpAt,
  listTitle,
}: {
  players: PoolPlayer[];
  /** Which rows are STANDIN registrations. A parallel list rather than a
   *  PoolPlayer field: that shape is shared with the draft room, which never
   *  lists standins. */
  standinIds?: string[];
  showDraftStatus: boolean;
  /** Captains are still being chosen (signups, or a draft not yet started).
   *  "Wants captain" is a setup-time signal: once the auction starts the
   *  volunteers who weren't picked stop wearing the badge, and the filter
   *  chip goes with it. */
  captainSelectionOpen?: boolean;
  draftInfo?: PoolDraftInfo;
  /** Per-player scouting extras (inhouse record, pub snapshot, goals quote) —
   *  a parallel record like draftInfo, so PoolPlayer stays frozen. */
  scout?: PoolScoutInfo;
  /** Server clock (epoch ms) for the pub recency labels — passed down so the
   *  SSR pass and hydration compute identical text. */
  now: number;
  /** True for active league participants/admins. The payload blanks contact
   *  for outsiders, so without this flag the component cannot distinguish a
   *  hidden handle from a player who has no Discord. */
  showContact?: boolean;
  /** When each player signed up (epoch ms), for "Sort: Newest". */
  signedUpAt?: Record<string, number>;
  /** The phase's name for the list ("Signed up to play", "Draft pool"…). */
  listTitle: string;
}) {
  const scoutMap = useMemo(() => scout ?? {}, [scout]);
  const signups = useMemo(() => signedUpAt ?? {}, [signedUpAt]);
  const standinSet = useMemo(() => new Set(standinIds ?? []), [standinIds]);
  const facts = useMemo(
    () =>
      new Map(
        players.map((p) => [
          p.userId,
          poolRowFacts(p, scoutMap[p.userId], standinSet, now),
        ]),
      ),
    [players, scoutMap, standinSet, now],
  );
  // Data-presence gates (never season phase): a control renders only where
  // it does something, and a column only where someone has data for it.
  const anyDrafted = players.some((p) => p.drafted);
  const gates: PoolFilterGates = {
    captainSelectionOpen,
    draftStatus: showDraftStatus && anyDrafted,
    anyStandin: players.some((p) => standinSet.has(p.userId)),
    anyInhouse: players.some((p) => facts.get(p.userId)?.inhouse),
    anyReturning: players.some((p) => facts.get(p.userId)?.returning),
    anyInactive: players.some((p) => facts.get(p.userId)?.inactive),
    showContact,
  };
  const columns = {
    inhouse: gates.anyInhouse,
    pubs: players.some((p) => !!scoutMap[p.userId]?.pub?.scout),
    favorites: players.some((p) => hasText(p.favoriteHeroes)),
  };

  // Seeded from the URL once, on mount, so a captain can SEND someone "the
  // pos-4 and pos-5 free agents under 3,300" and a reload, or a trip to a
  // profile and back, keeps what they were reading. React is the source of
  // truth; the URL is a mirror (the effect below).
  const params = useSearchParams();
  const [seed] = useState(() => readPoolParams(params, gates));
  const [filter, setFilter] = useState<PoolPageFilter>(seed.filter);
  const [sort, setSort] = useState<PoolPageSort>(seed.sort);
  const [details, setDetails] = usePersistedFlag("playerPoolDetails", false);
  const [scoutFull, setScoutFull] = usePersistedFlag(
    "playerPoolScoutFull",
    false,
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const update = (patch: Partial<PoolPageFilter>) =>
    setFilter((f) => ({ ...f, ...patch }));

  // Mirror the filters into the address bar. `history.replaceState`, never
  // router.replace: the filter is client-side, and a router call would re-run
  // the page's queries per tap. Debounced because browsers rate-limit
  // replaceState (Safari: 100 per 30s) and the search box fires per
  // keystroke; a click through to a profile flushes it first.
  useEffect(() => {
    const syncFilters = () => {
      const qs = poolParamsQuery(filter, sort);
      const next =
        (qs ? `${window.location.pathname}?${qs}` : window.location.pathname) +
        window.location.hash;
      if (
        next !==
        window.location.pathname + window.location.search + window.location.hash
      ) {
        window.history.replaceState(null, "", next);
      }
    };
    const t = setTimeout(syncFilters, 250);
    window.addEventListener(SAVE_LIST_CONTEXT_EVENT, syncFilters);
    return () => {
      clearTimeout(t);
      window.removeEventListener(SAVE_LIST_CONTEXT_EVENT, syncFilters);
    };
  }, [filter, sort]);

  const heroes = useMemo(
    () => heroesForPlayerSearch(filter.query),
    [filter.query],
  );
  const heroIds = useMemo(() => new Set(heroes.map((h) => h.id)), [heroes]);
  const shown = useMemo(
    () =>
      sortPoolPage(filterPoolPage(players, facts, filter, heroIds), sort, {
        scout: scoutMap,
        signedUpAt: signups,
      }),
    [players, facts, filter, heroIds, sort, scoutMap, signups],
  );
  const counts = useMemo(
    () => poolFacetCounts(players, facts, filter, heroIds),
    [players, facts, filter, heroIds],
  );
  const filtersActive = poolFilterActive(filter);
  // Sort is an ordering preference, not a filter: Clear keeps it.
  const resetFilters = () => setFilter(EMPTY_POOL_FILTER);
  const panelCount = poolPanelFilterCount(filter);
  const toggleRow = (userId: string) => {
    const next = openId === userId ? null : userId;
    setOpenId(next);
    if (next) {
      // Bring the opened card into view when it lands below the fold.
      requestAnimationFrame(() =>
        document.getElementById(cardIdFor(next))?.scrollIntoView({
          block: "nearest",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
        }),
      );
    }
  };
  const titleId = useId();

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_19rem] xl:grid-rows-[auto_auto_1fr] xl:gap-x-6">
      <Toolbar
        filter={filter}
        update={update}
        heroes={heroes.map((h) => h.name)}
        counts={counts}
        gates={gates}
        panelOpen={panelOpen}
        onPanelToggle={() => setPanelOpen((v) => !v)}
        panelCount={panelCount}
      />

      <FilterPanel
        open={panelOpen}
        filter={filter}
        update={update}
        counts={counts}
        gates={gates}
        shownAvgMmr={averageMmr(shown)}
      />

      {/* The list's name and count, the one "Clear filters" (when the list
          isn't empty: the empty state carries it then), row density and the
          sort, on one line at every width. */}
      <div className="flex min-w-0 items-center justify-between gap-3 xl:col-start-1 xl:row-start-2">
        <div className="min-w-0 sm:flex sm:flex-wrap sm:items-baseline sm:gap-x-3">
          <h2 id={titleId} className="text-sm font-semibold text-fg">
            {listTitle}
          </h2>
          <div className="flex flex-wrap items-baseline gap-x-2.5">
            {/* aria-live: filtering is a keyboard action whose only feedback
                is this line changing. */}
            <p aria-live="polite" className="text-xs text-muted">
              Showing{" "}
              <span className="font-medium tabular-nums text-fg">
                {shown.length}
              </span>{" "}
              of {players.length} players
            </p>
            {filtersActive && shown.length > 0 ? (
              <button
                type="button"
                onClick={resetFilters}
                className={textLink("text-xs")}
              >
                Clear filters
              </button>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Density, not a filter: one line a player, or their scouting
              line and own words under each row. Not in the URL or "Clear
              filters"; it is the reader's own, kept on their device. */}
          <button
            type="button"
            onClick={() => setDetails(!details)}
            aria-pressed={details}
            aria-label="Scouting details"
            title="Show each player's scouting line and own words under their row"
            className={cn(
              CHIP_BASE,
              "inline-flex h-10 w-10 items-center justify-center gap-1.5 sm:h-8 sm:w-auto sm:px-2.5",
              details ? CHIP_ON : CHIP_OFF,
            )}
          >
            <DetailsIcon />
            <span className="hidden sm:inline">Scouting details</span>
          </button>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as PoolPageSort)}
            aria-label="Sort players"
            className="h-10 rounded-lg border border-line bg-surface-2/50 px-2 text-sm outline-none focus:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/60 sm:h-8"
          >
            <option value="mmr">Sort: MMR</option>
            {gates.anyInhouse ? <option value="inhouse">Sort: Inhouse</option> : null}
            {/* "Medal", not "Rank": the Inhouse column shows ladder ranks
                (#1), and this sorts by Dota medal. The value stays "rank" so
                shared ?sort=rank links keep working. */}
            <option value="rank">Sort: Medal</option>
            <option value="name">Sort: Name</option>
            <option value="newest">Sort: Newest</option>
          </select>
        </div>
      </div>

      <div className="min-w-0 xl:col-start-1 xl:row-start-3">
        {shown.length === 0 ? (
          <EmptyState
            title="No players match"
            description="Try clearing the search or a filter."
            action={
              <button
                type="button"
                onClick={resetFilters}
                className={buttonClasses("secondary", "sm")}
              >
                Clear filters
              </button>
            }
          />
        ) : (
          <div
            className="overflow-hidden rounded-[var(--radius)] border border-line bg-surface/80"
            style={{ "--pool-columns": poolColumns(columns) } as CSSProperties}
          >
            {/* The column header exists from lg, where rows are columns;
                below it each row is two lines with nothing to label. */}
            <div
              aria-hidden
              className={cn(
                ROW_GRID,
                "hidden border-b border-line bg-surface-2/40 py-2 text-[11px] font-medium uppercase tracking-wide text-muted lg:grid",
              )}
            >
              <span />
              <span>Player</span>
              <span className="text-right">MMR</span>
              <span>Roles</span>
              {columns.inhouse ? <span className="text-right">Inhouse</span> : null}
              {columns.pubs ? <span className="lg:pl-2">Pubs</span> : null}
              {columns.favorites ? <span>Favorites</span> : null}
              <span className="text-right">Status</span>
              <span />
            </div>
            <ul aria-labelledby={titleId} className="divide-y divide-line/60">
              {shown.map((p) => (
                <PoolRow
                  key={p.userId}
                  player={p}
                  scout={scoutMap[p.userId]}
                  facts={facts.get(p.userId)!}
                  columns={columns}
                  open={openId === p.userId}
                  onToggle={toggleRow}
                  details={details}
                  now={now}
                  query={filter.query}
                  heroes={heroes}
                  captainSelectionOpen={captainSelectionOpen}
                  showDraftStatus={showDraftStatus}
                  draft={draftInfo?.[p.userId]}
                  showContact={showContact}
                  scoutFull={scoutFull}
                  onScoutFullChange={setScoutFull}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

const cardIdFor = (userId: string) => `pool-scout-${userId}`;

// --- Toolbar ---------------------------------------------------------------------

function Toolbar({
  filter,
  update,
  heroes,
  counts,
  gates,
  panelOpen,
  onPanelToggle,
  panelCount,
}: {
  filter: PoolPageFilter;
  update: (patch: Partial<PoolPageFilter>) => void;
  heroes: string[];
  counts: PoolFacetCounts;
  gates: PoolFilterGates;
  panelOpen: boolean;
  onPanelToggle: () => void;
  panelCount: number;
}) {
  const toggleRole = (key: string) =>
    update({
      roles: filter.roles.includes(key)
        ? filter.roles.filter((r) => r !== key)
        : [...filter.roles, key],
    });
  const statusChip = (value: PoolPageFilter["status"], label: string, n: number) => (
    <Chip
      active={filter.status === value}
      onClick={() => update({ status: filter.status === value ? "all" : value })}
      count={n}
    >
      {label}
    </Chip>
  );
  const anyStatus = gates.anyStandin || gates.draftStatus || gates.captainSelectionOpen;
  return (
    <div className="min-w-0 space-y-2 xl:col-start-1 xl:row-start-1">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            type="search"
            value={filter.query}
            onChange={(e) => update({ query: e.target.value })}
            placeholder="Search players or heroes…"
            aria-label="Search players or heroes"
            className="h-11 w-full rounded-lg border border-line bg-surface-2/50 pl-3 pr-10 text-sm outline-none focus:border-accent/60 sm:h-9 [&::-webkit-search-cancel-button]:hidden"
          />
          {filter.query ? (
            <button
              type="button"
              onClick={() => update({ query: "" })}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg sm:h-8 sm:w-8"
            >
              ✕
            </button>
          ) : null}
        </div>
        {/* The sidebar holds these from xl; below it they fold out here. */}
        <button
          type="button"
          onClick={onPanelToggle}
          aria-expanded={panelOpen}
          aria-controls={PANEL_ID}
          className={cn(
            CHIP_BASE,
            "inline-flex h-11 shrink-0 items-center gap-1.5 px-3 sm:h-9 xl:hidden",
            panelOpen || panelCount > 0 ? CHIP_ON : CHIP_OFF,
          )}
        >
          <FilterIcon />
          Filters
          {panelCount > 0 ? (
            <span className="rounded-full bg-accent/25 px-1.5 text-xs tabular-nums">
              {panelCount}
              <span className="sr-only"> on</span>
            </span>
          ) : null}
        </button>
      </div>
      {heroes.length > 0 ? (
        <p className="text-xs text-muted">
          Also finding players of{" "}
          <span className="text-fg">{heroes.join(", ")}</span>: a favorite, or
          in their pubs.
        </p>
      ) : null}

      {/* gap-y-2: a wrapped row of chips stays 8px from the one above. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Filter by role"
        >
          <Chip
            active={filter.roles.length === 0}
            onClick={() => update({ roles: [] })}
            label="All roles"
            square
          >
            All
          </Chip>
          {DOTA_ROLES.map((r) => (
            <Chip
              key={r.key}
              active={filter.roles.includes(r.key)}
              onClick={() => toggleRole(r.key)}
              title={`${r.short} · ${r.label}`}
              // A bare "1" is not a name: text content beats `title` for the
              // accessible name, and touch never shows a tooltip.
              label={`Position ${r.key} — ${r.label}`}
              square
            >
              {r.key}
            </Chip>
          ))}
        </div>

        {anyStatus ? (
          // flex-wrap: four chips with counts don't fit a 360px phone's row.
          <div
            className="flex flex-wrap items-center gap-x-1 gap-y-2"
            role="group"
            aria-label="Filter by status"
          >
            {/* Players and Standins split the pool by registration type, so
                both exist only while there are standins to split off. Players
                leads: Drafted and Free agents are kinds of player. */}
            {gates.anyStandin ? statusChip("player", "Players", counts.status.player) : null}
            {gates.draftStatus ? (
              <>
                {statusChip("drafted", "Drafted", counts.status.drafted)}
                {statusChip("free", "Free agents", counts.status.free)}
              </>
            ) : null}
            {gates.anyStandin ? statusChip("standin", "Standins", counts.status.standin) : null}
            {gates.captainSelectionOpen ? (
              <Chip
                active={filter.captainOnly}
                onClick={() => update({ captainOnly: !filter.captainOnly })}
                count={counts.captain}
              >
                Wants captain
              </Chip>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// --- Filter panel (the sidebar from xl) ---------------------------------------

function FilterPanel({
  open,
  filter,
  update,
  counts,
  gates,
  shownAvgMmr,
}: {
  open: boolean;
  filter: PoolPageFilter;
  update: (patch: Partial<PoolPageFilter>) => void;
  counts: PoolFacetCounts;
  gates: PoolFilterGates;
  shownAvgMmr: number;
}) {
  const anyPlayerFilter =
    gates.anyReturning || gates.anyInhouse || gates.showContact || gates.anyInactive;
  const roleMax = Math.max(1, ...Object.values(counts.roles));
  return (
    <aside
      id={PANEL_ID}
      aria-label="More filters"
      className={cn(
        open ? "block" : "hidden",
        // From xl: the sidebar, beside the toolbar and the whole list, held
        // under the header while the list scrolls. Its own scroll only if a
        // short window can't hold it.
        "min-w-0 xl:sticky xl:top-20 xl:col-start-2 xl:row-span-3 xl:row-start-1 xl:block xl:max-h-[calc(100dvh-6rem)] xl:self-start xl:overflow-y-auto",
      )}
    >
      {/* Its sections are h3s; this keeps the outline h1 → h2 → h3. */}
      <h2 className="sr-only">More filters</h2>
      <div className="rounded-[var(--radius)] border border-line bg-surface/80 md:grid md:grid-cols-2 xl:block">
        <PanelSection
          title="MMR"
          aside={shownAvgMmr > 0 ? `list average ${MMR_FORMAT.format(shownAvgMmr)}` : undefined}
        >
          <MmrFilter
            range={filter.mmr}
            onChange={(mmr) => update({ mmr })}
            bandCounts={counts.mmrBands}
          />
        </PanelSection>

        {anyPlayerFilter ? (
          <PanelSection title="Players">
            <div className="flex flex-wrap gap-x-1 gap-y-2">
              {gates.anyReturning ? (
                <>
                  <Chip
                    active={filter.history === "returning"}
                    onClick={() =>
                      update({
                        history: filter.history === "returning" ? "any" : "returning",
                      })
                    }
                    title="Played on a league team in an earlier season"
                    count={counts.history.returning}
                  >
                    Returning
                  </Chip>
                  <Chip
                    active={filter.history === "new"}
                    onClick={() =>
                      update({ history: filter.history === "new" ? "any" : "new" })
                    }
                    title="Hasn't played on a league team in an earlier season"
                    count={counts.history.new}
                  >
                    New to the league
                  </Chip>
                </>
              ) : null}
              {gates.anyInhouse ? (
                <Chip
                  active={filter.inhouseOnly}
                  onClick={() => update({ inhouseOnly: !filter.inhouseOnly })}
                  title="Has games on the inhouse ladder"
                  count={counts.inhouse}
                >
                  Plays inhouses
                </Chip>
              ) : null}
              {gates.showContact ? (
                <Chip
                  active={filter.discordOnly}
                  onClick={() => update({ discordOnly: !filter.discordOnly })}
                  title="Has a Discord handle on file, so a captain can reach them"
                  count={counts.discord}
                >
                  On Discord
                </Chip>
              ) : null}
              {gates.anyInactive ? (
                <Chip
                  active={filter.hideInactive}
                  onClick={() => update({ hideInactive: !filter.hideInactive })}
                  title="Hides players with no pub game OpenDota has seen in over two months. Players it can't see stay listed."
                  count={counts.inactive}
                >
                  Hide inactive
                </Chip>
              ) : null}
            </div>
          </PanelSection>
        ) : null}

        {/* The shape of what is listed, beside the list: how many of the
            players matching everything else play each position. Read-only;
            the position chips filter. Wide screens only, where it has room. */}
        <PanelSection title="Positions" className="hidden xl:block">
          <div className="space-y-1.5">
            {DOTA_ROLES.map((r) => (
              <div key={r.key} className="flex items-center gap-2 text-xs">
                <span className="w-[6.5rem] shrink-0 truncate text-muted">
                  {r.short} · {r.label}
                </span>
                <span
                  aria-hidden
                  className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2"
                >
                  <span
                    className="block h-full rounded-full bg-accent/60"
                    style={{ width: `${(counts.roles[r.key] / roleMax) * 100}%` }}
                  />
                </span>
                <span className="w-6 shrink-0 text-right tabular-nums text-fg">
                  {counts.roles[r.key]}
                </span>
              </div>
            ))}
          </div>
        </PanelSection>
      </div>
    </aside>
  );
}

const MMR_FORMAT = new Intl.NumberFormat("en-US");

function PanelSection({
  title,
  aside,
  className,
  children,
}: {
  title: string;
  aside?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        // Stacked in the sidebar and on a phone; side by side on a tablet,
        // where the second section takes a rule on its left instead.
        "min-w-0 border-line-soft p-3 [&:not(:first-child)]:border-t md:[&:nth-child(2)]:border-l md:[&:nth-child(2)]:border-t-0 xl:[&:nth-child(2)]:border-l-0 xl:[&:nth-child(2)]:border-t",
        className,
      )}
    >
      <h3 className="mb-2 flex items-baseline justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
        {title}
        {aside ? (
          <span className="font-normal normal-case tracking-normal">{aside}</span>
        ) : null}
      </h3>
      {children}
    </section>
  );
}

/** Two boxes for any range, and the histogram's bands for the usual ones. */
function MmrFilter({
  range,
  onChange,
  bandCounts,
}: {
  range: MmrRange;
  onChange: (range: MmrRange) => void;
  bandCounts: number[];
}) {
  // The boxes keep what was typed ("30" on the way to "3000"); the filter
  // reads the parsed number. A band click or Clear rewrites both.
  const [text, setText] = useState(() => ({
    min: range.min?.toString() ?? "",
    max: range.max?.toString() ?? "",
  }));
  const parsedText = { min: parseMmrInput(text.min), max: parseMmrInput(text.max) };
  if (parsedText.min !== range.min || parsedText.max !== range.max) {
    // The range moved without a keystroke (a band, Clear filters): show it.
    // Setting state during render is React's pattern for "derive from a
    // prop that changed".
    setText({ min: range.min?.toString() ?? "", max: range.max?.toString() ?? "" });
  }
  const type = (which: "min" | "max", value: string) => {
    const next = { ...text, [which]: value };
    setText(next);
    onChange({ min: parseMmrInput(next.min), max: parseMmrInput(next.max) });
  };
  const current = normalizeMmrRange(range);
  const maxCount = Math.max(1, ...bandCounts);
  const label = mmrRangeLabel(range);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={5}
          value={text.min}
          onChange={(e) => type("min", e.target.value)}
          placeholder="Min"
          aria-label="Minimum MMR"
          className={MMR_BOX}
        />
        <span aria-hidden className="text-muted">
          –
        </span>
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={5}
          value={text.max}
          onChange={(e) => type("max", e.target.value)}
          placeholder="Max"
          aria-label="Maximum MMR"
          className={MMR_BOX}
        />
        {label ? (
          <button
            type="button"
            onClick={() => onChange({ min: null, max: null })}
            className={textLink("shrink-0 text-xs")}
          >
            Any MMR
          </button>
        ) : null}
      </div>
      <div role="group" aria-label="MMR bands" className="space-y-1">
        {POOL_MMR_BANDS.map((band, i) => {
          const active = current.min === band.min && current.max === band.max;
          const n = bandCounts[i] ?? 0;
          return (
            <button
              key={band.label}
              type="button"
              aria-pressed={active}
              aria-label={`${band.label} MMR, ${n} ${n === 1 ? "player" : "players"}`}
              onClick={() =>
                onChange(active ? { min: null, max: null } : { min: band.min, max: band.max })
              }
              className={cn(
                "relative flex h-8 w-full items-center justify-between gap-2 overflow-hidden rounded-md border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                active
                  ? "border-accent/50 text-accent"
                  : "border-transparent text-muted hover:border-line hover:text-fg",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute inset-y-0 left-0 rounded-md",
                  active ? "bg-accent/15" : "bg-surface-2/70",
                )}
                style={{ width: `${(n / maxCount) * 100}%` }}
              />
              <span className="relative">{band.label}</span>
              <span className="relative tabular-nums text-fg">{n}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const MMR_BOX =
  "h-11 w-full min-w-0 rounded-lg border border-line bg-surface-2/50 px-2.5 text-sm tabular-nums outline-none focus:border-accent/60 sm:h-9";

// --- Rows ----------------------------------------------------------------------

/**
 * The lg+ column tracks for the header and every row, one string set as a
 * CSS variable on the list (Tailwind can't see a class built at runtime).
 * Below lg there are no columns: the avatar keeps the gutter, the name and
 * MMR share line one, and everything else rides line two
 * (`ROW_GRID`). A column exists only when some player has data for it.
 */
function poolColumns(cols: { inhouse: boolean; pubs: boolean; favorites: boolean }) {
  return [
    "1.75rem", // avatar
    "minmax(0,1fr)", // name
    "4.25rem", // MMR + medal
    "7.25rem", // roles: five pills, 5 x 20px + 4 x 4px
    cols.inhouse ? "4rem" : null,
    cols.pubs ? "5rem" : null, // "Support" + a medal, after an 8px gutter
    cols.favorites ? "4.25rem" : null, // three 20px icons
    "8rem", // status
    "2rem", // the scouting toggle
  ]
    .filter(Boolean)
    .join(" ");
}

/** The row grid at every width: phone tracks below lg (avatar, name, MMR,
 *  toggle; line two spans the last three), the shared column variable from
 *  lg. */
const ROW_GRID =
  "grid grid-cols-[1.75rem_minmax(0,1fr)_auto_auto] gap-x-2.5 gap-y-2 px-3 lg:[grid-template-columns:var(--pool-columns)] lg:gap-y-1";

function PoolRow({
  player: p,
  scout: sc,
  facts,
  columns,
  open,
  onToggle,
  details,
  now,
  query,
  heroes,
  captainSelectionOpen,
  showDraftStatus,
  draft,
  showContact,
  scoutFull,
  onScoutFullChange,
}: {
  player: PoolPlayer;
  scout: PoolScout | undefined;
  facts: PoolRowFacts;
  columns: { inhouse: boolean; pubs: boolean; favorites: boolean };
  open: boolean;
  onToggle: (userId: string) => void;
  details: boolean;
  now: number;
  query: string;
  heroes: readonly { id: number; name: string }[];
  captainSelectionOpen: boolean;
  showDraftStatus: boolean;
  draft: PoolDraftInfo[string] | undefined;
  showContact: boolean;
  scoutFull: boolean;
  onScoutFullChange: (next: boolean) => void;
}) {
  const ih = sc?.inhouse;
  const pub = sc?.pub;
  const ctx: ScoutContext = {
    roles: p.roles,
    signupMmr: p.mmr,
    rankTier: p.rankTier,
    league: LEAGUE_CONFIG.region,
  };
  const pubCell = pub?.scout ? pubColumn(pub.scout, ctx) : null;
  // What they wrote about themselves. Signups from before the one "About
  // you" box keep a captain note and goals; both show, joined.
  const about = aboutText({ captainNote: p.captainNote, statement: sc?.statement }, " · ");
  const heroHits = poolHeroMatches(p, sc, query, heroes);
  const cardId = cardIdFor(p.userId);

  return (
    <li
      // The whole row opens the card for a pointer; the chevron is the
      // keyboard's and screen reader's control. Links and buttons inside
      // keep their own clicks, and so does selecting text.
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("a,button,input,select,textarea,summary,[data-pool-card]")) return;
        if (window.getSelection()?.toString()) return;
        onToggle(p.userId);
      }}
      className={cn(
        ROW_GRID,
        "cursor-pointer items-center py-2 transition-colors hover:bg-surface-2/40 lg:py-1.5",
        open && "bg-surface-2/50 shadow-[inset_3px_0_0_var(--color-accent)] hover:bg-surface-2/50",
      )}
    >
      {/* Decorative: the name beside it is the link. */}
      <span aria-hidden className="row-span-2 self-center lg:row-span-1">
        <Avatar name={p.name} src={p.avatar} size={28} />
      </span>

      <span className="min-w-0">
        <PlayerLink
          userId={p.userId}
          className="block min-w-6 max-w-full truncate text-sm font-medium"
        >
          {p.name}
        </PlayerLink>
        {heroHits.length > 0 ? (
          <span className="mt-0.5 block truncate text-xs text-accent">
            {heroHits.map((h) => h.text).join(" · ")}
          </span>
        ) : null}
      </span>

      {/* The default sort key, beside the name at every width. */}
      <span className="flex items-center justify-end gap-1.5">
        <RankBadge rankTier={p.rankTier} />
        {p.mmr > 0 ? (
          <span className="text-sm font-semibold tabular-nums text-fg">{p.mmr}</span>
        ) : (
          <span className="text-sm text-muted" title="No MMR on this signup">
            —
          </span>
        )}
      </span>

      {/* Line two below lg; from lg the wrapper dissolves (`contents`) and
          each cell takes its own column, in the header's order. An empty
          cell hides below lg so it doesn't add a gap to the line. */}
      <span className="col-span-3 col-start-2 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2 lg:contents">
        <span className={cn(!hasText(p.roles) && "hidden lg:block")}>
          <RoleBadges roles={p.roles} />
        </span>

        {columns.inhouse ? (
          <span
            className={cn(
              "text-xs text-muted lg:flex lg:flex-col lg:items-end",
              !ih && "hidden",
            )}
            title={ih ? inhouseTitle(ih) : undefined}
          >
            {ih ? (
              <>
                <span className="tabular-nums lg:hidden">{inhouseToken(ih)}</span>
                <span
                  className={cn(
                    "hidden text-sm font-semibold tabular-nums lg:inline",
                    // Provisionals are dimmed and never ranked.
                    ih.rank == null ? "text-muted" : "text-fg",
                  )}
                >
                  {ih.rating}
                  {ih.rank != null ? (
                    <span className="ml-1 text-xs font-normal text-muted">#{ih.rank}</span>
                  ) : null}
                </span>
                <span className="hidden tabular-nums lg:inline">
                  {ih.wins}–{ih.losses}
                  {ih.rank == null ? ` · ${ih.games}g` : ""}
                </span>
              </>
            ) : null}
          </span>
        ) : null}

        {columns.pubs ? (
          <span
            className={cn(
              "flex min-w-0 items-center gap-1 text-xs lg:pl-2",
              !pubCell && "hidden lg:flex",
            )}
          >
            {pubCell ? (
              <>
                <span className="text-muted lg:hidden">Pubs</span>
                {pubCell.role ? (
                  <span
                    title={pubCell.role.title}
                    className={cn("truncate", pubCell.role.warn ? "text-accent" : "text-fg")}
                  >
                    {pubCell.role.text}
                  </span>
                ) : null}
                {pubCell.level ? (
                  <RankMedal
                    rankTier={pubCell.level.rankTier}
                    size={18}
                    label={pubCell.level.title}
                    className={cn(
                      "shrink-0 rounded-full",
                      pubCell.level.warn && "ring-1 ring-accent/80",
                    )}
                  />
                ) : null}
              </>
            ) : null}
          </span>
        ) : null}

        {columns.favorites ? (
          // A tablet's line two has room for them (a phone's doesn't); the
          // label keeps them apart from pub heroes there, where no column
          // header says which strip is which.
          <span
            className={cn(
              "hidden min-w-0 items-center gap-1.5 text-xs text-muted lg:flex",
              hasText(p.favoriteHeroes) && "md:flex",
            )}
          >
            <span className="lg:hidden">Favorites</span>
            <HeroList value={p.favoriteHeroes} size={20} max={3} className="flex-nowrap" />
          </span>
        ) : null}

        <StatusCell
          player={p}
          standin={facts.standin}
          captainSelectionOpen={captainSelectionOpen}
          showDraftStatus={showDraftStatus}
          draft={draft}
        />
      </span>

      {/* Beside the MMR on line one below lg, so line two has the row's
          whole width and a long team name can't push the toggle under it;
          the last column from lg. */}
      <button
        type="button"
        onClick={() => onToggle(p.userId)}
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-label={`Scouting for ${p.name}`}
        title={open ? "Close the scouting card" : "Open the scouting card"}
        className="col-start-4 row-start-1 -my-1 grid h-8 w-8 place-items-center self-center justify-self-end rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 lg:col-start-auto lg:row-start-auto lg:my-0"
      >
        <ChevronIcon open={open} />
      </button>

      {details ? (
        <DetailLines scout={sc} ctx={ctx} now={now} about={about} />
      ) : null}

      {open ? (
        <div data-pool-card className="col-span-full min-w-0 lg:[grid-column:2/-1]">
          <DraftPlayerCard
            variant="pool"
            id={cardId}
            name={p.name}
            player={p}
            scout={draftScout(p, sc, about)}
            nowMs={now}
            full={scoutFull}
            onFullChange={onScoutFullChange}
            actions={
              <CardLinks player={p} showContact={showContact} />
            }
          />
        </div>
      ) : null}
    </li>
  );
}

/** The card's facts in the draft room's shape (`DraftScout`), from the
 *  pool's: the same helpers then phrase them the same on both pages. */
function draftScout(p: PoolPlayer, sc: PoolScout | undefined, about: string): DraftScout {
  return {
    ...(sc?.pub ? { pub: sc.pub } : {}),
    ...(sc?.inhouse ? { inhouse: sc.inhouse } : {}),
    ...(sc?.lastSeason ? { lastSeason: sc.lastSeason } : {}),
    ...(hasText(p.favoriteHeroes) ? { favoriteHeroes: p.favoriteHeroes } : {}),
    ...(about ? { about } : {}),
  };
}

/** Standin, captain, team or free agent, plus captain interest while
 *  captains are being chosen. */
function StatusCell({
  player: p,
  standin,
  captainSelectionOpen,
  showDraftStatus,
  draft,
}: {
  player: PoolPlayer;
  standin: boolean;
  captainSelectionOpen: boolean;
  showDraftStatus: boolean;
  draft: PoolDraftInfo[string] | undefined;
}) {
  const badges: ReactNode[] = [];
  // Only volunteers still waiting on the call: a designated captain reads
  // "Captain", and after the auction starts the volunteers who weren't
  // picked stop carrying a signup-week badge.
  if (captainSelectionOpen && p.wantsCaptain && !draft?.captain) {
    badges.push(
      <Badge key="wants" tone="accent">
        Wants captain
      </Badge>,
    );
  }
  // A captain is on their team's roster, so they wear the (C) inside its
  // team chip (below) rather than a second badge that wrapped the cell.
  if (standin) {
    // Before the draft-status branch: a standin is never rostered, and
    // "Free agent" would say they can be signed.
    badges.push(<Badge key="standin">Standin</Badge>);
  } else if (p.drafted) {
    badges.push(
      draft ? (
        <TeamChip key="team" info={draft} />
      ) : (
        <Badge key="drafted" tone="success">
          Drafted
        </Badge>
      ),
    );
  } else if (showDraftStatus) {
    badges.push(
      <Badge key="free" tone="accent">
        Free agent
      </Badge>,
    );
  }
  return (
    <span
      className={cn(
        // On line two (below lg) it takes what the line has left, from 8rem,
        // so a long team name truncates beside the roles instead of
        // wrapping under them.
        "flex min-w-0 flex-wrap items-center gap-1.5 max-lg:flex-1 max-lg:basis-32 lg:justify-end",
        badges.length === 0 && "hidden lg:flex",
      )}
    >
      {badges}
    </span>
  );
}

/** Scouting details: the facts line and the player's own words, across the
 *  row under the name, one line each where the screen allows. No links:
 *  those are in the card, so the line adds no tap targets. */
function DetailLines({
  scout: sc,
  ctx,
  now,
  about,
}: {
  scout: PoolScout | undefined;
  ctx: ScoutContext;
  now: number;
  about: string;
}) {
  const pub = sc?.pub;
  // Measured when the snapshot was taken, and only while it is recent: an
  // old snapshot says nothing about last week.
  const activity = pub ? pubLastPlayed(pub, now) : null;
  const facts: ReactNode[] = [];
  if (sc?.lastSeason) {
    facts.push(
      // Free text (season and team names): may break anywhere rather than
      // widen a phone row.
      <span
        key="last"
        className="min-w-0 tabular-nums [overflow-wrap:anywhere]"
        title={lastSeasonTitle(sc.lastSeason)}
      >
        {lastSeasonToken(sc.lastSeason)}
      </span>,
    );
  }
  if (pub && pubHasWindow(pub)) {
    facts.push(
      <span key="pubs" className="tabular-nums" title={pubTitle(pub, now)}>
        {pubToken(pub, now)}
      </span>,
    );
  }
  if (pub?.scout) {
    facts.push(
      <PubScoutLine
        key="scout"
        parts={scoutingRowParts(pub.scout, ctx)}
        title={scoutingTitle(pub.scout, ctx)}
      />,
    );
  }
  // What they play now beats what they played years ago: their last 100
  // games' heroes once the snapshot has them, else the all-time list. Kept
  // apart from the favorite heroes, which they chose themselves.
  if (pub?.scout && pub.scout.heroes.length > 0) {
    const window = pub.scout.games;
    facts.push(
      <PubHeroStrip
        key="heroes"
        label="Recent pubs"
        heroes={pub.scout.heroes.slice(0, 3)}
        titleOf={(h) => recentHeroTitle(h, window)}
      />,
    );
  } else if (pub && pub.topHeroes.length > 0) {
    facts.push(
      <PubHeroStrip
        key="heroes"
        label="Most played (pubs)"
        heroes={pub.topHeroes}
        titleOf={pubHeroTitle}
      />,
    );
  }
  if (activity?.quiet) {
    facts.push(
      <span key="quiet" className="text-accent" title={PUB_QUIET_TITLE}>
        {pubQuietToken(activity)}
      </span>,
    );
  }
  if (facts.length === 0 && !about) return null;
  return (
    <div className="col-span-3 col-start-2 min-w-0 space-y-1 text-xs text-muted lg:[grid-column:2/-1]">
      {facts.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{facts}</div>
      ) : null}
      {about ? (
        <p className="truncate italic" title={about}>
          &ldquo;{about}&rdquo;
        </p>
      ) : null}
    </div>
  );
}

/** How they play pubs, one plain-text fact after another. A read worth a
 *  second look is tinted, its hover saying why. */
function PubScoutLine({ parts, title }: { parts: ScoutPart[]; title: string }) {
  if (parts.length === 0) return null;
  return (
    <span className="min-w-0 tabular-nums" title={title}>
      {/* Each fact is unbreakable ("82% ranked" never splits on a phone);
          the line wraps between them. */}
      {parts.map((part, i) => (
        <span key={part.key}>
          {i > 0 ? " · " : null}
          <span className={cn("whitespace-nowrap", part.warn && "text-accent")}>
            {part.text}
          </span>
        </span>
      ))}
    </span>
  );
}

/** The card's links: the profile, Dotabuff and how to reach them. */
function CardLinks({ player: p, showContact }: { player: PoolPlayer; showContact: boolean }) {
  return (
    <>
      <Link href={`/players/${p.userId}`} className={textLink()}>
        Full profile <LinkArrow />
      </Link>
      {p.accountId ? (
        <a
          href={`https://www.dotabuff.com/players/${p.accountId}`}
          target="_blank"
          rel="noreferrer"
          className={textLink()}
        >
          Dotabuff <LinkArrow out />
        </a>
      ) : null}
      <DiscordTag name={p.discordName} verified={p.discordVerified} />
      {showContact && !p.discordName ? (
        // The absence IS the information on draft night: this player can't be
        // reached where the league lives. Only for viewers allowed contact:
        // a hidden handle must never read as a missing one.
        <span className="text-muted" title={NO_DISCORD_TITLE}>
          no Discord
        </span>
      ) : null}
    </>
  );
}

/** Post-draft chip: crest + team name (links to the team) with a muted draft
 * price, or a captain's (C). `TeamCrest` is decorative, so the adjacent name
 * carries the label. */
function TeamChip({ info }: { info: NonNullable<PoolDraftInfo[string]> }) {
  return (
    <Link
      href={`/teams/${info.teamId}`}
      className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-2/50 py-1 pl-0.5 pr-2 text-xs hover:border-muted/60 hover:no-underline"
    >
      <TeamCrest
        name={info.teamName}
        seed={info.teamId}
        logoUrl={info.teamLogoUrl}
        size={16}
        className="rounded"
      />
      <span className="min-w-0 truncate">{info.teamName}</span>
      {info.captain ? (
        <span title="Captain" className="shrink-0 font-semibold text-accent">
          <span aria-hidden>(C)</span>
          <span className="sr-only">, captain</span>
        </span>
      ) : info.price != null ? (
        <span className="shrink-0 text-muted">${info.price}</span>
      ) : null}
    </Link>
  );
}

// --- Chips ------------------------------------------------------------------------

/** Every filter control shares the kit's focus ring. */
const CHIP_BASE =
  "rounded-lg border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";
const CHIP_ON = "border-accent/50 bg-accent/15 text-accent";
const CHIP_OFF = "border-line text-muted hover:border-muted/60 hover:text-fg";

function Chip({
  active,
  onClick,
  title,
  label,
  count,
  square = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  label?: string;
  /** How many rows it would show; part of its name ("Standins 3"). */
  count?: number;
  /** The one-character position chips: square, 44px on a phone. */
  square?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        CHIP_BASE,
        "inline-flex h-11 items-center justify-center gap-1.5 sm:h-9",
        square ? "min-w-11 px-2.5 sm:min-w-9" : "px-3",
        active ? CHIP_ON : CHIP_OFF,
      )}
    >
      {children}
      {count != null ? (
        <span
          className={cn(
            "text-xs font-normal tabular-nums",
            active ? "text-accent/80" : "text-muted",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("transition-transform motion-reduce:transition-none", open && "rotate-180")}
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

function DetailsIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M2 4h12M4.5 8h7M7 12h2" />
    </svg>
  );
}
