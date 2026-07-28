"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Avatar,
  Badge,
  EmptyState,
  HeroList,
  PlayerLink,
  RankBadge,
  RoleBadges,
  TeamCrest,
  buttonClasses,
} from "@/components/ui";
import { DOTA_ROLES } from "@/lib/roles";
import {
  filterAndSortPlayers,
  type PoolPlayer,
  type PoolSort,
} from "@/lib/player-pool";
import { cn, hasText } from "@/lib/utils";
import { DiscordTag } from "@/components/discord-tag";

/** Which team drafted a player, keyed by userId (parallel to the frozen
 * PoolPlayer type). `price` is null for captains — no draft price shown. */
export type PoolDraftInfo = Record<
  string,
  { teamId: string; teamName: string; price: number | null }
>;

type PoolStatus = "all" | "drafted" | "free";

const SORTS: PoolSort[] = ["mmr", "rank", "name"];
const ROLE_KEYS: string[] = DOTA_ROLES.map((r) => r.key);

export function PlayerPool({
  players,
  showDraftStatus,
  draftInfo,
}: {
  players: PoolPlayer[];
  showDraftStatus: boolean;
  draftInfo?: PoolDraftInfo;
}) {
  // Filter state seeds from the URL so a captain can SEND someone "the pos-1
  // free agents" — and so a reload, or a trip to a player's profile and back,
  // doesn't silently drop the filter they were reading. Read once on mount:
  // React stays the source of truth, the URL is a mirror (see the effect
  // below), which keeps chip clicks instant instead of round-tripping to the
  // server for a filter that is entirely client-side.
  const params = useSearchParams();
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [role, setRole] = useState<string | null>(() => {
    const p = params.get("pos");
    return p && ROLE_KEYS.includes(p) ? p : null;
  });
  const [sort, setSort] = useState<PoolSort>(() => {
    const s = params.get("sort") as PoolSort | null;
    return s && SORTS.includes(s) ? s : "mmr";
  });
  const [captainOnly, setCaptainOnly] = useState(() => params.get("cap") === "1");
  const [status, setStatus] = useState<PoolStatus>(() => {
    const s = params.get("status");
    return s === "drafted" || s === "free" ? s : "all";
  });

  // Mirror the filters into the address bar. `history.replaceState` rather than
  // router.replace: this is a purely client-side filter, and a router call
  // would re-run the page's four Prisma queries on every chip tap. Debounced
  // because browsers rate-limit replaceState (Safari: 100 per 30s) and the
  // search box would otherwise fire once per keystroke. Defaults are omitted
  // so an unfiltered pool has a clean /players URL.
  useEffect(() => {
    const t = setTimeout(() => {
      const sp = new URLSearchParams();
      if (query) sp.set("q", query);
      if (role) sp.set("pos", role);
      if (sort !== "mmr") sp.set("sort", sort);
      if (captainOnly) sp.set("cap", "1");
      if (status !== "all") sp.set("status", status);
      const qs = sp.toString();
      const next = qs
        ? `${window.location.pathname}?${qs}`
        : window.location.pathname;
      if (next !== window.location.pathname + window.location.search) {
        window.history.replaceState(null, "", next);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, role, sort, captainOnly, status]);

  // The draft-status filter only makes sense once someone's been drafted
  // (post-draft phases) — during SIGNUPS/an empty DRAFT the pool is all free.
  const anyDrafted = useMemo(() => players.some((p) => p.drafted), [players]);

  const filtered = useMemo(
    () =>
      filterAndSortPlayers(players, { query, role, sort, captainOnly, status }),
    [players, query, role, sort, captainOnly, status],
  );
  const filtersActive =
    query !== "" || role !== null || captainOnly || status !== "all";
  // Sort is deliberately NOT reset: it's an ordering preference, not a filter,
  // and `filtersActive` doesn't count it either.
  const resetFilters = () => {
    setQuery("");
    setRole(null);
    setCaptainOnly(false);
    setStatus("all");
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[9rem] flex-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search players…"
            className="h-9 w-full rounded-lg border border-line bg-surface-2/50 pl-3 pr-8 text-sm outline-none focus:border-accent/60"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              ✕
            </button>
          ) : null}
        </div>

        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Filter by role"
        >
          <span
            aria-hidden
            className="mr-0.5 hidden text-xs font-medium uppercase tracking-wide text-muted sm:inline"
          >
            Role
          </span>
          <RoleChip
            active={role === null}
            label="All roles"
            onClick={() => setRole(null)}
          >
            All
          </RoleChip>
          {DOTA_ROLES.map((r) => (
            <RoleChip
              key={r.key}
              active={role === r.key}
              title={r.label}
              // A bare "1" is not a name. Text content beats `title` for the
              // accessible name, so without this a screen reader announced
              // "1, pressed" with nothing to say it meant Carry — and on touch
              // the tooltip never appears at all.
              label={`Position ${r.key} — ${r.label}`}
              onClick={() => setRole(role === r.key ? null : r.key)}
            >
              {r.key}
            </RoleChip>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setCaptainOnly((v) => !v)}
          aria-pressed={captainOnly}
          className={cn(
            CHIP_BASE,
            "h-9 px-3",
            captainOnly
              ? "border-brand/50 bg-brand/10 text-brand"
              : CHIP_OFF,
          )}
        >
          Wants captain
        </button>

        {anyDrafted ? (
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label="Filter by draft status"
          >
            <StatusChip
              active={status === "drafted"}
              onClick={() =>
                setStatus((s) => (s === "drafted" ? "all" : "drafted"))
              }
            >
              Drafted
            </StatusChip>
            <StatusChip
              active={status === "free"}
              onClick={() => setStatus((s) => (s === "free" ? "all" : "free"))}
            >
              Free agents
            </StatusChip>
          </div>
        ) : null}

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as PoolSort)}
          className="h-9 rounded-lg border border-line bg-surface-2/50 px-2 text-sm outline-none focus:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/60"
          aria-label="Sort players"
        >
          <option value="mmr">Sort: MMR</option>
          <option value="rank">Sort: Rank</option>
          <option value="name">Sort: Name</option>
        </select>
      </div>

      {/* aria-live: filtering is a keyboard action whose only feedback used to
          be this line silently changing. */}
      <div
        aria-live="polite"
        className="flex items-center gap-2 text-xs text-muted"
      >
        <span>
          Showing <span className="font-medium text-fg">{filtered.length}</span>{" "}
          of {players.length} players
        </span>
        {filtersActive ? (
          <button
            type="button"
            onClick={resetFilters}
            className="rounded text-info hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No players match"
          description="Try clearing the search or role filters."
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
        <div className="overflow-hidden rounded-[var(--radius)] border border-line bg-surface/80">
          {/* The column header is what turns this from a list into a table.
              It only exists from md up, because below that each row stacks and
              there are no columns to label. */}
          <div
            aria-hidden
            className={cn(
              ROW_GRID,
              "hidden border-b border-line bg-surface-2/40 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted md:grid",
            )}
          >
            <span />
            <span>Player</span>
            <span className="text-right">MMR</span>
            <span>Roles</span>
            <span className="hidden xl:block">Signature heroes</span>
            <span className="text-right">
              {showDraftStatus ? "Status" : "Notes"}
            </span>
          </div>
          <ul className="divide-y divide-line/60">
            {filtered.map((p) => (
              <li
                key={p.userId}
                className={cn(
                  ROW_GRID,
                  "grid items-center px-4 py-3 transition-colors hover:bg-surface-2/40",
                )}
              >
                {/* 1 — avatar */}
                <PlayerLink userId={p.userId} className="shrink-0">
                  <Avatar name={p.name} src={p.avatar} size={34} />
                </PlayerLink>

                {/* 2 — name, contact, note */}
                <span className="min-w-0">
                  <PlayerLink
                    userId={p.userId}
                    className="block truncate text-sm font-medium"
                  >
                    {p.name}
                  </PlayerLink>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    {p.accountId ? (
                      <a
                        href={`https://www.dotabuff.com/players/${p.accountId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded text-info hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                      >
                        Dotabuff ↗
                      </a>
                    ) : null}
                    <DiscordTag
                      name={p.discordName}
                      verified={p.discordVerified}
                    />
                  </span>
                  {hasText(p.captainNote) ? (
                    <span className="mt-1 block truncate text-xs italic text-muted">
                      &ldquo;{p.captainNote}&rdquo;
                    </span>
                  ) : null}
                </span>

                {/* 3 — MMR + medal. The default sort key, so it gets the
                    tabular figure treatment and its own right-aligned column
                    rather than being one wrapping fragment among six. Stays on
                    the name's row at every width — it is the one number a
                    scanning captain wants beside the name. */}
                <span className="flex items-center justify-end gap-1.5">
                  <RankBadge rankTier={p.rankTier} />
                  {p.mmr > 0 ? (
                    <span className="text-sm font-semibold tabular-nums text-fg">
                      {p.mmr}
                    </span>
                  ) : (
                    <span
                      className="text-sm text-muted/70"
                      title="No MMR on this signup"
                    >
                      —
                    </span>
                  )}
                </span>

                {/* 4 — roles, and (below md) the hero strip riding along with
                    them: both answer "what does this player play", and packing
                    them onto one phone row is what keeps a row to three lines. */}
                <span className={cn(CELL, "flex flex-wrap items-center gap-2")}>
                  <RoleBadges roles={p.roles} />
                  <span className="md:hidden">
                    <HeroList value={p.favoriteHeroes} size={22} max={6} />
                  </span>
                </span>

                {/* 5 — draft status / captain interest. DOM order puts this
                    BEFORE heroes so md gets its five tracks in the right order;
                    `xl:order` swaps the two back for the wide layout, where
                    heroes want the column to the LEFT of status.
                    It spans both phone tracks rather than sitting in track 3 —
                    an `auto` track sized by a "Techies Anonymous $4" chip stole
                    ~170px back off the name column on the row above. */}
                <span
                  className={cn(
                    CELL,
                    "flex flex-wrap items-center gap-1.5 justify-end md:justify-end xl:order-2",
                  )}
                >
                  {p.wantsCaptain ? (
                    <Badge tone="brand">Wants captain</Badge>
                  ) : null}
                  {p.drafted ? (
                    draftInfo?.[p.userId] ? (
                      <TeamChip info={draftInfo[p.userId]} />
                    ) : (
                      <Badge tone="success">Drafted</Badge>
                    )
                  ) : showDraftStatus ? (
                    <Badge tone="accent">Free agent</Badge>
                  ) : null}
                </span>

                {/* 6 — signature heroes in their own column, xl only: between
                    md and xl there is no track to spare, and above they ride
                    with the roles. */}
                <span className={cn(CELL, "hidden xl:order-1 xl:block")}>
                  <HeroList value={p.favoriteHeroes} size={22} max={4} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The shared row template — the header and every row use the SAME string, which
 * is the whole point: two copies of these tracks would drift within a week and
 * the header would start lying about which column is which.
 *
 * Below md there are no columns: the avatar keeps the left gutter and every
 * other cell stacks in the second track. That is not a nicety — at 390px the
 * old `justify-between` row gave its right-hand chips `shrink-0` and left the
 * name ~40px, so real players rendered as "P…", "R." and "Dir…".
 */
const ROW_GRID =
  "grid-cols-[2.25rem_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 " +
  // The roles track is 7.5rem because that is EXACTLY what five position pills
  // need (5 x 20px + 4 x 4px gap = 120px). At the 5.5rem it started as, 6 of
  // the 30 real signups wrapped their pills onto a second line, which is the
  // one thing a column is supposed to stop happening.
  "md:grid-cols-[2.25rem_minmax(0,1fr)_5.5rem_7.5rem_11rem] " +
  "xl:grid-cols-[2.25rem_minmax(0,1fr)_5.5rem_7.5rem_9rem_11rem]";

/** Cells 3+ share one placement rule: stacked under the name until md. */
const CELL = "col-start-2 col-span-2 md:col-span-1 md:col-start-auto";

/** Every filter control shares the kit's focus ring — these are buttons, and
 *  they were the only ones on the page a keyboard user couldn't see land on. */
const CHIP_BASE =
  "rounded-lg border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";
const CHIP_ON = "border-accent/50 bg-accent/15 text-accent";
const CHIP_OFF = "border-line text-muted hover:border-muted/60 hover:text-fg";

function RoleChip({
  active,
  onClick,
  title,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  label?: string;
  children: React.ReactNode;
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
        "grid h-9 min-w-9 place-items-center px-2.5",
        active ? CHIP_ON : CHIP_OFF,
      )}
    >
      {children}
    </button>
  );
}

function StatusChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(CHIP_BASE, "h-9 px-3", active ? CHIP_ON : CHIP_OFF)}
    >
      {children}
    </button>
  );
}

/** Post-draft chip: crest + team name (links to the team) with a muted draft
 * price. `TeamCrest` is decorative, so the adjacent name carries the label. */
function TeamChip({
  info,
}: {
  info: { teamId: string; teamName: string; price: number | null };
}) {
  return (
    <Link
      href={`/teams/${info.teamId}`}
      className="flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface-2/50 py-0.5 pl-0.5 pr-2 text-xs hover:border-muted/60 hover:no-underline"
    >
      <TeamCrest
        name={info.teamName}
        seed={info.teamId}
        size={16}
        className="rounded"
      />
      <span className="max-w-[9rem] truncate">{info.teamName}</span>
      {info.price != null ? (
        <span className="text-muted">${info.price}</span>
      ) : null}
    </Link>
  );
}
