"use client";

import { useRef } from "react";
import { Avatar, Badge, RankBadge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useBannerOffscreen } from "@/components/room-clock";
import { orderCaptains } from "@/lib/inhouse";
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
}: {
  lobby: RoomLobby;
  me: InhouseState["me"];
  offset: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  const vote = lobby.vote;
  const candidatesRef = useRef<HTMLDivElement>(null);
  // The 25s vote clock must stay visible while a player scrolls the nominate
  // list — same compact-bar treatment as the draft's pick clock.
  const { ref: bannerRef, offscreen } = useBannerOffscreen(true);
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

  return (
    <div className="space-y-5">
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

      <div
        ref={bannerRef}
        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/40 bg-gradient-to-br from-accent/10 to-surface px-5 py-5"
      >
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
            Captain vote
          </p>
          <h2 className="font-display text-2xl font-semibold">
            Choose your captains
          </h2>
          <div className="text-xs text-muted">
            {vote.votedCount}/{vote.voterCount} voted · lobby decides by
            majority
          </div>
        </div>
        <SecondsClock
          prominent
          endsAtMs={lobby.voteEndsAt}
          offsetMs={offset}
          urgentAt={5}
          label={(s) => `${s} seconds left to vote`}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MethodCard
          label="Elect captains"
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
              block: "center",
            });
          }}
          preview={hasNominations ? byVotes.slice(0, 2) : []}
          previewEmpty="Tap players below to nominate"
        />
        <MethodCard
          label="Highest MMR"
          hint="Two highest-MMR players"
          tally={vote.methodTallies.MMR}
          total={vote.voterCount}
          selected={myMethod === "MMR"}
          disabled={!me.canVote || pending}
          onClick={() => act({ action: "vote", method: "MMR" })}
          preview={byMmr.slice(0, 2)}
        />
        <MethodCard
          label="Best record"
          hint="Most inhouse wins, then MMR"
          tally={vote.methodTallies.RECORD}
          total={vote.voterCount}
          selected={myMethod === "RECORD"}
          disabled={!me.canVote || pending}
          onClick={() => act({ action: "vote", method: "RECORD" })}
          preview={hasWinners ? byRecord.slice(0, 2) : []}
          previewEmpty="No inhouse wins yet — falls back to MMR"
        />
      </div>

      <div
        ref={candidatesRef}
        tabIndex={-1}
        aria-label="Captain nominations"
        className="scroll-mt-36 rounded-2xl border border-line bg-surface/80 outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3 text-sm">
          <span className="font-semibold">Nominate a captain</span>
          <span className="text-xs text-muted">
            {me.canVote ? "tap a player to vote for them" : "spectating"}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-1.5 p-3 sm:grid-cols-2">
          {vote.candidates.map((c) => {
            const picked = myNominee === c.userId && myMethod === "VOTE";
            return (
              <button
                key={c.userId}
                disabled={!me.canVote || pending}
                aria-pressed={picked}
                aria-label={`Vote for ${c.name} as captain`}
                onClick={() =>
                  act({ action: "vote", method: "VOTE", nomineeId: c.userId })
                }
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors",
                  me.canVote ? "hover:border-accent/50" : "cursor-default",
                  picked
                    ? "border-accent bg-accent/15"
                    : "border-line bg-surface-2/40",
                )}
              >
                <Avatar name={c.name} src={c.avatar} size={26} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {c.name}
                </span>
                {c.nominations > 0 ? (
                  <Badge tone="accent">
                    {c.nominations} {c.nominations === 1 ? "vote" : "votes"}
                  </Badge>
                ) : null}
                <span className="text-xs text-muted">
                  {c.games > 0 ? `${c.wins}-${c.losses}` : "new"}
                </span>
                <RankBadge rankTier={c.rankTier} />
                {c.mmr > 0 ? (
                  <span className="text-xs text-muted tabular-nums">
                    {c.mmr}
                  </span>
                ) : null}
              </button>
            );
          })}
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
        "flex min-w-0 flex-col gap-2 rounded-2xl border bg-surface/80 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        selected ? "border-accent bg-accent/10" : "border-line",
        !disabled && onClick ? "hover:border-accent/50" : "",
        disabled && !selected ? "opacity-90" : "",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold">{label}</span>
        {selected ? <Badge tone="accent">your vote</Badge> : null}
      </div>
      <span className="text-xs text-muted">{hint}</span>

      <div className="mt-1 flex items-center gap-2">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-xs tabular-nums text-muted">
          {tally}/{total}
        </span>
      </div>

      <div className="min-h-[1.75rem] pt-1">
        {preview.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {preview.map((c) => (
              <span
                key={c.userId}
                className="flex items-center gap-1 rounded-full border border-line bg-surface-2/50 py-0.5 pl-0.5 pr-2 text-xs"
              >
                <Avatar name={c.name} src={c.avatar} size={18} />
                <span className="max-w-[6rem] truncate">{c.name}</span>
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted">{previewEmpty}</span>
        )}
      </div>
    </button>
  );
}
