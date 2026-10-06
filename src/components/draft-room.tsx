"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  Avatar,
  Badge,
  HeroList,
  PlayerLink,
  RankBadge,
  RoleBadges,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { aboutText } from "@/lib/about-you";
import { pushToast } from "@/components/toaster";
import { Countdown } from "@/components/countdown";
import { DiscordTag } from "@/components/discord-tag";
import {
  armAudioUnlock,
  audioReady,
  playChime,
  subscribeAudioReady,
  unlockAudio,
} from "@/components/chime";
import {
  useBannerOffscreen,
  usePersistedFlag,
  usePollHealth,
  useSecondsLeft,
} from "@/components/room-clock";
import { DOTA_ROLES } from "@/lib/roles";
import {
  adminNominationTeam,
  nominationOrderLabel,
  bidAllowanceLine,
  captainStatusLine,
  draftAlertsReachViewer,
  draftTitleFlag,
  draftViewerStake,
  keepsLinedUpPick,
  lineUpHint,
  lotHeadingLead,
  lotWatcherLine,
  maxBid,
  nominationTurnTeamId,
  nominationWaitLine,
  openSeatsLabel,
  outbidLatchAfter,
  outbidLine,
  rosterDisplayOrder,
  stripDraftTitleFlag,
  uncoveredRoles,
  upcomingNominatorTeamId,
  upNextLine,
} from "@/lib/draft";
import { DRAFT_PASSED_LABEL } from "@/lib/season-copy";
import {
  DRAFT_PRESENCE,
  captainPresence,
  captainPresenceLine,
  missingCaptainsConfirmLine,
} from "@/lib/draft-presence";
import {
  draftToolbarControls,
  hasToolbarControl,
  undoSaleConfirm,
  voidLotConfirm,
} from "@/lib/draft-admin";
import {
  FEED_MAX,
  draftFeedInvalidated,
  draftFeedDiff,
  seedDraftFeed,
  type FeedLine,
} from "@/lib/draft-feed";
import { draftPollCadence } from "@/lib/room-poll";
import { DRAFT_ROOM_STATUS_COPY, roomStatus } from "@/lib/room-status";
import { RoomStatusLine } from "@/components/room-status-line";
import { nextClockOffset } from "@/lib/countdown";
import {
  ROOM_SEQUENCE_START,
  acceptSequence,
  isColdStart,
  issueSequence,
} from "@/lib/room-sequence";
import {
  DEFAULTS,
  ROOM_ACTION_TIMEOUT_MS,
  ROOM_POLL_TIMEOUT_MS,
} from "@/lib/constants";
import { filterAndSortPlayers, type PoolSort } from "@/lib/player-pool";
import type { DraftState } from "@/lib/draft-service";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { DraftRecapCard } from "@/components/draft-recap-card";
import { StartDraftConfirmLine } from "@/components/start-draft-submit";
import type { ActionResult } from "@/lib/action-result";

// A single line in "Recent sales": the tested content (see @/lib/draft-feed)
// plus the React key this component hands out.
type FeedEvent = FeedLine & { id: number };

// --- Countdown leaves -------------------------------------------------------
// These own the 250ms tick via useSecondsLeft, so only the clock text
// re-renders each second — the room + player pool no longer do. Markup matches
// the originals exactly.

// Compact clock for the sticky bar that pins under the header.
function CompactClock({
  endsAtMs,
  offsetMs,
  urgentAt,
  calmTone,
}: {
  endsAtMs: number | null;
  offsetMs: number;
  urgentAt: number;
  calmTone: string;
}) {
  const seconds = useSecondsLeft(endsAtMs, offsetMs);
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-lg font-bold tabular-nums",
        seconds <= urgentAt ? "text-danger" : calmTone,
      )}
    >
      {seconds}s
    </span>
  );
}

// The big bid clock in the "on the block" banner (ping dot under 5s). The
// small lead-in says WHICH clock this is: the header beside it names the team
// that nominated, and a bare "27s" there read as that team's turn.
function BidClock({
  endsAtMs,
  offsetMs,
}: {
  endsAtMs: number | null;
  offsetMs: number;
}) {
  const seconds = useSecondsLeft(endsAtMs, offsetMs);
  return (
    <div
      role="timer"
      aria-label={`${seconds} seconds left on the bid clock`}
      className={cn(
        "flex items-center gap-2 font-mono text-2xl font-bold tabular-nums",
        seconds <= 5 ? "text-danger" : "text-accent",
      )}
    >
      <span className="font-sans text-xs font-normal text-muted">
        <span className="hidden sm:inline">Bidding </span>closes in
      </span>
      {seconds <= 5 ? (
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
        </span>
      ) : null}
      <span className={seconds <= 5 ? "animate-countdown-urgent" : ""}>
        {seconds}s
      </span>
    </div>
  );
}

// The big nomination clock in the banner (auto-skip warning under 10s).
function NomClock({
  endsAtMs,
  offsetMs,
}: {
  endsAtMs: number | null;
  offsetMs: number;
}) {
  const seconds = useSecondsLeft(endsAtMs, offsetMs);
  return (
    <div
      role="timer"
      aria-label={`${seconds} seconds left to nominate`}
      className={cn(
        "flex items-center gap-2 font-mono text-2xl font-bold tabular-nums",
        seconds <= 10 ? "text-danger" : "text-muted",
      )}
    >
      <span className={seconds <= 10 ? "animate-countdown-urgent" : ""}>
        {seconds}s
      </span>
    </div>
  );
}

/**
 * Reconciles a client clock reaching zero with the server authority. Keeping
 * this as a leaf preserves the room's render isolation while immediately
 * disabling time-sensitive controls at the boundary the viewer can see.
 */
function ClockExpiryObserver({
  endsAtMs,
  offsetMs,
  onExpire,
}: {
  endsAtMs: number | null;
  offsetMs: number;
  onExpire: () => void;
}) {
  const seconds = useSecondsLeft(endsAtMs, offsetMs);
  useEffect(() => {
    if (endsAtMs && seconds <= 0) onExpire();
  }, [endsAtMs, onExpire, seconds]);
  return null;
}

// The typed-amount box, with Max as a quiet link inside it. It starts EMPTY
// (hinted with the cap) rather than pre-filled: the +$1 button already offers
// the next price, and a pre-filled box had to be reset on every rival bid,
// wiping whatever a captain was halfway through typing.
function ExactBidControl({
  currentBid,
  maxBid,
  pending,
  submit,
  onMax,
}: {
  currentBid: number;
  maxBid: number;
  pending: boolean;
  submit: (amount: number) => void;
  onMax: () => void;
}) {
  const [raw, setRaw] = useState("");
  const amount = raw.trim() === "" ? null : Number(raw);
  const valid =
    amount !== null &&
    Number.isSafeInteger(amount) &&
    amount > currentBid &&
    amount <= maxBid;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !pending) submit(amount);
      }}
      className="flex w-full min-w-0 items-center gap-2 sm:w-auto"
    >
      <input
        type="number"
        inputMode="numeric"
        min={currentBid + 1}
        max={maxBid}
        value={raw}
        placeholder={`up to $${maxBid}`}
        onChange={(event) => setRaw(event.target.value)}
        className="h-10 min-w-0 flex-1 rounded-md border border-line bg-surface-2/50 px-2 text-center text-sm sm:h-8 sm:w-28 sm:flex-none"
        aria-label="Exact bid amount"
      />
      <button
        type="submit"
        disabled={pending || !valid}
        className={buttonClasses("accent", "sm", "shrink-0")}
      >
        {amount !== null && Number.isFinite(amount) ? `Bid $${amount}` : "Bid"}
      </button>
      {/* Spends the whole cap, so it is the QUIETEST control here, and it
          still asks first. */}
      <button
        type="button"
        disabled={pending || maxBid <= currentBid}
        onClick={onMax}
        className="inline-flex h-10 shrink-0 items-center rounded px-1 text-xs text-muted underline decoration-line underline-offset-4 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50 sm:h-8"
      >
        Max ${maxBid}
      </button>
    </form>
  );
}

export function DraftRoom({
  pollMs = 1200,
  seasonId,
  pauseAction,
  resumeAction,
  undoAction,
  voidLotAction,
  adminStart,
  adminFinish,
}: {
  pollMs?: number;
  seasonId: string;
  pauseAction: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  resumeAction: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  undoAction: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  voidLotAction: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  /**
   * Admins only, while draft setup is open: the Start draft button from
   * /admin (same form, same startDraft action, same confirm), rendered by the
   * page, plus why Start is unavailable when it is.
   */
  adminStart?: { control: ReactNode; blocker: string | null };
  /**
   * Admins only, in the Draft phase: the finished auction's next step, titled
   * as /admin's banner titles it, with its control (the Regular season phase
   * button from /admin, same action and confirm, or the way to the schedule
   * when there are no fixtures yet).
   */
  adminFinish?: { title: string; detail: string; control: ReactNode };
}) {
  const [state, setState] = useState<DraftState | null>(null);
  const { disconnected, ok: pollOk, fail: pollFail } = usePollHealth();
  const [connectivity, setConnectivity] = useState<
    "online" | "offline" | "resyncing"
  >("online");
  const connectionUnavailable = connectivity !== "online";
  // While there's no active season the tick 404s forever — terminal state.
  const [noSeason, setNoSeason] = useState(false);
  const [seasonChanged, setSeasonChanged] = useState(false);
  const [syncDelayed, setSyncDelayed] = useState(false);
  const [initialError, setInitialError] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [settlingClockKey, setSettlingClockKey] = useState<string | null>(null);
  const currentClockKey = `${state?.status ?? "loading"}:${
    state?.nominatedPlayer?.userId ?? "no-lot"
  }:${state?.bidEndsAt ?? "no-bid-clock"}:${
    state?.nominationEndsAt ?? "no-nomination-clock"
  }`;
  const clockSettling = settlingClockKey === currentClockKey;
  const [pollKick, setPollKick] = useState(0);
  const [reqPending, setPending] = useState(false);
  const [actionReconciling, setActionReconciling] = useState(false);
  // Disconnected = every action disabled: a bid against stale state would
  // either fail or, worse, look accepted while the real auction moved on.
  const pending =
    reqPending ||
    actionReconciling ||
    disconnected ||
    connectionUnavailable ||
    clockSettling;
  const [soundOn, setSoundOn] = usePersistedFlag("draftSound");
  // Latched while the viewer's team has lost the high bid on the live
  // nomination — cleared by the poll once it's stale (re-took the bid, the
  // player sold, or bidding closed). A plain flag: the card's price block
  // already names the current leader live, and a remembered "Team B bid $5"
  // went stale the moment a third captain bid.
  const [outbid, setOutbid] = useState(false);
  // Clock skew as STATE, not a ref read during render. Reading `ref.current`
  // while rendering is unsafe under concurrent React (the value can differ
  // between a render React keeps and one it throws away) and the lint rules
  // flag it. Storing it only when it MOVES keeps the original reason it was a
  // ref: `s.now - Date.now()` jitters by a few ms on every poll, and
  // re-rendering the room + player pool for that would undo the leaf-clock
  // optimisation. A whole second of drift is the smallest change any countdown
  // can show.
  const [offsetMsState, setOffsetMs] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  // The pool's position filter lives here, not in <AvailableList>, so the
  // captain's "roles to cover" chips at the top of the room can set it.
  const [poolRole, setPoolRole] = useState<string | null>(null);
  const [nomAmount, setNomAmount] = useState(1);
  // Recent sales + "SOLD!" flash — derived client-side by diffing successive
  // polled states, so no changes to the server-authoritative draft engine.
  const prevRef = useRef<DraftState | null>(null);
  const eventIdRef = useRef(0);
  const [sales, setSales] = useState<FeedEvent[]>([]);
  // The newest nomination or bid, read out to screen readers only. The lot
  // card shows both already; the old feed repeated them on screen, and was
  // also the only place a bid was ever announced.
  const [lotNews, setLotNews] = useState("");
  const [soldFlash, setSoldFlash] = useState<{
    name: string;
    team: string;
    price: number;
    /** The viewer themself was just sold — their personal draft moment. */
    isMe: boolean;
  } | null>(null);

  // Spectators and players-on-the-block never call act(), so without this
  // their first chime (you're nominated / you're drafted) would be blocked by
  // the browser's autoplay policy — any first click/tap on the page unlocks.
  useEffect(() => {
    // Keeps listening until audio actually runs (armAudioUnlock): a one-time
    // pointerdown never unlocked on phones.
    return armAudioUnlock();
  }, []);

  // Whether the browser lets the bell ring yet. Until a gesture unlocks it,
  // "Sound on" was a promise the room couldn't keep, and tapping it muted.
  const audioOn = useSyncExternalStore(subscribeAudioReady, audioReady, () => false);
  const toggleSound = useCallback(() => {
    // Locked audio with the bell on: this tap turns it on, not off.
    const next = soundOn && !audioReady() ? true : !soundOn;
    setSoundOn(next);
    if (next) playChime(); // confirm + unlock audio on this gesture
  }, [soundOn, setSoundOn]);

  // Order poll and action responses by request START: a slow tick that left
  // before my bid must not overwrite the bid's fresher state when it finally
  // lands (the flash of stale auction mid-bid confused captains).
  const seqRef = useRef(ROOM_SEQUENCE_START);
  // Unknown action outcomes stay locked until a poll that STARTED after the
  // action successfully applies. A pre-action request cannot prove whether the
  // mutation committed, even if its response arrives later.
  const actionReconcileSeqRef = useRef<number | null>(null);
  // Network transitions invalidate every poll that started before them. An
  // old request can survive an offline/online round-trip at the transport
  // layer; it must never be the payload that re-enables live actions.
  const connectivityEpochRef = useRef(0);
  const hadIdentityRef = useRef(false);

  const apply = useCallback((s: DraftState, seq: number) => {
    const { accept, next } = acceptSequence(seqRef.current, seq);
    seqRef.current = next;
    if (!accept) return false; // lost the response race — stale
    if (s.me.userId) {
      hadIdentityRef.current = true;
      setSessionExpired(false);
    } else if (hadIdentityRef.current) {
      setSessionExpired(true);
    }
    setOffsetMs((prev) => nextClockOffset(prev, s.now, Date.now()));
    setState(s);
    return true;
  }, []);

  // Seed the feed from the first state DURING RENDER rather than in the diff
  // effect: setState inside an effect cascades a render, and the feed would
  // otherwise paint empty for one frame on every page load mid-draft.
  const [seeded, setSeeded] = useState(false);
  if (state && !seeded) {
    setSeeded(true);
    // NEGATIVE ids, descending: the live counter above counts up from 0, so
    // the two ranges can never collide and break a React key mid-draft.
    const seed = seedDraftFeed(state).map((line, i) => ({
      ...line,
      id: -1 - i,
    }));
    if (seed.length) setSales(seed);
  }

  // Does this viewer need alerts even with the tab hidden? Captains and admins
  // act; a player still in the pool can be nominated at any moment and wants
  // the chime. A drafted player or a logged-out spectator is just watching.
  const hasStakeRef = useRef(false);
  // Captains and admins act on a live lot and keep the fast poll; everyone
  // else watches at the slower rate (draftPollCadence). True until the first
  // payload says otherwise, so nobody starts slow.
  const canActRef = useRef(true);
  // In an effect, not during render — writing a ref while rendering is exactly
  // what <InhouseRoom> avoids, and React's lint rules flag it.
  useEffect(() => {
    hasStakeRef.current = !!state && draftViewerStake(state);
    if (state) canActRef.current = state.me.isAdmin || !!state.me.myTeamId;
  }, [state]);

  // Self-scheduling poll (not setInterval): the cadence has to react to the
  // draft's phase and the tab's visibility, and a fixed interval also stacks
  // requests when one is slow. Mirrors <InhouseRoom>'s loop.
  useEffect(() => {
    let alive = true;
    let inFlight = false;
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
      // Hidden with nothing at stake: don't fetch at all. The visibility
      // listener wakes us the instant it's refocused. Rules + reasoning in
      // draftPollCadence, where they're unit-tested.
      const browserOffline = navigator.onLine === false;
      if (browserOffline) setConnectivity("offline");
      const pre = draftPollCadence({
        offline: browserOffline,
        hidden: document.visibilityState === "hidden",
        hasStake: hasStakeRef.current,
        canAct: canActRef.current,
        live: false, // irrelevant to the skip decision
        coldStart: isColdStart(seqRef.current),
        activeMs: pollMs,
      });
      if (pre.skip) {
        schedule(pre.delayMs);
        return;
      }
      inFlight = true;
      // Minted HERE, before the await — ordering is by request START (see
      // room-sequence.ts).
      const { seq, next: seqNext } = issueSequence(seqRef.current);
      seqRef.current = seqNext;
      const pollConnectivityEpoch = connectivityEpochRef.current;
      let live = false;
      let reached = false;
      let rateLimited = false;
      let supersededByConnectivityChange = false;
      try {
        const res = await fetch("/api/draft/tick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seasonId }),
          // See ROOM_POLL_TIMEOUT_MS: without a deadline a request that never
          // answers freezes this loop for good, with `disconnected` false and
          // every bid control still live on stale state.
          signal: AbortSignal.timeout(ROOM_POLL_TIMEOUT_MS),
        });
        if (pollConnectivityEpoch !== connectivityEpochRef.current) {
          supersededByConnectivityChange = true;
        } else if (res.ok) {
          const next = (await res.json()) as DraftState;
          if (pollConnectivityEpoch !== connectivityEpochRef.current) {
            supersededByConnectivityChange = true;
          } else if (next.seasonId !== seasonId) {
            setSeasonChanged(true);
            return;
          } else {
            const applied = apply(next, seq);
            const actionSeq = actionReconcileSeqRef.current;
            if (applied && actionSeq !== null && seq > actionSeq) {
              actionReconcileSeqRef.current = null;
              setActionReconciling(false);
            }
            consecutiveFailures = 0;
            pollOk();
            setConnectivity(navigator.onLine === false ? "offline" : "online");
            setInitialError(false);
            setSyncDelayed(false);
            reached = true;
            live = next.status === "IN_PROGRESS" || next.status === "PAUSED";
          }
        } else if (res.status === 404) {
          setNoSeason(true); // season deactivated under us — stop pretending
          return;
        } else if (res.status === 429) {
          // Deliberately NOT a poll failure. Tripping `disconnected` here would
          // disable every bid control over a rate limit — the exact moment a
          // captain most needs to act — and /api/draft/bid isn't rate limited,
          // so their bid would still land. Just ease off and keep the room live.
          rateLimited = true;
          setSyncDelayed(true);
        } else if (res.status === 409) {
          setSeasonChanged(true);
          return;
        } else {
          setInitialError(true);
          markFailure();
        }
      } catch {
        if (pollConnectivityEpoch !== connectivityEpochRef.current) {
          supersededByConnectivityChange = true;
        } else {
          setInitialError(true);
          markFailure(); // network blip; next poll retries
        }
      } finally {
        inFlight = false;
      }
      if (supersededByConnectivityChange) {
        setConnectivity(navigator.onLine === false ? "offline" : "resyncing");
        schedule(0);
        return;
      }
      // Recompute visibility HERE, not from a pre-fetch snapshot: a tab
      // refocused mid-request reschedules at the active rate straight away.
      schedule(
        draftPollCadence({
          offline: navigator.onLine === false,
          hidden: document.visibilityState === "hidden",
          hasStake: hasStakeRef.current,
          canAct: canActRef.current,
          live,
          reached,
          rateLimited,
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
      // Keep actions disabled until a fresh authoritative payload arrives.
      // Merely regaining a network interface does not make the old lot safe.
      connectivityEpochRef.current += 1;
      setConnectivity("resyncing");
      tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    tick();

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      if (timer) clearTimeout(timer);
    };
  }, [apply, pollKick, pollOk, pollFail, pollMs, seasonId]);

  // Diff each new state against the previous one to build the live feed +
  // trigger the SOLD! flash. Read-only — never mutates draft state. What the
  // diff CONTAINS is decided by the tested `draftFeedDiff`; what stays here is
  // React: the accumulated list, the ids, and the side effects.
  useEffect(() => {
    if (!state) return;
    const prev = prevRef.current;
    prevRef.current = state;
    // The first state seeds the feed during RENDER (see `seeded` below); here
    // we only take the bookkeeping snapshot so the next poll can diff.
    if (!prev) return;

    // Undo removes an authoritative roster sale and Abort returns the entire
    // run to NOT_STARTED. An append-only client log cannot represent either;
    // rebuild it from the new snapshot so a voided sale is never presented as
    // live history.
    if (draftFeedInvalidated(prev, state)) {
      eventIdRef.current = 0;
      setSales(
        seedDraftFeed(state).map((line, index) => ({
          ...line,
          id: -1 - index,
        })),
      );
      setLotNews("");
      setSoldFlash(null);
      setOutbid(false);
      return;
    }

    const { lines, sale, alerts, notice } = draftFeedDiff(prev, state);
    if (sale) setSoldFlash(sale);
    // "The clock picked for you" — news only to the captain it happened to.
    if (notice) pushToast("info", notice);

    // The feed is an append-only LOG of state transitions; it cannot be
    // derived from the current state alone, which is what a pure alternative
    // would require, and setting it here rather than deferring is deliberate:
    // the sale line and the SOLD! flash must land in the same commit, and this
    // is draft night's marquee moment. Ids are assigned HERE and counted up
    // from 0, staying clear of the negative ids the seed uses — a collision
    // would break React keys mid-draft.
    //
    // Only SALES are listed; the lot card already shows the live nomination
    // and its bid trail. The newest lot line (lines are newest first) goes to
    // the screen-reader announcement instead.
    const fresh = lines
      .filter((line) => line.kind === "sold")
      .map((line) => ({ ...line, id: eventIdRef.current++ }));
    if (fresh.length) setSales((e) => [...fresh, ...e].slice(0, FEED_MAX));
    const lotLine = lines.find((line) => line.kind !== "sold");
    if (lotLine) setLotNews(`${lotLine.text}, $${lotLine.amount}`);

    // Outbid latch — set / clear / leave alone, decided by the tested
    // outbidLatchAfter (which deliberately has no budget input: a priced-out
    // captain is exactly who most needs to see they lost the player).
    const latch = outbidLatchAfter({
      myTeamId: state.me.myTeamId,
      prevBidTeamId: prev.currentBidTeamId,
      curBidTeamId: state.currentBidTeamId,
      prevNominatedId: prev.nominatedPlayer?.userId ?? null,
      curNominatedId: state.nominatedPlayer?.userId ?? null,
    });
    if (latch === "clear") setOutbid(false);
    if (latch === "set") setOutbid(true);

    // ONE ring for the whole transition — being sold, being nominated, your
    // turn to nominate, being outbid. These do coincide (an admin nominating
    // on your behalf as your own lot resolves), and two playChime() calls in
    // one commit double-strike the same AudioContext.
    if (soundOn && (alerts.length > 0 || latch === "set")) playChime();

    // A selection whose player just sold (or withdrew) must not linger — the
    // sticky bar would offer a nameless Nominate for an undraftable player.
    if (selected && !state.available.some((p) => p.userId === selected)) {
      setSelected(null);
    }
  }, [state, soundOn, selected]);

  const turnRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    // A player the captain lined up while "next" survives the turn passing to
    // them — that is the point of lining one up. Any other hand-over clears
    // the selection.
    const keep = keepsLinedUpPick({
      nominatorTeamId: state.nominatorTeamId,
      myTeamId: state.me.myTeamId,
    });
    if (turnRef.current && turnRef.current !== state.nominatorTeamId) {
      setSelected((current) => (keep ? current : null));
      setNomAmount(state.minBid);
    }
    turnRef.current = state.nominatorTeamId;
  }, [state]);

  const reconcileExpiredClock = useCallback(() => {
    if (settlingClockKey === currentClockKey) return;
    setSettlingClockKey(currentClockKey);
    // Only a signed-in poll can settle the lot (the tick route runs the
    // resolvers for those alone), so a signed-out tab waits for its next
    // poll instead of joining every open tab's request at zero.
    if (state?.me.userId) setPollKick((value) => value + 1);
  }, [currentClockKey, settlingClockKey, state?.me.userId]);

  useEffect(() => {
    if (!soldFlash) return;
    const id = setTimeout(() => setSoldFlash(null), 3600);
    return () => clearTimeout(id);
  }, [soldFlash]);

  // A captain tabbed away can miss their nomination window (auto-skip picks
  // for them) or lose a player to the 30s bid clock — flag both in the tab
  // title. The outbid prefix is latched on the actual outbid event, never on
  // merely "not holding the high bid" (that would mislabel every nomination
  // the captain never bid on).
  const titleFlag = draftTitleFlag({
    loaded: !!state,
    status: state?.status ?? null,
    canNominate: !!state?.me.canNominate,
    outbid,
  });
  useEffect(() => {
    // Strip before writing, so a re-render can never stack two prefixes. The
    // strip must know exactly the strings the flag can be — which is why both
    // live in draft.ts and the round trip is pinned by a test.
    const base = stripDraftTitleFlag(document.title);
    document.title = titleFlag ? titleFlag + base : base;
    return () => {
      document.title = stripDraftTitleFlag(document.title);
    };
  }, [titleFlag]);

  // The clock banner scrolls away while captains browse the pool — a compact
  // sticky bar takes over (shared hook; the inhouse room uses it too).
  const draftLive = !!state && state.status !== "COMPLETE";
  const { ref: bannerRef, offscreen: bannerOffscreen } =
    useBannerOffscreen(draftLive);

  async function act(url: string, body: Record<string, unknown>) {
    if (!state) return;
    if (connectionUnavailable) {
      pushToast(
        "info",
        connectivity === "offline"
          ? "You're offline. Reconnect before using draft actions."
          : "We're confirming the current lot before enabling draft actions.",
      );
      return;
    }
    unlockAudio(); // this click is a user gesture — prime audio for later
    const { seq, next: seqNext } = issueSequence(seqRef.current);
    seqRef.current = seqNext;
    const reconcileUnknown = (message: string) => {
      pushToast("info", message);
      actionReconcileSeqRef.current = seq;
      setActionReconciling(true);
      setPollKick((value) => value + 1);
    };
    setPending(true);
    const expectation =
      url === "/api/draft/bid"
        ? {
            draftVersion: state.draftVersion,
            nominatedUserId: state.nominatedUserId,
            currentLotId: state.currentLotId,
            currentBid: state.currentBid,
            currentBidTeamId: state.currentBidTeamId,
            bidEndsAt: state.bidEndsAt,
          }
        : {
            draftVersion: state.draftVersion,
            nominatorTeamId: state.nominatorTeamId,
            nominationEndsAt: state.nominationEndsAt,
          };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, seasonId, ...expectation }),
        // `pending` is released in the finally below, so a request that never
        // answers left every bid control disabled until the captain reloaded —
        // under a 30s lot clock. See ROOM_ACTION_TIMEOUT_MS.
        signal: AbortSignal.timeout(ROOM_ACTION_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => null)) as
        DraftState | { error?: string } | null;
      if (!res.ok) {
        if (res.status >= 500) {
          reconcileUnknown(
            "The server couldn't confirm the action — checking the current live lot",
          );
          return;
        }
        // Toast, not an inline banner: race rejections ("Another bid just
        // landed") arrive exactly while the captain is scrolled deep in the
        // pool, where a top-of-room banner is invisible — a silently lost
        // bid under a 30s clock. The global toaster is fixed-position.
        if (res.status === 401) setSessionExpired(true);
        pushToast(
          "error",
          data && "error" in data && data.error
            ? data.error
            : "The server couldn't confirm that action — check the live lot before trying again.",
        );
        setPollKick((value) => value + 1);
      } else {
        if (!data || !("now" in data) || typeof data.now !== "number") {
          reconcileUnknown(
            "The response was incomplete — checking the current live lot",
          );
          return;
        }
        const next = data as DraftState;
        if (next.seasonId !== seasonId) {
          setSeasonChanged(true);
          return;
        }
        apply(next, seq);
        // A bid leaves the pick a captain has lined up for their next turn
        // alone; a nomination has just used it.
        if (url !== "/api/draft/bid") setSelected(null);
      }
    } catch {
      // A lost response is never proof that a mutation failed: the server can
      // commit before the connection drops. Reconcile before inviting a retry.
      reconcileUnknown(
        "Connection interrupted — check the live lot to see whether the action landed before trying again.",
      );
    } finally {
      setPending(false);
    }
  }

  if (seasonChanged) {
    return (
      <div
        role="alert"
        className="rounded-[var(--radius)] border border-accent/40 bg-accent/10 p-8 text-center"
      >
        <div className="text-lg font-semibold">
          This draft room is out of date
        </div>
        <p className="mt-1 text-sm text-muted">
          The active season changed. This tab will not send actions to the new
          auction until you reload it.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className={buttonClasses("primary", "sm", "mt-4")}
        >
          Reload draft room
        </button>
      </div>
    );
  }

  if (noSeason) {
    return (
      <div className="rounded-[var(--radius)] border border-line bg-surface/60 p-8 text-center">
        <div className="text-lg font-semibold">
          The draft isn&apos;t available
        </div>
        <p className="mt-1 text-sm text-muted">
          There&apos;s no active season right now.
        </p>
        <Link href="/" className={buttonClasses("secondary", "sm", "mt-4")}>
          Back to home
        </Link>
      </div>
    );
  }

  if (!state) {
    if (initialError || disconnected || syncDelayed || connectionUnavailable) {
      return (
        <div
          role="status"
          aria-live="polite"
          className="rounded-[var(--radius)] border border-accent/40 bg-accent/10 p-8 text-center"
        >
          <div className="text-lg font-semibold">
            The draft room hasn&apos;t loaded
          </div>
          <p className="mt-1 text-sm text-muted">
            {connectivity === "offline"
              ? "You're offline. Reconnect to load the current auction; no actions are available from stale state."
              : connectivity === "resyncing"
                ? "You're back online. We're checking the current auction before enabling any actions."
                : syncDelayed
                  ? "Live updates are temporarily delayed. Your place is safe; try syncing again."
                  : "The server could not provide the live auction yet. Check your connection and retry."}
          </p>
          <button
            type="button"
            onClick={() => setPollKick((value) => value + 1)}
            disabled={connectivity === "offline"}
            title={
              connectivity === "offline"
                ? "Reconnect to the internet before retrying."
                : undefined
            }
            className={buttonClasses("secondary", "sm", "mt-4")}
          >
            {connectivity === "offline"
              ? "Waiting for connection"
              : "Retry now"}
          </button>
        </div>
      );
    }
    return <div className="py-10 text-center text-muted">Loading draft…</div>;
  }

  // ONE status line, chosen by priority (roomStatus): offline, connection
  // lost, back online and checking, checking after an interrupted action,
  // sign-in expired, updates delayed. The inhouse room renders the same line.
  const connectionStatus = roomStatus(
    {
      connectivity,
      disconnected,
      actionReconciling,
      sessionExpired,
      syncDelayed,
    },
    DRAFT_ROOM_STATUS_COPY,
  );
  const roomAlerts = (
    <RoomStatusLine
      status={connectionStatus}
      signInHref="/login?next=/draft"
    />
  );

  const { me } = state;
  // The countdowns tick inside <BidClock>/<NomClock> leaves (see below) so the
  // per-second update doesn't re-render the whole room + player pool.
  const offsetMs = offsetMsState;
  const nominatorName =
    state.teams.find((t) => t.id === state.nominatorTeamId)?.name ?? "—";
  const highBidderName = state.teams.find(
    (t) => t.id === state.currentBidTeamId,
  )?.name;
  // Who nominates after this lot — captains plan a turn ahead. Pure rotation
  // math over the same draftOrder-sorted teams the server uses.
  const upcomingTeamId = upcomingNominatorTeamId(state);
  const nextNominatorName = upcomingTeamId
    ? (state.teams.find((t) => t.id === upcomingTeamId)?.name ?? null)
    : null;
  // The captain whose turn comes next may line up a pick in advance, and so
  // may the captain on the clock while the admin has paused the auction.
  const iAmNext = !!me.myTeamId && upcomingTeamId === me.myTeamId;
  const myTurnPaused =
    state.status === "PAUSED" &&
    !state.nominatedPlayer &&
    !!me.myTeamId &&
    state.nominatorTeamId === me.myTeamId;
  // An admin can nominate for the team on the clock (a captain who dropped
  // off and asks for "Player X at $5"), capped at that team's max bid.
  const adminTeam = adminNominationTeam({
    status: state.status,
    seasonStatus: state.seasonStatus,
    nominatedUserId: state.nominatedUserId,
    nominatorTeamId: state.nominatorTeamId,
    teams: state.teams,
    teamSize: state.teamSize,
    minBid: state.minBid,
    me,
  });
  const canLineUp = me.canNominate || iAmNext || myTurnPaused || !!adminTeam;
  const nominateCap = adminTeam ? adminTeam.maxBid : me.myMaxBid;
  // Same endpoint and turn check for both; the admin confirms because the
  // nomination spends another team's turn.
  const nominate = (playerId: string, amount: number) => {
    if (adminTeam) {
      const name =
        state.available.find((p) => p.userId === playerId)?.name ??
        "this player";
      if (
        !window.confirm(
          `Nominate ${name} for ${adminTeam.name} at $${amount}? This uses ${adminTeam.name}'s turn.`,
        )
      ) {
        return;
      }
    }
    act("/api/draft/nominate", { playerId, amount });
  };
  const linedUpName = selected
    ? (state.available.find((p) => p.userId === selected)?.name ?? null)
    : null;
  // The viewer's own team (if a captain) — drives the "why can't I bid" copy.
  const myTeam = me.myTeamId
    ? state.teams.find((t) => t.id === me.myTeamId)
    : undefined;
  const rosterFull = !!me.myTeamId && myTeam?.need === 0;
  const pricedOut =
    !!me.myTeamId && !rosterFull && me.myMaxBid <= state.currentBid;
  // The player on the block, or one still waiting in the pool, gets a line of
  // their own; visitors get none (they used to read the captains' rules).
  const watcherText = lotWatcherLine({
    me,
    nominatedPlayer: state.nominatedPlayer,
    available: state.available,
    currentBid: state.currentBid,
    highBidderName: highBidderName ?? null,
  });
  // Who can still answer the current price — the fact a captain weighs before
  // going higher, which used to live only in each team card's tiny "max $N".
  const outbidText = state.nominatedPlayer
    ? outbidLine({
        teams: state.teams,
        teamSize: state.teamSize,
        minBid: state.minBid,
        currentBid: state.currentBid,
        currentBidTeamId: state.currentBidTeamId,
        myTeamId: me.myTeamId,
      })
    : null;

  const viewerTeamBanner = me.rosterTeamId ? (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-info/30 bg-info/5 px-4 py-2 text-sm"
    >
      <span>
        <strong>Your team: {me.rosterTeamName}</strong>
        {me.rosterIsCaptain
          ? " · captain"
          : me.rosterPrice != null
            ? ` · drafted for $${me.rosterPrice}`
            : ""}
      </span>
      <Link
        href={`/teams/${me.rosterTeamId}`}
        target={state.status === "COMPLETE" ? undefined : "_blank"}
        rel={state.status === "COMPLETE" ? undefined : "noreferrer"}
        className={textLink()}
      >
        View roster{state.status === "COMPLETE" ? "" : " ↗"}
      </Link>
    </div>
  ) : null;

  const quickBid = (delta: number) => {
    const amount = state.currentBid + delta;
    if (amount > me.myMaxBid) return;
    act("/api/draft/bid", { amount });
  };

  // Only for viewers the room can actually ring for (draftAlertsReachViewer):
  // a visitor, an admin or a drafted player never hears a thing. Shown in the
  // waiting room too, where a pool player first opens the room.
  const soundLocked = soundOn && !audioOn;
  const soundToggleFor = (className: string) =>
    draftAlertsReachViewer(state) ? (
      <button
        type="button"
        onClick={toggleSound}
        aria-pressed={soundOn && audioOn}
        title={
          soundLocked
            ? "Your browser holds sound until you tap the page — tap to turn on the bell"
            : soundOn
              ? "Notification sound on — click to mute"
              : "Notifications muted — click to enable a bell"
        }
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-2/40 px-3 py-1 text-xs text-muted transition-colors hover:text-fg",
          soundLocked && "border-accent/50 text-accent",
          className,
        )}
      >
        <span aria-hidden>{soundOn ? "🔔" : "🔕"}</span>
        {soundLocked ? "Tap to turn on alerts" : soundOn ? "Sound on" : "Muted"}
      </button>
    ) : null;

  if (state.status === "NOT_STARTED") {
    if (state.seasonStatus !== "SIGNUPS" && state.seasonStatus !== "DRAFT") {
      return (
        <div className="space-y-6">
          {roomAlerts}
          {viewerTeamBanner}
          <div className="rounded-[var(--radius)] border border-accent/40 bg-accent/10 p-6 text-center">
            <div className="text-lg font-semibold">
              The auction is not available
            </div>
            <p className="mt-1 text-sm text-muted">
              {state.seasonName} is currently in{" "}
              {state.seasonStatus.toLowerCase().replaceAll("_", " ")}. An admin
              must review the missing or reset draft record before this room can
              be used.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Link href="/teams" className={buttonClasses("secondary", "sm")}>
                View teams
              </Link>
              {me.isAdmin ? (
                <Link href="/admin" className={buttonClasses("accent", "sm")}>
                  Review league controls
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      );
    }
    // Waiting room, not a dead end: the poll flips this live the moment the
    // admin starts — nobody has to hand-refresh into a running clock. The
    // admin CTA renders only for admins (everyone else used to get bounced
    // off /admin with no explanation).
    // Who's in the room, from the live poll: a line above Start draft, and
    // the missing captains named in its confirm at the moment of the click.
    const presence = captainPresence(state.teams, me.userId);
    return (
      <div className="space-y-6">
        {roomAlerts}
        {viewerTeamBanner}
        <div className="rounded-[var(--radius)] border border-line bg-surface/60 p-6 text-center">
          <div className="text-2xl" aria-hidden>
            ⏳
          </div>
          <div className="mt-1 text-lg font-semibold">
            Waiting for the admin to start the auction
          </div>
          <div className="text-sm text-muted">
            This page goes live automatically — no need to refresh.
          </div>
          {soundToggleFor("mx-auto mt-3")}
          {state.draftAtMs ? (
            <div className="mt-2 text-sm text-muted">
              🗓️ Draft night:{" "}
              {/* Client component — this branch never SSRs (state loads via
                  poll first), so browser-local formatting can't mismatch. */}
              <strong className="text-fg">
                {new Date(state.draftAtMs).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </strong>
              <Countdown
                targetMs={state.draftAtMs}
                eventLabel="Draft"
                passedLabel={DRAFT_PASSED_LABEL}
              />
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Draft night has not been scheduled yet. The league admin will set
              the time before the auction starts.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Link href="/players" className={buttonClasses("secondary", "sm")}>
              Scout the player pool
            </Link>
            <Link href="/teams" className={buttonClasses("secondary", "sm")}>
              Captains &amp; budgets
            </Link>
            {me.isAdmin && !adminStart ? (
              <Link
                href="/admin#adm-captains"
                className={buttonClasses("accent", "sm")}
              >
                Start it from the admin panel →
              </Link>
            ) : null}
          </div>
          {/* Admins start the auction right here: the same Start draft form
              as the Captains & draft card (same action, same confirm), so a
              phone on draft night doesn't have to dig through /admin. The
              rest of setup stays one link away, on that card. */}
          {me.isAdmin && adminStart ? (
            <div className="mt-4 flex flex-col items-center gap-2 border-t border-line pt-4">
              {presence ? (
                <p className="text-sm text-muted">
                  {captainPresenceLine(presence)}
                </p>
              ) : null}
              <StartDraftConfirmLine
                line={missingCaptainsConfirmLine(presence?.away ?? [], "now")}
              >
                {adminStart.control}
              </StartDraftConfirmLine>
              {adminStart.blocker ? (
                <p className="text-sm font-medium text-accent">
                  Start unavailable: {adminStart.blocker}
                </p>
              ) : null}
              <Link href="/admin#adm-captains" className={textLink("text-sm")}>
                Captains &amp; draft setup on the admin panel
              </Link>
            </div>
          ) : null}
        </div>
        <AuctionPrimer
          minBid={state.minBid}
          teamSize={state.teamSize}
          defaultOpen
        />
        {state.teams.length > 0 ? (
          <TeamsGrid state={state} showNominationOrder />
        ) : null}
      </div>
    );
  }

  if (state.status === "COMPLETE") {
    const shortTeams = state.teams.filter((team) => team.need > 0);
    // Auction purchases only: $0 rows are free-agent signings, which an
    // admin can make once the auction is over.
    const bought = state.teams.reduce(
      (n, t) => n + t.members.filter((m) => !m.isCaptain && m.price > 0).length,
      0,
    );
    // The auction is over, so this is a results page: what happened, the
    // recap, and the final rosters with what each player cost. Admins get
    // the one thing left to do here (start the Regular season), not a list
    // of places to go.
    const showNextStep =
      me.isAdmin && !!adminFinish && state.seasonStatus === "DRAFT";
    return (
      <div className="space-y-6">
        {/* Same strip as every other branch — undoLastSale can re-open a
            draft from COMPLETE, and only the poll delivers that flip. */}
        {roomAlerts}
        {viewerTeamBanner}
        {me.isAdmin ? (
          <DraftAdminToolbar
            state={state}
            seasonId={seasonId}
            disabled={pending}
            pauseAction={pauseAction}
            resumeAction={resumeAction}
            undoAction={undoAction}
            voidLotAction={voidLotAction}
          />
        ) : null}
        <div
          role="status"
          aria-live="polite"
          className="rounded-[var(--radius)] border border-success/40 bg-success/10 p-6 text-center"
        >
          <div className="text-2xl" aria-hidden>
            ✅
          </div>
          <h2 className="mt-1 text-lg font-semibold">The draft is complete</h2>
          <p className="text-sm text-muted">
            {bought} player{bought === 1 ? "" : "s"} bought across{" "}
            {state.teams.length} team{state.teams.length === 1 ? "" : "s"}.{" "}
            {shortTeams.length === 0
              ? "Every roster is full."
              : `${shortTeams.length} team${shortTeams.length === 1 ? " still has" : "s still have"} open seats: an admin can sign free agents to fill them, and standins can cover games until then.`}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Link href="/teams" className={buttonClasses("secondary", "sm")}>
              View teams
            </Link>
          </div>
        </div>
        {showNextStep ? (
          <section
            aria-label="Next step"
            className="flex flex-col items-center gap-3 rounded-[var(--radius)] border border-accent/40 bg-accent/10 p-4 text-center"
          >
            <p className="text-sm">
              <span className="font-semibold">{adminFinish.title}</span>{" "}
              <span className="text-muted">{adminFinish.detail}</span>
            </p>
            {adminFinish.control}
          </section>
        ) : null}
        {state.recap ? <DraftRecapCard recap={state.recap} /> : null}
        <TeamsGrid state={state} />
      </div>
    );
  }

  const paused = state.status === "PAUSED";

  // A captain's roles-to-cover chip: filter the pool to that position and
  // bring the pool into view if it is below the fold (phones). Pressing the
  // active one again clears the filter, like the pool's own chips.
  const findRole = (key: string) => {
    if (poolRole === key) {
      setPoolRole(null);
      return;
    }
    setPoolRole(key);
    document.getElementById("player-pool")?.scrollIntoView({
      block: "nearest",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  };
  const rolesToCover =
    myTeam && myTeam.need > 0 ? uncoveredRoles(myTeam.members) : [];

  // While the auction runs, "Your team" and the sound toggle ride in the lot
  // card's header instead of taking two rows of their own above the clock.
  // A captain's version is their standing in the auction — money, seats, bid
  // cap and the positions nobody on the roster plays yet — which used to show
  // only inside a lot they could bid on, never during their own nomination.
  const liveTeamLine = myTeam ? (
    <span className="min-w-0 flex-1">
      <Link
        href={`/teams/${myTeam.id}`}
        target="_blank"
        rel="noreferrer"
        title="Open your team's roster in a new tab"
        className={textLink("font-medium")}
      >
        {myTeam.name}
        <span aria-hidden> ↗</span>
      </Link>
      {" · "}
      {captainStatusLine({
        budget: me.myBudget,
        need: myTeam.need,
        maxBid: me.myMaxBid,
      })}
      {rolesToCover.length > 0 ? (
        <>
          {" · roles to cover "}
          <span
            role="group"
            aria-label="Positions nobody on your team plays yet"
            className="inline-flex flex-wrap gap-1 align-middle"
          >
            {rolesToCover.map((key) => {
              const role = DOTA_ROLES.find((r) => r.key === key);
              const name = role ? `${role.short} (${role.label})` : key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => findRole(key)}
                  aria-pressed={poolRole === key}
                  aria-label={`Show ${name} players in the pool`}
                  title={`Nobody on your team lists ${name}. Tap to show those players in the pool.`}
                  className={cn(
                    "inline-flex h-6 min-w-6 items-center justify-center rounded border px-1 text-[11px] font-semibold tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                    poolRole === key
                      ? "border-accent/60 bg-accent/20 text-fg"
                      : "border-line text-muted hover:border-accent/60 hover:text-fg",
                  )}
                >
                  {key}
                </button>
              );
            })}
          </span>
        </>
      ) : null}
    </span>
  ) : me.rosterTeamId ? (
    <span className="min-w-0 truncate">
      Your team:{" "}
      <Link
        href={`/teams/${me.rosterTeamId}`}
        target="_blank"
        rel="noreferrer"
        title="Open your team's roster in a new tab"
        className={textLink("font-medium")}
      >
        {me.rosterTeamName}
        <span aria-hidden> ↗</span>
      </Link>
      {me.rosterIsCaptain
        ? " · captain"
        : me.rosterPrice != null
          ? ` · drafted for $${me.rosterPrice}`
          : ""}
    </span>
  ) : null;

  // Dim the (stale) clocks while polling is dead: they're ticking on the last
  // state we saw, not the live auction. Everything in the lot card dims
  // except the status slot that explains why.
  const lotStale = connectionUnavailable || disconnected;
  // The player's "About you" box, named as the pool and profile name it. An
  // older signup's captain note and goals show joined (about-you.ts).
  const nominatedAbout = state.nominatedPlayer
    ? aboutText(state.nominatedPlayer, " · ")
    : "";

  return (
    <div className="space-y-6">
      {/* Screen readers hear each nomination and bid as it lands ("Team 3
          bid on Pudge, $8"); sighted viewers read it off the lot card. */}
      <p role="status" className="sr-only">
        {lotNews}
      </p>
      {!paused ? (
        <ClockExpiryObserver
          endsAtMs={
            state.nominatedPlayer ? state.bidEndsAt : state.nominationEndsAt
          }
          offsetMs={offsetMs}
          onExpire={reconcileExpiredClock}
        />
      ) : null}
      {me.isAdmin ? (
        <DraftAdminToolbar
          state={state}
          seasonId={seasonId}
          disabled={pending}
          pauseAction={pauseAction}
          resumeAction={resumeAction}
          undoAction={undoAction}
          voidLotAction={voidLotAction}
        />
      ) : null}
      {/* Compact clock bar — pins under the site header while the captain is
          deep in the player pool, so the auction never disappears. */}
      {bannerOffscreen &&
      !paused &&
      (state.nominatedPlayer || state.nominationEndsAt) ? (
        // Outer element is a DIV so the action button can sit beside the
        // scroll-back button — interactive content nested inside a <button>
        // is invalid HTML (unreliable clicks, screen-reader breakage).
        <div className="fixed inset-x-0 top-16 z-20 border-b border-line bg-bg/90 backdrop-blur">
          <div className="mx-auto flex h-11 w-full max-w-7xl items-center gap-3 px-4 text-sm sm:px-6 lg:px-8">
            {/* No aria-label here: it would REPLACE the accessible name
                computed from the content, hiding the lot/price/clock from
                screen readers — the content itself is the announcement. */}
            <button
              type="button"
              onClick={() =>
                window.scrollTo({
                  top: 0,
                  behavior: window.matchMedia(
                    "(prefers-reduced-motion: reduce)",
                  ).matches
                    ? "auto"
                    : "smooth",
                })
              }
              title="Back to the auction clock"
              className="flex h-full min-w-0 flex-1 items-center justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
            >
              {connectionStatus?.short ? (
                <span className="shrink-0 text-xs font-medium text-danger">
                  {connectionStatus.short}
                </span>
              ) : null}
              {state.nominatedPlayer ? (
                <>
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden>🔨</span>
                    <span className="truncate font-medium">
                      {state.nominatedPlayer.name}
                    </span>
                    <span className="shrink-0 font-mono font-semibold text-accent">
                      ${state.currentBid}
                    </span>
                    {highBidderName ? (
                      <span className="hidden truncate text-muted sm:inline">
                        · {highBidderName}
                      </span>
                    ) : null}
                  </span>
                  <CompactClock
                    endsAtMs={state.bidEndsAt}
                    offsetMs={offsetMs}
                    urgentAt={5}
                    calmTone="text-accent"
                  />
                </>
              ) : (
                <>
                  <span className="min-w-0 truncate text-muted">
                    {nominatorName} to nominate…
                  </span>
                  <CompactClock
                    endsAtMs={state.nominationEndsAt}
                    offsetMs={offsetMs}
                    urgentAt={10}
                    calmTone="text-muted"
                  />
                </>
              )}
            </button>
            {/* Act from HERE: scrolling a full page up and re-orienting burns
                5-10s of a 30s bid clock — the dominant flow on phones where
                the pool is deliberately DOM-first. */}
            {state.nominatedPlayer && me.canBid ? (
              <button
                type="button"
                onClick={() => quickBid(1)}
                disabled={pending || state.currentBid + 1 > me.myMaxBid}
                className={buttonClasses("accent", "sm", "shrink-0")}
              >
                {outbid
                  ? `Re-bid $${state.currentBid + 1}`
                  : `Bid $${state.currentBid + 1}`}
              </button>
            ) : !state.nominatedPlayer &&
              (me.canNominate || adminTeam) &&
              selected ? (
              <button
                type="button"
                onClick={() => nominate(selected, nomAmount)}
                disabled={
                  pending || nomAmount < state.minBid || nomAmount > nominateCap
                }
                className={buttonClasses(
                  "accent",
                  "sm",
                  "max-w-[14rem] shrink-0",
                )}
              >
                <span className="truncate">
                  Nominate{" "}
                  {state.available.find((p) => p.userId === selected)?.name ??
                    ""}{" "}
                  · ${nomAmount}
                </span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* On the block */}
      <div
        className={cn(
          "rounded-[var(--radius)] border border-line bg-surface/80",
          // The viewer IS the player being auctioned — their moment glows.
          !!me.userId &&
            state.nominatedPlayer?.userId === me.userId &&
            "border-accent/70 ring-2 ring-accent/30",
        )}
      >
        {/* The ACTION ZONE — clock, player, price and the bid controls, in
            that order — is what useBannerOffscreen watches. Scouting detail
            (heroes, notes, contact, the bid trail) lives below it, so the
            compact bar takes over the moment the controls themselves scroll
            away rather than once the whole card has gone. */}
        <div ref={bannerRef}>
          <div
            className={cn("border-b border-line", lotStale && "opacity-50")}
          >
            {/* FIXED HEIGHT (min-h-14, two text lines at most): a sale and a
                clock running out used to insert banners ABOVE the card, which
                pushed the lot and its buttons ~110px down and back again right
                as the next captain nominated and others reached for +$1. Those
                moments now replace text inside this row instead. */}
            <div
              className={cn(
                "flex min-h-14 items-center justify-between gap-3 rounded-t-[var(--radius)] px-5 py-2 transition-colors",
                soldFlash &&
                  (soldFlash.isMe ? "bg-accent/15" : "bg-success/10"),
              )}
            >
              {soldFlash ? (
                <p
                  role="status"
                  className={cn(
                    "sold-flash line-clamp-2 min-w-0 text-sm font-semibold [overflow-wrap:anywhere]",
                    soldFlash.isMe ? "text-accent" : "text-success",
                  )}
                >
                  {soldFlash.isMe ? (
                    <>
                      🎉 You&apos;re drafted! {soldFlash.team} paid $
                      {soldFlash.price} for you.
                    </>
                  ) : (
                    <>
                      Sold! {soldFlash.name} → {soldFlash.team} · $
                      {soldFlash.price}
                    </>
                  )}
                </p>
              ) : (
                <h2 className="line-clamp-2 min-w-0 text-sm font-normal text-muted [overflow-wrap:anywhere]">
                  {lotHeadingLead({
                    lotLive: !!state.nominatedPlayer,
                    autoNominated: state.lotAutoNominated,
                  })}{" "}
                  <span className="text-fg">{nominatorName}</span>
                  {/* Every screen size: phone viewers never saw who
                      nominates next. */}
                  {nextNominatorName ? (
                    <span>
                      {" "}
                      · next: {nextNominatorName}
                    </span>
                  ) : null}
                </h2>
              )}
              {paused ? (
                <span className="shrink-0 font-mono text-sm font-semibold text-info">
                  ⏸ paused
                </span>
              ) : clockSettling ? (
                // The clock hit zero and the room is waiting for the server to
                // settle it — said in the clock's own slot, not a strip above.
                <span
                  role="status"
                  className="shrink-0 font-mono text-sm font-semibold text-info"
                >
                  {state.nominatedPlayer ? "Closing…" : "Time's up…"}
                  <span className="sr-only">
                    {state.nominatedPlayer
                      ? " Confirming the sale with the server."
                      : " Confirming the next nomination with the server."}
                  </span>
                </span>
              ) : state.nominatedPlayer ? (
                <BidClock endsAtMs={state.bidEndsAt} offsetMs={offsetMs} />
              ) : state.nominationEndsAt ? (
                <NomClock
                  endsAtMs={state.nominationEndsAt}
                  offsetMs={offsetMs}
                />
              ) : null}
            </div>
            {liveTeamLine || draftAlertsReachViewer(state) || iAmNext ? (
              <div className="-mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-5 pb-2 text-xs text-muted">
                {liveTeamLine}
                {soundToggleFor("ml-auto")}
                {/* Every screen size: the header's "next: Team 3" is hidden
                    on phones, and a turn that starts with searching the pool
                    loses most of its 90 seconds. */}
                {iAmNext ? (
                  <p className="basis-full font-medium text-accent">
                    {upNextLine(linedUpName)}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className={cn("p-5", lotStale && "opacity-50")}>
            {state.nominatedPlayer ? (
              <>
                {/* Price beside the name, then straight into the controls:
                    on a phone the bid row used to start ~800px down, under
                    the player's heroes, note and quote. */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar
                      name={state.nominatedPlayer.name}
                      src={state.nominatedPlayer.avatar}
                      size={52}
                      className="shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xl font-bold [overflow-wrap:anywhere]">
                        {state.nominatedPlayer.name}
                        {me.userId === state.nominatedPlayer.userId ? (
                          <Badge tone="accent">You&apos;re on the block!</Badge>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted">
                        {state.nominatedPlayer.mmr > 0 ? (
                          <span>{state.nominatedPlayer.mmr} MMR</span>
                        ) : null}
                        <RankBadge rankTier={state.nominatedPlayer.rankTier} />
                        <RoleBadges roles={state.nominatedPlayer.roles} />
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-3xl font-bold text-accent">
                      ${state.currentBid}
                    </div>
                    {/* One line whatever the bidder's name: a wrapping name
                        would move the bid buttons every time the lead
                        changed hands. */}
                    <div
                      className="max-w-[8rem] truncate text-xs text-muted sm:max-w-[12rem]"
                      title={
                        highBidderName
                          ? `High bid: ${highBidderName}`
                          : undefined
                      }
                    >
                      {highBidderName
                        ? `high bid · ${highBidderName}`
                        : "opening"}
                    </div>
                  </div>
                </div>

                <div
                  aria-busy={me.canBid ? reqPending : undefined}
                  className="mt-4 space-y-3 border-t border-line pt-4 text-sm"
                >
                  {/* The outbid alert has a slot of its own at the top of this
                      area rather than a banner above the card. It can only
                      appear on the poll where the viewer LOST the high bid —
                      the same poll that brings their bid buttons back — so it
                      never shoves controls that were already on screen. */}
                  {/* The latch clears in the effect AFTER this render, so
                      also check the payload: never "lost" beside "hold". */}
                  {outbid && state.currentBidTeamId !== me.myTeamId ? (
                    <p role="status">
                      <span className="font-display font-black uppercase tracking-wider text-danger">
                        💸 Outbid!
                      </span>{" "}
                      You lost the high bid.
                    </p>
                  ) : null}
                  {me.canBid ? (
                    <>
                      <p className="text-muted">
                        {bidAllowanceLine({
                          maxBid: me.myMaxBid,
                          need: myTeam?.need ?? 1,
                          minBid: state.minBid,
                        })}
                      </p>
                      {/* +$1, +$5 and a typed amount. +$10 went: the box
                          covers any bigger jump, and six controls under a
                          30-second clock was four more than a captain needs. */}
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
                          {[1, 5].map((d) => {
                            const amount = state.currentBid + d;
                            // After an outbid, +$1 IS the re-bid — one button,
                            // not a second copy of it in a banner.
                            const label =
                              d === 1 && outbid
                                ? `Re-bid $${amount}`
                                : `Bid $${amount}`;
                            return (
                              <button
                                key={d}
                                disabled={pending || amount > me.myMaxBid}
                                onClick={() => quickBid(d)}
                                aria-label={label}
                                title={label}
                                className={buttonClasses(
                                  d === 1 && outbid ? "accent" : "secondary",
                                  "sm",
                                )}
                              >
                                {/* Show the amount that will actually be
                                    submitted — "+$5" alone hid the absolute
                                    price. */}
                                {d === 1 && outbid
                                  ? label
                                  : `+$${d} → $${amount}`}
                              </button>
                            );
                          })}
                        </div>
                        <ExactBidControl
                          key={
                            state.currentLotId ?? state.nominatedPlayer.userId
                          }
                          currentBid={state.currentBid}
                          maxBid={me.myMaxBid}
                          pending={pending}
                          submit={(amount) => act("/api/draft/bid", { amount })}
                          onMax={() => {
                            // One tap here commits the entire remaining
                            // budget — make it deliberate.
                            if (
                              window.confirm(
                                `Bid your maximum $${me.myMaxBid}? That's everything you can spend on this player.`,
                              )
                            ) {
                              act("/api/draft/bid", { amount: me.myMaxBid });
                            }
                          }}
                        />
                      </div>
                    </>
                  ) : me.myTeamId && state.currentBidTeamId === me.myTeamId ? (
                    <p role="status" className="text-success">
                      You hold the high bid.
                    </p>
                  ) : rosterFull ? (
                    <p className="text-muted">
                      Your roster is full — you&apos;re done bidding.
                    </p>
                  ) : pricedOut ? (
                    <p className="text-muted">
                      Priced out — your max bid is ${me.myMaxBid} (reserving $
                      {state.minBid} per remaining slot).
                    </p>
                  ) : watcherText ? (
                    <p
                      className={
                        me.userId === state.nominatedPlayer.userId
                          ? "text-fg"
                          : "text-muted"
                      }
                    >
                      {watcherText}
                    </p>
                  ) : null}
                  {/* Last in the area, BELOW the controls: its length changes
                      as teams price out, and above the buttons that would move
                      them under a captain's thumb. */}
                  {outbidText ? (
                    <p className="text-xs text-muted">{outbidText}</p>
                  ) : null}
                </div>
              </>
            ) : me.canNominate ? (
              <NominateBar
                state={state}
                selected={selected}
                nomAmount={nomAmount}
                setNomAmount={setNomAmount}
                maxBid={me.myMaxBid}
                pending={pending}
                onNominate={nominate}
              />
            ) : adminTeam ? (
              <div className="space-y-3">
                <NominateBar
                  state={state}
                  selected={selected}
                  nomAmount={nomAmount}
                  setNomAmount={setNomAmount}
                  maxBid={adminTeam.maxBid}
                  forTeamName={adminTeam.name}
                  pending={pending}
                  onNominate={nominate}
                />
                {(() => {
                  // Presence is already in the poll; it showed only as a 10px
                  // "not in room" label on the team card, so the admin waited
                  // out the absent captain's clock on every turn.
                  const clockTeam = state.teams.find((t) => t.id === adminTeam.id);
                  if (clockTeam?.captainInRoom !== false) return null;
                  const captain = clockTeam.members.find(
                    (m) => m.userId === clockTeam.captainId,
                  );
                  return (
                    <p className="text-sm text-accent [overflow-wrap:anywhere]">
                      {captain?.name ?? "Their captain"} isn&apos;t in the room —
                      nominate for {adminTeam.name} or auto-nominate instead of
                      waiting out the clock.
                    </p>
                  );
                })()}
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                  <span>Or let the draft choose:</span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      // Skipping a captain's turn is intrusive — confirm it.
                      if (
                        window.confirm(
                          `Auto-nominate the top player for ${adminTeam.name}? Use this when they're absent — it takes their turn.`,
                        )
                      ) {
                        act("/api/draft/admin-nominate", {});
                      }
                    }}
                    className={buttonClasses("secondary", "sm")}
                  >
                    Auto-nominate top player
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 py-4">
                <p
                  className={cn(
                    "text-center",
                    myTurnPaused ? "font-medium text-fg" : "text-muted",
                  )}
                >
                  {nominationWaitLine({
                    paused,
                    myTurn: myTurnPaused,
                    nominatorName,
                  })}
                </p>
                {myTurnPaused ? (
                  <p className="text-center text-sm text-muted">
                    {lineUpHint(linedUpName)}
                  </p>
                ) : null}
              </div>
            )}
          </div>
          {/* The room's status line and the pause note sit BELOW the
              controls, undimmed. Above the card they came and went between
              polls (a lost bid response, a 429, the admin resuming) and
              pushed the lot and its bid buttons down and back up under a
              captain's thumb; here they move only the scouting detail. */}
          {connectionStatus || paused ? (
            <div className="space-y-2 px-5 pb-5">
              {roomAlerts}
              {paused ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="rounded-lg border border-info/40 bg-info/10 px-4 py-2 text-sm text-info"
                >
                  ⏸️ The admin paused the auction — clocks are parked and
                  nothing can sell. Stay put; it resumes with a fresh clock.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {state.nominatedPlayer ? (
          <div
            className={cn(
              "space-y-3 border-t border-line px-5 py-3 text-sm",
              lotStale && "opacity-50",
            )}
          >
            {state.lotBids.length > 1 ? (
              // The lot's audit trail (newest first) — kills "who bid
              // what?" disputes without leaving the card.
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <span className="shrink-0">
                  {state.lotBidsTruncated ? "Latest 8 bids:" : "Bid trail:"}
                </span>
                {state.lotBids.map((b, i) => (
                  <span
                    key={b.at + "-" + i}
                    className="flex items-center gap-2"
                  >
                    {i > 0 ? <span aria-hidden>‹</span> : null}
                    <span
                      className={cn(
                        "font-mono tabular-nums",
                        i === 0 && "font-semibold text-accent",
                      )}
                    >
                      {state.teams.find((t) => t.id === b.teamId)?.name ?? "—"}{" "}
                      ${b.amount}
                    </span>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 text-muted">
              <DiscordTag
                name={state.nominatedPlayer.discordName}
                verified={state.nominatedPlayer.discordVerified}
              />
              {/* Scouting links — open in a new tab so a captain can't
                  navigate away mid-auction. */}
              <Link
                href={`/players/${state.nominatedPlayer.userId}`}
                target="_blank"
                className={textLink()}
              >
                Profile ↗
              </Link>
              {state.nominatedPlayer.accountId ? (
                <a
                  href={`https://www.dotabuff.com/players/${state.nominatedPlayer.accountId}`}
                  target="_blank"
                  rel="noreferrer"
                  className={textLink()}
                >
                  Dotabuff ↗
                </a>
              ) : null}
            </div>
            {state.nominatedPlayer.favoriteHeroes ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted">Favorite heroes:</span>
                <HeroList
                  value={state.nominatedPlayer.favoriteHeroes}
                  size={30}
                />
              </div>
            ) : null}
            {/* Clamped: this is free text up to 2000 chars. The full
                text is a click away on the player's profile. */}
            {nominatedAbout ? (
              <div className="line-clamp-3 [overflow-wrap:anywhere]">
                <span className="text-muted">About this player:</span>{" "}
                {nominatedAbout}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <AuctionPrimer
        minBid={state.minBid}
        teamSize={state.teamSize}
        defaultOpen={false}
      />

      {/* Desktop is fixed by grid placement: teams on the left across both
          rows, the feed above the pool on the right (rows auto, then the
          rest, and the pool starts at its row's top, so a tall roster column
          never opens a gap between them). Phone ORDER follows the viewer.
          A captain or admin gets the pool FIRST: on the clock it is what they
          need now, and team cards would bury it 3-4 screens down. Everyone
          else (spectators, players in the pool) acts on nothing there, and
          40-60 pool rows put the sales and rosters they came to watch about
          2,000px down, so they get those first. DOM order, not CSS order, so
          screen readers and tab order match what they see. */}
      {(() => {
        const watcher = !me.myTeamId && !me.isAdmin;
        const pool = (
          // scroll-mt clears the 64px sticky header + the fixed clock bar
          // when the NominateBar's #player-pool anchor jumps here.
          <div
            key="pool"
            id="player-pool"
            className="min-w-0 scroll-mt-32 lg:col-start-3 lg:row-start-2 lg:self-start"
          >
            <AvailableList
              state={state}
              role={poolRole}
              onRoleChange={setPoolRole}
              canPick={canLineUp}
              selected={selected}
              onPick={(userId) => {
                setSelected(userId);
                setNomAmount(state.minBid);
              }}
            />
          </div>
        );
        const feed = (
          <div key="feed" className="min-w-0 lg:col-start-3 lg:row-start-1">
            <RecentSales sales={sales} />
          </div>
        );
        const rosters = (
          <div
            key="rosters"
            className="min-w-0 lg:col-span-2 lg:col-start-1 lg:row-span-2 lg:row-start-1"
          >
            <TeamsGrid state={state} />
          </div>
        );
        return (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:grid-rows-[auto_1fr]">
            {watcher ? [feed, rosters, pool] : [pool, feed, rosters]}
          </div>
        );
      })()}
    </div>
  );
}

// Only the buttons that work right now (draftToolbarControls): a disabled
// Undo explained in a hover tooltip told a phone nothing, and the bar took
// ~190px above the clock. The room's confirms are the same texts /admin uses.
function DraftAdminToolbar({
  state,
  seasonId,
  disabled,
  pauseAction,
  resumeAction,
  undoAction,
  voidLotAction,
}: {
  state: DraftState;
  seasonId: string;
  disabled: boolean;
  pauseAction: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  resumeAction: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  undoAction: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  voidLotAction: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
}) {
  const controls = draftToolbarControls({
    seasonStatus: state.seasonStatus,
    status: state.status,
    lotLive: !!state.nominatedPlayer,
    hasSale: state.recentSales.length > 0,
  });
  // Nothing to press here (e.g. the season has left the Draft phase): no
  // bar, just the way to the admin panel.
  if (!controls || !hasToolbarControl(controls)) {
    return (
      <p className="text-right">
        <Link href="/admin" className={textLink("text-sm")}>
          Admin panel
        </Link>
      </p>
    );
  }
  const hidden = { expectedActiveSeasonId: seasonId };
  const lastSale = state.recentSales[0];
  const nominatorName =
    state.teams.find((t) => t.id === state.nominatorTeamId)?.name ?? null;

  return (
    <section
      aria-label="Live draft administration"
      className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-info/30 bg-info/5 px-4 py-2"
    >
      <h2 className="mr-auto text-sm font-semibold">Admin controls</h2>
      {controls.pause ? (
        <ActionForm action={pauseAction} hidden={hidden}>
          <SubmitButton variant="secondary" size="sm" disabled={disabled}>
            Pause auction
          </SubmitButton>
        </ActionForm>
      ) : null}
      {controls.resume ? (
        <ActionForm action={resumeAction} hidden={hidden}>
          <SubmitButton variant="primary" size="sm" disabled={disabled}>
            Resume auction
          </SubmitButton>
        </ActionForm>
      ) : null}
      {controls.voidLot ? (
        <ActionForm action={voidLotAction} hidden={hidden}>
          <SubmitButton
            variant="danger"
            size="sm"
            disabled={disabled}
            confirm={voidLotConfirm({
              playerName: state.nominatedPlayer?.name ?? null,
              nominatorName,
            })}
          >
            Void live lot
          </SubmitButton>
        </ActionForm>
      ) : null}
      {controls.undo ? (
        <ActionForm action={undoAction} hidden={hidden}>
          <SubmitButton
            variant="secondary"
            size="sm"
            disabled={disabled}
            confirm={undoSaleConfirm({
              draftComplete: state.status === "COMPLETE",
              sale: lastSale
                ? {
                    name: lastSale.name,
                    teamName: lastSale.teamName,
                    price: lastSale.price,
                  }
                : null,
            })}
          >
            Undo last sale
          </SubmitButton>
        </ActionForm>
      ) : null}
      <Link href="/admin#adm-captains" className={textLink("text-sm")}>
        More controls
      </Link>
    </section>
  );
}

// The auction's shopping list. Draft night runs on a clock, so captains get
// search, position filters, and sorting instead of one long MMR-sorted list.
function AvailableList({
  state,
  role,
  onRoleChange: setRole,
  canPick,
  selected,
  onPick,
}: {
  state: DraftState;
  /** The position filter, owned by the room (see `poolRole`). */
  role: string | null;
  onRoleChange: (role: string | null) => void;
  /** Rows are pick buttons: on the clock, or lining up the next turn. */
  canPick: boolean;
  selected: string | null;
  onPick: (userId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PoolSort>("mmr");
  const shown = filterAndSortPlayers(state.available, { query, role, sort });
  // The lot's player stays in "Available" until they sell, so say which row it
  // is — otherwise the top of the list reads like nobody is up yet.
  const onBlockId = state.nominatedPlayer?.userId ?? null;

  return (
    <div className="rounded-[var(--radius)] border border-line bg-surface/80">
      <h2 className="border-b border-line px-5 py-3 text-sm font-semibold">
        Available · {state.available.length}
      </h2>
      {state.available.length > 0 ? (
        <div className="space-y-2 border-b border-line/60 p-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search players…"
            aria-label="Search available players"
            className="h-11 w-full rounded-md border border-line bg-surface-2/50 px-2.5 text-sm outline-none focus:border-accent/60 sm:h-9"
          />
          {/* One row at every width, the desktop side column included: the
              three sort chips used to wrap "Name" onto a line of its own. */}
          <div className="flex items-center gap-1">
            <div
              role="group"
              aria-label="Filter by role"
              className="flex items-center gap-1"
            >
              <button
                onClick={() => setRole(null)}
                aria-pressed={role === null}
                className={cn(
                  "min-h-11 rounded-md px-2 py-1 text-xs sm:min-h-9",
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
                  aria-label={r.label}
                  aria-pressed={role === r.key}
                  onClick={() => setRole(role === r.key ? null : r.key)}
                  className={cn(
                    "min-h-11 rounded-md px-2 py-1 text-xs tabular-nums sm:min-h-9",
                    role === r.key
                      ? "bg-accent/20 text-fg ring-1 ring-accent/40"
                      : "text-muted hover:bg-surface-2",
                  )}
                >
                  {r.key}
                </button>
              ))}
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as PoolSort)}
              aria-label="Sort players"
              className="ml-auto h-11 min-w-0 rounded-md border border-line bg-surface-2/50 px-2 text-xs outline-none focus:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/60 sm:h-9"
            >
              <option value="mmr">Sort: MMR</option>
              <option value="rank">Sort: Medal</option>
              <option value="name">Sort: Name</option>
            </select>
          </div>
        </div>
      ) : null}
      {/* Its own scroll box only beside the auction on desktop. On a phone the
          list flows with the page: a scroller inside a scrolling page made a
          swipe move one or the other, unpredictably. */}
      <div className="space-y-1 p-3 lg:max-h-[30rem] lg:overflow-y-auto">
        {shown.map((p) => {
          const onBlock = p.userId === onBlockId;
          const rowContent = (
            <>
              <span className="flex min-w-0 items-center gap-2">
                <Avatar name={p.name} src={p.avatar} size={20} />
                <span className="truncate">{p.name}</span>
                {onBlock ? (
                  <span className="shrink-0">
                    <Badge tone="accent">on the block</Badge>
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
                <RoleBadges roles={p.roles} />
                <RankBadge rankTier={p.rankTier} />
                {p.mmr > 0 ? <span>{p.mmr}</span> : null}
              </span>
            </>
          );
          return (
            // The row body is the nominate button; the profile link is a
            // sibling anchor (never nested inside the button).
            <div
              key={p.userId}
              className={cn(
                "flex items-center rounded-md",
                selected === p.userId
                  ? "bg-accent/15 ring-1 ring-accent/40"
                  : onBlock
                    ? "bg-accent/5"
                    : "",
              )}
            >
              {canPick ? (
                <button
                  type="button"
                  onClick={() => onPick(p.userId)}
                  aria-pressed={selected === p.userId}
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                >
                  {rowContent}
                </button>
              ) : (
                <div className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm">
                  {rowContent}
                </div>
              )}
              <Link
                href={`/players/${p.userId}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`${p.name} profile`}
                title="Open profile in a new tab"
                className="shrink-0 px-2 py-1.5 text-muted hover:text-info"
              >
                ↗
              </Link>
            </div>
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

function RecentSales({ sales }: { sales: FeedEvent[] }) {
  return (
    <div className="rounded-[var(--radius)] border border-line bg-surface/80">
      <h2 className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm font-semibold">
        <span className="animate-live-pulse inline-block h-1.5 w-1.5 rounded-full bg-danger" />
        Recent sales
      </h2>
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        className="max-h-64 space-y-0.5 overflow-y-auto p-3"
      >
        {sales.length === 0 ? (
          <p className="p-2 text-sm text-muted">
            Each player appears here as they&apos;re sold.
          </p>
        ) : (
          sales.map((e) => (
            <div
              key={e.id}
              className="flex items-center justify-between gap-2 rounded-md bg-success/5 px-2 py-1.5 text-sm"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden>✅</span>
                <span className="truncate">{e.text}</span>
                {e.auto ? (
                  <span
                    title="The nominating captain's clock ran out, so the draft put this player up for them."
                    className="shrink-0 text-xs text-muted"
                  >
                    auto-picked
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 font-mono text-xs font-bold tabular-nums text-success">
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
  maxBid,
  forTeamName,
  pending,
  onNominate,
}: {
  state: DraftState;
  selected: string | null;
  nomAmount: number;
  setNomAmount: (n: number) => void;
  /** Opening-bid cap: the nominating TEAM's max bid (an admin has none). */
  maxBid: number;
  /** Set when an admin nominates on behalf of the team on the clock. */
  forTeamName?: string;
  pending: boolean;
  onNominate: (playerId: string, amount: number) => void;
}) {
  const player = state.available.find((p) => p.userId === selected);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Badge tone="accent">
        {forTeamName ? (
          <>Nominating for {forTeamName}</>
        ) : (
          <>You&apos;re on the clock</>
        )}
      </Badge>
      {player ? (
        <span className="flex items-center gap-2 text-sm">
          <Avatar name={player.name} src={player.avatar} size={24} />
          {player.name}
        </span>
      ) : (
        <a
          href="#player-pool"
          className="text-sm text-muted underline decoration-line underline-offset-4 hover:text-fg"
        >
          Pick a player from the pool
          <span className="lg:hidden"> ↓</span>
          <span className="hidden lg:inline"> →</span>
        </a>
      )}
      <div className="ml-auto flex items-center gap-2">
        <label htmlFor="nom-amount" className="text-sm text-muted">
          Opening $
        </label>
        <input
          id="nom-amount"
          type="number"
          min={state.minBid}
          max={maxBid}
          value={nomAmount}
          onChange={(e) => setNomAmount(Number(e.target.value))}
          className="h-9 w-20 rounded-md border border-line bg-surface-2/50 px-2 text-center text-sm"
        />
        <button
          disabled={
            pending ||
            !selected ||
            nomAmount < state.minBid ||
            nomAmount > maxBid
          }
          onClick={() => selected && onNominate(selected, nomAmount)}
          aria-busy={pending}
          className={buttonClasses("accent", "sm")}
        >
          {pending
            ? "Submitting…"
            : forTeamName
              ? `Nominate for ${forTeamName}`
              : "Nominate"}
        </button>
      </div>
    </div>
  );
}

// How the auction works — the learn audience has mostly never drafted this
// way, and every one of these rules was previously discoverable only by being
// burned by it. Static native <details>: accessible by default, no clock leaf.
function AuctionPrimer({
  minBid,
  teamSize,
  defaultOpen,
}: {
  minBid: number;
  teamSize: number;
  defaultOpen: boolean;
}) {
  return (
    <details
      open={defaultOpen || undefined}
      className="rounded-[var(--radius)] border border-line bg-surface/60"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <span aria-hidden>📖</span> How the auction works
        <span className="ml-auto text-xs font-normal text-muted">
          rules &amp; timers
        </span>
      </summary>
      <ul className="space-y-2 border-t border-line/60 px-5 py-4 text-sm text-muted">
        <li>
          <strong className="text-fg">Captains take turns nominating</strong> a
          player from the pool — the order rotates while eligible teams and
          players remain. Players and visitors can follow every lot here.
        </li>
        <li>
          <strong className="text-fg">
            Idle for {DEFAULTS.NOMINATION_TIMER_SECONDS}s on your nomination
          </strong>{" "}
          and the draft auto-nominates the top available player at ${minBid} for
          you — take your time, but not all of it.
        </li>
        <li>
          <strong className="text-fg">
            Every bid resets the {DEFAULTS.BID_TIMER_SECONDS}s clock.
          </strong>{" "}
          When it hits zero, the high bidder wins the player.
        </li>
        <li>
          <strong className="text-fg">
            Nobody left to outbid? {DEFAULTS.UNCONTESTED_BID_TIMER_SECONDS}s.
          </strong>{" "}
          When no other team has an open seat and the money to top the price,
          the clock runs {DEFAULTS.UNCONTESTED_BID_TIMER_SECONDS} seconds
          instead, so late lots don&apos;t sit through{" "}
          {DEFAULTS.BID_TIMER_SECONDS} seconds of waiting.
        </li>
        <li>
          <strong className="text-fg">Your max bid is capped</strong> — the room
          reserves ${minBid} for each seat you&apos;d still have to fill
          afterwards, so you can always finish your roster.
        </li>
        <li>
          <strong className="text-fg">Captains cost $0</strong> (they fill one
          of the {teamSize} roster seats), and leftover budget is worth nothing
          once the draft ends — spend it.
        </li>
      </ul>
    </details>
  );
}

/**
 * Beside a captain's name while presence is tracked: whether they have the
 * draft room open. Words, not just a dot, so it reads without colour and to
 * a screen reader. A captain who isn't here never bids, and the draft
 * nominates for them when their clock runs out.
 */
function InRoomMark({ inRoom }: { inRoom: boolean }) {
  return (
    <span
      title={
        inRoom
          ? "Has the draft room open"
          : `Hasn't had the draft room open in the last ${DRAFT_PRESENCE.AWAY_SECONDS} seconds`
      }
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[10px] font-medium",
        inRoom ? "text-success" : "text-muted",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          inRoom ? "bg-success" : "border border-current",
        )}
      />
      {inRoom ? "in room" : "not in room"}
    </span>
  );
}

function TeamsGrid({
  state,
  showNominationOrder = false,
}: {
  state: DraftState;
  /** Waiting room: label each card with its place in the opening order. */
  showNominationOrder?: boolean;
}) {
  // A player is up for auction → the "max bid" lines can flag who's priced
  // out. Outside a live lot there is nothing to bid on, so the cards show just
  // the budget (a waiting-room "max $77" meant nothing to anyone).
  const nominationLive = !!state.nominatedPlayer;
  const finished = state.status === "COMPLETE";
  return (
    <section
      aria-label="Team rosters"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2"
    >
      {state.teams.map((t, i) => {
        // Only while the team still has to nominate — during a live lot the
        // ring and badge belong to the high bidder, not whoever put it up.
        const onClock = nominationTurnTeamId(state) === t.id;
        const highBid = t.id === state.currentBidTeamId;
        // Derived from the roster, not me.myTeamId (that's captain-only) —
        // drafted players get a persistent home marker too.
        const isMyTeam =
          !!state.me.userId &&
          t.members.some((m) => m.userId === state.me.userId);
        // The most this team can still bid on the current player while
        // reserving the minimum for its remaining empty slots.
        const cap = maxBid(
          { id: t.id, budget: t.budget, rosterCount: t.members.length },
          state.teamSize,
          state.minBid,
        );
        const openSeats = openSeatsLabel(t.need);
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
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2 font-display text-base font-semibold">
                  <TeamCrest
                    name={t.name}
                    seed={t.id}
                    logoUrl={t.logoUrl}
                    size={22}
                    className="shrink-0 rounded-md"
                  />
                  <Link
                    href={`/teams/${t.id}`}
                    target={finished ? undefined : "_blank"}
                    rel={finished ? undefined : "noreferrer"}
                    className="truncate hover:text-info hover:underline"
                  >
                    {t.name}
                  </Link>
                  {onClock ? (
                    <span className="shrink-0">
                      <Badge tone="accent">on clock</Badge>
                    </span>
                  ) : null}
                  {isMyTeam ? (
                    <span className="shrink-0">
                      <Badge tone="info">Your team</Badge>
                    </span>
                  ) : null}
                  {highBid ? (
                    <span className="shrink-0">
                      <Badge tone="success">high bid</Badge>
                    </span>
                  ) : null}
                </div>
                <div className="text-xs text-muted">
                  {/* state.teams is in draft order, which is the order
                      Start draft hands out the opening nominations. */}
                  {showNominationOrder ? (
                    <>
                      <span className="font-medium text-fg">
                        {nominationOrderLabel(i)}
                      </span>
                      {" · "}
                    </>
                  ) : null}
                  {t.members.length}/{state.teamSize} players
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {/* Once the auction is over, leftover budget is worth
                    nothing; what a team spent is the number people compare
                    (purchases only, like the recap's spend totals). */}
                {finished ? (
                  <Badge title="What this team spent at the auction">
                    $
                    {t.members.reduce(
                      (sum, m) => sum + (m.isCaptain ? 0 : m.price),
                      0,
                    )}{" "}
                    spent
                  </Badge>
                ) : (
                  <Badge
                    tone="accent"
                    title={
                      state.budgetsProjected
                        ? "Projected starting budget; finalized when the auction starts"
                        : "Remaining auction budget"
                    }
                  >
                    ${t.budget}
                    {state.budgetsProjected ? " projected" : null}
                  </Badge>
                )}
                {!nominationLive ? null : t.need === 0 ? (
                  <span className="text-[10px] text-muted">full</span>
                ) : (
                  <span
                    className={cn(
                      "text-[10px] tabular-nums",
                      cap <= state.currentBid ? "text-danger" : "text-muted",
                    )}
                  >
                    max ${cap}
                  </span>
                )}
              </div>
            </div>
            <div className="space-y-1 p-3">
              {/* Captain first, then purchases — never a price sort, which put
                  the $0 captain below the players they bought. */}
              {rosterDisplayOrder(t.members).map((m) => (
                <div
                  key={m.userId}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar name={m.name} src={m.avatar} size={20} />
                    <PlayerLink userId={m.userId} className="min-w-6 truncate">
                      {m.name}
                    </PlayerLink>
                    {m.isCaptain ? (
                      <span className="shrink-0">
                        <Badge tone="accent">C</Badge>
                      </span>
                    ) : null}
                    {m.userId === t.captainId && t.captainInRoom !== null ? (
                      <InRoomMark
                        inRoom={
                          t.captainInRoom || t.captainId === state.me.userId
                        }
                      />
                    ) : null}
                    <RankBadge rankTier={m.rankTier} />
                  </span>
                  <span className="shrink-0 text-muted">
                    {m.isCaptain ? "—" : `$${m.price}`}
                  </span>
                </div>
              ))}
              {/* One line for every open seat: five "Empty slot" rows per card
                  made six teams about 1,500px tall on a phone. */}
              {openSeats ? (
                <div className="py-1 text-sm text-muted">{openSeats}</div>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}
