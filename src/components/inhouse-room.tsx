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
  INHOUSE,
  DISCORD_INVITE_URL,
  INHOUSE_SCAN_ACTIONS,
  INHOUSE_SCAN_ACTION_TIMEOUT_MS,
  ROOM_ACTION_TIMEOUT_MS,
  ROOM_POLL_TIMEOUT_MS,
} from "@/lib/constants";
import { playChime, unlockAudio } from "@/components/chime";
import type { InhouseState } from "@/lib/inhouse-service";
import { DotaLobbyControls } from "@/components/dota-lobby-controls";

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
      }
    : {
        name: "Dire",
        badge: "danger" as const,
        ring: "border-danger/50",
        chip: "bg-danger/10 text-danger border-danger/30",
        dot: "bg-danger",
      };
}

const ROOM_STAGES = [
  { status: null, label: "Queue" },
  { status: "READY_CHECK", label: "Accept" },
  { status: "CAPTAIN_VOTE", label: "Captains" },
  { status: "DRAFTING", label: "Draft" },
  { status: "READY", label: "Set up" },
  { status: "IN_PROGRESS", label: "Play" },
] as const;

/** A shared orientation strip, with no new state machine or extra polling. */
function RoomStages({ lobby }: { lobby: InhouseState["lobby"] }) {
  const current = ROOM_STAGES.findIndex(
    (stage) => stage.status === (lobby?.status ?? null),
  );
  return (
    <ol
      aria-label="Inhouse progress"
      className="grid grid-cols-6 gap-1 sm:gap-2"
    >
      {ROOM_STAGES.map((stage, i) => (
        <li
          key={stage.label}
          aria-current={i === current ? "step" : undefined}
          className={cn(
            "min-w-0 border-t-2 pt-2.5 text-center text-[10px] font-medium sm:text-xs",
            i === current
              ? "border-accent text-accent"
              : i < current
                ? "border-success/60 text-muted"
                : "border-line text-muted",
          )}
        >
          <span className="mr-1 hidden tabular-nums sm:inline" aria-hidden>
            {i < current ? "✓" : String(i + 1).padStart(2, "0")}
          </span>
          {stage.label}
        </li>
      ))}
    </ol>
  );
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
  // fully pauses. Updated only by accepted snapshots so failed or stale
  // responses cannot forget a spot or slow an active deadline.
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
      const pre = inhousePollCadence({
        offline: browserOffline,
        hidden: document.visibilityState === "hidden",
        hasStake: hasStakeRef.current,
        lobbyStatus: latestStateRef.current?.lobby?.status ?? null,
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
      schedule(
        inhousePollCadence({
          offline: navigator.onLine === false,
          hidden: document.visibilityState === "hidden",
          // Keep the latest ACCEPTED state through a failed or stale poll.
          hasStake: hasStakeRef.current,
          lobbyStatus: latestStateRef.current?.lobby?.status ?? null,
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
          ) : null}
          {me.inLobby ? (
            <Badge tone="accent">Your lobby</Badge>
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

      <RoomStages lobby={lobby} />

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
          key={lobby.id}
          lobby={lobby}
          me={me}
          offset={offset}
          pending={pending}
          act={act}
        />
      ) : lobby.status === "CAPTAIN_VOTE" ? (
        <VoteView
          key={lobby.id}
          lobby={lobby}
          me={me}
          offset={offset}
          pending={pending}
          act={act}
        />
      ) : lobby.status === "DRAFTING" ? (
        <DraftView
          key={lobby.id}
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
          key={lobby.id}
          lobby={lobby}
          me={me}
          serverNow={state.now}
          pending={pending}
          act={act}
        />
      ) : (
        <InProgressView
          key={lobby.id}
          lobby={lobby}
          me={me}
          offset={offset}
          serverNow={state.now}
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
      {mmrHint ? (
        <details className="mt-3 text-center text-xs text-muted">
          <summary className="inline-flex min-h-8 cursor-pointer items-center rounded px-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
            How your MMR is set
          </summary>
          <p className="mt-1 text-left leading-relaxed">{mmrHint}</p>
        </details>
      ) : null}
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

  const myPosition = present.findIndex((q) => q.userId === me.userId) + 1;

  return (
    <div className="space-y-3">
      <section
        aria-label={nextGame ? "Next-game queue" : "Inhouse queue"}
        className="overflow-hidden rounded-2xl border border-accent/25 bg-surface/90 shadow-xl shadow-black/10"
      >
        <div className="grid lg:grid-cols-[0.85fr_1.35fr]">
          <div className="relative overflow-hidden border-b border-line bg-[radial-gradient(ellipse_at_top_left,color-mix(in_srgb,var(--color-accent)_12%,transparent),transparent_75%)] p-5 lg:border-b-0 lg:border-r lg:p-6">
            <div className="flex items-center gap-5 lg:flex-col lg:gap-3 lg:text-center">
              <div className="relative grid h-32 w-32 shrink-0 place-items-center lg:h-40 lg:w-40">
                <svg
                  viewBox="0 0 120 120"
                  aria-hidden
                  className="absolute inset-0 h-full w-full -rotate-90"
                >
                  <circle
                    cx="60"
                    cy="60"
                    r="51"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="5"
                    className="text-line"
                  />
                  <circle
                    cx="60"
                    cy="60"
                    r="51"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="5"
                    pathLength="100"
                    strokeDasharray={`${pct} 100`}
                    strokeLinecap={pct > 0 ? "round" : "butt"}
                    className="text-accent transition-[stroke-dasharray] duration-500 motion-reduce:transition-none"
                  />
                </svg>
                <div
                  role="progressbar"
                  aria-label={
                    nextGame
                      ? "Next-game queue progress"
                      : "Inhouse queue progress"
                  }
                  aria-valuemin={0}
                  aria-valuemax={lobbySize}
                  aria-valuenow={Math.min(present.length, lobbySize)}
                  aria-valuetext={`${present.length} players queued; ${needed} more needed`}
                  className="text-center"
                >
                  <span className="block font-display text-4xl font-bold leading-none tabular-nums lg:text-5xl">
                    {present.length}
                  </span>
                  <span className="mt-1 block text-[11px] text-muted">
                    of {lobbySize} players
                  </span>
                </div>
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
                  {nextGame ? "Up next" : "Pick-up Dota"}
                </p>
                <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight">
                  {nextGame ? "Next-game queue" : "Inhouse queue"}
                </h2>
                <p className="mt-1.5 text-sm text-muted">
                  {needed > 0
                    ? `${needed} more ${needed === 1 ? "player" : "players"} to play`
                    : nextGame
                      ? "Full · waiting for this game to finish"
                      : "Full · starting the ready check…"}
                </p>
                {queueAvg > 0 ? (
                  <p className="mt-2 text-xs tabular-nums text-muted">
                    {queueAvg.toLocaleString()} average MMR
                  </p>
                ) : null}
              </div>
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
            {me.inQueue ? (
              <p
                role="status"
                className="mt-3 text-center text-xs text-success"
              >
                {myPosition > 0
                  ? `You’re #${myPosition} in line`
                  : "Your spot is saved"}
                {nextGame ? " · next game" : " · listen for the ready check"}
              </p>
            ) : null}
          </div>

          <div className="min-w-0 p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Who’s playing</h3>
              <span className="text-xs text-muted">
                {nextGame ? (
                  "Ready check after this game"
                ) : (
                  <>First {lobbySize} in → ready check</>
                )}
              </span>
            </div>
            <ul className="grid grid-cols-2 gap-2">
              {slots.map((q, i) => {
                if (!q) {
                  return (
                    <li
                      key={`open-${i}`}
                      className="flex min-h-16 items-center gap-2 rounded-xl border border-dashed border-line/70 px-3 py-2"
                    >
                      <span
                        aria-hidden
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-dashed border-line text-sm text-muted"
                      >
                        +
                      </span>
                      <span className="min-w-0 text-xs text-muted">
                        Open slot
                        <span className="ml-1 tabular-nums">{i + 1}</span>
                      </span>
                    </li>
                  );
                }
                const isMe = q.userId === me.userId;
                return (
                  <li
                    key={q.userId}
                    className={cn(
                      "flex min-h-16 min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2 transition-colors",
                      isMe
                        ? "border-accent/50 bg-accent/10"
                        : "border-line bg-surface-2/50",
                      q.away && "opacity-60",
                    )}
                  >
                    <Avatar name={q.name} src={q.avatar} size={30} />
                    <div className="min-w-0 flex-1">
                      <PlayerLink
                        userId={q.userId}
                        className="block truncate text-xs font-semibold sm:text-sm"
                      >
                        {q.name}
                      </PlayerLink>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                        <span className="tabular-nums">#{i + 1}</span>
                        {isMe ? <span className="text-accent">You</span> : null}
                        {q.mmr > 0 ? (
                          <span className="tabular-nums">
                            {q.mmr.toLocaleString()} MMR
                          </span>
                        ) : null}
                        {q.away ? (
                          <span title="This player will rejoin lobby formation when they return">
                            away
                          </span>
                        ) : null}
                      </span>
                    </div>
                    <span className="hidden xl:block">
                      <RankBadge rankTier={q.rankTier} />
                    </span>
                  </li>
                );
              })}
            </ul>
            {overflow.length > 0 ? (
              <div className="mt-3 border-t border-line/60 pt-3">
                <div className="mb-2 text-xs text-muted">
                  Also queued · {overflow.length}
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
                      <PlayerLink
                        userId={q.userId}
                        className="max-w-32 truncate"
                      >
                        {q.name}
                      </PlayerLink>
                      {q.away ? <span className="text-muted">away</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      </section>
      <p className="px-1 text-center text-xs text-muted">
        Tab switching keeps your spot · queue clears after{" "}
        {INHOUSE.QUEUE_IDLE_HOURS}h without lobby activity
      </p>
      <details className="group rounded-xl border border-line bg-surface/60">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [&::-webkit-details-marker]:hidden">
          <span>
            New to inhouse?{" "}
            <span className="font-medium text-fg">The game plan</span>
          </span>
          <span
            aria-hidden
            className="transition-transform group-open:rotate-180"
          >
            ⌄
          </span>
        </summary>
        <ol className="grid gap-4 border-t border-line p-4 text-xs text-muted sm:grid-cols-2 lg:grid-cols-4">
          <li>
            <strong className="mb-1 block text-fg">01 · Queue & accept</strong>
            {lobbySize} players fill the room. Accept within{" "}
            {INHOUSE.ACCEPT_SECONDS}s or lose your spot.
          </li>
          <li>
            <strong className="mb-1 block text-fg">02 · Choose captains</strong>
            Elect players, use highest MMR, or pick by inhouse record.
          </li>
          <li>
            <strong className="mb-1 block text-fg">03 · Draft your side</strong>
            Captains pick Radiant and Dire in a snake draft: one pick, then
            pairs.
          </li>
          <li>
            <strong className="mb-1 block text-fg">04 · Play & climb</strong>
            Host the Dota lobby, join your team in Discord, and let results
            update your Elo.
          </li>
        </ol>
      </details>
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
        className="rounded-2xl border border-accent/40 bg-gradient-to-br from-accent/15 via-surface to-surface px-5 py-5 sm:p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
              Ready check
            </p>
            <h2 className="font-display text-2xl font-semibold">
              {me.canAccept ? "Match found. You in?" : "A match is filling up"}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {check.acceptedCount}/{check.total} accepted
              {waitingOn > 0
                ? ` · waiting on ${waitingOn}`
                : " · everyone’s ready"}
            </p>
            <p className="mt-1 text-xs text-muted">
              {me.canAccept
                ? me.hasAccepted
                  ? "Your spot is confirmed."
                  : "Accept before the timer ends to keep your spot."
                : me.inQueue
                  ? "You’re in line for the next game."
                  : "Spectating · join the next-game queue above."}
            </p>
          </div>
          <SecondsClock
            prominent
            endsAtMs={lobby.acceptEndsAt}
            offsetMs={offset}
            urgentAt={10}
            label={(s) => `${s} seconds left to accept`}
          />
        </div>

        <div aria-hidden className="mt-4 flex gap-1.5">
          {Array.from({ length: check.total }, (_, i) => (
            <span
              key={i}
              className={cn(
                "h-2 flex-1 rounded-full transition-colors",
                i < check.acceptedCount ? "bg-success" : "bg-line",
              )}
            />
          ))}
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
                className={cn(
                  buttonClasses("accent", "lg"),
                  "min-h-14 w-full font-bold sm:w-auto sm:px-12",
                )}
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
      <ul className="grid grid-cols-2 gap-2">
        {check.players.map((p) => (
          <li
            key={p.userId}
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-3",
              p.accepted
                ? "border-success/40 bg-success/5"
                : "border-line bg-surface-2/40",
            )}
          >
            <Avatar name={p.name} src={p.avatar} size={28} />
            <span className="min-w-0 flex-1 truncate text-xs font-medium sm:text-sm">
              {p.name}
            </span>
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
  serverNow,
  pending,
  act,
}: {
  lobby: NonNullable<InhouseState["lobby"]>;
  me: InhouseState["me"];
  /** The server clock from the last poll (see scanNote). */
  serverNow: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-6 py-5 text-center">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
          Draft complete
        </p>
        <h2 className="mt-1 font-display text-3xl font-semibold">
          Teams are set!
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          Join the Dota lobby and your team’s voice channel, then play. The
          result records itself from OpenDota after the game — nobody has to
          press anything.
        </p>
        {me.canStart ? (
          <div className="mt-4">
            {/* Optional since results record from here too: it only starts
                the game clock for the room and the Discord board. No confirm
                — an early tap costs nothing. */}
            <button
              disabled={pending}
              onClick={() => act({ action: "start" })}
              className={buttonClasses("secondary", "md")}
            >
              Start the game clock
            </button>
            <p className="mx-auto mt-2 max-w-sm text-xs text-muted">
              Optional: shows the game as live here and on Discord.
            </p>
          </div>
        ) : null}
        {me.canRecord ? (
          <ResultControls
            folded
            scanNote={scanNote(lobby.scanOpensAt, serverNow)}
            pending={pending}
            act={act}
          />
        ) : null}
      </div>

      {me.inLobby || me.isAdmin ? <GameSetupCard lobby={lobby} me={me} /> : null}

      <MatchupGrid lobby={lobby} />
    </div>
  );
}

/**
 * The automatic scan's status line, from the server's own scan window
 * (`lobby.scanOpensAt`, the same clock maybeAutoDetectResult waits on) and the
 * server clock of the last poll. Poll-driven, not ticking: calling Date.now()
 * during render makes the render non-idempotent (React may run it twice and
 * keep either result). It only lags by one poll.
 */
function scanNote(scanOpensAt: number | null, serverNow: number) {
  if (scanOpensAt == null || serverNow >= scanOpensAt) {
    return {
      live: true,
      text: "Auto-scan is running · results appear after the game ends.",
    };
  }
  const minutes = Math.max(1, Math.ceil((scanOpensAt - serverNow) / 60_000));
  return { live: false, text: `Auto-scan starts in ${minutes} min.` };
}

/**
 * The manual result paths: "Auto-detect result" (scan the ten players' recent
 * games now) and "Record by match ID". The automatic scan normally records the
 * game with nobody pressing anything — these cover a game it can't see yet.
 * Shared by the Set up and Play screens, because a lobby is being played from
 * the moment teams lock whether or not anyone pressed Start. `folded` (Set up)
 * keeps both behind one disclosure so they don't compete with getting into the
 * Dota lobby.
 */
function ResultControls({
  folded = false,
  scanNote: note,
  pending,
  act,
}: {
  folded?: boolean;
  scanNote: { live: boolean; text: string };
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  const [matchId, setMatchId] = useState("");
  const detect = (
    <div>
      <button
        disabled={pending}
        onClick={() => act({ action: "detect" })}
        className={buttonClasses(folded ? "secondary" : "accent", "md")}
      >
        {pending ? "Fetching from OpenDota…" : "Auto-detect result"}
      </button>
      <p className="mx-auto mt-2 max-w-sm text-xs text-muted">{note.text}</p>
    </div>
  );
  const form = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && matchId.trim())
          void act({ action: "record", matchId: matchId.trim() });
      }}
      className="mt-2 flex flex-wrap items-end justify-center gap-2"
    >
      <div className="min-w-0 flex-1">
        <label
          htmlFor="inhouse-match-id"
          className="mb-1 block text-xs text-muted"
        >
          Dota match ID
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
          className="h-11 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
        />
      </div>
      <button
        type="submit"
        disabled={pending || !matchId.trim()}
        className={buttonClasses("secondary", "md", "min-h-11")}
      >
        Record
      </button>
    </form>
  );
  const summaryClass =
    "cursor-pointer rounded py-2 text-center text-xs text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

  if (folded) {
    return (
      <details className="mx-auto mt-4 max-w-lg border-t border-accent/20 pt-2 text-left">
        <summary className={summaryClass}>
          Game over and no result yet? Record it
        </summary>
        <div className="mt-2 space-y-3 text-center">
          {detect}
          {form}
        </div>
      </details>
    );
  }
  return (
    <div className="mt-4 space-y-3">
      {detect}
      <details className="mx-auto max-w-lg border-t border-info/20 pt-2 text-left">
        <summary className={summaryClass}>
          Have a match ID? Record it manually
        </summary>
        {form}
      </details>
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
  prominent = false,
}: {
  endsAtMs: number | null;
  offsetMs: number;
  urgentAt: number;
  label: (seconds: number) => string;
  prominent?: boolean;
}) {
  const seconds = useSecondsLeft(endsAtMs, offsetMs);
  return (
    <div
      role="timer"
      aria-label={label(seconds)}
      className={cn(
        "shrink-0 font-mono font-bold tabular-nums",
        prominent
          ? "rounded-xl border border-current/20 bg-bg/40 px-4 py-3 text-3xl sm:text-4xl"
          : "text-xl",
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
  pending,
  act,
}: {
  lobby: NonNullable<InhouseState["lobby"]>;
  me: InhouseState["me"];
  offset: number;
  /** The server clock from the last poll (see scanNote). */
  serverNow: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  // Poll-driven (not ticking) — only gates the "auto-scan is live" note, which
  // flips once, minutes in; the visible timer ticks in <ElapsedClock>.
  const note = scanNote(lobby.scanOpensAt, serverNow);

  return (
    <div className="space-y-5">
      <div className="rounded-[var(--radius)] border border-info/40 bg-info/10 px-6 py-5 text-center">
        <h2 className="flex flex-wrap items-center justify-center gap-3 font-display text-2xl font-semibold sm:text-3xl">
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
          <ResultControls scanNote={note} pending={pending} act={act} />
        ) : (
          <p className="mt-3 text-sm text-muted">
            {note.live
              ? "The result is pulled from OpenDota automatically once the game ends."
              : `The result is pulled from OpenDota automatically. ${note.text}`}
          </p>
        )}
      </div>

      {me.inLobby || me.isAdmin ? <GameSetupCard lobby={lobby} me={me} /> : null}

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
      className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface-2/60 px-3 py-2 font-mono text-sm font-semibold text-fg transition-colors hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      {value}
      <span aria-hidden className="text-xs text-muted">
        📋
      </span>
    </button>
  );
}

/**
 * What the ten players do once teams lock: one hosts the Dota 2 lobby with the
 * fixed shared credentials, selects the required league ticket, and everyone
 * joins their team's Discord voice channel. The ticket makes the private game
 * available to OpenDota. When the bot hosted, the result is looked up by the
 * match id the bot saw; otherwise the scan searches the players' histories.
 */
function GameSetupCard({
  lobby,
  me,
}: {
  lobby: NonNullable<InhouseState["lobby"]>;
  me: InhouseState["me"];
}) {
  const voiceByTeam = (team: number) =>
    team === 1 ? INHOUSE.VOICE_TEAM_1 : INHOUSE.VOICE_TEAM_2;

  return (
    <section
      aria-label="Game setup"
      className="overflow-hidden rounded-2xl border border-line bg-surface/90"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-4">
        <h3 className="text-sm font-semibold">How to play this game</h3>
        {DISCORD_INVITE_URL ? (
          <a
            href={DISCORD_INVITE_URL}
            target="_blank"
            rel="noreferrer"
            className={textLink("inline-flex min-h-8 items-center text-xs")}
          >
            League Discord ↗
          </a>
        ) : null}
      </div>
      <div className="p-5">
        <DotaLobbyControls key={lobby.id} kind="inhouse" id={lobby.id} />
      </div>
      <p className="px-5 text-xs text-muted">
        Manual setup below is available if you are hosting without the bot.
        For a bot lobby, use the name and password above.
      </p>
      <div className="grid gap-0 lg:grid-cols-3">
        <div className="min-w-0 border-b border-line p-5 lg:border-b-0 lg:border-r">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-accent">
            01 · Dota lobby
          </p>
          <h4 className="text-sm font-semibold">Create or join</h4>
          <p className="mt-1 text-xs text-muted">
            Dota 2 → Play → Custom Lobbies
          </p>
          <dl className="mt-4 space-y-3">
            <div>
              <dt className="mb-1 text-[11px] text-muted">Lobby name</dt>
              <dd>
                <CopyChip value={INHOUSE.LOBBY_NAME} label="lobby name" />
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-[11px] text-muted">Password</dt>
              <dd>
                <CopyChip value={INHOUSE.LOBBY_PASSWORD} label="password" />
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-muted">
            Any player can host. Everyone else joins the lobby or asks the host
            for an invite.
          </p>
        </div>
        <div className="min-w-0 border-b border-line bg-accent/5 p-5 lg:border-b-0 lg:border-r">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-accent">
            02 · Match tracking
          </p>
          <h4 className="text-sm font-semibold">Set the league ticket</h4>
          <p className="mt-1 text-xs text-muted">
            Host → Lobby Settings → League
          </p>
          <div className="mt-4">
            {INHOUSE.LOBBY_TICKET_CONFIGURED ? (
              <CopyChip value={INHOUSE.LOBBY_TICKET} label="league ticket" />
            ) : (
              <p className="text-xs text-muted">{INHOUSE.LOBBY_TICKET}</p>
            )}
          </div>
          <p className="mt-3 text-xs text-muted">
            {INHOUSE.LOBBY_TICKET_CONFIGURED
              ? "Required: without this ticket, the game will not appear on OpenDota and cannot be recorded on the site."
              : "The league administrators will provide the European ticket before tracked inhouse games begin."}
          </p>
          <a
            href="#opendota-setup"
            className={textLink(
              "mt-3 inline-flex min-h-8 items-center text-xs",
            )}
          >
            Check your match-data setup ↓
          </a>
        </div>
        <div className="min-w-0 p-5">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-accent">
            03 · Team voice
          </p>
          <h4 className="text-sm font-semibold">Meet in Discord</h4>
          <p className="mt-1 text-xs text-muted">
            Join your side’s voice channel.
          </p>
          <ul className="mt-4 space-y-2">
            {lobby.teams.map((t) => {
              const meta = sideMeta(t.isRadiant);
              const mine = me.myTeam === t.team;
              return (
                <li
                  key={t.team}
                  className={cn(
                    "rounded-xl border px-3 py-2.5",
                    mine ? meta.chip : "border-line bg-surface-2/40",
                  )}
                >
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                    <span
                      className={cn(
                        "font-semibold",
                        t.isRadiant ? "text-success" : "text-danger",
                      )}
                    >
                      {meta.name}
                    </span>
                    {mine ? (
                      <span className="font-medium">Your team</span>
                    ) : null}
                  </div>
                  <span className="block break-words text-sm text-fg">
                    {voiceByTeam(t.team)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
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
