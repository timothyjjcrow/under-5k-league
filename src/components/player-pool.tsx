"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
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
import { cn } from "@/lib/utils";

/** Which team drafted a player, keyed by userId (parallel to the frozen
 * PoolPlayer type). `price` is null for captains — no draft price shown. */
export type PoolDraftInfo = Record<
  string,
  { teamId: string; teamName: string; price: number | null }
>;

type PoolStatus = "all" | "drafted" | "free";

export function PlayerPool({
  players,
  showDraftStatus,
  draftInfo,
}: {
  players: PoolPlayer[];
  showDraftStatus: boolean;
  draftInfo?: PoolDraftInfo;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [sort, setSort] = useState<PoolSort>("mmr");
  const [captainOnly, setCaptainOnly] = useState(false);
  const [status, setStatus] = useState<PoolStatus>("all");

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

        <div className="flex items-center gap-1" role="group" aria-label="Filter by role">
          <RoleChip active={role === null} onClick={() => setRole(null)}>
            All
          </RoleChip>
          {DOTA_ROLES.map((r) => (
            <RoleChip
              key={r.key}
              active={role === r.key}
              title={r.label}
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
            "h-9 rounded-lg border px-3 text-sm font-medium transition-colors",
            captainOnly
              ? "border-brand/50 bg-brand/10 text-brand"
              : "border-line text-muted hover:text-fg",
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
          className="h-9 rounded-lg border border-line bg-surface-2/50 px-2 text-sm outline-none focus:border-accent/60"
          aria-label="Sort players"
        >
          <option value="mmr">Sort: MMR</option>
          <option value="rank">Sort: Rank</option>
          <option value="name">Sort: Name</option>
        </select>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted">
        <span>
          {filtered.length} of {players.length} players
        </span>
        {filtersActive ? (
          <button
            type="button"
            onClick={resetFilters}
            className="text-info hover:underline"
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
        <ul className="divide-y divide-line/60 overflow-hidden rounded-[var(--radius)] border border-line bg-surface/80">
          {filtered.map((p) => (
              <li
                key={p.userId}
                className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-surface-2/40"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <PlayerLink userId={p.userId}>
                    <Avatar name={p.name} src={p.avatar} size={32} />
                  </PlayerLink>
                  <span className="min-w-0">
                    <PlayerLink
                      userId={p.userId}
                      className="block truncate text-sm font-medium"
                    >
                      {p.name}
                    </PlayerLink>
                    <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                      {p.mmr} MMR
                      <RankBadge rankTier={p.rankTier} />
                      <RoleBadges roles={p.roles} />
                      {p.accountId ? (
                        <a
                          href={`https://www.dotabuff.com/players/${p.accountId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-info hover:underline"
                        >
                          Dotabuff ↗
                        </a>
                      ) : null}
                    </span>
                    {p.favoriteHeroes ? (
                      <span className="mt-1.5 block">
                        <HeroList value={p.favoriteHeroes} size={24} />
                      </span>
                    ) : null}
                    {p.captainNote ? (
                      <span className="mt-0.5 block max-w-xl truncate text-xs italic text-muted">
                        &ldquo;{p.captainNote}&rdquo;
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {p.wantsCaptain ? <Badge tone="brand">Wants captain</Badge> : null}
                  {p.drafted ? (
                    draftInfo?.[p.userId] ? (
                      <TeamChip info={draftInfo[p.userId]} />
                    ) : (
                      <Badge tone="success">Drafted</Badge>
                    )
                  ) : showDraftStatus ? (
                    <Badge>Undrafted</Badge>
                  ) : null}
                </span>
              </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RoleChip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "grid h-9 min-w-9 place-items-center rounded-lg border px-2.5 text-sm font-medium transition-colors",
        active
          ? "border-accent/50 bg-accent/15 text-accent"
          : "border-line text-muted hover:text-fg",
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
      className={cn(
        "h-9 rounded-lg border px-3 text-sm font-medium transition-colors",
        active
          ? "border-accent/50 bg-accent/15 text-accent"
          : "border-line text-muted hover:text-fg",
      )}
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
