"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar, Badge, PlayerLink, RankBadge, buttonClasses } from "@/components/ui";
import { pushToast } from "@/components/toaster";
import { cn } from "@/lib/utils";
import {
  useBannerOffscreen,
  usePollHealth,
  useSecondsLeft,
  useElapsedMs,
} from "@/components/room-clock";
import { mmrBalance } from "@/lib/inhouse";
import { playChime, unlockAudio } from "@/components/chime";
import type { InhouseState } from "@/lib/inhouse-service";

type LobbyTeam = NonNullable<InhouseState["lobby"]>["teams"][number];
type Player = LobbyTeam["players"][number];

// Radiant = green, Dire = red — matching the in-client colors so it reads fast.
function sideMeta(isRadiant: boolean) {
  return isRadiant
    ? {
        name: "Radiant",
        badge: "success" as const,
        ring: "border-success/50",
        chip: "bg-success/10 text-success border-success/30",
        dot: "bg-success",
      }
    : {
        name: "Dire",
        badge: "danger" as const,
        ring: "border-danger/50",
        chip: "bg-danger/10 text-danger border-danger/30",
        dot: "bg-danger",
      };
}

export function InhouseRoom({
  pollMs = 1500,
  defaultMmr = 0,
}: {
  pollMs?: number;
  defaultMmr?: number;
}) {
  const router = useRouter();
  const [state, setState] = useState<InhouseState | null>(null);
  const { disconnected, ok: pollOk, fail: pollFail } = usePollHealth();
  const [reqPending, setPending] = useState(false);
  // Disconnected = all actions disabled: a pick/vote against stale state
  // would fail (or look accepted) while the real lobby moved on.
  const pending = reqPending || disconnected;
  const [selected, setSelected] = useState<string | null>(null);
  const [mmr, setMmr] = useState<number>(defaultMmr);
  const [soundOn, setSoundOn] = useState(true);
  const offsetRef = useRef(0); // serverNow - clientNow, to sync the clock
  const prevLobbyId = useRef<string | null>(null);
  // For the bell notification: remember what we saw last poll.
  const soundInitRef = useRef(false);
  const prevStatusRef = useRef<string | null>(null);
  const prevOnClockRef = useRef(false);
  const prevResultIdRef = useRef<string | null>(null);
  const originalTitleRef = useRef<string | null>(null);
  // Result banners the viewer closed — stays dismissed across the polls of
  // the 10-minute lastResult window AND across reloads (localStorage), so a
  // refresh doesn't resurrect a banner they already read.
  const [dismissedResults, setDismissedResults] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    setSoundOn(localStorage.getItem("inhouseSound") !== "off");
    const dismissed = localStorage.getItem("inhouseDismissedResult");
    if (dismissed) setDismissedResults(new Set([dismissed]));
  }, []);

  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      const next = !on;
      localStorage.setItem("inhouseSound", next ? "on" : "off");
      if (next) playChime(); // confirm + unlock audio on this gesture
      return next;
    });
  }, []);

  const apply = useCallback((s: InhouseState) => {
    offsetRef.current = s.now - Date.now();
    setState(s);
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/inhouse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "state" }),
      });
      if (res.ok) {
        apply(await res.json());
        pollOk();
      } else {
        pollFail();
      }
    } catch {
      pollFail(); // transient blip; next poll retries
    }
  }, [apply, pollOk, pollFail]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, pollMs);
    return () => clearInterval(id);
  }, [poll, pollMs]);

  // The vote/pick countdowns and the elapsed timer tick inside their own leaf
  // components (see <SecondsClock>/<ElapsedClock>), so the per-second update
  // doesn't re-render this room or the drafting pool.

  // When a lobby ends (or a new one forms), refresh the server-rendered
  // leaderboard + recent games sitting below this component.
  useEffect(() => {
    const cur = state?.lobby?.id ?? null;
    if (prevLobbyId.current && prevLobbyId.current !== cur) router.refresh();
    prevLobbyId.current = cur;
  }, [state?.lobby?.id, router]);

  // Ring a bell on the moments that matter to this viewer: their lobby forming,
  // their turn to pick, and teams locking in. Skips the initial page load.
  useEffect(() => {
    if (!state) return;
    const status = state.lobby?.status ?? null;
    const isOnClock = state.me.isOnClock;
    const inLobby = state.me.inLobby;

    const resultId = state.lastResult?.lobbyId ?? null;
    if (soundInitRef.current && soundOn) {
      const lobbyFormed = status !== null && prevStatusRef.current === null && inLobby;
      const myTurn = isOnClock && !prevOnClockRef.current;
      const teamsReady =
        status === "READY" && prevStatusRef.current !== "READY" && inLobby;
      // Keyed off lastResult, NOT the lobby vanishing — an admin cancel also
      // drops the lobby and must not ring a victory bell.
      const gameEnded = !!resultId && prevResultIdRef.current !== resultId;
      if (lobbyFormed || myTurn || teamsReady || gameEnded) playChime();
    }
    prevStatusRef.current = status;
    prevOnClockRef.current = isOnClock;
    prevResultIdRef.current = resultId;
    soundInitRef.current = true;
  }, [state, soundOn]);

  // Flip the tab title while something needs this viewer's attention. Unlike
  // the chime this needs no sound toggle or prior-gesture audio unlock, so a
  // backgrounded tab still shows the "(!)" in the tab strip.
  useEffect(() => {
    if (originalTitleRef.current === null) {
      originalTitleRef.current = document.title;
    }
    const original = originalTitleRef.current;
    const status = state?.lobby?.status ?? null;
    const flag = state?.me.isOnClock
      ? "(!) Your pick"
      : state?.me.inLobby && status === "CAPTAIN_VOTE"
        ? "(!) Lobby up — vote"
        : state?.me.inLobby && status === "READY"
          ? "(!) Teams locked"
          : null;
    document.title = flag ? `${flag} · ${original}` : original;
    return () => {
      document.title = original;
    };
  }, [state]);

  const act = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      unlockAudio(); // this click is a user gesture — prime audio for later
      setPending(true);
      try {
        const res = await fetch("/api/inhouse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        // Toast, not an inline banner — same reasoning as the draft room:
        // pick-race rejections land while the captain is scrolled into the
        // pool, where a top-of-room banner is invisible and went stale.
        if (!res.ok) {
          pushToast("error", data.error || "Action failed");
          return false;
        }
        apply(data);
        setSelected(null);
        return true;
      } catch {
        pushToast("error", "Network error — that didn't go through");
        return false;
      } finally {
        setPending(false);
      }
    },
    [apply],
  );

  if (!state) {
    return <div className="py-12 text-center text-muted">Loading inhouse…</div>;
  }

  const { lobby, me } = state;
  const offset = offsetRef.current; // serverNow - clientNow, for the pick clock

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={toggleSound}
          aria-pressed={soundOn}
          title={
            soundOn
              ? "Notification sound on — click to mute"
              : "Notifications muted — click to enable a bell"
          }
          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2/40 px-3 py-1 text-xs text-muted transition-colors hover:text-fg"
        >
          <span aria-hidden>{soundOn ? "🔔" : "🔕"}</span>
          {soundOn ? "Sound on" : "Muted"}
        </button>
      </div>

      {disconnected ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger"
        >
          ⚠️ Connection lost — reconnecting… The lobby keeps running on the
          server; actions are paused until we&apos;re back.
        </div>
      ) : null}

      {state.lastResult &&
      !lobby &&
      !dismissedResults.has(state.lastResult.lobbyId) ? (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "flex flex-wrap items-center gap-3 rounded-[var(--radius)] border px-4 py-3",
            state.lastResult.myTeamWon
              ? "border-success/50 bg-success/10"
              : "border-danger/40 bg-danger/10",
          )}
        >
          <span className="text-lg" aria-hidden>
            {state.lastResult.myTeamWon ? "🏆" : "💀"}
          </span>
          <span className="min-w-0 flex-1 text-sm">
            <strong>
              {state.lastResult.winnerSide} win {state.lastResult.radiantScore}
              –{state.lastResult.direScore}
            </strong>{" "}
            — {state.lastResult.myTeamWon ? "victory" : "defeat"} for you,{" "}
            <strong
              className={
                state.lastResult.eloDelta >= 0 ? "text-success" : "text-danger"
              }
            >
              {state.lastResult.eloDelta >= 0 ? "+" : ""}
              {state.lastResult.eloDelta} Elo
            </strong>
            .{" "}
            <a
              href={`#result-${state.lastResult.lobbyId}`}
              className="text-info hover:underline"
            >
              Box score ↓
            </a>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {me.canJoin ? (
              // The retention moment: everyone's still here, the game just
              // ended — one tap puts you back in line for the next one.
              <button
                type="button"
                disabled={pending}
                onClick={() => act({ action: "join", mmr })}
                className={buttonClasses("accent", "sm")}
              >
                Run it back →
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                const id = state.lastResult!.lobbyId;
                setDismissedResults((s) => new Set(s).add(id));
                // The banner only ever shows the newest result, so one id is
                // all the persistence a reload needs.
                localStorage.setItem("inhouseDismissedResult", id);
              }}
              aria-label="Dismiss result banner"
              className={buttonClasses("secondary", "sm")}
            >
              Dismiss
            </button>
          </span>
        </div>
      ) : null}

      {!lobby ? (
        <QueueView state={state} pending={pending} mmr={mmr} setMmr={setMmr} act={act} />
      ) : lobby.status === "CAPTAIN_VOTE" ? (
        <VoteView lobby={lobby} me={me} offset={offset} pending={pending} act={act} />
      ) : lobby.status === "DRAFTING" ? (
        <DraftView
          state={state}
          lobby={lobby}
          offset={offset}
          selected={selected}
          setSelected={setSelected}
          pending={pending}
          act={act}
        />
      ) : lobby.status === "READY" ? (
        <ReadyView lobby={lobby} me={me} pending={pending} act={act} />
      ) : (
        <InProgressView
          lobby={lobby}
          me={me}
          offset={offset}
          detectMinMinutes={state.detectMinMinutes}
          pending={pending}
          act={act}
        />
      )}

      {me.canCancel ? (
        <div className="text-right">
          <button
            disabled={pending}
            onClick={async () => {
              if (
                window.confirm(
                  "Scrap the current inhouse lobby? Everyone goes back into the queue.",
                )
              ) {
                // Only claim success once the server agrees — the cancel can
                // legitimately lose to a result landing mid-confirm.
                if (await act({ action: "cancel" })) {
                  pushToast("success", "Lobby cancelled — players re-queued");
                }
              }
            }}
            className="rounded text-xs text-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
          >
            Admin: cancel this lobby
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------- Queue ----------

function QueueView({
  state,
  pending,
  mmr,
  setMmr,
  act,
}: {
  state: InhouseState;
  pending: boolean;
  mmr: number;
  setMmr: (n: number) => void;
  act: (body: Record<string, unknown>) => void;
}) {
  const { queue, lobbySize, needed, me } = state;
  // "Away" players (heartbeat gone quiet) keep their row for a grace window
  // but don't count toward forming — the headline number stays honest.
  const present = queue.filter((q) => !q.away);
  const pct = Math.min(100, Math.round((present.length / lobbySize) * 100));
  // Rough lobby strength while it fills (0 = unknown MMR, excluded).
  const knownMmrs = present.map((q) => q.mmr).filter((m) => m > 0);
  const queueAvg =
    knownMmrs.length >= 2
      ? Math.round(knownMmrs.reduce((s, m) => s + m, 0) / knownMmrs.length)
      : 0;

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-b from-surface-2/60 to-surface/40">
        <div className="px-6 py-6 text-center">
          <div className="text-sm uppercase tracking-wide text-muted">
            Inhouse queue
          </div>
          <div className="mt-1 text-4xl font-bold tabular-nums">
            {present.length}
            <span className="text-muted"> / {lobbySize}</span>
          </div>
          <div className="mt-1 text-sm text-muted">
            {needed > 0
              ? `${needed} more ${needed === 1 ? "player" : "players"} to fire up a draft`
              : "Lobby full — forming the draft…"}
            {queueAvg > 0 ? (
              <span className="tabular-nums"> · avg {queueAvg} MMR</span>
            ) : null}
          </div>

          <div className="mx-auto mt-4 h-3 w-full max-w-md overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-brand transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            {!me.isLoggedIn ? (
              <a href="/login?next=/inhouse" className={buttonClasses("primary", "lg")}>
                Sign in to queue
              </a>
            ) : me.inQueue ? (
              <button
                disabled={pending}
                onClick={() => act({ action: "leave" })}
                className={buttonClasses("secondary", "lg")}
              >
                Leave queue
              </button>
            ) : (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <label htmlFor="inhouse-mmr" className="text-sm text-muted">
                  MMR
                </label>
                <input
                  id="inhouse-mmr"
                  type="number"
                  min={0}
                  max={12000}
                  value={mmr || ""}
                  placeholder="0"
                  onChange={(e) => setMmr(Number(e.target.value))}
                  title="Seeds captain selection and the balance meter. If you've registered for a season, your league signup MMR is used instead."
                  className="h-11 w-24 rounded-lg border border-line bg-surface-2/50 px-3 text-center text-sm outline-none focus:border-accent/60"
                />
                <button
                  disabled={pending}
                  onClick={() => act({ action: "join", mmr })}
                  className={buttonClasses("accent", "lg")}
                >
                  Join queue →
                </button>
              </div>
            )}
          </div>

          <p className="mt-3 text-xs text-muted">
            Keep this page open to hold your spot — players who close it are
            marked away and dropped from the queue after a few minutes.
          </p>
        </div>

        <div className="border-t border-line bg-surface/40 px-4 py-4">
          {/* All lobby slots — filled players + open placeholders, so the
              lobby visibly fills up as people queue. */}
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {Array.from({ length: lobbySize }).map((_, i) => {
              const q = queue[i];
              if (!q) {
                return (
                  <li
                    key={`open-${i}`}
                    className="flex items-center gap-3 rounded-lg border border-dashed border-line/60 px-3 py-2"
                  >
                    <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full border border-dashed border-line/60 text-xs tabular-nums text-muted/60">
                      {i + 1}
                    </span>
                    <span className="text-sm text-muted/60">Open slot</span>
                  </li>
                );
              }
              const isMe = q.userId === me.userId;
              return (
                <li
                  key={q.userId}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-3 py-2",
                    isMe
                      ? "border-accent/50 bg-accent/10"
                      : "border-line bg-surface-2/40",
                    q.away && "opacity-60",
                  )}
                >
                  <span className="w-5 shrink-0 text-center text-xs text-muted tabular-nums">
                    {i + 1}
                  </span>
                  <Avatar name={q.name} src={q.avatar} size={30} />
                  <PlayerLink userId={q.userId} className="truncate text-sm font-medium">
                    {q.name}
                  </PlayerLink>
                  {q.away ? (
                    <span
                      className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted"
                      aria-label={`${q.name} looks away — they won't count toward forming a lobby until they return`}
                      title="No heartbeat from this player recently — they won't count toward forming a lobby until they return"
                    >
                      away
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                    <RankBadge rankTier={q.rankTier} />
                    {q.mmr > 0 ? <span>{q.mmr}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>

          {/* Players beyond the ten slots (queued while a lobby was live, or
              an overflow crowd) — never silently hidden. */}
          {queue.length > lobbySize ? (
            <div className="mt-3 border-t border-line/60 pt-3">
              <div className="mb-1.5 text-xs text-muted">
                In line for the next game · {queue.length - lobbySize}
              </div>
              <ul className="flex flex-wrap gap-2">
                {queue.slice(lobbySize).map((q) => (
                  <li
                    key={q.userId}
                    className={cn(
                      "flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface-2/40 py-1 pl-1 pr-2.5 text-xs",
                      q.away && "opacity-60",
                    )}
                  >
                    <Avatar name={q.name} src={q.avatar} size={20} />
                    <span className="max-w-[8rem] truncate">{q.name}</span>
                    {q.away ? <span className="text-muted">away</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      <p className="text-center text-xs text-muted">
        How it works: {lobbySize} players queue → vote how captains are chosen
        (elect them, highest MMR, or best record) → captains draft{" "}
        <span className="text-success">Radiant</span> &{" "}
        <span className="text-danger">Dire</span> back and forth → anyone hosts
        a private lobby in Dota 2 and the result records itself.
      </p>
    </div>
  );
}

// ---------- Captain vote ----------

type VoteLobby = NonNullable<InhouseState["lobby"]>;
type Candidate = NonNullable<VoteLobby["vote"]>["candidates"][number];

function VoteView({
  lobby,
  me,
  offset,
  pending,
  act,
}: {
  lobby: VoteLobby;
  me: InhouseState["me"];
  offset: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  const vote = lobby.vote;
  // The 25s vote clock must stay visible while a player scrolls the nominate
  // list — same compact-bar treatment as the draft's pick clock.
  const { ref: bannerRef, offscreen } = useBannerOffscreen(true);
  if (!vote) return null;

  const myMethod = me.myVote?.method ?? null;
  const myNominee = me.myVote?.nomineeId ?? null;

  const byMmr = [...vote.candidates].sort((a, b) => b.mmr - a.mmr);
  const byRecord = [...vote.candidates].sort(
    (a, b) =>
      b.wins - a.wins || b.winRate - a.winRate || b.games - a.games || b.mmr - a.mmr,
  );
  const byVotes = [...vote.candidates].sort(
    (a, b) => b.nominations - a.nominations || b.mmr - a.mmr,
  );
  const hasRecords = vote.candidates.some((c) => c.games > 0);
  const hasNominations = vote.candidates.some((c) => c.nominations > 0);

  return (
    <div className="space-y-5">
      {/* Compact fixed bar while the vote clock is scrolled away. top-20
          matches the 80px header (see useBannerOffscreen). */}
      {offscreen ? (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="Back to the captain vote"
          className="fixed inset-x-0 top-20 z-20 border-b border-line bg-bg/90 text-left backdrop-blur"
        >
          <div className="mx-auto flex h-11 w-full max-w-6xl items-center justify-between gap-3 px-4 text-sm sm:px-6">
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
        className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-5 py-3"
      >
        <div>
          <div className="text-sm font-semibold">
            🗳️ How should captains be picked?
          </div>
          <div className="text-xs text-muted">
            {vote.votedCount}/{vote.voterCount} voted · lobby decides by majority
          </div>
        </div>
        <SecondsClock
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
          disabled={!me.canVote}
          onClick={() =>
            // Electing means naming a player — point at the list instead of
            // silently ignoring the tap.
            pushToast("info", "Tap a player below to nominate them as captain")
          }
          preview={hasNominations ? byVotes.slice(0, 2) : []}
          previewEmpty="Tap players below to nominate"
        />
        <MethodCard
          label="Highest MMR"
          hint="Top 2 MMR captain"
          tally={vote.methodTallies.MMR}
          total={vote.voterCount}
          selected={myMethod === "MMR"}
          disabled={!me.canVote || pending}
          onClick={() => act({ action: "vote", method: "MMR" })}
          preview={byMmr.slice(0, 2)}
        />
        <MethodCard
          label="Best record"
          hint="Top 2 inhouse records"
          tally={vote.methodTallies.RECORD}
          total={vote.voterCount}
          selected={myMethod === "RECORD"}
          disabled={!me.canVote || pending}
          onClick={() => act({ action: "vote", method: "RECORD" })}
          preview={hasRecords ? byRecord.slice(0, 2) : []}
          previewEmpty="No records yet — falls back to MMR"
        />
      </div>

      <div className="rounded-[var(--radius)] border border-line bg-surface/80">
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
                onClick={() => act({ action: "vote", method: "VOTE", nomineeId: c.userId })}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors",
                  me.canVote ? "hover:border-accent/50" : "cursor-default",
                  picked ? "border-accent bg-accent/15" : "border-line bg-surface-2/40",
                )}
              >
                <Avatar name={c.name} src={c.avatar} size={26} />
                <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
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
                  <span className="text-xs text-muted tabular-nums">{c.mmr}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {!me.isLoggedIn ? (
        <p className="text-center text-xs text-muted">
          Sign in to join future inhouses — this one&apos;s already drafting soon.
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
      onClick={onClick}
      className={cn(
        "flex flex-col gap-2 rounded-[var(--radius)] border bg-surface/80 p-4 text-left transition-colors",
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
        <span className="text-xs tabular-nums text-muted">{tally}</span>
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
          <span className="text-xs text-muted/70">{previewEmpty}</span>
        )}
      </div>
    </button>
  );
}

// ---------- Draft ----------

function DraftView({
  state,
  lobby,
  offset,
  selected,
  setSelected,
  pending,
  act,
}: {
  state: InhouseState;
  lobby: NonNullable<InhouseState["lobby"]>;
  offset: number;
  selected: string | null;
  setSelected: (id: string | null) => void;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  const { me, teamSize } = state;
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
  const balance = mmrBalance(sideMmrs(lobby.teams[0]), sideMmrs(lobby.teams[1]));
  const leader =
    balance.diff > 0 ? lobby.teams[0] : balance.diff < 0 ? lobby.teams[1] : null;
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
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
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
          "flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border bg-surface/80 px-5 py-3",
          onClockSide?.ring ?? "border-line",
        )}
      >
        <div className="text-sm">
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
        </div>
        <div className="flex items-center gap-3">
          {balanceLabel ? (
            <span className="hidden text-xs text-muted sm:inline">
              ⚖️ {balanceLabel}
            </span>
          ) : null}
          {me.isOnClock ? (
            <Badge tone="accent">Your pick</Badge>
          ) : (
            <span className="text-xs text-muted">Drafting…</span>
          )}
          <SecondsClock
            endsAtMs={lobby.pickEndsAt}
            offsetMs={offset}
            urgentAt={10}
            label={(s) => `${s} seconds left on the pick clock`}
          />
        </div>
      </div>

      {/* Pool FIRST in DOM: on phones the on-clock captain needs it now —
          Team 1's roster card would otherwise bury it (same treatment as the
          league draft room). lg:order-* restores the three-column desktop. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.1fr_1fr]">
        {/* Draft pool */}
        <div className="min-w-0 rounded-[var(--radius)] border border-line bg-surface/80 lg:order-2">
          <div className="border-b border-line px-4 py-3 text-sm font-semibold">
            Draft pool · {lobby.pool.length}
          </div>
          <div className="space-y-1.5 p-3">
            {lobby.pool.map((p) => {
              const pickable = me.isOnClock;
              const isSel = selected === p.userId;
              return (
                <button
                  key={p.userId}
                  disabled={!pickable}
                  aria-pressed={isSel}
                  aria-label={`Select ${p.name} to draft`}
                  onClick={() => setSelected(isSel ? null : p.userId)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors",
                    pickable ? "hover:border-accent/50" : "cursor-default",
                    isSel
                      ? "border-accent bg-accent/15"
                      : "border-line bg-surface-2/40",
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
                    <span className="text-xs text-muted tabular-nums">{p.mmr}</span>
                  ) : null}
                </button>
              );
            })}
            {lobby.pool.length === 0 ? (
              <p className="p-2 text-center text-sm text-muted">
                Everyone&apos;s drafted.
              </p>
            ) : null}
          </div>
          {me.isOnClock ? (
            <div className="border-t border-line p-3">
              <button
                disabled={pending || !selected}
                onClick={() => selected && act({ action: "pick", userId: selected })}
                className={buttonClasses("accent", "md", "w-full")}
              >
                {selected
                  ? `Draft ${lobby.pool.find((p) => p.userId === selected)?.name ?? ""}`
                  : "Select a player to draft"}
              </button>
            </div>
          ) : null}
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
  const roster: (Player | null)[] = [
    team.captain,
    ...team.players,
  ];
  while (roster.length < teamSize) roster.push(null);
  const known = roster.filter((p): p is Player => !!p && p.mmr > 0);
  const avgMmr = known.length
    ? Math.round(known.reduce((s, p) => s + p.mmr, 0) / known.length)
    : 0;

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
              p ? "border-line bg-surface-2/40" : "border-dashed border-line/60",
            )}
          >
            {p ? (
              <>
                <Avatar name={p.name} src={p.avatar} size={24} />
                <PlayerLink userId={p.userId} className="min-w-0 flex-1 truncate">
                  {p.name}
                </PlayerLink>
                {i === 0 ? <Badge tone={meta.badge}>C</Badge> : null}
                {i > 0 && p.pickIndex != null ? (
                  <span
                    title={`Draft pick ${p.pickIndex + 1}`}
                    className="text-[10px] tabular-nums text-muted/70"
                  >
                    #{p.pickIndex + 1}
                  </span>
                ) : null}
                <RankBadge rankTier={p.rankTier} />
              </>
            ) : (
              <span className="py-0.5 pl-1 text-muted/50">Empty slot</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Ready ----------

function ReadyView({
  lobby,
  me,
  pending,
  act,
}: {
  lobby: NonNullable<InhouseState["lobby"]>;
  me: InhouseState["me"];
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-6 py-5 text-center">
        <div className="text-2xl">🎮</div>
        <div className="mt-1 text-lg font-semibold">Teams are set!</div>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          Anyone can host: create a private lobby in Dota 2, invite both
          teams, then hit start below once everyone&apos;s in. No ticket or
          league id needed — the result is found from players&apos; match
          histories.
        </p>
        {me.canStart ? (
          <button
            disabled={pending}
            onClick={() => {
              // One unconfirmed tap from any of the ten would start the clock
              // for everyone — make it deliberate.
              if (
                window.confirm(
                  "Start the game for all ten players? Do this once the in-client lobby is up and everyone's in.",
                )
              ) {
                act({ action: "start" });
              }
            }}
            className={buttonClasses("accent", "lg", "mt-4")}
          >
            Start the game →
          </button>
        ) : (
          <p className="mt-3 text-sm text-muted">
            Waiting for a player to launch the lobby…
          </p>
        )}
      </div>

      <MatchupGrid lobby={lobby} />
    </div>
  );
}

// ---------- In progress ----------

/** "12:34" / "1:02:45" — how long the game has been running. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// --- Countdown leaves -------------------------------------------------------
// Own the 250ms tick (useSecondsLeft/useElapsedMs) so only the clock text
// re-renders each second — not the whole room or the drafting pool.

// The vote & pick countdowns share one shape; urgency threshold + label vary.
function SecondsClock({
  endsAtMs,
  offsetMs,
  urgentAt,
  label,
}: {
  endsAtMs: number | null;
  offsetMs: number;
  urgentAt: number;
  label: (seconds: number) => string;
}) {
  const seconds = useSecondsLeft(endsAtMs, offsetMs);
  return (
    <div
      role="timer"
      aria-label={label(seconds)}
      className={cn(
        "font-mono text-xl font-bold tabular-nums",
        seconds <= urgentAt ? "text-danger" : "text-accent",
      )}
    >
      {seconds}s
    </div>
  );
}

// The running "12:34" game timer in the in-progress banner.
function ElapsedClock({
  startedAtMs,
  offsetMs,
}: {
  startedAtMs: number | null;
  offsetMs: number;
}) {
  const elapsedMs = useElapsedMs(startedAtMs, offsetMs);
  if (elapsedMs == null) return null;
  return (
    <span
      role="timer"
      aria-label={`game running for ${fmtElapsed(elapsedMs)}`}
      className="font-mono text-base font-bold tabular-nums text-info"
    >
      {fmtElapsed(elapsedMs)}
    </span>
  );
}

function InProgressView({
  lobby,
  me,
  offset,
  detectMinMinutes,
  pending,
  act,
}: {
  lobby: NonNullable<InhouseState["lobby"]>;
  me: InhouseState["me"];
  offset: number;
  detectMinMinutes: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  const [matchId, setMatchId] = useState("");
  // Poll-driven (not ticking) — only gates the "auto-scan is live" note, which
  // flips once, minutes in; the visible timer ticks in <ElapsedClock>.
  const elapsedMs =
    lobby.startedAt != null ? Date.now() + offset - lobby.startedAt : null;
  const scanLive =
    elapsedMs != null && elapsedMs >= detectMinMinutes * 60_000;

  return (
    <div className="space-y-5">
      <div className="rounded-[var(--radius)] border border-info/40 bg-info/10 px-6 py-5 text-center">
        <div className="flex items-center justify-center gap-2 text-lg font-semibold">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info/70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-info" />
          </span>
          Game in progress
          {lobby.startedAt != null ? (
            <ElapsedClock startedAtMs={lobby.startedAt} offsetMs={offset} />
          ) : null}
        </div>
        {lobby.startedByName ? (
          <p className="mt-1 text-sm text-muted">Hosted by {lobby.startedByName}</p>
        ) : null}
        {me.canRecord ? (
          <div className="mt-4 space-y-3">
            <div>
              <button
                disabled={pending}
                onClick={() => act({ action: "detect" })}
                className={buttonClasses("accent", "md")}
              >
                {pending ? "Fetching from OpenDota…" : "Auto-detect result"}
              </button>
              <p className="mx-auto mt-1.5 max-w-sm text-xs text-muted">
                Finds your game on OpenDota and pulls the full box score.{" "}
                {scanLive
                  ? "Background auto-scan is live too — it re-checks every few minutes (needs players' “Expose Public Match Data” on)."
                  : `Background auto-scan kicks in ${detectMinMinutes} minutes into the game.`}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2 border-t border-info/20 pt-3">
              <label htmlFor="inhouse-match-id" className="text-xs text-muted">
                or paste the match ID:
              </label>
              <input
                id="inhouse-match-id"
                value={matchId}
                onChange={(e) => setMatchId(e.target.value)}
                placeholder="e.g. 7891234567"
                className="h-9 w-44 rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
              />
              <button
                disabled={pending || !matchId.trim()}
                onClick={() => act({ action: "record", matchId: matchId.trim() })}
                className={buttonClasses("secondary", "sm")}
              >
                Record
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">
            {scanLive
              ? "The result is pulled from OpenDota automatically once the game ends."
              : `The result is pulled from OpenDota automatically — auto-scan starts ${detectMinMinutes} minutes in.`}
          </p>
        )}
      </div>

      <MatchupGrid lobby={lobby} />
    </div>
  );
}

// ---------- Shared roster grid ----------

function MatchupGrid({
  lobby,
}: {
  lobby: NonNullable<InhouseState["lobby"]>;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {lobby.teams.map((t) => {
        const meta = sideMeta(t.isRadiant);
        const roster = t.captain ? [t.captain, ...t.players] : t.players;
        const avgMmr =
          roster.length > 0
            ? Math.round(roster.reduce((s, p) => s + p.mmr, 0) / roster.length)
            : 0;
        return (
          <div
            key={t.team}
            className={cn("rounded-[var(--radius)] border bg-surface/80", meta.ring)}
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="flex items-center gap-2 font-semibold">
                <span className={cn("h-2.5 w-2.5 rounded-full", meta.dot)} />
                {meta.name}
              </div>
              {avgMmr > 0 ? (
                <span className="text-xs text-muted">avg {avgMmr} MMR</span>
              ) : null}
            </div>
            <div className="space-y-1.5 p-3">
              {roster.map((p, i) => (
                <div key={p.userId} className="flex items-center gap-2 text-sm">
                  <Avatar name={p.name} src={p.avatar} size={24} />
                  <PlayerLink userId={p.userId} className="min-w-0 flex-1 truncate">
                    {p.name}
                  </PlayerLink>
                  {i === 0 ? <Badge tone={meta.badge}>C</Badge> : null}
                  <RankBadge rankTier={p.rankTier} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
