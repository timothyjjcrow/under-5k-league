"use client";

// The inhouse room SHELL: the poll loop, act(), the alerts/title/focus
// effects and the page-level layout. Each stage view (queue, accept, captain
// vote, draft, set up, play) lives in its own file under
// src/components/inhouse/; room-source-guards.test.ts reads the shell and that
// folder together as one room.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, buttonClasses, textLink } from "@/components/ui";
import { pushToast } from "@/components/toaster";
import { cn } from "@/lib/utils";
import { usePersistedFlag, usePollHealth } from "@/components/room-clock";
import {
  autoJoinDecision,
  inhouseAlerts,
  inhouseGameLabel,
  inhouseLobbyCode,
  inhouseTitleFlag,
  liveGameEnded,
  otherGameFlags,
  pollingLobby,
  readyCheckEndedToast,
  shouldFocusStage,
  showGameLabel,
  wasInReadyCheck,
  type InhouseAlertSnapshot,
  type InhouseFocusSnapshot,
} from "@/lib/inhouse";
import { inhousePollCadence } from "@/lib/room-poll";
import { INHOUSE_ROOM_STATUS_COPY, roomStatus } from "@/lib/room-status";
import { RoomStatusLine } from "@/components/room-status-line";
import { nextClockOffset } from "@/lib/countdown";
import {
  ROOM_SEQUENCE_START,
  acceptSequence,
  isColdStart,
  issueSequence,
} from "@/lib/room-sequence";
import {
  INHOUSE_SCAN_ACTIONS,
  INHOUSE_SCAN_ACTION_TIMEOUT_MS,
  ROOM_ACTION_TIMEOUT_MS,
  ROOM_POLL_TIMEOUT_MS,
} from "@/lib/constants";
import { armAudioUnlock, playChime, unlockAudio } from "@/components/chime";
import type { InhouseState } from "@/lib/inhouse-service";
import type { RoomLobby, RoomMe } from "@/components/inhouse/shared";
import { RoomStages, roomStageLabel } from "@/components/inhouse/room-stages";
import { NextGameQueueCard, QueueView } from "@/components/inhouse/queue-view";
import { ReadyCheckView } from "@/components/inhouse/ready-check-view";
import { VoteView } from "@/components/inhouse/vote-view";
import { DraftView } from "@/components/inhouse/draft-view";
import { ReadyView } from "@/components/inhouse/ready-view";
import { InProgressView } from "@/components/inhouse/in-progress-view";

/**
 * The lobby whose phase sets the poll rate: the viewer's own game, or the
 * other live game on the shortest clock (pollingLobby).
 */
function clockLobby(s: InhouseState | null) {
  return s ? pollingLobby(s.lobby, s.otherLobbies, s.now) : null;
}

export function InhouseRoom({
  pollMs = 1500,
  signupMmr = 0,
  mmrHint = null,
  firstGame = false,
}: {
  pollMs?: number;
  /**
   * The viewer's newest league-signup MMR (0 = none). joinQueue always uses
   * it when there is one, so the join panel shows it as plain text instead
   * of an input whose value would be ignored.
   */
  signupMmr?: number;
  /** Server-computed medal→MMR window note for the queue join panel. */
  mmrHint?: string | null;
  /**
   * Signed in with no completed inhouse yet: the queue's "game plan" fold
   * starts open, because it is the page's one walkthrough of what a game is.
   */
  firstGame?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<InhouseState | null>(null);
  const { disconnected, ok: pollOk, fail: pollFail } = usePollHealth();
  const [connectivity, setConnectivity] = useState<
    "online" | "offline" | "resyncing"
  >("online");
  const connectionUnavailable = connectivity !== "online";
  const [reqPending, setPending] = useState(false);
  const [actionReconciling, setActionReconciling] = useState(false);
  // Disconnected = all actions disabled: a pick/vote against stale state
  // would fail (or look accepted) while the real lobby moved on.
  const pending =
    reqPending || actionReconciling || disconnected || connectionUnavailable;
  const [selected, setSelected] = useState<string | null>(null);
  const [mmr, setMmr] = useState<number>(signupMmr);
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
  // fully pauses. Updated only by accepted snapshots so failed or stale
  // responses cannot forget a spot or slow an active deadline.
  const hasStakeRef = useRef(false);
  // One-tap join from a Discord ping (?join=1). Fires at most ONCE per page
  // load — queue membership has teeth (a filled lobby drags you into a timed
  // ready check whose failure drops you from the queue), so an accidental
  // re-enqueue on a re-render would be a real cost, not a cosmetic one.
  const autoJoinedRef = useRef(false);
  // The live games the last poll showed, so a game ending refreshes the
  // server-rendered ladder and results below the room.
  const prevLiveIds = useRef<string[] | null>(null);
  // What the LAST poll said about this viewer — the one input to both the
  // chime (inhouseAlerts) and the "match cancelled" toast, so the two can
  // never disagree about what just changed. null = nothing seen yet, which is
  // what suppresses alerts for a mid-lobby page load.
  const prevAlertRef = useRef<InhouseAlertSnapshot | null>(null);
  const originalTitleRef = useRef<string | null>(null);
  // The current stage view, and what the last poll said about it, so the
  // room can bring a stage that needs this member to the top of the screen
  // (shouldFocusStage decides when).
  const stageRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<InhouseFocusSnapshot | null>(null);
  // Result banners the viewer closed — stays dismissed across the polls of
  // the 10-minute lastResult window AND across reloads (localStorage), so a
  // refresh doesn't resurrect a banner they already read.
  const [dismissedResults, setDismissedResults] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    let dismissed: string | null = null;
    try {
      dismissed = localStorage.getItem("inhouseDismissedResult");
    } catch {
      // Optional preferences must never prevent the live room from loading.
    }
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
  // the alert gating a timed ACCEPT window, is computed correctly and
  // played into a suspended context. The draft room has had this since it
  // shipped; this room did not.
  useEffect(() => {
    // Keeps listening until audio actually runs (armAudioUnlock): a one-time
    // pointerdown never unlocked on phones.
    return armAudioUnlock();
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
  // A timeout, 5xx, or unreadable 2xx can happen after the mutation committed.
  // Keep controls locked until a state poll that STARTED after that action is
  // successfully applied; an older in-flight payload is not reconciliation.
  const actionReconcileSeqRef = useRef<number | null>(null);
  // Only a poll that starts after the latest offline/online transition may
  // make controls live again. Transport-held pre-outage responses are stale.
  const connectivityEpochRef = useRef(0);
  // Unlike React state, this can be read safely inside the long-lived poll
  // effect without resubscribing it. A 429 after a good snapshot is ordinary
  // back-pressure; a cold page receiving only 429s still needs to leave its
  // otherwise-endless Loading state.
  const hasLoadedRef = useRef(false);
  const latestStateRef = useRef<InhouseState | null>(null);

  const apply = useCallback((s: InhouseState, seq: number) => {
    const { accept, next } = acceptSequence(seqRef.current, seq);
    seqRef.current = next;
    if (!accept) return false; // lost the response race — stale
    hasLoadedRef.current = true;
    latestStateRef.current = s;
    hasStakeRef.current = s.me.inLobby || s.me.inQueue;
    const receivedAt = Date.now();
    setOffsetMs((prev) => nextClockOffset(prev, s.now, receivedAt));
    setState(s);
    return true;
  }, []);

  // Adaptive, visibility-aware poll loop (self-scheduling setTimeout, not a
  // fixed setInterval): FAST for timed ready/vote/draft stages, slower while
  // waiting or playing, and IDLE-slow when just spectating. While the tab is HIDDEN: a viewer with a
  // stake (queued or in a lobby) keeps a slow KEEPALIVE so their presence
  // heartbeat holds the spot and a forming ready check's chime/title still
  // reaches them; a hidden spectator doesn't fetch at all (authenticated room
  // traffic and the leased worker advance lobbies meanwhile). Either way it
  // re-syncs the instant it's refocused. Mirrors <ResultSyncPing>; kills the
  // ~40 req/min an idle open tab used to fire.
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    // An action can finish while a slower state poll is already in flight.
    // Remember the requested reconciliation until that poll settles; merely
    // replacing its timer is insufficient because the timer can fire, see
    // `inFlight`, and disappear without ever starting a post-action request.
    let rerunRequested = false;
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const markFailure = () => {
      consecutiveFailures += 1;
      pollFail();
    };

    const schedule = (ms: number) => {
      if (!alive) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, ms);
    };

    const tick = async () => {
      // inFlight also guards a visibilitychange firing mid-request — the active
      // call reschedules when it settles.
      if (!alive || inFlight) return;
      // This tick satisfies any queued action reconciliation. A new action
      // that lands during the await will set the latch again.
      rerunRequested = false;
      // Hidden with nothing at stake: don't fetch (browsers throttle background
      // timers anyway); the visibility listener wakes us on focus. Rules +
      // reasoning in inhousePollCadence, where they're unit-tested.
      const browserOffline = navigator.onLine === false;
      if (browserOffline) setConnectivity("offline");
      const preClock = clockLobby(latestStateRef.current);
      const pre = inhousePollCadence({
        offline: browserOffline,
        hidden: document.visibilityState === "hidden",
        hasStake: hasStakeRef.current,
        lobbyStatus: preClock?.status ?? null,
        scanOpensAt: preClock?.scanOpensAt ?? null,
        serverNow: latestStateRef.current?.now ?? null,
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
      const pollConnectivityEpoch = connectivityEpochRef.current;
      let next: InhouseState | null = null;
      let rateLimited = false;
      let supersededByConnectivityChange = false;
      try {
        const res = await fetch("/api/inhouse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "state" }),
          // See ROOM_POLL_TIMEOUT_MS — the draft room's loop shares it, and
          // both freeze the same way without it.
          signal: AbortSignal.timeout(ROOM_POLL_TIMEOUT_MS),
        });
        if (pollConnectivityEpoch !== connectivityEpochRef.current) {
          supersededByConnectivityChange = true;
        } else if (res.ok) {
          const payload = (await res.json()) as InhouseState;
          if (pollConnectivityEpoch !== connectivityEpochRef.current) {
            supersededByConnectivityChange = true;
          } else {
            next = payload;
            const applied = apply(next, seq);
            const actionSeq = actionReconcileSeqRef.current;
            if (applied && actionSeq !== null && seq > actionSeq) {
              actionReconcileSeqRef.current = null;
              setActionReconciling(false);
            }
            consecutiveFailures = 0;
            pollOk();
            setConnectivity(navigator.onLine === false ? "offline" : "online");
          }
        } else if (res.status === 429) {
          // Once a snapshot exists this is deliberately NOT a poll failure: it
          // must slow us down rather than disable a usable room. Cold-start
          // rate limits are different — without a failure signal they leave the
          // page saying Loading forever, so they participate in the same
          // retryable initial-error threshold as other non-success responses.
          rateLimited = true;
          if (!hasLoadedRef.current) markFailure();
        } else {
          markFailure();
        }
      } catch {
        if (pollConnectivityEpoch !== connectivityEpochRef.current) {
          supersededByConnectivityChange = true;
        } else {
          markFailure(); // transient blip (or the abort above); next poll retries
        }
      } finally {
        inFlight = false;
      }
      if (supersededByConnectivityChange) {
        setConnectivity(navigator.onLine === false ? "offline" : "resyncing");
        schedule(0);
        return;
      }
      if (rerunRequested) {
        // The action response may be unreadable or time out after the server
        // committed. Always start one poll *after* that action, even when the
        // earlier 250ms timer fired harmlessly during this request.
        rerunRequested = false;
        schedule(0);
        return;
      }
      // Recompute visibility HERE (not from the pre-fetch snapshot): if the tab
      // was refocused mid-fetch this reschedules at the active rate instead of
      // the hidden-tab keepalive, so refocus stays snappy. Stake is MEMBERSHIP, not
      // mere existence of a lobby — five people watching a 45min game were each
      // firing 40 req/min because one existed.
      const postClock = clockLobby(latestStateRef.current);
      schedule(
        inhousePollCadence({
          offline: navigator.onLine === false,
          hidden: document.visibilityState === "hidden",
          // Keep the latest ACCEPTED state through a failed or stale poll.
          hasStake: hasStakeRef.current,
          lobbyStatus: postClock?.status ?? null,
          scanOpensAt: postClock?.scanOpensAt ?? null,
          serverNow: latestStateRef.current?.now ?? null,
          rateLimited,
          reached: !!next,
          failureCount: consecutiveFailures,
          activeMs: pollMs,
        }).delayMs,
      );
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    const onOffline = () => {
      connectivityEpochRef.current += 1;
      setConnectivity("offline");
    };
    const onOnline = () => {
      // Do not re-enable a stale queue/lobby merely because the interface came
      // back. A successful state payload below is the recovery boundary.
      connectivityEpochRef.current += 1;
      setConnectivity("resyncing");
      tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    // An action that changes the viewer's state (join/accept/vote/pick) calls
    // this to poll again almost immediately, so the cadence re-locks to fast
    // right after joining instead of finishing a pending idle wait.
    bumpPollRef.current = () => {
      rerunRequested = true;
      schedule(250);
    };
    tick();

    return () => {
      alive = false;
      bumpPollRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      if (timer) clearTimeout(timer);
    };
  }, [apply, pollOk, pollFail, pollMs]);

  // The vote/pick countdowns and the elapsed timer tick inside their own leaf
  // components (see <SecondsClock>/<ElapsedClock>), so the per-second update
  // doesn't re-render this room or the drafting pool.

  // When a live game ends, refresh the server-rendered leaderboard + recent
  // games sitting below this component.
  const liveIdsKey = state
    ? [state.lobby, ...state.otherLobbies]
        .flatMap((l) => (l ? [l.id] : []))
        .join(",")
    : null;
  useEffect(() => {
    if (liveIdsKey === null) return;
    const cur = liveIdsKey ? liveIdsKey.split(",") : [];
    if (liveGameEnded(prevLiveIds.current, cur)) router.refresh();
    prevLiveIds.current = cur;
  }, [liveIdsKey, router]);

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

  // On a phone the page's title, links and the stage strip sit above the
  // room, so a member reaching a stage that needs them (accept, vote, pick,
  // get into the Dota lobby) could see the clock but not the thing to press.
  // Scroll that stage to the top once per stage; never for spectators.
  useEffect(() => {
    if (!state) return;
    const snap: InhouseFocusSnapshot = {
      lobbyId: state.lobby?.id ?? null,
      status: state.lobby?.status ?? null,
      inLobby: state.me.inLobby,
    };
    const focus = shouldFocusStage(prevFocusRef.current, snap);
    prevFocusRef.current = snap;
    if (focus) {
      stageRef.current?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    }
  }, [state]);

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
        scanOpensAt: state.lobby?.scanOpensAt ?? null,
        serverNow: state.now,
      },
    );
    document.title = flag ? `${flag} · ${original}` : original;
    return () => {
      document.title = original;
    };
  }, [state]);

  const act = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      if (connectionUnavailable) {
        pushToast(
          "info",
          connectivity === "offline"
            ? "You're offline. Reconnect before using queue or lobby actions."
            : "We're confirming the current room state before enabling actions.",
        );
        return false;
      }
      unlockAudio(); // this click is a user gesture — prime audio for later
      setPending(true);
      const { seq, next: seqNext } = issueSequence(seqRef.current);
      seqRef.current = seqNext;
      const reconcileUnknown = (message: string) => {
        pushToast("info", message);
        actionReconcileSeqRef.current = seq;
        setActionReconciling(true);
        bumpPollRef.current?.();
      };
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
          // sit disabled through its own ready check.
          signal: AbortSignal.timeout(
            (INHOUSE_SCAN_ACTIONS as readonly string[]).includes(
              String(body.action),
            )
              ? INHOUSE_SCAN_ACTION_TIMEOUT_MS
              : ROOM_ACTION_TIMEOUT_MS,
          ),
        });
        const data = (await res.json().catch(() => null)) as
          | (InhouseState & { error?: string })
          | null;
        // Toast, not an inline banner — same reasoning as the draft room:
        // pick-race rejections land while the captain is scrolled into the
        // pool, where a top-of-room banner is invisible and went stale.
        if (!res.ok) {
          if (res.status >= 500) {
            reconcileUnknown(
              "The server couldn't confirm the action — checking the current room state",
            );
            return false;
          }
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
        // like a timeout: never invite a duplicate pick, and let the next
        // authoritative state poll tell the player what happened.
        if (!data || typeof data.now !== "number") {
          reconcileUnknown(
            "The response was incomplete — checking the current room state",
          );
          return false;
        }
        apply(data, seq);
        setSelected(null);
        // A void keeps lobby=null before and after the action, so the lobby
        // transition effect cannot refresh the server-rendered ladder/results.
        if (body.action === "void") router.refresh();
        // Re-lock the poll cadence now — joining an idle page must not keep
        // idle-polling until a stale 10s timer expires.
        bumpPollRef.current?.();
        return true;
      } catch (e) {
        // A timeout is NOT a failed action: the server kept going and may well
        // have committed. Saying "that didn't go through" would send a captain
        // to re-click a pick that already landed. Nudge the poll instead — the
        // next state payload is the honest answer either way.
        reconcileUnknown(
          (e as Error)?.name === "TimeoutError"
            ? "That's taking a while — checking where things got to"
            : "We lost the response — checking the current room state",
        );
        return false;
      } finally {
        setPending(false);
      }
    },
    [apply, connectionUnavailable, connectivity, router],
  );

  // ?join=1 — the one-tap join a Discord ping links to. Waits for the first
  // state so it can refuse the cases where an auto-join would be wrong, then
  // scrubs the param so a refresh can never re-enqueue you.
  useEffect(() => {
    if (!state || autoJoinedRef.current || connectionUnavailable) return;
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
  }, [state, act, connectionUnavailable, mmr]);

  if (!state) {
    return disconnected || connectionUnavailable ? (
      <section
        role="alert"
        aria-labelledby="inhouse-load-error-title"
        className="rounded-[var(--radius)] border border-danger/40 bg-danger/10 px-5 py-6 text-center"
      >
        <h2 id="inhouse-load-error-title" className="font-semibold text-danger">
          {connectivity === "offline"
            ? "You're offline"
            : connectivity === "resyncing"
              ? "Back online — checking the room"
              : "We can't load the inhouse room"}
        </h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-muted">
          {connectivity === "offline"
            ? "Reconnect to load the current queue or lobby. Actions stay unavailable while this page has no current server state."
            : "We're reconnecting automatically. Queue and lobby actions stay unavailable until a current server state arrives."}
        </p>
        <button
          type="button"
          onClick={() => bumpPollRef.current?.()}
          disabled={connectivity === "offline"}
          title={
            connectivity === "offline"
              ? "Reconnect to the internet before retrying."
              : undefined
          }
          className={buttonClasses("secondary", "md", "mt-4")}
        >
          {connectivity === "offline"
            ? "Waiting for connection"
            : "Try again now"}
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

  // `lobby` is the viewer's own game; `otherLobbies` are the other live games,
  // which they watch read-only. Every flag in `state.me` is about `lobby`.
  const { lobby, otherLobbies } = state;
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
  // later holding a dead id. The old footer Draft button then rendered
  // ENABLED with no name, and every click was a "Player already drafted"
  // toast while their real 60s clock burned. Nobody is in two pools, so one
  // selection serves every game (an admin picking for a stalled captain).
  const selectedIn = (l: RoomLobby) =>
    selected && l.pool.some((p) => p.userId === selected) ? selected : null;
  // "Game 2" once two games are live (or for a lone game 2).
  const gameLabel = (l: RoomLobby) =>
    showGameLabel(l.slot, state.liveGames) ? inhouseGameLabel(l.slot) : null;
  // A spectator of the one live game sees it as the room's stage, exactly as
  // before two games could run; beside the viewer's own game, or beside the
  // other live game, a pinned clock bar would cover the one that matters.
  const soleWatched = !lobby && otherLobbies.length === 1;

  // One game's stage view. Its actions name the game, so a click is judged
  // against the lobby it was made on even with two live.
  const stageView = (l: RoomLobby, viewer: RoomMe, clockBar: boolean) => {
    const actOn = (body: Record<string, unknown>) =>
      act({ ...body, lobbyId: l.id });
    return l.status === "READY_CHECK" ? (
      <ReadyCheckView
        key={l.id}
        lobby={l}
        me={viewer}
        offset={offset}
        pending={pending}
        act={actOn}
        clockBar={clockBar}
      />
    ) : l.status === "CAPTAIN_VOTE" ? (
      <VoteView
        key={l.id}
        lobby={l}
        me={viewer}
        offset={offset}
        pending={pending}
        act={actOn}
        clockBar={clockBar}
      />
    ) : l.status === "DRAFTING" ? (
      <DraftView
        key={l.id}
        state={state}
        me={viewer}
        lobby={l}
        offset={offset}
        selected={selectedIn(l)}
        setSelected={setSelected}
        pending={pending}
        act={actOn}
        clockBar={clockBar}
      />
    ) : l.status === "READY" ? (
      <ReadyView
        key={l.id}
        lobby={l}
        me={viewer}
        serverNow={state.now}
        pending={pending}
        act={actOn}
      />
    ) : (
      <InProgressView
        key={l.id}
        lobby={l}
        me={viewer}
        offset={offset}
        serverNow={state.now}
        pending={pending}
        act={actOn}
      />
    );
  };

  // An admin scraps one game; its ten requeue. The confirm names the game
  // when two are live.
  const cancelButton = (l: RoomLobby) => {
    const label = gameLabel(l);
    return (
      <div className="text-right">
        <button
          disabled={pending}
          onClick={async () => {
            if (
              window.confirm(
                label
                  ? `Scrap ${label}? Its ten players go back into the queue.`
                  : "Scrap the current inhouse lobby? Everyone goes back into the queue.",
              )
            ) {
              // Only claim success once the server agrees — the cancel can
              // legitimately lose to a result landing mid-confirm.
              if (await act({ action: "cancel", lobbyId: l.id })) {
                pushToast("success", "Lobby cancelled — players re-queued");
              }
            }
          }}
          className="rounded text-xs text-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
        >
          {label ? `Admin: cancel ${label}` : "Admin: cancel this lobby"}
        </button>
      </div>
    );
  };

  // The other live games, read-only: nothing in them is the viewer's to
  // accept, vote on or draft, while an admin keeps their per-game controls.
  const otherGame = (l: RoomLobby) => {
    const viewer: RoomMe = {
      ...state.me,
      ...otherGameFlags(state.me.isAdmin, l.status),
    };
    const label = gameLabel(l);
    const body = (
      <>
        {stageView(l, viewer, soleWatched)}
        {viewer.canCancel ? cancelButton(l) : null}
      </>
    );
    // Beside the viewer's own game it folds away to one line.
    if (lobby) {
      return (
        <details
          key={l.id}
          className="rounded-[var(--radius)] border border-line bg-surface/40"
        >
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 text-sm text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
            <span className="font-medium text-fg">
              {label ?? inhouseGameLabel(l.slot)}
            </span>
            <span>is also live · {roomStageLabel(l.status)}</span>
          </summary>
          <div className="space-y-3 border-t border-line p-4">{body}</div>
        </details>
      );
    }
    return (
      <section
        key={l.id}
        aria-label={label ?? "Live game"}
        className="space-y-3"
      >
        {label ? (
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {label}
            <span className="font-mono text-[11px] font-normal text-muted">
              #{inhouseLobbyCode(l.id)}
            </span>
          </h2>
        ) : null}
        {body}
      </section>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
          <span
            aria-hidden
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              disconnected || connectionUnavailable
                ? "bg-danger"
                : "bg-success",
            )}
          />
          <span>
            {disconnected || connectionUnavailable
              ? "Reconnecting"
              : "Live room"}
          </span>
          {lobby ? (
            <span className="font-mono text-[11px]">
              #{inhouseLobbyCode(lobby.id)}
            </span>
          ) : soleWatched ? (
            <span className="font-mono text-[11px]">
              #{inhouseLobbyCode(otherLobbies[0].id)}
            </span>
          ) : null}
          {me.inLobby ? (
            <Badge tone="accent">
              {lobby && gameLabel(lobby)
                ? `Your lobby · ${gameLabel(lobby)}`
                : "Your lobby"}
            </Badge>
          ) : me.inQueue ? (
            <Badge tone="success">You’re queued</Badge>
          ) : null}
        </div>
        <button
          type="button"
          onClick={toggleSound}
          aria-pressed={soundOn}
          title={
            soundOn
              ? "Notification sound on — click to mute"
              : "Notifications muted — click to enable a bell"
          }
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface-2/40 px-3 py-1 text-xs text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <span aria-hidden>{soundOn ? "🔔" : "🔕"}</span>
          {soundOn ? "Sound on" : "Muted"}
        </button>
      </div>

      <RoomStages lobby={lobby ?? (soleWatched ? otherLobbies[0] : null)} />

      {/* ONE status line, chosen by priority — the draft room's too. */}
      <RoomStatusLine
        status={roomStatus(
          { connectivity, disconnected, actionReconciling },
          INHOUSE_ROOM_STATUS_COPY,
        )}
      />

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
                try {
                  localStorage.setItem("inhouseDismissedResult", id);
                } catch {
                  // The in-memory dismissal still holds for this page visit.
                }
              }}
              aria-label="Dismiss result banner"
              className={buttonClasses("secondary", "sm")}
            >
              Dismiss
            </button>
          </span>
        </div>
      ) : null}

      {/* A live game does not close the queue. People outside it need a clear
          next-game entry point; once queued, the full view keeps their position
          and Leave control visible for the life of the current game. */}
      {!lobby && otherLobbies.length > 0 ? (
        me.inQueue ? (
          <QueueView
            state={state}
            pending={pending}
            mmr={mmr}
            setMmr={setMmr}
            mmrHint={mmrHint}
            signupMmr={signupMmr}
            firstGame={firstGame}
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
            signupMmr={signupMmr}
            act={act}
          />
        )
      ) : null}

      {/* scroll-mt clears the 64px sticky header (see shouldFocusStage). */}
      <div ref={stageRef} className="scroll-mt-24">
        {lobby ? (
          stageView(lobby, me, true)
        ) : otherLobbies.length === 0 ? (
          <QueueView
            state={state}
            pending={pending}
            mmr={mmr}
            setMmr={setMmr}
            mmrHint={mmrHint}
            signupMmr={signupMmr}
            firstGame={firstGame}
            act={act}
          />
        ) : null}
      </div>

      {lobby && me.canCancel ? cancelButton(lobby) : null}

      {otherLobbies.map(otherGame)}

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
