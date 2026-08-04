"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Avatar,
  Badge,
  PlayerLink,
  RankBadge,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { pushToast } from "@/components/toaster";
import { cn } from "@/lib/utils";
import {
  useBannerOffscreen,
  usePersistedFlag,
  usePollHealth,
  useSecondsLeft,
  useElapsedMs,
} from "@/components/room-clock";
import {
  autoJoinDecision,
  avgKnownMmr,
  inhouseAlerts,
  inhouseLobbyCode,
  inhouseTitleFlag,
  mmrBalance,
  orderCaptains,
  queueSlots,
  readyCheckEndedToast,
  wasInReadyCheck,
  type InhouseAlertSnapshot,
} from "@/lib/inhouse";
import {
  betGateError,
  potView,
  tierLabel,
  type BetRow,
} from "@/lib/inhouse-bets";
import { inhousePollCadence } from "@/lib/room-poll";
import { nextClockOffset } from "@/lib/countdown";
import {
  ROOM_SEQUENCE_START,
  acceptSequence,
  isColdStart,
  issueSequence,
} from "@/lib/room-sequence";
import {
  INHOUSE,
  INHOUSE_BETS,
  INHOUSE_SCAN_ACTIONS,
  INHOUSE_SCAN_ACTION_TIMEOUT_MS,
  ROOM_ACTION_TIMEOUT_MS,
  ROOM_POLL_TIMEOUT_MS,
} from "@/lib/constants";
import { playChime, unlockAudio } from "@/components/chime";
import type { InhouseState } from "@/lib/inhouse-service";

type LobbyTeam = NonNullable<InhouseState["lobby"]>["teams"][number];
type Player = LobbyTeam["players"][number];
type RoomMe = InhouseState["me"] & {
  /**
   * A UI capability, not an attention signal. Captains on the current turn and
   * administrators can both submit the service's `pick` action, but only the
   * captain should receive the chime and "Your pick" title driven by
   * `isOnClock`.
   */
  canPick: boolean;
};

function scrollToRoomTop() {
  window.scrollTo({
    top: 0,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });
}

// Radiant = green, Dire = red — matching the in-client colors so it reads fast.
function sideMeta(isRadiant: boolean) {
  return isRadiant
    ? {
        name: "Radiant",
        badge: "success" as const,
        ring: "border-success/50",
        chip: "bg-success/10 text-success border-success/30",
        dot: "bg-success",
        // The faded half of a pool bar: staked but NOT covered, i.e. Cred that
        // is coming home whatever happens. Solid vs faded is the whole point of
        // the bar — a single flat bar would show a 500-vs-20 pot as a rout when
        // only 20 of it is actually live.
        soft: "bg-success/25",
      }
    : {
        name: "Dire",
        badge: "danger" as const,
        ring: "border-danger/50",
        chip: "bg-danger/10 text-danger border-danger/30",
        dot: "bg-danger",
        soft: "bg-danger/25",
      };
}

export function InhouseRoom({
  pollMs = 1500,
  defaultMmr = 0,
  mmrHint = null,
}: {
  pollMs?: number;
  defaultMmr?: number;
  /** Server-computed medal→MMR window note for the queue join panel. */
  mmrHint?: string | null;
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
  const [soundOn, setSoundOn] = usePersistedFlag("inhouseSound");
  // Clock skew as STATE, not a ref read during render. Reading `ref.current`
  // while rendering is unsafe under concurrent React (the value can differ
  // between a render React keeps and one it throws away) and the lint rules
  // flag it. Storing it only when it MOVES keeps the original reason it was a
  // ref: `s.now - Date.now()` jitters by a few ms on every poll, and
  // re-rendering the room + player pool for that would undo the leaf-clock
  // optimisation. A whole second of drift is the smallest change any countdown
  // can show.
  const [offsetMsState, setOffsetMs] = useState(0);
  // Lets an action (join/accept/vote/pick) nudge the adaptive poll loop to
  // re-evaluate its cadence NOW instead of waiting out a stale idle timer —
  // so joining an idle page snaps to fast polling immediately.
  const bumpPollRef = useRef<(() => void) | null>(null);
  // Does the viewer currently have a stake (queued or in a lobby)? Read by the
  // poll loop to decide whether a HIDDEN tab keepalive-polls (hold the spot) or
  // fully pauses. Kept current by the effect below so the closure always sees
  // the latest, without re-subscribing the loop on every state change.
  const hasStakeRef = useRef(false);
  // One-tap join from a Discord ping (?join=1). Fires at most ONCE per page
  // load — queue membership has teeth (a filled lobby drags you into a 45s
  // ready check whose failure drops you from the queue), so an accidental
  // re-enqueue on a re-render would be a real cost, not a cosmetic one.
  const autoJoinedRef = useRef(false);
  const prevLobbyId = useRef<string | null>(null);
  // What the LAST poll said about this viewer — the one input to both the
  // chime (inhouseAlerts) and the "match cancelled" toast, so the two can
  // never disagree about what just changed. null = nothing seen yet, which is
  // what suppresses alerts for a mid-lobby page load.
  const prevAlertRef = useRef<InhouseAlertSnapshot | null>(null);
  const originalTitleRef = useRef<string | null>(null);
  // Result banners the viewer closed — stays dismissed across the polls of
  // the 10-minute lastResult window AND across reloads (localStorage), so a
  // refresh doesn't resurrect a banner they already read.
  const [dismissedResults, setDismissedResults] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const dismissed = localStorage.getItem("inhouseDismissedResult");
    // Deferred a tick: setting state synchronously inside an effect cascades a
    // render, and this only has to beat the first result banner.
    if (dismissed) {
      const t = setTimeout(() => setDismissedResults(new Set([dismissed])), 0);
      return () => clearTimeout(t);
    }
  }, []);

  // Browsers block the AudioContext until a user gesture, and the people who
  // most need the bell never click anything in this room: someone who arrived
  // from a Discord ping auto-joins programmatically (?join=1), and someone who
  // queued on a previous page load and reloaded has touched nothing at all. So
  // the first tap ANYWHERE on the page primes it — otherwise "match found",
  // the alert gating a 45-second ACCEPT window, is computed correctly and
  // played into a suspended context. The draft room has had this since it
  // shipped; this room did not.
  useEffect(() => {
    const unlock = () => unlockAudio();
    document.addEventListener("pointerdown", unlock, { once: true });
    return () => document.removeEventListener("pointerdown", unlock);
  }, []);

  const toggleSound = useCallback(() => {
    const next = !soundOn;
    setSoundOn(next);
    if (next) playChime(); // confirm + unlock audio on this gesture
  }, [soundOn, setSoundOn]);

  // Order poll and action responses by request START (the draft room's guard —
  // this loop needs it just as much). A `state` poll that left BEFORE a pick
  // can land after it: /api/inhouse answers mutations with syncBoard:false, so
  // the mutation returns fast while the poll behind it may still be blocked on
  // the Discord board edit. Applying the older payload put the drafted player
  // back in the pool, flipped `isOnClock` true again — re-firing the chime and
  // the "(!) Your pick" title — and the captain re-clicked into an error toast
  // while their real 60s clock burned. Never key this off `s.now`: it's
  // per-instance wall-clock and can skew between serverless instances.
  const seqRef = useRef(ROOM_SEQUENCE_START);
  // Unlike React state, this can be read safely inside the long-lived poll
  // effect without resubscribing it. A 429 after a good snapshot is ordinary
  // back-pressure; a cold page receiving only 429s still needs to leave its
  // otherwise-endless Loading state.
  const hasLoadedRef = useRef(false);

  const apply = useCallback((s: InhouseState, seq: number) => {
    const { accept, next } = acceptSequence(seqRef.current, seq);
    seqRef.current = next;
    if (!accept) return; // lost the response race — stale
    hasLoadedRef.current = true;
    setOffsetMs((prev) => nextClockOffset(prev, s.now, Date.now()));
    setState(s);
  }, []);

  // Keep the poll loop's "has stake" flag current for its hidden-tab decision.
  useEffect(() => {
    // The viewer's OWN stake — `!!state.lobby` is true for every spectator
    // too, so a public lobby kept every open tab on the fast path.
    hasStakeRef.current = !!state?.me.inLobby || !!state?.me.inQueue;
  }, [state]);

  // Adaptive, visibility-aware poll loop (self-scheduling setTimeout, not a
  // fixed setInterval): FAST while the viewer is in a lobby or the queue,
  // IDLE-slow when just spectating. While the tab is HIDDEN: a viewer with a
  // stake (queued or in a lobby) keeps a slow KEEPALIVE so their presence
  // heartbeat holds the spot and a forming ready check's chime/title still
  // reaches them; a hidden spectator doesn't fetch at all (the sitewide
  // /api/sync ping advances lobbies meanwhile). Either way it re-syncs the
  // instant it's refocused. Mirrors <ResultSyncPing>; kills the ~40 req/min an
  // idle open tab used to fire.
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (ms: number) => {
      if (!alive) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, ms);
    };

    const tick = async () => {
      // inFlight also guards a visibilitychange firing mid-request — the active
      // call reschedules when it settles.
      if (!alive || inFlight) return;
      // Hidden with nothing at stake: don't fetch (browsers throttle background
      // timers anyway); the visibility listener wakes us on focus. Rules +
      // reasoning in inhousePollCadence, where they're unit-tested.
      const pre = inhousePollCadence({
        hidden: document.visibilityState === "hidden",
        hasStake: hasStakeRef.current,
        // Nothing has left yet, so `hasStake` is still the pre-payload `false`
        // for everyone — fetch once rather than skipping forever (a tab that is
        // HIDDEN at load would otherwise never learn it had a stake).
        coldStart: isColdStart(seqRef.current),
        activeMs: pollMs,
      });
      if (pre.skip) {
        schedule(pre.delayMs);
        return;
      }
      inFlight = true;
      // Minted HERE, before the await — ordering is by request START. Move it
      // below the fetch and the gate silently becomes a no-op that rejects
      // nothing (see room-sequence.ts; the source guard is what catches that).
      const { seq, next: seqNext } = issueSequence(seqRef.current);
      seqRef.current = seqNext;
      let next: InhouseState | null = null;
      let rateLimited = false;
      try {
        const res = await fetch("/api/inhouse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "state" }),
          // See ROOM_POLL_TIMEOUT_MS — the draft room's loop shares it, and
          // both freeze the same way without it.
          signal: AbortSignal.timeout(ROOM_POLL_TIMEOUT_MS),
        });
        if (res.ok) {
          next = (await res.json()) as InhouseState;
          apply(next, seq);
          pollOk();
        } else if (res.status === 429) {
          // Once a snapshot exists this is deliberately NOT a poll failure: it
          // must slow us down rather than disable a usable room. Cold-start
          // rate limits are different — without a failure signal they leave the
          // page saying Loading forever, so they participate in the same
          // retryable initial-error threshold as other non-success responses.
          rateLimited = true;
          if (!hasLoadedRef.current) pollFail();
        } else {
          pollFail();
        }
      } catch {
        pollFail(); // transient blip (or the abort above); next poll retries
      } finally {
        inFlight = false;
      }
      // Recompute visibility HERE (not from the pre-fetch snapshot): if the tab
      // was refocused mid-fetch this reschedules at the active rate instead of
      // the hidden-tab keepalive, so refocus stays snappy. Stake is MEMBERSHIP, not
      // mere existence of a lobby — five people watching a 45min game were each
      // firing 40 req/min because one existed.
      schedule(
        inhousePollCadence({
          hidden: document.visibilityState === "hidden",
          hasStake: !!next && (next.me.inLobby || next.me.inQueue),
          rateLimited,
          reached: !!next,
          activeMs: pollMs,
        }).delayMs,
      );
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // An action that changes the viewer's state (join/accept/vote/pick) calls
    // this to poll again almost immediately, so the cadence re-locks to fast
    // right after joining instead of finishing a pending idle wait.
    bumpPollRef.current = () => schedule(250);
    tick();

    return () => {
      alive = false;
      bumpPollRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearTimeout(timer);
    };
  }, [apply, pollOk, pollFail, pollMs]);

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

  // Ring a bell on the moments that matter to this viewer: their match found
  // (ready check), the captain vote opening, their turn to pick, teams locking
  // in, the result landing. Which of those a poll earned — and the fact that
  // the first payload after mount earns none of them — is decided by the
  // tested `inhouseAlerts`.
  useEffect(() => {
    if (!state) return;
    const snap: InhouseAlertSnapshot = {
      status: state.lobby?.status ?? null,
      inLobby: state.me.inLobby,
      isOnClock: state.me.isOnClock,
      resultId: state.lastResult?.lobbyId ?? null,
    };
    const prev = prevAlertRef.current;

    // A ready check the viewer was in vanished — a decline, an expiry, or an
    // admin cancel scrapped it. The lobby query drops CANCELLED instantly, so
    // without this the room would silently snap back to the queue with no
    // explanation. Which message (and whether there is one at all) is decided
    // by the tested `readyCheckEndedToast` — both of its wording rules were
    // once wrong in ways that told the player the opposite of the truth. NOT
    // sound-gated: it is information, not an alert.
    const cancelled = readyCheckEndedToast({
      wasInReadyCheck: wasInReadyCheck(prev),
      inLobby: state.me.inLobby,
      inQueue: state.me.inQueue,
    });
    if (cancelled) pushToast("info", cancelled);

    // One ring however many transitions coincided — two playChime() calls in
    // one commit double-strike the same AudioContext.
    if (soundOn && inhouseAlerts(prev, snap).length) playChime();
    // ALWAYS advanced, outside the sound gate: a muted viewer who unmutes
    // mid-lobby must not be rung for a lobby they have been watching for five
    // minutes.
    prevAlertRef.current = snap;
  }, [state, soundOn]);

  // Flip the tab title while something needs this viewer's attention. Unlike
  // the chime this needs no sound toggle or prior-gesture audio unlock, so a
  // backgrounded tab still shows the "(!)" in the tab strip.
  useEffect(() => {
    if (originalTitleRef.current === null) {
      originalTitleRef.current = document.title;
    }
    const original = originalTitleRef.current;
    const flag = inhouseTitleFlag(
      state && {
        status: state.lobby?.status ?? null,
        inLobby: state.me.inLobby,
        isOnClock: state.me.isOnClock,
        hasAccepted: state.me.hasAccepted,
        hasVoted: !!state.me.myVote?.method,
      },
    );
    document.title = flag ? `${flag} · ${original}` : original;
    return () => {
      document.title = original;
    };
  }, [state]);

  const act = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      unlockAudio(); // this click is a user gesture — prime audio for later
      setPending(true);
      const { seq, next: seqNext } = issueSequence(seqRef.current);
      seqRef.current = seqNext;
      try {
        const res = await fetch("/api/inhouse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          // `pending` is flipped off in the finally below, so a request that
          // never answers left every control in the room disabled until the
          // player reloaded. The abort lands in the catch, which toasts and
          // releases them. Per-action, not one ceiling: `detect`/`record` go
          // to OpenDota and legitimately take ~25s, while ACCEPT must never
          // sit disabled through its own 45s ready check.
          signal: AbortSignal.timeout(
            (INHOUSE_SCAN_ACTIONS as readonly string[]).includes(
              String(body.action),
            )
              ? INHOUSE_SCAN_ACTION_TIMEOUT_MS
              : ROOM_ACTION_TIMEOUT_MS,
          ),
        });
        const data = (await res.json().catch(() => null)) as
          (InhouseState & { error?: string }) | null;
        // Toast, not an inline banner — same reasoning as the draft room:
        // pick-race rejections land while the captain is scrolled into the
        // pool, where a top-of-room banner is invisible and went stale.
        if (!res.ok) {
          pushToast(
            "error",
            data && typeof data.error === "string"
              ? data.error
              : `Action failed (${res.status})`,
          );
          return false;
        }
        // A successful mutation can commit before its response is truncated by
        // a proxy or a dropped connection. Treat an unreadable success exactly
        // like a timeout: never invite a duplicate pick/bet, and let the next
        // authoritative state poll tell the player what happened.
        if (!data || typeof data.now !== "number") {
          pushToast(
            "info",
            "The response was incomplete — checking the current room state",
          );
          bumpPollRef.current?.();
          return false;
        }
        apply(data, seq);
        setSelected(null);
        // Re-lock the poll cadence now — joining an idle page must not keep
        // idle-polling until a stale 10s timer expires.
        bumpPollRef.current?.();
        return true;
      } catch (e) {
        // A timeout is NOT a failed action: the server kept going and may well
        // have committed. Saying "that didn't go through" would send a captain
        // to re-click a pick that already landed. Nudge the poll instead — the
        // next state payload is the honest answer either way.
        pushToast(
          "info",
          (e as Error)?.name === "TimeoutError"
            ? "That's taking a while — checking where things got to"
            : "We lost the response — checking the current room state",
        );
        bumpPollRef.current?.();
        return false;
      } finally {
        setPending(false);
      }
    },
    [apply],
  );

  // ?join=1 — the one-tap join a Discord ping links to. Waits for the first
  // state so it can refuse the cases where an auto-join would be wrong, then
  // scrubs the param so a refresh can never re-enqueue you.
  useEffect(() => {
    if (!state || autoJoinedRef.current) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("join") !== "1") return;
    autoJoinedRef.current = true;
    url.searchParams.delete("join");
    window.history.replaceState(null, "", url);

    // Signed out → the page's own CTA takes over; already queued or in the
    // lobby → say so and stop. A live lobby is NOT a reason to refuse (see
    // autoJoinDecision, where the rules are tested).
    const decision = autoJoinDecision(state.me);
    if (decision === "signed-out") return;
    if (decision === "already-in") {
      pushToast("info", "You're already in the queue");
      return;
    }
    // Deferred a tick: act() flips `pending` immediately, and setting state
    // synchronously inside an effect cascades a render.
    const t = setTimeout(() => {
      void act({ action: "join", mmr }).then((ok) => {
        if (ok) pushToast("success", "You're in the queue");
      });
    }, 0);
    return () => clearTimeout(t);
  }, [state, act, mmr]);

  if (!state) {
    return disconnected ? (
      <section
        role="alert"
        aria-labelledby="inhouse-load-error-title"
        className="rounded-[var(--radius)] border border-danger/40 bg-danger/10 px-5 py-6 text-center"
      >
        <h2 id="inhouse-load-error-title" className="font-semibold text-danger">
          We can&apos;t load the inhouse room
        </h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-muted">
          We&apos;re reconnecting automatically. Queue and lobby actions stay
          unavailable until a current server state arrives.
        </p>
        <button
          type="button"
          onClick={() => bumpPollRef.current?.()}
          className={buttonClasses("secondary", "md", "mt-4")}
        >
          Try again now
        </button>
      </section>
    ) : (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="py-12 text-center text-muted"
      >
        Loading inhouse…
      </div>
    );
  }

  const { lobby } = state;
  // The service already authorizes administrators to recover a stuck draft by
  // picking for the captain on the current side. Keep that broader CAPABILITY
  // separate from `isOnClock`, which remains the captain-only attention flag
  // used by the tab title, chime and "Your pick" badge.
  const me: RoomMe = {
    ...state.me,
    canPick:
      lobby?.status === "DRAFTING" && (state.me.isOnClock || state.me.isAdmin),
  };
  const offset = offsetMsState; // serverNow - clientNow, for the pick clock
  // A selection is only meaningful while its player is still in the pool.
  // Derived, not synced through an effect: `selected` is otherwise cleared
  // only on a successful act(), so a captain who tapped the top-MMR player and
  // then let the clock run out — resolveStalledPick auto-drafts that exact
  // player, it sorts the pool the same way — came back on the clock two picks
  // later holding a dead id. The footer then rendered an ENABLED button
  // reading "Draft " with no name, and every click was a "Player already
  // drafted" toast while their real 60s clock burned.
  const selectedInPool =
    selected && lobby?.pool.some((p) => p.userId === selected)
      ? selected
      : null;

  // The one state a PLAIN cancel is guaranteed to refuse: a live game carrying
  // confirmed bets. `cancelLobby`'s claim has exactly this predicate (the pot
  // is read off the same confirmed rows the panel renders), so offering the
  // ordinary button here would be a button whose only outcome is a refusal —
  // the reason the bet chips are filtered through the gate rather than rendered
  // and disabled. The admin block swaps in the forced control instead, which is
  // also what makes that refusal's own sentence ("use the forced cancel") true.
  const forcedCancel =
    lobby &&
    lobby.status === "IN_PROGRESS" &&
    lobby.pot &&
    lobby.pot.slips.length > 0
      ? {
          code: inhouseLobbyCode(lobby.id),
          bettors: lobby.pot.slips.length,
          staked: lobby.pot.pool1 + lobby.pot.pool2,
        }
      : null;

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
              {state.lastResult.winnerSide} win {state.lastResult.radiantScore}–
              {state.lastResult.direScore}
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
            {/* Only for the people who were in the pot: null means they sat it
                out, and "+0 Cred" announced to the other eight is noise. */}
            {state.lastResult.credPending ? (
              <span className="text-muted">
                {" "}
                · Cred settlement is pending; your balance will update
                automatically
              </span>
            ) : state.lastResult.credDelta != null ? (
              <CredDelta delta={state.lastResult.credDelta} />
            ) : null}
            .{" "}
            <a
              href={`#result-${state.lastResult.lobbyId}`}
              className={textLink()}
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

      {/* A live lobby does not close the queue. People outside it need a clear
          next-game entry point; once queued, the full view keeps their position
          and Leave control visible for the life of the current game. */}
      {lobby && !me.inLobby ? (
        me.inQueue ? (
          <QueueView
            state={state}
            pending={pending}
            mmr={mmr}
            setMmr={setMmr}
            mmrHint={mmrHint}
            act={act}
            nextGame
          />
        ) : (
          <NextGameQueueCard
            state={state}
            pending={pending}
            mmr={mmr}
            setMmr={setMmr}
            mmrHint={mmrHint}
            act={act}
          />
        )
      ) : null}

      {!lobby ? (
        <QueueView
          state={state}
          pending={pending}
          mmr={mmr}
          setMmr={setMmr}
          mmrHint={mmrHint}
          act={act}
        />
      ) : lobby.status === "READY_CHECK" ? (
        <ReadyCheckView
          lobby={lobby}
          me={me}
          offset={offset}
          pending={pending}
          act={act}
        />
      ) : lobby.status === "CAPTAIN_VOTE" ? (
        <VoteView
          lobby={lobby}
          me={me}
          offset={offset}
          pending={pending}
          act={act}
        />
      ) : lobby.status === "DRAFTING" ? (
        <DraftView
          state={state}
          me={me}
          lobby={lobby}
          offset={offset}
          selected={selectedInPool}
          setSelected={setSelected}
          pending={pending}
          act={act}
        />
      ) : lobby.status === "READY" ? (
        <ReadyView
          lobby={lobby}
          me={me}
          offset={offset}
          serverNow={state.now}
          pending={pending}
          act={act}
        />
      ) : (
        <InProgressView
          lobby={lobby}
          me={me}
          offset={offset}
          serverNow={state.now}
          detectMinMinutes={state.detectMinMinutes}
          pending={pending}
          act={act}
        />
      )}

      {me.canCancel ? (
        <div className="text-right">
          {forcedCancel ? (
            <ForceCancelLobby {...forcedCancel} pending={pending} act={act} />
          ) : (
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
          )}
        </div>
      ) : null}

      {/* A wrong result used to be permanent — the ladder and history both
          filter on COMPLETED, so voiding the lobby removes it and every
          player's Elo recomputes from the surviving games on the next read. */}
      {me.isAdmin && !lobby && state.lastResult ? (
        <div className="text-right">
          <button
            disabled={pending}
            onClick={async () => {
              if (
                window.confirm(
                  "Void the last inhouse result? It leaves the ladder and history, and everyone's Elo is recalculated without it.",
                )
              ) {
                // Name the target: the banner's own lobby, never "whatever
                // completed most recently at click time".
                if (
                  await act({
                    action: "void",
                    lobbyId: state.lastResult?.lobbyId,
                  })
                ) {
                  pushToast("success", "Result voided — Elo recalculated");
                }
              }
            }}
            className="rounded text-xs text-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
          >
            Admin: void the last result
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------- Admin: the forced cancel ----------

/**
 * The override for the one state that can lock the WHOLE LEAGUE out of
 * inhouses: a live game with Cred staked on it.
 *
 * `cancelLobby` refuses a plain cancel there and is right to — cancelling a
 * half-played game everyone can see the shape of is otherwise an admin undo for
 * a losing bet. But the lobby holds the single active slot while it stands, so
 * `maybeFormLobby` can form nothing and its own ten are refused the queue, for
 * the six hours until the abandon sweep. That is why the service takes a
 * `force` and says so in its refusal — and until this control existed the
 * refusal named an override reachable only by hand-POSTing `/api/inhouse`,
 * which is the worst of both: a documented escape hatch nobody can take.
 *
 * TYPED confirmation, for the /admin reason: `window.confirm` focuses OK by
 * default, so it is one Enter away, and it looks identical whether it guards a
 * rename or the scrapping of a live game ten people are inside. The token is
 * the LOBBY CODE — the Dota password those ten are playing under, and the value
 * `GameSetupCard` prints for anyone who is in the lobby. Like DangerSubmit's
 * season name it is shown in the dialog rather than kept secret (it is a
 * barrier against reflex, not against knowledge), but it means confirming
 * NAMES the exact game being killed instead of reproducing a magic word — an
 * admin who has the wrong lobby on screen has to notice.
 *
 * Inline rather than `<DangerSubmit>`: that one reads `useFormStatus` and
 * submits a server action, while this room is a fetch client whose pending
 * state comes from `act()`. The mechanism is deliberately identical — exact
 * match, blank on every open, Escape disarms, Enter cannot complete it.
 *
 * It is rendered only while the plain cancel would refuse, so a poll that ends
 * the lobby unmounts it and takes the open dialog with it. That is the right
 * outcome and not a lost edit: the game it names has finished, and a modal
 * still offering to scrap it would be the stale banner this room's toasts exist
 * to avoid.
 */
function ForceCancelLobby({
  code,
  bettors,
  staked,
  pending,
  act,
}: {
  /** `inhouseLobbyCode(lobby.id)` — the token, and the game's own name. */
  code: string;
  bettors: number;
  staked: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Trim only — otherwise EXACT. A fuzzy match would let a half-read code
  // through, and reproducing it exactly IS the whole barrier.
  const armed = typed.trim() === code;

  const closeDialog = useCallback(() => {
    setOpen(false);
    setTyped("");
  }, []);

  // Keep keyboard focus and page scrolling inside the destructive dialog.
  // Closing always disarms and returns focus to the trigger, including Escape;
  // reopening must start from a blank field so a code typed a minute ago can't
  // linger and auto-arm.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const trigger = triggerRef.current;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeDialog();
        return;
      }
      if (e.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      const current = document.activeElement;
      if (e.shiftKey && (current === first || !dialog.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (
        !e.shiftKey &&
        (current === last || !dialog.contains(current))
      ) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [open, closeDialog]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={pending}
        onClick={() => {
          setTyped("");
          setOpen(true);
        }}
        className="rounded text-xs text-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
      >
        Admin: force-cancel this live game
      </button>
      {/* Say WHY the ordinary button isn't here. An admin who came looking for
          "cancel this lobby" and found a differently-worded control needs to
          know it isn't a rename — and "nothing happened" is the one answer an
          admin cannot act on. */}
      <p className="mt-1 text-[11px] text-muted">
        A plain cancel is refused while Cred is staked on a live game.
      </p>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${inputId}-title`}
            aria-describedby={`${inputId}-description`}
            className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-danger/40 bg-surface p-5 text-left shadow-xl"
          >
            <h2
              id={`${inputId}-title`}
              className="text-lg font-semibold text-danger"
            >
              Force-cancel the live game?
            </h2>
            {/* The real numbers, read from the pot this room is already
                rendering — the /admin rule: a confirm that can't state what
                dies is a confirm that gets skimmed. */}
            <div id={`${inputId}-description`}>
              <ul className="mt-3 space-y-1 text-sm text-fg">
                {[
                  `${staked} Cred across ${bettors} ${
                    bettors === 1 ? "bet" : "bets"
                  } is refunded in full — nobody wins or loses on this game.`,
                  "The game is scrapped: no result, no Elo, nothing in the ladder or the history, even if the ten finish it in Dota.",
                  "All ten go back into the queue and re-confirm on their next poll.",
                  "It is logged as an admin action, naming the pot.",
                ].map((c) => (
                  <li key={c} className="flex gap-2">
                    <span aria-hidden className="text-danger">
                      •
                    </span>
                    <span className="min-w-0">{c}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-xs text-muted">
                The money is the recoverable half — the server attempts the
                automatic refund before this action returns, and any interrupted
                refund is retried on the next page view anywhere on the site.
                The game is not: once the lobby reads cancelled there is nothing
                left for a result to attach to. Do this when a live lobby is
                stuck, because it is holding the one active-lobby slot and
                nobody in the league can start another game until it clears.
              </p>
            </div>
            <label htmlFor={inputId} className="mt-4 block text-sm text-muted">
              Type the lobby code <b className="font-mono text-fg">{code}</b> to
              confirm:
            </label>
            <input
              id={inputId}
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              // No single keypress may complete this. There is no enclosing
              // form here, but Enter still lands on the focused control and
              // reflex-confirming is the exact thing being prevented.
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
              autoComplete="off"
              spellCheck={false}
              inputMode="numeric"
              className="mt-1 h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 font-mono text-sm outline-none focus:border-danger/60"
            />
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={closeDialog}
                className={buttonClasses("secondary", "md")}
              >
                Keep the game
              </button>
              <button
                type="button"
                disabled={!armed || pending}
                onClick={async () => {
                  closeDialog();
                  // Only claim success once the server agrees. A forced cancel
                  // still loses to a result that landed mid-dialog — the claim
                  // keeps its `status: { in: ACTIVE }` predicate — and telling
                  // an admin the pot was refunded when the game in fact paid
                  // out is the worst sentence a money screen can produce.
                  if (await act({ action: "cancel", force: true })) {
                    // No figure in this one, unlike the list above. That list
                    // states what is on the table BEFORE the click, which is
                    // exactly what a confirm is for; this states what happened,
                    // and `staked` is a poll old — the window can still be open
                    // here (Start does not close it), so one more slip may have
                    // landed. "In full" is true whatever it was, and the
                    // AdminAction the server writes carries the exact pot.
                    pushToast(
                      "success",
                      "Live game scrapped — players re-queued and Cred refunds are resolving",
                    );
                  }
                }}
                className={buttonClasses("danger", "md")}
              >
                Force-cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ---------- Queue ----------

type QueueControlProps = {
  me: InhouseState["me"];
  pending: boolean;
  mmr: number;
  setMmr: (n: number) => void;
  mmrHint: string | null;
  act: (body: Record<string, unknown>) => void;
  nextGame?: boolean;
};

/**
 * The single join/leave/sign-in control used by both the idle queue and the
 * compact live-lobby card. Keeping this in one component prevents the live
 * path from drifting back to a hidden API-only affordance.
 */
function QueueControls({
  me,
  pending,
  mmr,
  setMmr,
  mmrHint,
  act,
  nextGame = false,
}: QueueControlProps) {
  const mmrInputId = useId();

  return (
    <div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {!me.isLoggedIn ? (
          <a
            href="/login?next=/inhouse"
            className={buttonClasses("primary", "lg")}
          >
            {nextGame ? "Sign in for next game" : "Sign in to queue"}
          </a>
        ) : me.inQueue ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => act({ action: "leave" })}
            className={buttonClasses("secondary", "lg")}
          >
            Leave queue
          </button>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <label htmlFor={mmrInputId} className="text-sm text-muted">
              MMR
            </label>
            <input
              id={mmrInputId}
              type="number"
              min={0}
              max={12000}
              inputMode="numeric"
              value={mmr || ""}
              placeholder="0"
              onChange={(e) => setMmr(Number(e.target.value))}
              title="Seeds captain selection and the balance meter. If you've registered for a season, your league signup MMR is used instead."
              className="h-11 w-24 rounded-lg border border-line bg-surface-2/50 px-3 text-center text-sm outline-none focus:border-accent/60"
            />
            <button
              type="button"
              disabled={pending}
              onClick={() => act({ action: "join", mmr })}
              className={buttonClasses("accent", "lg")}
            >
              {nextGame ? "Join next-game queue →" : "Join queue →"}
            </button>
          </div>
        )}
      </div>

      {/* Stays visible after joining — it's the explanation for why the listed
          MMR can differ from what was typed. */}
      {mmrHint ? <p className="mt-3 text-xs text-muted">{mmrHint}</p> : null}
    </div>
  );
}

/** A small entry point above a lobby for people who are not part of that game. */
function NextGameQueueCard({
  state,
  pending,
  mmr,
  setMmr,
  mmrHint,
  act,
}: Omit<QueueControlProps, "me" | "nextGame"> & { state: InhouseState }) {
  const titleId = useId();
  const present = state.queue.filter((q) => !q.away).length;

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-[var(--radius)] border border-accent/30 bg-accent/5 px-4 py-4 sm:px-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={titleId} className="font-semibold">
              Queue for the next game
            </h2>
            <Badge tone="accent">{present} queued</Badge>
          </div>
          <p className="mt-1 max-w-xl text-sm text-muted">
            This lobby is already underway. The next ready check can only start
            after it closes.
          </p>
        </div>
        <div className="shrink-0">
          <QueueControls
            me={state.me}
            pending={pending}
            mmr={mmr}
            setMmr={setMmr}
            mmrHint={mmrHint}
            act={act}
            nextGame
          />
        </div>
      </div>
    </section>
  );
}

function QueueView({
  state,
  pending,
  mmr,
  setMmr,
  mmrHint,
  act,
  nextGame = false,
}: {
  state: InhouseState;
  pending: boolean;
  mmr: number;
  setMmr: (n: number) => void;
  mmrHint: string | null;
  act: (body: Record<string, unknown>) => void;
  /** The visible queue will not form until the active lobby closes. */
  nextGame?: boolean;
}) {
  const { queue, lobbySize, needed, me } = state;
  // "Away" players (heartbeat gone quiet) keep their row for a grace window
  // but don't count toward forming — the headline number stays honest, and
  // (via queueSlots below) they can't take a visible slot off someone who is
  // actually here.
  const present = queue.filter((q) => !q.away);
  const pct = lobbySize
    ? Math.min(100, Math.round((present.length / lobbySize) * 100))
    : 0;
  // Rough lobby strength while it fills. avgKnownMmr owns the "0 = unknown,
  // excluded" rule — this only adds the sample floor, so one lone known MMR
  // isn't presented as the room's calibre.
  const knownMmrs = present.map((q) => q.mmr).filter((m) => m > 0);
  const queueAvg = knownMmrs.length >= 2 ? avgKnownMmr(knownMmrs) : 0;
  const { slots, overflow } = queueSlots(queue, lobbySize);

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-[var(--radius)] border border-accent/30 bg-gradient-to-b from-surface-3/70 to-surface/40 shadow-lg shadow-black/25">
        <div className="px-5 py-6 text-center sm:px-6">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-accent/90">
            {nextGame ? "Next-game queue" : "Inhouse queue"}
          </h2>
          <div className="mt-1.5 font-display text-6xl font-bold leading-none tabular-nums">
            {present.length}
            <span className="text-muted"> / {lobbySize}</span>
          </div>
          <div className="mt-2 text-sm text-muted">
            {nextGame
              ? needed > 0
                ? `${needed} more ${needed === 1 ? "player" : "players"} for a full next-game lobby`
                : "Queue full — ready check waits for the current lobby to close"
              : needed > 0
                ? `${needed} more ${needed === 1 ? "player" : "players"} to fire up a game`
                : "Lobby full — starting the ready check…"}
            {queueAvg > 0 ? (
              <span className="tabular-nums"> · avg {queueAvg} MMR</span>
            ) : null}
          </div>

          <div className="mx-auto mt-4 h-2 w-full max-w-md overflow-hidden rounded-full bg-surface-2">
            <div
              role="progressbar"
              aria-label={
                nextGame ? "Next-game queue progress" : "Inhouse queue progress"
              }
              aria-valuemin={0}
              aria-valuemax={lobbySize}
              aria-valuenow={Math.min(present.length, lobbySize)}
              className="h-full rounded-full bg-brand transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>

          <div className="mt-5">
            <QueueControls
              me={me}
              pending={pending}
              mmr={mmr}
              setMmr={setMmr}
              mmrHint={mmrHint}
              act={act}
              nextGame={nextGame}
            />
          </div>

          <p className="mt-3 text-xs text-muted">
            {nextGame
              ? "Keep this page open to hold your next-game spot. Your ready check starts only after the current lobby closes."
              : "Keep this page open to hold your spot — players who close it are marked away and dropped from the queue after a few minutes."}
          </p>
        </div>

        <div className="border-t border-line bg-surface/40 px-3 py-3 sm:px-4">
          {/* All lobby slots — filled players + open placeholders, so the
              lobby visibly fills up as people queue. Present players claim the
              slots first (see queueSlots): the headline count, `needed` and
              lobby formation all ignore away entries, so letting one hold a
              visible slot made this grid contradict the number above it.

              The trailing open rows ARE the call to action (the same reasoning
              as the pinned Discord board), so they stay — but at 56px each an
              empty queue rendered 560px of identical dashes, which is the state
              ~95% of visits land on. Same ten rows, half the height. */}
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {slots.map((q, i) => {
              if (!q) {
                return (
                  <li
                    key={`open-${i}`}
                    className="flex items-center gap-2.5 rounded-lg border border-dashed border-line/50 px-2.5 py-1.5"
                  >
                    <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted">
                      {i + 1}
                    </span>
                    <span className="text-sm text-muted">Open slot</span>
                  </li>
                );
              }
              const isMe = q.userId === me.userId;
              return (
                <li
                  key={q.userId}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5",
                    isMe
                      ? "border-accent/50 bg-accent/10"
                      : "border-line bg-surface-2/40",
                    q.away && "opacity-60",
                  )}
                >
                  <span className="w-5 shrink-0 text-center text-xs text-muted tabular-nums">
                    {i + 1}
                  </span>
                  <Avatar name={q.name} src={q.avatar} size={26} />
                  <PlayerLink
                    userId={q.userId}
                    className="min-w-0 truncate text-sm font-medium"
                  >
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
                  <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted">
                    <RankBadge rankTier={q.rankTier} />
                    {q.mmr > 0 ? (
                      <span className="tabular-nums">{q.mmr}</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>

          {/* Players beyond the ten slots (queued while a lobby was live, or
              an overflow crowd) — never silently hidden. */}
          {overflow.length > 0 ? (
            <div className="mt-3 border-t border-line/60 pt-3">
              <div className="mb-1.5 text-xs text-muted">
                In line for the next game · {overflow.length}
              </div>
              <ul className="flex flex-wrap gap-2">
                {overflow.map((q) => (
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
        How it works: {lobbySize} players queue → everyone accepts the match →
        vote how captains are chosen (elect them, highest MMR, or best record) →
        captains snake-draft <span className="text-success">Radiant</span> &{" "}
        <span className="text-danger">Dire</span> (1, then 2 at a time) → anyone
        hosts a private lobby in Dota 2 and the result records itself.
      </p>
    </div>
  );
}

// ---------- Captain vote ----------

type VoteLobby = NonNullable<InhouseState["lobby"]>;
type Candidate = NonNullable<VoteLobby["vote"]>["candidates"][number];

// ---------- Ready check ----------

function ReadyCheckView({
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
  const check = lobby.readyCheck;
  // The accept clock must stay visible if the player scrolls — same
  // compact-bar treatment as the vote and pick clocks.
  const { ref: bannerRef, offscreen } = useBannerOffscreen(true);
  if (!check) return null;

  const waitingOn = check.total - check.acceptedCount;

  return (
    <div className="space-y-5">
      {/* Compact fixed bar while the accept clock is scrolled away. top-20
          matches the 80px header (see useBannerOffscreen). */}
      {offscreen ? (
        <button
          type="button"
          onClick={scrollToRoomTop}
          aria-label="Back to the match accept"
          className="fixed inset-x-0 top-20 z-20 border-b border-line bg-bg/90 text-left backdrop-blur"
        >
          <div className="mx-auto flex h-11 w-full max-w-6xl items-center justify-between gap-3 px-4 text-sm sm:px-6">
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden>🎮</span>
              <span className="truncate font-medium">Match found</span>
              <span className="shrink-0 text-xs text-muted tabular-nums">
                {check.acceptedCount}/{check.total} accepted
              </span>
            </span>
            <SecondsClock
              endsAtMs={lobby.acceptEndsAt}
              offsetMs={offset}
              urgentAt={10}
              label={(s) => `${s} seconds left to accept`}
            />
          </div>
        </button>
      ) : null}

      <div
        ref={bannerRef}
        className="rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-5 py-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">
              {me.canAccept
                ? "🎮 Match found — accept to play!"
                : "🎮 A match is filling up"}
            </h2>
            <div className="text-xs text-muted">
              {check.acceptedCount}/{check.total} accepted
              {waitingOn > 0
                ? ` · waiting on ${waitingOn} ${waitingOn === 1 ? "player" : "players"}`
                : ""}
              {me.canAccept
                ? " · accept before the timer or you'll lose your spot"
                : me.inQueue
                  ? " · you're queued for the next game — this lobby closes first"
                  : me.isLoggedIn
                    ? " · you're spectating — join the next-game queue above"
                    : " · you're spectating — sign in above to queue for the next game"}
            </div>
          </div>
          <SecondsClock
            endsAtMs={lobby.acceptEndsAt}
            offsetMs={offset}
            urgentAt={10}
            label={(s) => `${s} seconds left to accept`}
          />
        </div>

        {me.canAccept ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {me.hasAccepted ? (
              <span className="inline-flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-4 py-2.5 text-sm font-semibold text-success">
                <span aria-hidden>✓</span> Accepted — waiting for the others
              </span>
            ) : (
              <button
                disabled={pending}
                onClick={() => act({ action: "accept" })}
                className={cn(buttonClasses("accent", "lg"), "px-10 font-bold")}
              >
                ACCEPT MATCH
              </button>
            )}
            {!me.hasAccepted ? (
              <button
                disabled={pending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Decline this match? The lobby is scrapped and you leave the queue. Everyone who accepted keeps their spot at the front of the queue.",
                    )
                  ) {
                    act({ action: "decline" });
                  }
                }}
                className="rounded text-xs text-muted hover:text-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
              >
                Decline
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Who's in — pending players sort first (they're the holdup). */}
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {check.players.map((p) => (
          <li
            key={p.userId}
            className={cn(
              "flex items-center gap-3 rounded-lg border px-3 py-2",
              p.accepted
                ? "border-success/40 bg-success/5"
                : "border-line bg-surface-2/40",
            )}
          >
            <Avatar name={p.name} src={p.avatar} size={28} />
            <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
            {p.accepted ? (
              <span
                role="img"
                aria-label={`${p.name} accepted`}
                className="text-sm text-success"
              >
                <span aria-hidden>✓</span>
              </span>
            ) : (
              <span
                role="img"
                aria-label={`${p.name} hasn't accepted yet`}
                className="animate-pulse text-sm text-muted motion-reduce:animate-none"
              >
                <span aria-hidden>…</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

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

  // The SAME ranking the server will install, not a hand-copy of it: these
  // three previews are what the ten players are voting on, and the local sorts
  // they used to run dropped orderCaptains' final earliest-queued tiebreak. On
  // a young ladder ties are the normal case — everyone 0-0, unregistered
  // players at MMR 0 — so the cards routinely named a different second captain
  // than the vote would actually produce.
  const byMmr = orderCaptains("MMR", vote.candidates);
  const byRecord = orderCaptains("RECORD", vote.candidates);
  const byVotes = orderCaptains("VOTE", vote.candidates);
  const hasRecords = vote.candidates.some((c) => c.games > 0);
  const hasNominations = vote.candidates.some((c) => c.nominations > 0);

  return (
    <div className="space-y-5">
      {/* Compact fixed bar while the vote clock is scrolled away. top-20
          matches the 80px header (see useBannerOffscreen). */}
      {offscreen ? (
        <button
          type="button"
          onClick={scrollToRoomTop}
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
          <h2 className="text-sm font-semibold">
            🗳️ How should captains be picked?
          </h2>
          <div className="text-xs text-muted">
            {vote.votedCount}/{vote.voterCount} voted · lobby decides by
            majority
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
          <span className="text-xs text-muted">{previewEmpty}</span>
        )}
      </div>
    </button>
  );
}

// ---------- Draft ----------

function DraftView({
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
  lobby: NonNullable<InhouseState["lobby"]>;
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
          "flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border bg-surface/80 px-5 py-3",
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

      <p className="-mt-3 text-center text-xs text-muted">
        Snake draft — the first captain picks once, then picks come in pairs, so
        neither side gets the better player at every tier.
      </p>

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
              const pickable = me.canPick;
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
                    <span className="text-xs text-muted tabular-nums">
                      {p.mmr}
                    </span>
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
          {me.canPick ? (
            <div className="border-t border-line p-3">
              <button
                disabled={pending || !selected}
                onClick={() =>
                  selected && act({ action: "pick", userId: selected })
                }
                className={buttonClasses("accent", "md", "w-full")}
              >
                {selected
                  ? me.isOnClock
                    ? `Draft ${lobby.pool.find((p) => p.userId === selected)?.name ?? ""}`
                    : `Admin: draft ${lobby.pool.find((p) => p.userId === selected)?.name ?? ""} for ${lobby.onClockCaptain?.name ?? "the current captain"}`
                  : me.isOnClock
                    ? "Select a player to draft"
                    : `Select a player to draft for ${lobby.onClockCaptain?.name ?? "the current captain"}`}
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

// ---------- Ready ----------

function ReadyView({
  lobby,
  me,
  offset,
  serverNow,
  pending,
  act,
}: {
  lobby: NonNullable<InhouseState["lobby"]>;
  me: InhouseState["me"];
  offset: number;
  /** The server clock from the last poll — the pot's gate is judged against it
   *  rather than Date.now(), which would make this render non-idempotent. */
  serverNow: number;
  pending: boolean;
  /** Widened from the other phases' `=> void`: placing a bet must only claim
   *  success once the server agrees, exactly like the admin cancel above. */
  act: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  return (
    <div className="space-y-5">
      <div className="rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-6 py-5 text-center">
        <div className="text-2xl">🎮</div>
        <h2 className="mt-1 text-lg font-semibold">Teams are set!</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          Set up the Dota lobby and hop into voice — the steps are just below.
          Then hit start once everyone&apos;s in. No ticket or league id needed;
          the result is found from players&apos; match histories.
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

      {/* ABOVE the setup card, deliberately: that card is the thing that pulls
          ten people out of the browser and into the Dota client, and a 45s
          window rendered underneath it is a window nobody sees. */}
      {lobby.pot ? (
        <PotPanel
          lobby={lobby}
          pot={lobby.pot}
          me={me}
          offset={offset}
          serverNow={serverNow}
          pending={pending}
          act={act}
        />
      ) : null}

      {me.inLobby ? <GameSetupCard lobby={lobby} me={me} /> : null}

      <MatchupGrid lobby={lobby} />
    </div>
  );
}

// ---------- Betting ----------

type Pot = NonNullable<NonNullable<InhouseState["lobby"]>["pot"]>;

/** Derived, never typed out: the bankruptcy floor's "a game that looks like a
 *  game" bar is stated to players in minutes and enforced in seconds, and two
 *  hand-written copies of one threshold is how copy starts lying. */
const FLOOR_GAME_MINUTES = Math.round(INHOUSE_BETS.REAL_GAME_SECONDS / 60);

/**
 * The promise a control makes BEFORE it is tapped: "100 staked · 40 covered ·
 * 60 comes home". Only matched Cred is ever at risk, so a panel that showed the
 * stake alone would sell a 100 into an empty pool as if it were a 100 — betting
 * into a vacuum is free bravado, and this sentence is where the panel says so.
 *
 * The `covered` figure always comes from `potView`, the same function the
 * server settles with, never from arithmetic written here. Two definitions of
 * "covered" is the avgKnownMmr mistake with money attached: the button would
 * promise one number and the payout would pay another.
 */
function stakeOutcome(stake: number, covered: number): string {
  return `${stake} staked · ${covered} covered · ${stake - covered} comes home`;
}

/** The same sentence at chip width. "none covered" is the warning, not filler. */
function stakeOutcomeShort(stake: number, covered: number): string {
  if (covered <= 0) return "none covered";
  if (covered >= stake) return "all live";
  return `${covered} live · ${stake - covered} back`;
}

/**
 * The viewer's net Cred, beside their Elo swing in the post-game banner. Read
 * from the `betDeltas` the settlement stamped — never re-derived here, because
 * a banner that recomputed the pot would disagree with the ledger the moment
 * anything was voided.
 *
 * Zero is a real outcome and not a rounding artefact (nobody covered your side,
 * or the bet was voided and refunded), so it renders muted with the reason in
 * the title rather than borrowing the win/loss colours.
 */
function CredDelta({ delta }: { delta: number }) {
  return (
    <>
      {" · "}
      <strong
        title={
          delta === 0
            ? "Your stake came back in full — either nobody covered your side, or the bet was voided."
            : `Matched Cred pays even money; anything the other side didn't cover was never at risk.`
        }
        className={cn(
          delta > 0 ? "text-success" : delta < 0 ? "text-danger" : "text-muted",
        )}
      >
        {delta > 0 ? "+" : ""}
        {delta} Cred
      </strong>
    </>
  );
}

/**
 * The pot, from the moment teams lock. Two bars, every slip as it lands, and —
 * for the ten who are in the game — one-tap stakes on their OWN side.
 *
 * It renders for spectators too: the slips are the product. The panel is a live
 * argument ("they're 160 ahead — somebody take it"), and an argument nobody can
 * see is one nobody joins.
 *
 * **THE PHASE IS NOT THE WINDOW.** The controls ride `me.canBet` and the clock
 * rides `pot.closesAt` — both the server's decision, both from this payload —
 * never "did the caller pass `act`?". `betsCloseAt` alone closes betting, on
 * purpose (nobody should ever be the person who closed the ante, and Start has
 * to stay instant), so `BETTABLE_STATUSES` deliberately includes IN_PROGRESS.
 * Using the phase as a proxy for the window is what this panel used to do, and
 * it took the chips away the instant any one of the ten pressed Start — for as
 * much as the whole 45 seconds, while the server went on accepting bets and the
 * integration test went on pinning that it does.
 */
function PotPanel({
  lobby,
  pot,
  me,
  offset,
  serverNow,
  pending = false,
  act,
}: {
  lobby: NonNullable<InhouseState["lobby"]>;
  /** Passed narrowed by the call site so the hooks below run unconditionally. */
  pot: Pot;
  me: InhouseState["me"];
  offset: number;
  serverNow: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const total = pot.pool1 + pot.pool2;
  const tier = tierLabel(pot.tier);
  const balance = me.cred ?? 0;
  const maxPool = Math.max(pot.pool1, pot.pool2);
  const myPool = me.myTeam === 1 ? pot.pool1 : me.myTeam === 2 ? pot.pool2 : 0;
  const theirPool =
    me.myTeam === 1 ? pot.pool2 : me.myTeam === 2 ? pot.pool1 : 0;
  // ELIGIBILITY, straight from the server (in the ten, on a side, hasn't bet,
  // window still open). Affordability is the chips' business below, via the
  // same `betGateError` the write refuses with.
  const canBet = me.canBet;
  // The clock is a call to action, so it rides the window rather than the
  // phase: a countdown over a closed pot is a taunt, and a pot with seconds
  // left and no clock is the same lie the other way round.
  const showClock = pot.closesAt != null;
  // Same contract as the vote/pick/accept clocks — top-20 is the 80px header.
  const { ref: bannerRef, offscreen } = useBannerOffscreen(showClock);

  const sideName = (team: number) => {
    const t = lobby.teams.find((x) => x.team === team);
    return t ? sideMeta(t.isRadiant).name : `Team ${team}`;
  };

  // Why this can't just be `stake <= balance`: `betGateError` is the sentence
  // the SERVER refuses with, so asking it here is what keeps a chip that is
  // offered and a bet that is accepted the same set. A second opinion about
  // affordability living in this file is how a disabled button and the toast
  // explaining it end up telling different stories.
  const gate = (stake: number) =>
    betGateError({
      balance,
      stake,
      myTeam: me.myTeam,
      lobbyStatus: lobby.status,
      betsCloseAtMs: pot.closesAt,
      // The server's clock from this payload, NOT Date.now(): calling that
      // during render makes the render non-idempotent (React may run it twice
      // and keep either result), and the window is the server's decision
      // anyway — `closesAt` is already nulled once it has passed.
      nowMs: serverNow,
      alreadyBet: !!me.myBet,
    });

  // What the pot would look like with this stake added to the viewer's side.
  // `placedAtMs` is 0 for every row on purpose: potView never reads it (the
  // timestamp only decides the late-bet void at settlement) and the allocation
  // is ordered by userId, so this is the identical arithmetic the server runs.
  const placed: BetRow[] = pot.slips.map((s) => ({
    userId: s.userId,
    team: s.team,
    stake: s.stake,
    placedAtMs: 0,
  }));
  const coveredIf = (stake: number): number => {
    if (!me.userId || me.myTeam == null) return 0;
    const view = potView([
      ...placed,
      { userId: me.userId, team: me.myTeam, stake, placedAtMs: 0 },
    ]);
    return view.coveredByUser[me.userId] ?? 0;
  };

  const step = INHOUSE_BETS.STEP;
  const toStep = (n: number) => Math.floor(n / step) * step;
  const maxChip = toStep(Math.min(INHOUSE_BETS.MAX_STAKE, balance));
  // One-tap amounts, never a text input: a bet that needs typing does not
  // happen inside 45 seconds with Dota already open. Built from the constants
  // (so a change to STEP/MAX can't leave an illegal chip on screen) and then
  // filtered through the gate, which is what drops the ones this balance can't
  // reach instead of offering a button whose only outcome is a refusal.
  const chips = [
    ...new Set([
      INHOUSE_BETS.MIN_STAKE,
      INHOUSE_BETS.MIN_STAKE * 2,
      toStep(INHOUSE_BETS.MAX_STAKE / 2),
      maxChip,
    ]),
  ]
    .sort((a, b) => a - b)
    .filter((c) => gate(c) === null);

  // COVER stakes exactly the gap, so it lands on the SHORT side and is matched
  // at ratio 1.0 — the built-in magnet back toward a balanced pot, and the
  // reason this button exists at all. Capped at MAX_STAKE and at the balance;
  // the covered figure still comes from potView rather than that reasoning.
  const coverAmount = toStep(
    Math.min(theirPool - myPool, INHOUSE_BETS.MAX_STAKE, balance),
  );
  const canCover =
    canBet &&
    coverAmount >= INHOUSE_BETS.MIN_STAKE &&
    gate(coverAmount) === null;
  // Derived, not asserted: a cover lands on the short side and is therefore
  // matched in full, but the button quotes potView like every other control
  // rather than trusting that sentence.
  const coverCovered = canCover ? coveredIf(coverAmount) : 0;

  // A CLOSED pot nobody joined has nothing to say, and it said it directly
  // above the lobby password while ten people were trying to leave for the Dota
  // client. Keyed on the WINDOW, not on whether controls were passed: while the
  // window is open an empty panel IS the invitation (betting is opt-in and a
  // quiet night carries no pot at all), and the moment it shuts with nothing in
  // it there is nothing left to invite. Under the old `!act` test the panel
  // lingered dead through a whole READY phase whose window had expired, and
  // vanished from a live one whose window had not.
  if (pot.closesAt == null && total === 0 && !me.myBet) return null;

  const place = async (stake: number) => {
    // ONLY the success path speaks. A false return is either a refusal the
    // route already toasted, or a TIMEOUT — and act() branches on that one
    // itself, because "your bet didn't go through" beside a balance that
    // quietly dropped is the worst thing a money screen can say.
    if (await act({ action: "bet", stake })) {
      pushToast(
        "success",
        `${stake} Cred on ${sideName(me.myTeam ?? 0)} — your slip is in the pot.`,
      );
    }
  };

  return (
    <>
      {/* The panel scrolls away while people copy the lobby password, and the
          window is 45 seconds long. Same compact fixed bar as the other three
          phases; top-20 matches the 80px header (see useBannerOffscreen). */}
      {offscreen ? (
        <button
          type="button"
          onClick={scrollToRoomTop}
          aria-label="Back to the pot"
          className="fixed inset-x-0 top-20 z-20 border-b border-line bg-bg/90 text-left backdrop-blur"
        >
          <div className="mx-auto flex h-11 w-full max-w-6xl items-center justify-between gap-3 px-4 text-sm sm:px-6">
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden>💰</span>
              <span className="truncate font-medium">
                {total > 0 ? `Pot ${total} Cred` : "Bets open"}
              </span>
              {/* Named sides, not "240–160": a bare pair in a one-line bar is
                  a number nobody can attribute, and which side is which is the
                  entire question the bar is being glanced at to answer. */}
              <span className="shrink-0 text-xs text-muted tabular-nums">
                {lobby.teams
                  .map(
                    (t) =>
                      `${sideMeta(t.isRadiant).name[0]} ${
                        t.team === 1 ? pot.pool1 : pot.pool2
                      }`,
                  )
                  .join(" · ")}
              </span>
              {/* Dropped on phones: everything else in this bar is shrink-0,
                  so one more fixed-width chip is what tips a 390px viewport
                  into a horizontal scroll. The numbers earn the space. */}
              {canBet ? (
                <Badge tone="accent" className="hidden shrink-0 sm:inline-flex">
                  Not in yet
                </Badge>
              ) : null}
            </span>
            <SecondsClock
              endsAtMs={pot.closesAt}
              offsetMs={offset}
              urgentAt={10}
              label={(s) => `${s} seconds left to bet`}
            />
          </div>
        </button>
      ) : null}

      <section
        ref={bannerRef}
        aria-label="Betting pot"
        className={cn(
          "rounded-[var(--radius)] border bg-surface/80 p-4 sm:p-5",
          canBet ? "border-accent/40" : "border-line",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">💰 The pot</span>
              {tier ? <Badge tone="accent">{tier}</Badge> : null}
            </div>
            <div className="mt-0.5 text-xs text-muted">
              {total > 0
                ? `${total} Cred staked · ${
                    pot.matched > 0
                      ? `${pot.matched} live on each side`
                      : "nothing live yet"
                  }`
                : canBet
                  ? "Nothing staked yet — back your own side, once, before the clock runs out."
                  : "No bets on this game."}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {me.cred != null ? (
              <span className="text-xs text-muted">
                Your Cred{" "}
                <strong className="text-fg tabular-nums">{balance}</strong>
              </span>
            ) : null}
            {showClock ? (
              <SecondsClock
                endsAtMs={pot.closesAt}
                offsetMs={offset}
                urgentAt={10}
                label={(s) => `${s} seconds left to bet`}
              />
            ) : null}
          </div>
        </div>

        {/* Two explicit columns at every width: the sides are only meaningful
            side by side, and this is the comparison the panel exists to make. */}
        <div className="mt-4 grid grid-cols-2 gap-3">
          {lobby.teams.map((t) => {
            const meta = sideMeta(t.isRadiant);
            const pool = t.team === 1 ? pot.pool1 : pot.pool2;
            const live = Math.min(pool, pot.matched);
            const mine = me.myTeam === t.team;
            const slips = pot.slips.filter((s) => s.team === t.team);
            return (
              <div
                key={t.team}
                className={cn(
                  "min-w-0 rounded-lg border p-3",
                  mine ? meta.ring : "border-line",
                  mine ? "bg-surface-2/60" : "bg-surface-2/30",
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn("h-2 w-2 shrink-0 rounded-full", meta.dot)}
                  />
                  <span className="min-w-0 truncate text-sm font-medium">
                    {meta.name}
                  </span>
                  {mine ? (
                    <Badge tone={meta.badge} className="shrink-0">
                      You
                    </Badge>
                  ) : null}
                  <span className="ml-auto shrink-0 text-sm font-bold tabular-nums">
                    {pool}
                  </span>
                </div>

                {/* Purely visual, so it carries its own name: solid = covered
                    by the other side, faded = coming home either way. */}
                <div
                  role="img"
                  aria-label={`${meta.name}: ${pool} Cred staked, ${live} of it covered`}
                  className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-2"
                >
                  <div
                    aria-hidden
                    className={cn("h-full rounded-full", meta.soft)}
                    style={{
                      width: `${maxPool > 0 ? (pool / maxPool) * 100 : 0}%`,
                    }}
                  >
                    <div
                      aria-hidden
                      className={cn("h-full rounded-full", meta.dot)}
                      style={{
                        width: `${pool > 0 ? (live / pool) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>

                <ul className="mt-2 space-y-1">
                  {slips.map((s) => (
                    <li
                      key={s.userId}
                      className="flex items-center gap-1.5 text-xs"
                    >
                      {/* Plain text, not a PlayerLink: ten stacked links four
                          pixels apart is the ambiguous-tap-target case, and
                          every one of these names is a link in the matchup
                          grid a screen further down. */}
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          s.userId === me.userId ? "font-semibold" : "",
                        )}
                      >
                        {s.name}
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {s.stake}
                      </span>
                      <span
                        title={stakeOutcome(s.stake, s.covered)}
                        className="shrink-0 tabular-nums text-muted"
                      >
                        ({s.covered} live)
                      </span>
                    </li>
                  ))}
                  {slips.length === 0 ? (
                    <li className="text-xs text-muted">Nobody in yet</li>
                  ) : null}
                </ul>
              </div>
            );
          })}
        </div>

        <p className="mt-3 text-xs text-muted">
          {pot.matched > 0
            ? `${pot.matched} Cred is live on each side and pays even money. Everything above that comes home whatever happens.`
            : total > 0
              ? "Nothing is live yet — one side has the whole pot, and unmatched Cred is never at risk. It needs a taker."
              : "Only Cred the other side covers is ever at risk; the rest is returned."}
        </p>

        {/* The immutable receipt. It stays on screen through IN_PROGRESS, which
            is when someone starts wondering what they actually have riding. */}
        {me.myBet ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-sm">
            <span aria-hidden>🎟️</span>
            <span className="min-w-0">
              Your bet:{" "}
              <strong className="tabular-nums">{me.myBet.stake} Cred</strong> on{" "}
              {sideName(me.myBet.team)} —{" "}
              <span className="text-muted">
                {me.myBet.covered > 0
                  ? `${me.myBet.covered} covered, ${me.myBet.stake - me.myBet.covered} comes home`
                  : "nothing covered yet — as it stands the whole stake comes home"}
              </span>
            </span>
          </div>
        ) : null}

        {canBet ? (
          <div className="mt-4 border-t border-line pt-4">
            {chips.length > 0 ? (
              <>
                {theirPool > myPool ? (
                  <p className="mb-2 text-xs text-muted">
                    Your side is{" "}
                    <strong className="text-fg tabular-nums">
                      {theirPool - myPool}
                    </strong>{" "}
                    behind — anything you put in up to that is covered in full.
                  </p>
                ) : null}

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {chips.map((amount) => {
                    const covered = coveredIf(amount);
                    const label =
                      amount === INHOUSE_BETS.MAX_STAKE
                        ? `MAX ${amount}`
                        : amount === maxChip
                          ? `ALL ${amount}`
                          : `${amount}`;
                    return (
                      <button
                        key={amount}
                        type="button"
                        disabled={pending}
                        title={stakeOutcome(amount, covered)}
                        aria-label={`Bet ${amount} Cred on ${sideName(
                          me.myTeam ?? 0,
                        )} — ${stakeOutcome(amount, covered)}`}
                        onClick={() => place(amount)}
                        className={buttonClasses(
                          "secondary",
                          "md",
                          "h-auto min-h-11 flex-col gap-0 px-2 py-1.5 sm:h-auto sm:min-h-10",
                        )}
                      >
                        <span className="text-base font-bold tabular-nums">
                          {label}
                        </span>
                        <span className="text-[11px] font-normal text-muted">
                          {stakeOutcomeShort(amount, covered)}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {canCover ? (
                  <button
                    type="button"
                    disabled={pending}
                    title={stakeOutcome(coverAmount, coverCovered)}
                    aria-label={`Cover the gap with ${coverAmount} Cred — ${stakeOutcome(
                      coverAmount,
                      coverCovered,
                    )}`}
                    onClick={() => place(coverAmount)}
                    className={buttonClasses(
                      "accent",
                      "md",
                      "mt-2 h-auto min-h-11 w-full flex-col gap-0 py-1.5 sm:h-auto sm:min-h-10",
                    )}
                  >
                    <span className="font-bold">COVER {coverAmount} →</span>
                    <span className="text-[11px] font-normal opacity-80">
                      {stakeOutcome(coverAmount, coverCovered)}
                    </span>
                  </button>
                ) : null}

                {/* The one thing a player must not discover afterwards: a
                    stake can sit for hours if the game never gets hosted. */}
                <p className="mt-2 text-[11px] leading-relaxed text-muted">
                  One bet, your own side, no take-backs. If the game never gets
                  played everything is refunded — but that can take a few hours.
                </p>
              </>
            ) : (
              <p className="text-xs text-muted">
                {gate(INHOUSE_BETS.MIN_STAKE)}
                {/* THE FLOOR IS A NET, NOT AN ALLOWANCE, and this sentence is
                    read by the one person who will hold it to the promise: a
                    player with nothing left. Three things past the balance
                    decide it, and the first is invisible from here — settlement
                    only runs on a lobby that had a confirmed bet
                    (`betSettlement` is stamped by the first bet), and
                    `applyFloor` lives inside settlement, so a game nobody bet
                    on tops nobody up however long it ran. Then the game must
                    have lasted REAL_GAME_SECONDS (which is what stops
                    four-minute feed-fests being a faucet with a crank on it),
                    and it pays at most once per UTC day. "After the next game
                    that runs its course" promised all of that away. */}
                {balance < INHOUSE_BETS.MIN_STAKE
                  ? ` There's a top-up back to ${INHOUSE_BETS.FLOOR}, but it's a safety net rather than an allowance: it needs a game you were in that somebody bet on and that ran past ${FLOOR_GAME_MINUTES} minutes, and it pays at most once a day.`
                  : null}
              </p>
            )}
          </div>
        ) : null}
      </section>
    </>
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
  serverNow,
  detectMinMinutes,
  pending,
  act,
}: {
  lobby: NonNullable<InhouseState["lobby"]>;
  me: InhouseState["me"];
  offset: number;
  /** The server clock from the last poll — see the scan-window note below. */
  serverNow: number;
  detectMinMinutes: number;
  pending: boolean;
  /** Widened from `=> void` like ReadyView's: the pot below is still LIVE here
   *  (Start does not close the window), and placing a bet must only claim
   *  success once the server agrees. */
  act: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [matchId, setMatchId] = useState("");
  // Poll-driven (not ticking) — only gates the "auto-scan is live" note, which
  // flips once, minutes in; the visible timer ticks in <ElapsedClock>.
  // Server clock, not `Date.now() + offset`: calling Date.now() during render
  // makes the render non-idempotent (React may run it twice and keep either
  // result). `state.now` is the same figure the offset is derived FROM, so
  // this is equivalent and, if anything, more honest — the scan window is a
  // server-side decision. It only lags by one poll, and this flag flips once,
  // minutes in; the visible timer keeps ticking in <ElapsedClock>.
  const elapsedMs =
    lobby.startedAt != null ? serverNow - lobby.startedAt : null;
  const scanLive = elapsedMs != null && elapsedMs >= detectMinMinutes * 60_000;

  return (
    <div className="space-y-5">
      <div className="rounded-[var(--radius)] border border-info/40 bg-info/10 px-6 py-5 text-center">
        <h2 className="flex items-center justify-center gap-2 text-lg font-semibold">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info/70 motion-reduce:animate-none" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-info" />
          </span>
          Game in progress
          {lobby.startedAt != null ? (
            <ElapsedClock startedAtMs={lobby.startedAt} offsetMs={offset} />
          ) : null}
        </h2>
        {lobby.startedByName ? (
          <p className="mt-1 text-sm text-muted">
            Hosted by {lobby.startedByName}
          </p>
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
                type="text"
                inputMode="numeric"
                enterKeyHint="done"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={matchId}
                onChange={(e) => setMatchId(e.target.value)}
                placeholder="e.g. 7891234567"
                className="h-9 w-44 rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
              />
              <button
                disabled={pending || !matchId.trim()}
                onClick={() =>
                  act({ action: "record", matchId: matchId.trim() })
                }
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

      {/* Still interactive, and that is not an oversight: the window closes on
          `betsCloseAt`, so a Start pressed at second 20 leaves 25 seconds in
          which the server accepts bets. Once it does shut the panel becomes the
          scoreboard people ask about while the game runs — who is in for what,
          and how much of it is actually live — and it does that off the same
          payload, with no phase test anywhere in it. */}
      {lobby.pot ? (
        <PotPanel
          lobby={lobby}
          pot={lobby.pot}
          me={me}
          offset={offset}
          serverNow={serverNow}
          pending={pending}
          act={act}
        />
      ) : null}

      {me.inLobby ? <GameSetupCard lobby={lobby} me={me} /> : null}

      <MatchupGrid lobby={lobby} />
    </div>
  );
}

// ---------- Game setup instructions (lobby + voice) ----------

/** A monospace value with a click-to-copy button (name / password / etc.). */
function CopyChip({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          pushToast("success", `Copied ${label}: ${value}`);
        } catch {
          pushToast("error", "Couldn't copy — select it and copy manually");
        }
      }}
      title={`Copy ${label}`}
      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2/60 px-2 py-1 font-mono text-sm font-semibold text-fg transition-colors hover:border-accent/60"
    >
      {value}
      <span aria-hidden className="text-xs text-muted">
        📋
      </span>
    </button>
  );
}

/**
 * What the ten players do once teams lock: one hosts the Dota 2 lobby with a
 * shared name + password everyone sees, and each joins their team's Discord
 * voice channel. The lobby name/password are derived from the lobby id, so all
 * ten see the SAME values with no server round-trip.
 */
function GameSetupCard({
  lobby,
  me,
}: {
  lobby: NonNullable<InhouseState["lobby"]>;
  me: InhouseState["me"];
}) {
  const code = inhouseLobbyCode(lobby.id);
  const lobbyName = `${INHOUSE.LOBBY_NAME_PREFIX} #${code}`;
  const voiceByTeam = (team: number) =>
    team === 1 ? INHOUSE.VOICE_TEAM_1 : INHOUSE.VOICE_TEAM_2;

  return (
    <div className="rounded-[var(--radius)] border border-line bg-surface/80 p-5">
      <div className="mb-3 text-sm font-semibold">🕹️ How to play this game</div>

      {/* Step 1 — host the Dota lobby */}
      <div className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-bold text-accent">
          1
        </span>
        <div className="min-w-0 text-sm">
          <div className="font-medium">One player hosts the Dota 2 lobby</div>
          <p className="mt-1 text-muted">
            In Dota 2: <strong>Play → Custom Lobbies → Create Lobby</strong>.
            Set the name and password below, then invite/accept everyone.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted">Lobby name</span>
              <CopyChip value={lobbyName} label="lobby name" />
            </span>
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted">Password</span>
              <CopyChip value={code} label="password" />
            </span>
          </div>
          <p className="mt-2 text-xs text-muted">
            Everyone else: open <strong>Custom Lobbies</strong>, find{" "}
            <span className="font-mono text-fg">{lobbyName}</span> in the list
            (or ask the host to invite you) and join with the password.
          </p>
        </div>
      </div>

      {/* Step 2 — join your team's voice channel */}
      <div className="mt-4 flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-bold text-accent">
          2
        </span>
        <div className="min-w-0 text-sm">
          <div className="font-medium">
            Join your team&apos;s voice channel in Discord
          </div>
          <p className="mt-1 text-muted">
            Talk to your team during the game — hop into the voice channel for
            your side.
          </p>
          <ul className="mt-2 space-y-1.5">
            {lobby.teams.map((t) => {
              const meta = sideMeta(t.isRadiant);
              const mine = me.myTeam === t.team;
              return (
                <li
                  key={t.team}
                  className={cn(
                    "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-1.5",
                    mine ? meta.ring : "border-line",
                    mine ? meta.chip : "bg-surface-2/40",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn("h-2 w-2 rounded-full", meta.dot)}
                  />
                  <span className="font-medium">{meta.name}</span>
                  <span className="text-xs text-muted">→</span>
                  <span className="font-mono text-sm">
                    🔊 {voiceByTeam(t.team)}
                  </span>
                  {mine ? (
                    <Badge tone={meta.badge} className="ml-auto">
                      Your team — join here
                    </Badge>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ---------- Shared roster grid ----------

function MatchupGrid({ lobby }: { lobby: NonNullable<InhouseState["lobby"]> }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {lobby.teams.map((t) => {
        const meta = sideMeta(t.isRadiant);
        const roster = t.captain ? [t.captain, ...t.players] : t.players;
        // Shared with the drafting columns and the balance banner — this grid
        // used to average the unknowns in as zeroes and disagree with both.
        const avgMmr = avgKnownMmr(roster.map((p) => p.mmr));
        return (
          <div
            key={t.team}
            className={cn(
              "rounded-[var(--radius)] border bg-surface/80",
              meta.ring,
            )}
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
                  <PlayerLink
                    userId={p.userId}
                    className="min-w-6 flex-1 truncate"
                  >
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
