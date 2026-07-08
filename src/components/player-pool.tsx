"use client";

import { useMemo, useState } from "react";
import {
  Avatar,
  Badge,
  EmptyState,
  HeroList,
  PlayerLink,
  RankBadge,
  RoleBadges,
} from "@/components/ui";
import { DOTA_ROLES } from "@/lib/roles";
import {
  filterAndSortPlayers,
  type PoolPlayer,
  type PoolSort,
} from "@/lib/player-pool";
import { cn } from "@/lib/utils";

export function PlayerPool({
  players,
  showDraftStatus,
}: {
  players: PoolPlayer[];
  showDraftStatus: boolean;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [sort, setSort] = useState<PoolSort>("mmr");
  const [captainOnly, setCaptainOnly] = useState(false);

  const filtered = useMemo(
    () => filterAndSortPlayers(players, { query, role, sort, captainOnly }),
    [players, query, role, sort, captainOnly],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search players…"
          className="h-9 min-w-[9rem] flex-1 rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
        />

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
          className={cn(
            "h-9 rounded-lg border px-3 text-sm font-medium transition-colors",
            captainOnly
              ? "border-brand/50 bg-brand/10 text-brand"
              : "border-line text-muted hover:text-fg",
          )}
        >
          Wants captain
        </button>

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

      <div className="text-xs text-muted">
        {filtered.length} of {players.length} players
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No players match"
          description="Try clearing the search or role filters."
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
                    <Badge tone="success">Drafted</Badge>
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
