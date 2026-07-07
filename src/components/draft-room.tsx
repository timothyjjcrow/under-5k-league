"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Avatar,
  Badge,
  HeroList,
  RankBadge,
  RoleBadges,
  buttonClasses,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { DraftState } from "@/lib/draft-service";

export function DraftRoom({ pollMs = 1200 }: { pollMs?: number }) {
  const [state, setState] = useState<DraftState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [, forceTick] = useState(0);
  const offsetRef = useRef(0); // serverNow - clientNow, to sync the countdown
  const [selected, setSelected] = useState<string | null>(null);
  const [nomAmount, setNomAmount] = useState(1);

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

      {/* On the block */}
      <div className="rounded-[var(--radius)] border border-line bg-surface/80">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="text-sm text-muted">
            On the clock: <span className="text-fg">{nominatorName}</span>
          </div>
          {state.nominatedPlayer ? (
            <div
              className={cn(
                "font-mono text-lg font-bold tabular-nums",
                seconds <= 5 ? "text-danger" : "text-accent",
              )}
            >
              {seconds}s
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
        <div>
          <div className="rounded-[var(--radius)] border border-line bg-surface/80">
            <div className="border-b border-line px-5 py-3 text-sm font-semibold">
              Available · {state.available.length}
            </div>
            <div className="max-h-[30rem] space-y-1 overflow-y-auto p-3">
              {state.available.map((p) => {
                const pickable = me.canNominate;
                return (
                  <button
                    key={p.userId}
                    disabled={!pickable}
                    onClick={() => {
                      setSelected(p.userId);
                      setNomAmount(state.minBid);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm",
                      pickable
                        ? "hover:bg-surface-2"
                        : "cursor-default opacity-90",
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
              ) : null}
            </div>
          </div>
        </div>
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
        const onClock = t.id === state.nominatorTeamId;
        const highBid = t.id === state.currentBidTeamId;
        return (
          <div
            key={t.id}
            className={cn(
              "rounded-[var(--radius)] border bg-surface/80",
              onClock ? "border-accent/60" : "border-line",
            )}
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <div className="flex items-center gap-2 font-semibold">
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
