"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Avatar,
  Badge,
  HeroList,
  RankBadge,
  RoleBadges,
  TeamCrest,
  buttonClasses,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { DOTA_ROLES } from "@/lib/roles";
import { filterAndSortPlayers, type PoolSort } from "@/lib/player-pool";
import type { DraftState } from "@/lib/draft-service";

// A single line in the live feed, derived purely from state transitions.
type FeedEvent = {
  id: number;
  kind: "nominate" | "bid" | "sold";
  text: string;
  amount: number;
};

export function DraftRoom({ pollMs = 1200 }: { pollMs?: number }) {
  const [state, setState] = useState<DraftState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [, forceTick] = useState(0);
  const offsetRef = useRef(0); // serverNow - clientNow, to sync the countdown
  const [selected, setSelected] = useState<string | null>(null);
  const [nomAmount, setNomAmount] = useState(1);
  // Live feed + "SOLD!" flash — derived client-side by diffing successive
  // polled states, so no changes to the server-authoritative draft engine.
  const prevRef = useRef<DraftState | null>(null);
  const eventIdRef = useRef(0);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [soldFlash, setSoldFlash] = useState<{
    name: string;
    team: string;
    price: number;
  } | null>(null);

  const apply = useCallback((s: DraftState) => {
    offsetRef.current = s.now - Date.now();
    setState(s);
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/draft/tick", { method: "POST" });
      if (res.ok) apply(await res.json());
    } catch {
      /* transient network blip; next poll retries */
    }
  }, [apply]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, pollMs);
    return () => clearInterval(id);
  }, [poll, pollMs]);

  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, []);

  // Diff each new state against the previous one to build the live feed +
  // trigger the SOLD! flash. Read-only — never mutates draft state.
  useEffect(() => {
    if (!state) return;
    const prev = prevRef.current;
    prevRef.current = state;
    if (!prev) return;
    const nameOf = (id: string | null) =>
      state.teams.find((t) => t.id === id)?.name ?? "—";
    const add: FeedEvent[] = [];

    // A sale = any new non-captain roster member appearing on a team.
    const prevRostered = new Set(
      prev.teams.flatMap((t) => t.members.map((m) => m.userId)),
    );
    for (const t of state.teams) {
      for (const m of t.members) {
        if (!m.isCaptain && !prevRostered.has(m.userId)) {
          add.push({
            id: eventIdRef.current++,
            kind: "sold",
            text: `${m.name} → ${t.name}`,
            amount: m.price,
          });
          setSoldFlash({ name: m.name, team: t.name, price: m.price });
        }
      }
    }

    const prevNom = prev.nominatedPlayer?.userId ?? null;
    const curNom = state.nominatedPlayer?.userId ?? null;
    if (curNom && curNom !== prevNom) {
      add.push({
        id: eventIdRef.current++,
        kind: "nominate",
        text: `${nameOf(state.nominatorTeamId)} nominated ${state.nominatedPlayer!.name}`,
        amount: state.currentBid,
      });
    } else if (curNom && curNom === prevNom && state.currentBid > prev.currentBid) {
      add.push({
        id: eventIdRef.current++,
        kind: "bid",
        text: `${nameOf(state.currentBidTeamId)} bid`,
        amount: state.currentBid,
      });
    }

    if (add.length) setEvents((e) => [...add, ...e].slice(0, 12));
  }, [state]);

  useEffect(() => {
    if (!soldFlash) return;
    const id = setTimeout(() => setSoldFlash(null), 3600);
    return () => clearTimeout(id);
  }, [soldFlash]);

  async function act(url: string, body: Record<string, unknown>) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Action failed");
      } else {
        apply(data);
        setSelected(null);
      }
    } catch {
      setError("Network error");
    } finally {
      setPending(false);
    }
  }

  if (!state) {
    return <div className="py-10 text-center text-muted">Loading draft…</div>;
  }

  const { me } = state;
  const remainingMs = state.bidEndsAt
    ? state.bidEndsAt - (Date.now() + offsetRef.current)
    : 0;
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const nominatorName =
    state.teams.find((t) => t.id === state.nominatorTeamId)?.name ?? "—";
  const highBidderName = state.teams.find(
    (t) => t.id === state.currentBidTeamId,
  )?.name;

  const quickBid = (delta: number) => {
    const amount = state.currentBid + delta;
    if (amount > me.myMaxBid) return;
    act("/api/draft/bid", { amount });
  };

  if (state.status === "COMPLETE") {
    return (
      <div className="space-y-6">
        <div className="rounded-[var(--radius)] border border-success/40 bg-success/10 p-6 text-center">
          <div className="text-2xl">✅</div>
          <div className="mt-1 text-lg font-semibold">The draft is complete!</div>
          <div className="text-sm text-muted">
            All rosters are set. Standings and the schedule are next.
          </div>
        </div>
        <TeamsGrid state={state} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {soldFlash ? (
        <div className="sold-flash flex flex-col items-center gap-1 rounded-[var(--radius)] border border-success/50 bg-gradient-to-r from-success/15 via-success/10 to-success/15 px-5 py-4 text-center">
          <div className="font-display text-2xl font-black uppercase tracking-widest text-success">
            Sold!
          </div>
          <div className="text-sm">
            <span className="font-semibold">{soldFlash.name}</span> →{" "}
            {soldFlash.team} for{" "}
            <span className="font-bold text-accent">${soldFlash.price}</span>
          </div>
        </div>
      ) : null}

      {/* On the block */}
      <div className="rounded-[var(--radius)] border border-line bg-surface/80">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="text-sm text-muted">
            On the clock: <span className="text-fg">{nominatorName}</span>
          </div>
          {state.nominatedPlayer ? (
            <div
              className={cn(
                "flex items-center gap-2 font-mono text-2xl font-bold tabular-nums",
                seconds <= 5 ? "text-danger" : "text-accent",
              )}
            >
              {seconds <= 5 ? (
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
                </span>
              ) : null}
              <span className={seconds <= 5 ? "animate-countdown-urgent" : ""}>
                {seconds}s
              </span>
            </div>
          ) : null}
        </div>

        <div className="p-5">
          {state.nominatedPlayer ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Avatar
                  name={state.nominatedPlayer.name}
                  src={state.nominatedPlayer.avatar}
                  size={52}
                />
                <div>
                  <div className="text-xl font-bold">
                    {state.nominatedPlayer.name}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted">
                    {state.nominatedPlayer.mmr} MMR
                    <RankBadge rankTier={state.nominatedPlayer.rankTier} />
                    <RoleBadges roles={state.nominatedPlayer.roles} />
                  </div>
                </div>
              </div>

              <div className="text-right">
                <div className="text-3xl font-bold text-accent">
                  ${state.currentBid}
                </div>
                <div className="text-xs text-muted">
                  {highBidderName ? `high bid · ${highBidderName}` : "opening"}
                </div>
              </div>

              {state.nominatedPlayer.favoriteHeroes ||
              state.nominatedPlayer.statement ||
              state.nominatedPlayer.captainNote ? (
                <div className="w-full space-y-1 border-t border-line pt-3 text-sm">
                  {state.nominatedPlayer.favoriteHeroes ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted">Heroes:</span>
                      <HeroList
                        value={state.nominatedPlayer.favoriteHeroes}
                        size={30}
                      />
                    </div>
                  ) : null}
                  {state.nominatedPlayer.captainNote ? (
                    <div>
                      <span className="text-muted">Note to captains:</span>{" "}
                      {state.nominatedPlayer.captainNote}
                    </div>
                  ) : null}
                  {state.nominatedPlayer.statement ? (
                    <div className="text-muted">
                      &ldquo;{state.nominatedPlayer.statement}&rdquo;
                    </div>
                  ) : null}
                </div>
              ) : null}

              {me.canBid ? (
                <div className="flex w-full flex-wrap items-center gap-2 border-t border-line pt-4">
                  <span className="text-sm text-muted">
                    Your max ${me.myMaxBid} · budget ${me.myBudget}
                  </span>
                  <div className="ml-auto flex gap-2">
                    {[1, 5, 10].map((d) => (
                      <button
                        key={d}
                        disabled={pending || state.currentBid + d > me.myMaxBid}
                        onClick={() => quickBid(d)}
                        className={buttonClasses("secondary", "sm")}
                      >
                        +${d}
                      </button>
                    ))}
                    <button
                      disabled={pending || me.myMaxBid <= state.currentBid}
                      onClick={() =>
                        act("/api/draft/bid", { amount: me.myMaxBid })
                      }
                      className={buttonClasses("primary", "sm")}
                    >
                      Max ${me.myMaxBid}
                    </button>
                  </div>
                </div>
              ) : me.myTeamId && state.currentBidTeamId === me.myTeamId ? (
                <div className="w-full border-t border-line pt-3 text-sm text-success">
                  You hold the high bid.
                </div>
              ) : null}
            </div>
          ) : me.canNominate ? (
            <NominateBar
              state={state}
              selected={selected}
              setSelected={setSelected}
              nomAmount={nomAmount}
              setNomAmount={setNomAmount}
              pending={pending}
              onNominate={(playerId, amount) =>
                act("/api/draft/nominate", { playerId, amount })
              }
            />
          ) : (
            <div className="flex flex-col items-center gap-3 py-4">
              <p className="text-center text-muted">
                Waiting for {nominatorName} to nominate a player…
              </p>
              {me.isAdmin ? (
                <button
                  disabled={pending}
                  onClick={() => act("/api/draft/admin-nominate", {})}
                  className={buttonClasses("secondary", "sm")}
                >
                  Admin: auto-nominate top player
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TeamsGrid state={state} />
        </div>
        <div className="space-y-6">
          <BidFeed events={events} />
          <AvailableList
            state={state}
            canNominate={me.canNominate}
            selected={selected}
            onPick={(userId) => {
              setSelected(userId);
              setNomAmount(state.minBid);
            }}
          />
        </div>
      </div>
    </div>
  );
}

// The auction's shopping list. Draft night runs on a clock, so captains get
// search, position filters, and sorting instead of one long MMR-sorted list.
function AvailableList({
  state,
  canNominate,
  selected,
  onPick,
}: {
  state: DraftState;
  canNominate: boolean;
  selected: string | null;
  onPick: (userId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [sort, setSort] = useState<PoolSort>("mmr");
  const shown = filterAndSortPlayers(state.available, { query, role, sort });

  return (
    <div className="rounded-[var(--radius)] border border-line bg-surface/80">
      <div className="border-b border-line px-5 py-3 text-sm font-semibold">
        Available · {state.available.length}
      </div>
      {state.available.length > 0 ? (
        <div className="space-y-2 border-b border-line/60 p-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search players…"
            aria-label="Search available players"
            className="h-8 w-full rounded-md border border-line bg-surface-2/50 px-2.5 text-sm outline-none focus:border-accent/60"
          />
          <div className="flex flex-wrap items-center gap-1">
            <div
              role="group"
              aria-label="Filter by role"
              className="flex items-center gap-1"
            >
              <button
                onClick={() => setRole(null)}
                className={cn(
                  "rounded-md px-2 py-0.5 text-xs",
                  role === null
                    ? "bg-accent/20 text-fg ring-1 ring-accent/40"
                    : "text-muted hover:bg-surface-2",
                )}
              >
                All
              </button>
              {DOTA_ROLES.map((r) => (
                <button
                  key={r.key}
                  title={r.label}
                  onClick={() => setRole(role === r.key ? null : r.key)}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-xs tabular-nums",
                    role === r.key
                      ? "bg-accent/20 text-fg ring-1 ring-accent/40"
                      : "text-muted hover:bg-surface-2",
                  )}
                >
                  {r.key}
                </button>
              ))}
            </div>
            <span className="mx-1 h-4 w-px bg-line" aria-hidden />
            {(["mmr", "rank", "name"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={cn(
                  "rounded-md px-2 py-0.5 text-xs capitalize",
                  sort === s
                    ? "bg-accent/20 text-fg ring-1 ring-accent/40"
                    : "text-muted hover:bg-surface-2",
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="max-h-[30rem] space-y-1 overflow-y-auto p-3">
        {shown.map((p) => {
          return (
            <button
              key={p.userId}
              disabled={!canNominate}
              onClick={() => onPick(p.userId)}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm",
                canNominate ? "hover:bg-surface-2" : "cursor-default opacity-90",
                selected === p.userId ? "bg-accent/15 ring-1 ring-accent/40" : "",
              )}
            >
              <span className="flex items-center gap-2">
                <Avatar name={p.name} src={p.avatar} size={20} />
                {p.name}
              </span>
              <span className="flex items-center gap-2 text-xs text-muted">
                <RoleBadges roles={p.roles} />
                <RankBadge rankTier={p.rankTier} />
                {p.mmr}
              </span>
            </button>
          );
        })}
        {state.available.length === 0 ? (
          <p className="p-2 text-sm text-muted">All players drafted.</p>
        ) : shown.length === 0 ? (
          <p className="p-2 text-sm text-muted">
            No one matches — clear the search or role filter.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function BidFeed({ events }: { events: FeedEvent[] }) {
  return (
    <div className="rounded-[var(--radius)] border border-line bg-surface/80">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm font-semibold">
        <span className="animate-live-pulse inline-block h-1.5 w-1.5 rounded-full bg-danger" />
        Live feed
      </div>
      <div className="max-h-64 space-y-0.5 overflow-y-auto p-3">
        {events.length === 0 ? (
          <p className="p-2 text-sm text-muted">
            Nominations, bids, and picks appear here…
          </p>
        ) : (
          events.map((e) => (
            <div
              key={e.id}
              className={cn(
                "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm",
                e.kind === "sold" && "bg-success/5",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden>
                  {e.kind === "sold" ? "✅" : e.kind === "bid" ? "💰" : "🎯"}
                </span>
                <span className="truncate">{e.text}</span>
              </span>
              <span
                className={cn(
                  "shrink-0 font-mono text-xs tabular-nums",
                  e.kind === "sold" ? "font-bold text-success" : "text-accent",
                )}
              >
                ${e.amount}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function NominateBar({
  state,
  selected,
  nomAmount,
  setNomAmount,
  pending,
  onNominate,
}: {
  state: DraftState;
  selected: string | null;
  setSelected: (id: string | null) => void;
  nomAmount: number;
  setNomAmount: (n: number) => void;
  pending: boolean;
  onNominate: (playerId: string, amount: number) => void;
}) {
  const player = state.available.find((p) => p.userId === selected);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Badge tone="accent">You&apos;re on the clock</Badge>
      {player ? (
        <span className="flex items-center gap-2 text-sm">
          <Avatar name={player.name} src={player.avatar} size={24} />
          {player.name}
        </span>
      ) : (
        <span className="text-sm text-muted">
          Pick a player from the list →
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <label className="text-sm text-muted">Opening $</label>
        <input
          type="number"
          min={state.minBid}
          max={state.me.myMaxBid}
          value={nomAmount}
          onChange={(e) => setNomAmount(Number(e.target.value))}
          className="h-9 w-20 rounded-md border border-line bg-surface-2/50 px-2 text-center text-sm"
        />
        <button
          disabled={
            pending ||
            !selected ||
            nomAmount < state.minBid ||
            nomAmount > state.me.myMaxBid
          }
          onClick={() => selected && onNominate(selected, nomAmount)}
          className={buttonClasses("accent", "sm")}
        >
          Nominate
        </button>
      </div>
    </div>
  );
}

function TeamsGrid({ state }: { state: DraftState }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {state.teams.map((t) => {
        const onClock =
          state.status === "IN_PROGRESS" && t.id === state.nominatorTeamId;
        const highBid = t.id === state.currentBidTeamId;
        return (
          <div
            key={t.id}
            className={cn(
              "rounded-[var(--radius)] border bg-surface/80 transition-all",
              onClock
                ? "border-accent/70 ring-2 ring-accent/30"
                : highBid
                  ? "border-success/50 ring-1 ring-success/25"
                  : "border-line",
            )}
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <div className="flex items-center gap-2 font-display text-base font-semibold">
                  <TeamCrest
                    name={t.name}
                    seed={t.id}
                    size={22}
                    className="rounded-md"
                  />
                  {t.name}
                  {onClock ? <Badge tone="accent">on clock</Badge> : null}
                  {highBid ? <Badge tone="success">high bid</Badge> : null}
                </div>
                <div className="text-xs text-muted">
                  {t.members.length}/{state.teamSize} · needs {t.need}
                </div>
              </div>
              <Badge tone="accent">${t.budget}</Badge>
            </div>
            <div className="space-y-1 p-3">
              {Array.from({ length: state.teamSize }).map((_, i) => {
                const m = t.members[i];
                return m ? (
                  <div
                    key={m.userId}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <Avatar name={m.name} src={m.avatar} size={20} />
                      {m.name}
                      {m.isCaptain ? <Badge tone="accent">C</Badge> : null}
                      <RankBadge rankTier={m.rankTier} />
                    </span>
                    <span className="text-muted">
                      {m.isCaptain ? "—" : `$${m.price}`}
                    </span>
                  </div>
                ) : (
                  <div key={i} className="py-1 text-sm text-muted/50">
                    Empty slot
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
