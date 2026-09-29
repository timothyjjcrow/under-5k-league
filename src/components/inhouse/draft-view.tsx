"use client";

import {
  Avatar,
  Badge,
  PlayerLink,
  RankBadge,
  buttonClasses,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useBannerOffscreen } from "@/components/room-clock";
import { avgKnownMmr, mmrBalance } from "@/lib/inhouse";
import type { InhouseState } from "@/lib/inhouse-service";
import { SecondsClock } from "@/components/inhouse/clocks";
import {
  scrollToRoomTop,
  sideMeta,
  type LobbyTeam,
  type Player,
  type RoomLobby,
  type RoomMe,
} from "@/components/inhouse/shared";

export function DraftView({
  state,
  me,
  lobby,
  offset,
  selected,
  setSelected,
  pending,
  act,
}: {
  state: InhouseState;
  me: RoomMe;
  lobby: RoomLobby;
  offset: number;
  selected: string | null;
  setSelected: (id: string | null) => void;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  const { teamSize } = state;
  // Same mobile treatment as the league draft room: when the pick-clock
  // banner scrolls away, a compact fixed bar keeps the clock visible.
  const { ref: bannerRef, offscreen } = useBannerOffscreen(true);
  const onClockTeam = lobby.teams.find((t) => t.team === lobby.pickTeam);
  const onClockSide = onClockTeam ? sideMeta(onClockTeam.isRadiant) : null;
  // "Pick 4 of 8" — captains fill one slot each, the rest are drafted.
  const totalPicks = 2 * (teamSize - 1);
  const picksMade = lobby.teams.reduce((s, t) => s + t.players.length, 0);

  // Live balance-of-power line: how the two sides' average MMR compares as
  // picks come in.
  const sideMmrs = (t: LobbyTeam) =>
    (t.captain ? [t.captain, ...t.players] : t.players).map((p) => p.mmr);
  const balance = mmrBalance(
    sideMmrs(lobby.teams[0]),
    sideMmrs(lobby.teams[1]),
  );
  const leader =
    balance.diff > 0
      ? lobby.teams[0]
      : balance.diff < 0
        ? lobby.teams[1]
        : null;
  const balanceLabel =
    balance.avg1 > 0 && balance.avg2 > 0
      ? leader
        ? `${sideMeta(leader.isRadiant).name} ahead by ${Math.abs(balance.diff)} avg MMR`
        : "Teams dead even on MMR"
      : null;

  return (
    <div className="space-y-5">
      {/* Compact fixed bar while the pick clock is scrolled away — the 60s
          auto-pick clock must never be invisible mid-draft. top-20 matches
          the 80px header (see useBannerOffscreen). */}
      {offscreen ? (
        <button
          type="button"
          onClick={scrollToRoomTop}
          aria-label="Back to the pick clock"
          className="fixed inset-x-0 top-20 z-20 border-b border-line bg-bg/90 text-left backdrop-blur"
        >
          <div className="mx-auto flex h-11 w-full max-w-6xl items-center justify-between gap-3 px-4 text-sm sm:px-6">
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden>⏱</span>
              <span className="truncate font-medium">
                {lobby.onClockCaptain?.name ?? "—"} picking
              </span>
              <span className="shrink-0 text-xs text-muted tabular-nums">
                {Math.min(picksMade + 1, totalPicks)}/{totalPicks}
              </span>
              {me.isOnClock ? (
                <Badge tone="accent" className="shrink-0">
                  You
                </Badge>
              ) : null}
            </span>
            <SecondsClock
              endsAtMs={lobby.pickEndsAt}
              offsetMs={offset}
              urgentAt={10}
              label={(s) => `${s} seconds left on the pick clock`}
            />
          </div>
        </button>
      ) : null}

      {/* On the clock banner */}
      <div
        ref={bannerRef}
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-surface/90 px-5 py-4",
          onClockSide?.ring ?? "border-line",
        )}
      >
        <h2 className="text-sm font-normal">
          <span className="text-muted">On the clock: </span>
          <span className="font-semibold">
            {lobby.onClockCaptain?.name ?? "—"}
          </span>
          {onClockSide ? (
            <Badge tone={onClockSide.badge} className="ml-2">
              {onClockSide.name}
            </Badge>
          ) : null}
          <span className="ml-2 text-xs text-muted tabular-nums">
            Pick {Math.min(picksMade + 1, totalPicks)} of {totalPicks}
          </span>
        </h2>
        <div className="flex items-center gap-3">
          {me.isOnClock ? (
            <Badge tone="accent">Your pick</Badge>
          ) : (
            <span className="text-xs text-muted">Drafting…</span>
          )}
          <SecondsClock
            prominent
            endsAtMs={lobby.pickEndsAt}
            offsetMs={offset}
            urgentAt={10}
            label={(s) => `${s} seconds left on the pick clock`}
          />
        </div>
      </div>

      {me.isAdmin && !me.isOnClock ? (
        <p
          role="note"
          className="rounded-lg border border-info/30 bg-info/10 px-4 py-3 text-sm text-muted"
        >
          <strong className="text-fg">Admin recovery:</strong> you can pick for{" "}
          {lobby.onClockCaptain?.name ?? "the current captain"} if they are
          disconnected or unable to act. The current team, clock, and stale-turn
          safeguards still apply.
        </p>
      ) : null}

      {/* Pool FIRST in DOM, directly under the clock: on phones the
          on-clock captain needs it now — Team 1's roster card would otherwise
          bury it (same treatment as the league draft room). lg:order-*
          restores the three-column desktop. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.1fr_1fr]">
        {/* Draft pool. Tapping a player puts the Draft button on that
            same row, so a pick is two taps in one place instead of a hunt
            for a button under the whole pool while the clock runs. */}
        <div className="min-w-0 rounded-[var(--radius)] border border-line bg-surface/80 lg:order-2">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3 text-sm">
            <span className="font-semibold">
              Draft pool · {lobby.pool.length}
            </span>
            {me.canPick && lobby.pool.length > 0 ? (
              <span className="min-w-0 text-right text-xs text-muted">
                {me.isOnClock
                  ? "Tap a player, then Draft"
                  : `Tap a player to draft for ${lobby.onClockCaptain?.name ?? "the current captain"}`}
              </span>
            ) : null}
          </div>
          <div className="space-y-1.5 p-3">
            {lobby.pool.map((p) => {
              const pickable = me.canPick;
              const isSel = selected === p.userId;
              return (
                <div
                  key={p.userId}
                  className={cn(
                    "flex items-center rounded-lg border transition-colors",
                    isSel
                      ? "border-accent bg-accent/15"
                      : "border-line bg-surface-2/40",
                    pickable && !isSel ? "hover:border-accent/50" : "",
                  )}
                >
                  <button
                    type="button"
                    disabled={!pickable}
                    aria-pressed={isSel}
                    aria-label={`Select ${p.name} to draft`}
                    onClick={() => setSelected(isSel ? null : p.userId)}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                      pickable ? "" : "cursor-default",
                    )}
                  >
                    <Avatar name={p.name} src={p.avatar} size={26} />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {p.name}
                    </span>
                    {p.record ? (
                      <span
                        title={`Inhouse record ${p.record.wins}-${p.record.losses}`}
                        className="text-xs tabular-nums text-muted"
                      >
                        {p.record.wins}-{p.record.losses}
                      </span>
                    ) : null}
                    <RankBadge rankTier={p.rankTier} />
                    {p.mmr > 0 ? (
                      <span className="text-xs text-muted tabular-nums">
                        {p.mmr}
                      </span>
                    ) : null}
                  </button>
                  {isSel && pickable ? (
                    // The same pick action as ever; only its place moved.
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => act({ action: "pick", userId: p.userId })}
                      aria-label={
                        me.isOnClock
                          ? `Draft ${p.name}`
                          : `Admin: draft ${p.name} for ${lobby.onClockCaptain?.name ?? "the current captain"}`
                      }
                      className={buttonClasses("accent", "sm", "mr-1.5 shrink-0")}
                    >
                      Draft
                    </button>
                  ) : null}
                </div>
              );
            })}
            {lobby.pool.length === 0 ? (
              <p className="p-2 text-center text-sm text-muted">
                Everyone&apos;s drafted.
              </p>
            ) : null}
          </div>
        </div>

        <div className="min-w-0 lg:order-1">
          <TeamColumn
            team={lobby.teams[0]}
            teamSize={teamSize}
            onClock={lobby.pickTeam === lobby.teams[0].team}
          />
        </div>
        <div className="min-w-0 lg:order-3">
          <TeamColumn
            team={lobby.teams[1]}
            teamSize={teamSize}
            onClock={lobby.pickTeam === lobby.teams[1].team}
          />
        </div>
      </div>

      {/* Draft progress and the MMR balance sit under the pool, so the pool
          starts right under the pick clock. */}
      <div className="rounded-xl border border-line bg-surface/60 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>Snake draft · 1 pick, then pairs</span>
          <span className="tabular-nums">
            {picksMade}/{totalPicks} drafted
          </span>
        </div>
        <div
          aria-label={`${picksMade} of ${totalPicks} players drafted`}
          className="mt-2 flex gap-1.5"
        >
          {Array.from({ length: totalPicks }, (_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 flex-1 rounded-full",
                i < picksMade ? "bg-accent" : "bg-line",
              )}
            />
          ))}
        </div>
        {balanceLabel ? (
          <p className="mt-2 text-center text-xs text-muted">{balanceLabel}</p>
        ) : null}
      </div>
    </div>
  );
}

function TeamColumn({
  team,
  teamSize,
  onClock,
}: {
  team: LobbyTeam;
  teamSize: number;
  onClock: boolean;
}) {
  const meta = sideMeta(team.isRadiant);
  const roster: (Player | null)[] = [team.captain, ...team.players];
  while (roster.length < teamSize) roster.push(null);
  const avgMmr = avgKnownMmr(roster.map((p) => p?.mmr ?? 0));

  return (
    <div
      className={cn(
        "rounded-[var(--radius)] border bg-surface/80",
        onClock ? meta.ring : "border-line",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-b border-line px-4 py-3",
        )}
      >
        <div className="flex items-center gap-2">
          <span className={cn("h-2.5 w-2.5 rounded-full", meta.dot)} />
          <span className="font-semibold">{meta.name}</span>
        </div>
        <span className="flex items-center gap-2">
          {avgMmr > 0 ? (
            <span className="text-xs text-muted tabular-nums">
              avg {avgMmr}
            </span>
          ) : null}
          {onClock ? <Badge tone="accent">picking</Badge> : null}
        </span>
      </div>
      <div className="space-y-1.5 p-3">
        {roster.map((p, i) => (
          <div
            key={p?.userId ?? i}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm",
              p
                ? "border-line bg-surface-2/40"
                : "border-dashed border-line/60",
            )}
          >
            {p ? (
              <>
                <Avatar name={p.name} src={p.avatar} size={24} />
                <PlayerLink
                  userId={p.userId}
                  className="min-w-6 flex-1 truncate"
                >
                  {p.name}
                </PlayerLink>
                {i === 0 ? <Badge tone={meta.badge}>C</Badge> : null}
                {i > 0 && p.pickIndex != null ? (
                  <span
                    title={`Draft pick ${p.pickIndex + 1}`}
                    className="text-[10px] tabular-nums text-muted"
                  >
                    #{p.pickIndex + 1}
                  </span>
                ) : null}
                <RankBadge rankTier={p.rankTier} />
              </>
            ) : (
              <span className="py-0.5 pl-1 text-muted">Empty slot</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
