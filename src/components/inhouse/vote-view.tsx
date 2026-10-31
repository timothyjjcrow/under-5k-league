"use client";

import { useRef } from "react";
import { Avatar, Badge, RankBadge, RoleBadges } from "@/components/ui";
import { rolesAccessibleName } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { useBannerOffscreen } from "@/components/room-clock";
import { orderCaptains, type CaptainMethod } from "@/lib/inhouse";
import {
  CAPTAIN_METHOD_LABEL,
  projectedCaptains,
  voteProjectionText,
} from "@/lib/inhouse-room-view";
import type { InhouseState } from "@/lib/inhouse-service";
import { SecondsClock } from "@/components/inhouse/clocks";
import { scrollToRoomTop, type RoomLobby } from "@/components/inhouse/shared";

type Candidate = NonNullable<RoomLobby["vote"]>["candidates"][number];

export function VoteView({
  lobby,
  me,
  offset,
  pending,
  act,
  clockBar = true,
}: {
  lobby: RoomLobby;
  me: InhouseState["me"];
  offset: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
  /**
   * Pin a compact clock bar under the header when the banner scrolls away.
   * Off for a game the viewer only watches beside their own (or beside the
   * other live game), where a second pinned bar would cover the first.
   */
  clockBar?: boolean;
}) {
  const vote = lobby.vote;
  const candidatesRef = useRef<HTMLDivElement>(null);
  // The 25s vote clock must stay visible while a player scrolls the nominate
  // list — same compact-bar treatment as the draft's pick clock.
  const { ref: bannerRef, offscreen } = useBannerOffscreen(clockBar);
  if (!vote) return null;

  const myMethod = me.myVote?.method ?? null;
  const myNominee = me.myVote?.nomineeId ?? null;

  // The SAME ranking the server will install, not a hand-copy of it: these
  // three previews are what the ten players are voting on, and the local sorts
  // they used to run dropped orderCaptains' final earliest-queued tiebreak. On
  // a young ladder ties are the normal case — everyone 0-0, unregistered
  // players at MMR 0 — so the cards routinely named a different second captain
  // than the vote would actually produce.
  const byMmr = orderCaptains("MMR", vote.candidates);
  const byRecord = orderCaptains("RECORD", vote.candidates);
  const byVotes = orderCaptains("VOTE", vote.candidates);
  // RECORD only ranks players with an inhouse win; with none in the lobby it
  // is the MMR order, so the card says so instead of repeating that preview.
  const hasWinners = vote.candidates.some((c) => c.wins > 0);
  const hasNominations = vote.candidates.some((c) => c.nominations > 0);

  // What the vote decides if its clock runs out now: the same tally and
  // ranking resolveCaptainVote uses (projectedCaptains).
  const projection = projectedCaptains(vote);
  const myNomineeName =
    myMethod === "VOTE" && myNominee
      ? (vote.candidates.find((c) => c.userId === myNominee)?.name ?? null)
      : null;
  const myLine = !me.canVote
    ? "spectating"
    : myMethod
      ? `your vote: ${CAPTAIN_METHOD_LABEL[myMethod as CaptainMethod]}${myNomineeName ? ` (${myNomineeName})` : ""}`
      : "you haven’t voted";

  return (
    <div className="space-y-3">
      {/* Compact fixed bar while the vote clock is scrolled away. top-16
          matches the 64px header (see useBannerOffscreen). */}
      {offscreen ? (
        <button
          type="button"
          onClick={scrollToRoomTop}
          aria-label="Back to the captain vote"
          className="fixed inset-x-0 top-16 z-20 border-b border-line bg-bg/90 text-left backdrop-blur"
        >
          <div className="mx-auto flex h-11 w-full max-w-7xl items-center justify-between gap-3 px-4 text-sm sm:px-6 lg:px-8">
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden>🗳️</span>
              <span className="truncate font-medium">Captain vote</span>
              <span className="shrink-0 text-xs text-muted tabular-nums">
                {vote.votedCount}/{vote.voterCount} voted
              </span>
            </span>
            <SecondsClock
              endsAtMs={lobby.voteEndsAt}
              offsetMs={offset}
              urgentAt={5}
              label={(s) => `${s} seconds left to vote`}
            />
          </div>
        </button>
      ) : null}

      <section
        ref={bannerRef}
        aria-label="Captain vote"
        className="rounded-2xl border border-accent/40 bg-gradient-to-br from-accent/10 to-surface p-4 sm:p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
              Captain vote
            </p>
            <h2 className="font-display text-xl font-semibold sm:text-2xl">
              Choose your captains
            </h2>
            <p className="mt-1 text-xs text-muted tabular-nums">
              {vote.votedCount}/{vote.voterCount} voted · {myLine}
            </p>
          </div>
          <SecondsClock
            prominent
            endsAtMs={lobby.voteEndsAt}
            offsetMs={offset}
            urgentAt={5}
            label={(s) => `${s} seconds left to vote`}
          />
        </div>
        <div className="mt-3 rounded-lg border border-line bg-bg/40 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted">
            If time ran out now
          </p>
          <p className="mt-0.5 text-sm text-fg">
            {voteProjectionText(projection)}
          </p>
        </div>
      </section>

      {/* The three methods beside the nominations from lg, so the whole
          vote fits one screen; stacked slim on a phone. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:items-start">
        <div className="grid grid-cols-1 gap-2">
          <MethodCard
            label={CAPTAIN_METHOD_LABEL.VOTE}
            hint="Vote for the players you want"
            tally={vote.methodTallies.VOTE}
            total={vote.voterCount}
            selected={myMethod === "VOTE"}
            disabled={!me.canVote || pending}
            onClick={() => {
              candidatesRef.current?.focus({ preventScroll: true });
              candidatesRef.current?.scrollIntoView({
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                  .matches
                  ? "instant"
                  : "smooth",
                block: "nearest",
              });
            }}
            preview={hasNominations ? byVotes.slice(0, 2) : []}
            previewEmpty="Tap players to nominate"
          />
          <MethodCard
            label={CAPTAIN_METHOD_LABEL.MMR}
            hint="Two highest-MMR players"
            tally={vote.methodTallies.MMR}
            total={vote.voterCount}
            selected={myMethod === "MMR"}
            disabled={!me.canVote || pending}
            onClick={() => act({ action: "vote", method: "MMR" })}
            preview={byMmr.slice(0, 2)}
          />
          <MethodCard
            label={CAPTAIN_METHOD_LABEL.RECORD}
            hint="Most inhouse wins, then MMR"
            tally={vote.methodTallies.RECORD}
            total={vote.voterCount}
            selected={myMethod === "RECORD"}
            disabled={!me.canVote || pending}
            onClick={() => act({ action: "vote", method: "RECORD" })}
            preview={hasWinners ? byRecord.slice(0, 2) : []}
            previewEmpty="No inhouse wins yet — same as MMR"
          />
        </div>

        <div
          ref={candidatesRef}
          tabIndex={-1}
          aria-label="Captain nominations"
          className="min-w-0 scroll-mt-32 rounded-2xl border border-line bg-surface/80 outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-sm">
            <span className="font-semibold">Nominate a captain</span>
            <span className="text-xs text-muted">
              {me.canVote ? "tap a player to vote for them" : "spectating"}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-1.5 p-2.5 sm:grid-cols-2">
            {vote.candidates.map((c) => {
              const picked = myNominee === c.userId && myMethod === "VOTE";
              // The label replaces the button's contents for a screen reader;
              // the positions ride along as its description.
              const rolesText = rolesAccessibleName(c.roles, {
                ranked: c.rolesRanked,
              });
              const rolesId = `vote-roles-${lobby.id}-${c.userId}`;
              return (
                <button
                  key={c.userId}
                  disabled={!me.canVote || pending}
                  aria-pressed={picked}
                  aria-label={`Vote for ${c.name} as captain`}
                  aria-describedby={rolesText ? rolesId : undefined}
                  onClick={() =>
                    act({ action: "vote", method: "VOTE", nomineeId: c.userId })
                  }
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors",
                    me.canVote ? "hover:border-accent/50" : "cursor-default",
                    picked
                      ? "border-accent bg-accent/15"
                      : "border-line bg-surface-2/40",
                  )}
                >
                  <Avatar name={c.name} src={c.avatar} size={24} />
                  {/* Positions under the name, not beside it: the row is
                      already full at phone width. */}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.name}</span>
                    <RoleBadges
                      roles={c.roles}
                      ranked={c.rolesRanked}
                      className="mt-0.5"
                    />
                    {rolesText ? (
                      <span id={rolesId} className="sr-only">
                        {rolesText}
                      </span>
                    ) : null}
                  </span>
                  {c.nominations > 0 ? (
                    <Badge tone="accent">
                      {c.nominations} {c.nominations === 1 ? "vote" : "votes"}
                    </Badge>
                  ) : null}
                  <span className="shrink-0 text-xs text-muted">
                    {c.games > 0 ? `${c.wins}-${c.losses}` : "new"}
                  </span>
                  <RankBadge rankTier={c.rankTier} />
                  {c.mmr > 0 ? (
                    <span className="shrink-0 text-xs text-muted tabular-nums">
                      {c.mmr}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {!me.isLoggedIn ? (
        <p className="text-center text-xs text-muted">
          Sign in to join future inhouses — this one&apos;s already drafting
          soon.
        </p>
      ) : null}
    </div>
  );
}

function MethodCard({
  label,
  hint,
  tally,
  total,
  selected,
  disabled,
  onClick,
  preview,
  previewEmpty,
}: {
  label: string;
  hint: string;
  tally: number;
  total: number;
  selected: boolean;
  disabled?: boolean;
  onClick?: () => void;
  preview: Candidate[];
  previewEmpty?: string;
}) {
  const pct = total > 0 ? Math.round((tally / total) * 100) : 0;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-xl border bg-surface/80 px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        selected ? "border-accent bg-accent/10" : "border-line",
        !disabled && onClick ? "hover:border-accent/50" : "",
        disabled && !selected ? "opacity-90" : "",
      )}
    >
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold">{label}</span>
        <span className="flex shrink-0 items-center gap-2">
          {selected ? <Badge tone="accent">your vote</Badge> : null}
          <span className="text-xs tabular-nums text-muted">
            {tally}/{total}
          </span>
        </span>
      </span>
      <span className="block h-1.5 overflow-hidden rounded-full bg-surface-2">
        <span
          className="block h-full rounded-full bg-accent transition-all"
          style={{ width: `${pct}%` }}
        />
      </span>
      {/* The hint, then who this method would make captains. */}
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {/* A phone keeps the card to two lines: the label says it, the
            chips show it. */}
        <span
          className={cn(
            "text-muted",
            preview.length > 0 && "max-sm:sr-only",
          )}
        >
          {hint}
        </span>
        {preview.length > 0 ? (
          preview.map((c) => (
            <span
              key={c.userId}
              className="flex min-w-0 items-center gap-1 rounded-full border border-line bg-surface-2/50 py-0.5 pl-0.5 pr-2"
            >
              <Avatar name={c.name} src={c.avatar} size={16} />
              <span className="max-w-[7rem] truncate">{c.name}</span>
            </span>
          ))
        ) : previewEmpty ? (
          <span className="text-muted/80">· {previewEmpty}</span>
        ) : null}
      </span>
    </button>
  );
}
