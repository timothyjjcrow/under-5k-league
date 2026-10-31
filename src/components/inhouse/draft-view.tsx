"use client";

import {
  Avatar,
  Badge,
  PlayerLink,
  RankBadge,
  RoleBadges,
  buttonClasses,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useBannerOffscreen } from "@/components/room-clock";
import {
  avgKnownMmr,
  fillsRoleNeed,
  inhouseTeamRoleNeeds,
  mmrBalance,
} from "@/lib/inhouse";
import {
  draftTurn,
  draftTurnText,
  inhousePickOrder,
  lastDraftPick,
} from "@/lib/inhouse-room-view";
import { parseRoleOrder, rolesAccessibleName } from "@/lib/roles";
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
import { TeamRoleNeeds, rosterOf } from "@/components/inhouse/team-role-needs";

export function DraftView({
  state,
  me,
  lobby,
  offset,
  selected,
  setSelected,
  pending,
  act,
  clockBar = true,
}: {
  state: InhouseState;
  me: RoomMe;
  lobby: RoomLobby;
  offset: number;
  selected: string | null;
  setSelected: (id: string | null) => void;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
  /**
   * Pin a compact clock bar under the header when the banner scrolls away.
   * Off for a game the viewer only watches beside their own (or beside the
   * other live game), where a second pinned bar would cover the first.
   */
  clockBar?: boolean;
}) {
  const { teamSize } = state;
  // Same mobile treatment as the league draft room: when the pick-clock
  // banner scrolls away, a compact fixed bar keeps the clock visible.
  const { ref: bannerRef, offscreen } = useBannerOffscreen(clockBar);
  const onClockTeam = lobby.teams.find((t) => t.team === lobby.pickTeam);
  const onClockSide = onClockTeam ? sideMeta(onClockTeam.isRadiant) : null;
  // The positions the team on the clock still lacks, so its captain can see
  // which pool players would round it out ("fills Pos 4" on their rows).
  const onClockNeeds = onClockTeam
    ? inhouseTeamRoleNeeds(rosterOf(onClockTeam)).open
    : [];
  // "Pick 4 of 8" — captains fill one slot each, the rest are drafted.
  const totalPicks = 2 * (teamSize - 1);
  const picksMade = lobby.teams.reduce((s, t) => s + t.players.length, 0);
  const pickNo = Math.min(picksMade + 1, totalPicks);
  // The whole snake order, and where the viewer's own picks fall in it.
  const order = inhousePickOrder(teamSize);
  const turnText = draftTurnText(
    draftTurn({
      order,
      picksMade,
      pickTeam: lobby.pickTeam,
      myCaptainTeam: me.isCaptain ? me.myTeam : null,
    }),
  );
  const last = lastDraftPick(lobby.teams);
  const teamByNumber = (n: number) => lobby.teams.find((t) => t.team === n);

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
    <div className="space-y-3">
      {/* Compact fixed bar while the pick clock is scrolled away — the 60s
          auto-pick clock must never be invisible mid-draft. top-16 matches
          the 64px header (see useBannerOffscreen). */}
      {offscreen ? (
        <button
          type="button"
          onClick={scrollToRoomTop}
          aria-label="Back to the pick clock"
          className="fixed inset-x-0 top-16 z-20 border-b border-line bg-bg/90 text-left backdrop-blur"
        >
          <div className="mx-auto flex h-11 w-full max-w-7xl items-center justify-between gap-3 px-4 text-sm sm:px-6 lg:px-8">
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden>⏱</span>
              <span className="truncate font-medium">
                {me.isOnClock ? (
                  <>Your pick</>
                ) : (
                  `${lobby.onClockCaptain?.name ?? "—"} picking`
                )}
              </span>
              <span className="shrink-0 text-xs text-muted tabular-nums">
                {pickNo}/{totalPicks}
              </span>
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

      {/* The turn, its clock, the snake order and the last pick in one
          card: whose pick it is, and for a captain how soon theirs is. */}
      <section
        ref={bannerRef}
        aria-label="Draft"
        className={cn(
          "rounded-2xl border p-4 sm:p-5",
          me.isOnClock
            ? "border-accent/60 bg-gradient-to-br from-accent/15 via-surface to-surface"
            : cn("bg-surface/90", onClockSide?.ring ?? "border-line"),
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {me.isOnClock ? (
              <>
                <Badge tone="accent">Your pick</Badge>
                <h2 className="mt-1.5 font-display text-xl font-semibold sm:text-2xl">
                  {turnText ?? "You’re on the clock"}
                </h2>
              </>
            ) : (
              <h2 className="text-sm font-normal">
                <span className="text-muted">On the clock: </span>
                <span className="font-semibold">
                  {lobby.onClockCaptain?.name ?? "—"}
                </span>
              </h2>
            )}
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted tabular-nums">
              {onClockSide ? (
                <Badge tone={onClockSide.badge}>{onClockSide.name}</Badge>
              ) : null}
              <span>
                Pick {pickNo} of {totalPicks}
              </span>
            </p>
            {!me.isOnClock && turnText ? (
              <p className="mt-1.5 text-sm font-semibold text-accent">
                {turnText}
              </p>
            ) : null}
          </div>
          <SecondsClock
            prominent
            endsAtMs={lobby.pickEndsAt}
            offsetMs={offset}
            urgentAt={10}
            label={(s) => `${s} seconds left on the pick clock`}
          />
        </div>

        {/* The snake, one segment per pick in its side's colour: made picks
            solid, the one on the clock pulsing, the rest faint, so a captain
            sees a double pick coming. */}
        <ol aria-label="Pick order" className="mt-3 flex gap-1">
          {order.map((n, i) => {
            const team = teamByNumber(n);
            const radiant = team?.isRadiant ?? n === 1;
            const state =
              i < picksMade ? "made" : i === picksMade ? "on the clock" : "to come";
            return (
              <li
                key={i}
                aria-label={`Pick ${i + 1}: ${sideMeta(radiant).name}, ${state}`}
                className={cn(
                  "h-2 flex-1 rounded-full",
                  state === "to come"
                    ? radiant
                      ? "bg-success/20"
                      : "bg-danger/20"
                    : sideMeta(radiant).dot,
                  state === "on the clock" &&
                    "animate-pulse ring-2 ring-accent/70 ring-offset-1 ring-offset-surface motion-reduce:animate-none",
                )}
              />
            );
          })}
        </ol>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted">
          <span className="min-w-0">
            {last ? (
              <>
                Last pick:{" "}
                <span className="font-medium text-fg">
                  {last.team.captain?.name ?? sideMeta(last.team.isRadiant).name}
                </span>{" "}
                took{" "}
                <span className="font-medium text-fg">{last.player.name}</span>
              </>
            ) : (
              "Snake draft: one pick, then pairs"
            )}
          </span>
          {balanceLabel ? <span>{balanceLabel}</span> : null}
        </div>
        {/* A phone shows the team on the clock under the pool; here its
            captain sees what that side has and lacks without scrolling. */}
        {onClockTeam && onClockSide ? (
          <p className="mt-1 truncate text-xs text-muted lg:hidden">
            <span className="font-medium text-fg">{onClockSide.name}:</span>{" "}
            {rosterOf(onClockTeam)
              .map((p) => p.name)
              .join(", ")}
            {onClockNeeds.length > 0
              ? ` · needs ${onClockNeeds.map((k) => `Pos ${k}`).join(", ")}`
              : ""}
          </p>
        ) : null}
      </section>

      {me.isAdmin && !me.isOnClock ? (
        <p
          role="note"
          className="rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-xs text-muted"
        >
          <strong className="text-fg">Admin recovery:</strong> you can draft
          for {lobby.onClockCaptain?.name ?? "the current captain"} if
          they&apos;re stuck. The turn and clock safeguards still apply.
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
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-sm">
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
          <div className="space-y-1.5 p-2.5">
            {lobby.pool.map((p) => {
              const pickable = me.canPick;
              const isSel = selected === p.userId;
              // The positions this player would fill for the team on the
              // clock, shown as "fills Pos 4" and spoken with their roles.
              const fills = parseRoleOrder(p.roles).filter((k) =>
                onClockNeeds.includes(k),
              );
              const fillsText =
                fills.length > 0
                  ? `fills ${fills.map((k) => `Pos ${k}`).join(", ")}`
                  : null;
              // The button's label ("Select X to draft") replaces its
              // contents for a screen reader, so the positions ride along as
              // its description.
              const rolesText = [
                rolesAccessibleName(p.roles, { ranked: p.rolesRanked }),
                fillsText,
              ]
                .filter(Boolean)
                .join("; ");
              const rolesId = `pool-roles-${lobby.id}-${p.userId}`;
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
                    aria-describedby={rolesText ? rolesId : undefined}
                    onClick={() => setSelected(isSel ? null : p.userId)}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                      pickable ? "" : "cursor-default",
                    )}
                  >
                    <Avatar name={p.name} src={p.avatar} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {p.name}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <RoleBadges roles={p.roles} ranked={p.rolesRanked} />
                        {fillsRoleNeed(onClockNeeds, p.roles) ? (
                          <span className="text-[11px] font-medium text-accent">
                            {fillsText}
                          </span>
                        ) : null}
                        {rolesText ? (
                          <span id={rolesId} className="sr-only">
                            {rolesText}
                          </span>
                        ) : null}
                      </span>
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
          "flex items-center justify-between gap-2 border-b border-line px-4 py-2.5",
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
      <TeamRoleNeeds members={rosterOf(team)} />
      <div className="space-y-1.5 p-3">
        {roster.map((p, i) => (
          <div
            key={p?.userId ?? i}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm",
              p
                ? "border-line bg-surface-2/40"
                : "border-dashed border-line/60",
            )}
          >
            {p ? (
              <>
                <Avatar name={p.name} src={p.avatar} size={24} />
                <span className="min-w-6 flex-1">
                  <PlayerLink userId={p.userId} className="block truncate">
                    {p.name}
                  </PlayerLink>
                  <RoleBadges
                    roles={p.roles}
                    ranked={p.rolesRanked}
                    labelled
                    className="mt-0.5"
                  />
                </span>
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

