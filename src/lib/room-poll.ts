import {
  DRAFT_ROOM,
  INHOUSE,
  INHOUSE_STATUS,
  ROOM_POLL_FAIL_THRESHOLD,
  ROOM_POLL_TIMEOUT_MS,
} from "./constants";
import { inhouseReadyInPlay } from "./inhouse";

/**
 * The poll cadence for both live rooms.
 *
 * Each room's loop asks twice per tick: before it fetches (is this tick worth a
 * request?) and again once the response settles (how long until the next one?).
 * It is the most consequential logic in two ~1800-line client components, and
 * it lived inside their `useEffect`s where the vitest project — `environment:
 * node`, no jsdom — cannot reach it.
 *
 * ONE machine, two bindings. The rooms want the same four rules in the same
 * precedence order, but they differ in their RATES and in what counts as
 * "worth polling fast", so the shape below takes those as inputs rather than
 * pretending one number fits both:
 *
 *   - `hasStake` — does THIS VIEWER need a hidden tab to keep polling? Queued
 *     or in a lobby (inhouse); a captain, an admin, or a player still in the
 *     pool (draft). It gates the hidden-tab keepalive in both.
 *   - `active` — is the ROOM in a second-sensitive phase? For the draft that is
 *     the auction being IN_PROGRESS or PAUSED, while a captain staring at a
 *     finished draft is not (the draft binding then picks the rate by role:
 *     captains and admins fast, watchers at POLL_WATCH_MS). For the inhouse room the two coincide (the lobby only
 *     matters to its members), so its binding passes `hasStake` for both.
 *
 * The four rules, in the order they take precedence:
 *
 * 1. **429 is not a failure — it is a signal to ease off.** Public polling
 *    buckets can be shared by a household/NAT, and deployments can apply
 *    additional upstream limits. Treating back-pressure as a disconnect
 *    greys out second-sensitive actions while retrying fast can keep the
 *    window saturated. Easing off is what lets the next request through.
 * 2. **Offline means no request.** The browser wakes the loop immediately on
 *    `online`; scheduled checks are only a fallback for unreliable events.
 * 3. **A hidden tab WITH a stake keepalives; without one it does not fetch.**
 *    Queued or in a lobby, the poll IS the presence heartbeat (and carries the
 *    ready-check chime and the tab title), so it must outrun QUEUE_AWAY_SECONDS
 *    even after Chrome clamps background timers. A hidden spectator is pure
 *    cost: authenticated participants and the leased worker advance lobbies.
 *    Exception: `coldStart`, below.
 * 4. **Failures retry fast through the disconnect threshold; then back off.**
 *    That diagnoses a broken connection promptly without synchronizing every
 *    parked client into a request storm for the duration of an outage.
 * 5. Otherwise: fast while the room is active, idle when it is not.
 *
 * Callers must re-read `document.visibilityState` at the moment they ask, not
 * from a snapshot taken before the fetch — a tab refocused mid-request has to
 * reschedule at the active rate rather than the keepalive.
 */
export type RoomPollRates = {
  /** The room's fast cadence (its `pollMs` prop). */
  activeMs: number;
  /** Nothing at stake, nothing happening. */
  idleMs: number;
  /** Hidden tab belonging to someone with a stake. */
  keepaliveMs: number;
  /** After a 429. */
  rateLimitedMs: number;
  /** After a poll that did not land (failed, aborted, never attempted). */
  retryMs: number;
  /** Ceiling for disconnected/offline retry backoff. */
  maxRetryMs: number;
  /**
   * The shortest backed-off retry once a room counts as disconnected.
   * Defaults to `idleMs`, so a backed-off retry is never faster than idling.
   */
  retryFloorMs?: number;
};

export type RoomPollInput = {
  /** `document.visibilityState === "hidden"`, read when this is called. */
  hidden: boolean;
  /** Does this VIEWER need a hidden tab to keep polling? */
  hasStake: boolean;
  /** Is the ROOM in a second-sensitive phase? Defaults to `hasStake`. */
  active?: boolean;
  /** The response was a 429 from the route's applicable state/action bucket. */
  rateLimited?: boolean;
  /** A payload came back (false = failed, aborted, or not attempted). */
  reached?: boolean;
  /** Browser reports no network connectivity. */
  offline?: boolean;
  /** Consecutive non-429 failures for disconnected backoff. */
  failureCount?: number;
  /** Deterministic 0..1 jitter seam for tests; runtime defaults to Math.random. */
  jitter?: number;
  /**
   * No request has EVER left this room. Both rooms learn `hasStake` from a
   * payload, so before the first one it is `false` for everybody — and a tab
   * that is HIDDEN at load (cmd-clicked, or restored with the session) would
   * therefore skip forever, leaving a captain with no keepalive, no tab-title
   * flag and no chime until they happened to look at it. One cold fetch is
   * enough to learn the answer; it is keyed off "nothing issued yet" rather
   * than "nothing applied yet" so a room that cannot reach the server does not
   * turn into an unbounded background retry loop.
   */
  coldStart?: boolean;
};

export type RoomPollCadence = {
  /** Don't fetch at all this tick — just wait `delayMs` and re-check. */
  skip: boolean;
  delayMs: number;
};

export function roomPollCadence(
  o: RoomPollInput,
  rates: RoomPollRates,
): RoomPollCadence {
  if (o.rateLimited) return { skip: false, delayMs: rates.rateLimitedMs };
  if (o.offline) return { skip: true, delayMs: rates.maxRetryMs };
  // An unknown stake counts as a stake, exactly once — see `coldStart`.
  const stake = o.hasStake || !!o.coldStart;
  if (o.hidden) {
    return stake
      ? { skip: false, delayMs: rates.keepaliveMs }
      : { skip: true, delayMs: rates.idleMs };
  }
  if (o.reached === false) {
    const failures = o.failureCount ?? 1;
    if (failures <= ROOM_POLL_FAIL_THRESHOLD) {
      return { skip: false, delayMs: rates.retryMs };
    }
    const exponent = Math.min(10, failures - ROOM_POLL_FAIL_THRESHOLD);
    const base = Math.min(
      rates.maxRetryMs,
      Math.max(rates.retryFloorMs ?? rates.idleMs, rates.retryMs * 2 ** exponent),
    );
    const jitter = Math.min(1, Math.max(0, o.jitter ?? Math.random()));
    return {
      skip: false,
      delayMs: Math.min(
        rates.maxRetryMs,
        Math.round(base * (0.8 + 0.4 * jitter)),
      ),
    };
  }
  const active = o.active ?? o.hasStake;
  return { skip: false, delayMs: active ? rates.activeMs : rates.idleMs };
}

/** What the inhouse room knows about the game whose phase sets its pace. */
export type InhouseRoomPhaseInput = {
  /** Undefined preserves the cold-start rate before the first snapshot. */
  lobbyStatus?: string | null;
  /** `lobby.scanOpensAt` from the last snapshot. */
  scanOpensAt?: number | null;
  /** The server clock of the last snapshot. */
  serverNow?: number | null;
  /**
   * The viewer plays in the game `lobbyStatus` describes (`me.inLobby`).
   * False for a queued player shown another game. Defaults to true, so a
   * game the caller can't attribute polls as the player's own.
   */
  inLobby?: boolean;
};

/**
 * The phase as both inhouse bindings read it. `timedPhase`: a ready check,
 * vote, draft or game setup (READY until it is plausibly being played,
 * inhouseReadyInPlay), or nothing known yet. `clocked`: one of the first
 * three, where a deadline runs. `playing`: the viewer's own game is being
 * played. `ownLobby`: the game is the viewer's.
 */
function inhouseRoomPhase(o: InhouseRoomPhaseInput) {
  const readyInPlay = inhouseReadyInPlay(
    o.lobbyStatus,
    o.scanOpensAt,
    o.serverNow,
  );
  const timedPhase =
    o.lobbyStatus === undefined ||
    (!readyInPlay &&
      [
        INHOUSE_STATUS.READY_CHECK,
        INHOUSE_STATUS.CAPTAIN_VOTE,
        INHOUSE_STATUS.DRAFTING,
        INHOUSE_STATUS.READY,
      ].some((status) => status === o.lobbyStatus));
  const inGame =
    !timedPhase &&
    (readyInPlay || o.lobbyStatus === INHOUSE_STATUS.IN_PROGRESS);
  const ownLobby = o.lobbyStatus != null && o.inLobby !== false;
  const setup = timedPhase && o.lobbyStatus === INHOUSE_STATUS.READY;
  const clocked = timedPhase && !setup && o.lobbyStatus != null;
  return { timedPhase, setup, clocked, playing: inGame && ownLobby, ownLobby };
}

/**
 * The FALLBACK ladder (the long-poll is below): what a request that can't be
 * held waits before the next one. Membership controls background updates;
 * the phase controls foreground speed. Only ready checks, captain votes and
 * draft picks need the fast rate. Game setup (READY) is timed only in that it
 * ends: it polls at `POLL_SETUP_MS` (or a slower `activeMs`), and ends when a
 * READY lobby is plausibly being played (inhouseReadyInPlay): Start is
 * optional, so a game hosted by hand stays READY for its whole length and
 * must poll at the game rate like IN_PROGRESS.
 *
 * Every other state is a long wait, so it polls slower: every request is CPU
 * on the one box both leagues share (constants.ts). Whose game `lobbyStatus`
 * describes decides which wait it is. A player in their own game waits on
 * nothing timed (`POLL_GAME_MS`; `POLL_GAME_KEEPALIVE_MS` hidden, while they
 * are in the Dota client). A queued player sees someone else's game
 * (`pollingLobby`) but is waiting for their own lobby to form:
 * `POLL_QUEUE_MS`, or the fast rate while that game drafts, and
 * `POLL_QUEUE_KEEPALIVE_MS` hidden, which only the accept window binds. A
 * spectator idles at `POLL_IDLE_MS`.
 */
export function inhousePollCadence(
  o: Omit<RoomPollInput, "active"> &
    InhouseRoomPhaseInput & {
      activeMs: number;
      idleMs?: number;
    },
): RoomPollCadence {
  const idleMs = o.idleMs ?? INHOUSE.POLL_IDLE_MS;
  const { timedPhase, setup, playing, ownLobby } = inhouseRoomPhase(o);
  const activeMs = timedPhase
    ? setup
      ? Math.max(o.activeMs, INHOUSE.POLL_SETUP_MS)
      : o.activeMs
    : playing
      ? INHOUSE.POLL_GAME_MS
      : INHOUSE.POLL_QUEUE_MS;
  const keepaliveMs =
    o.lobbyStatus === undefined || (timedPhase && ownLobby)
      ? INHOUSE.POLL_KEEPALIVE_MS
      : playing
        ? INHOUSE.POLL_GAME_KEEPALIVE_MS
        : INHOUSE.POLL_QUEUE_KEEPALIVE_MS;
  return roomPollCadence(o, {
    activeMs,
    idleMs,
    keepaliveMs,
    // The inhouse route has no separate back-off rate. A 429's back-off and
    // a disconnected room's first backed-off retry are never faster than
    // idling.
    rateLimitedMs: INHOUSE.POLL_RECOVERY_MS,
    retryFloorMs: INHOUSE.POLL_RECOVERY_MS,
    retryMs: o.activeMs,
    maxRetryMs: 30_000,
  });
}

/** A state request the server may hold: what it sends, and its deadline. */
export type InhouseLongPoll = {
  /** The `roomVersion` of the last poll reply the room applied. */
  since: string;
  /**
   * The server clock of the reply the room shows (`serverNow`), or null.
   * The server answers at once when one of the room's clocks ran out after
   * it (parseInhouseHold, inhouseRoomWakeAt's `fromMs`), so a reply from
   * before a deadline or a result window never sits out a hold.
   */
  sinceNow: number | null;
  /** How long the server may hold it (it caps this at LONG_POLL_HOLD_MS). */
  holdMs: number;
  /** The request's own deadline: the hold plus ROOM_POLL_TIMEOUT_MS. */
  timeoutMs: number;
};

/**
 * Whether the room's next state request is a LONG-POLL, and for how long.
 * The server holds a request that sends back the version of the reply the
 * room shows until the room changes, so a change reaches every open tab in
 * well under a second, at about one request per change.
 *
 * Null, and the request answers at once on the fallback ladder, when:
 * - the last applied reply carried no `version` (the first request, or an
 *   old slot during a release, which doesn't know `since`): never hot-loop
 *   on a server that answers at once;
 * - something waits on an answer now (`urgent`: a resync after going
 *   offline, an action in flight or awaiting reconciliation, whose controls
 *   stay locked until a reply lands, or a refocus after a long hide,
 *   inhouseRefocusResync);
 * - the last request failed: a retry must be quick to diagnose.
 *
 * A member in their own game's clocked stages asks for the shorter
 * LONG_POLL_TIMED_HOLD_MS, so a held request that silently died there is
 * given up on, and the fast retries begin, 15s sooner; everyone else asks
 * for LONG_POLL_HOLD_MS. The cost of holding: usePollHealth says
 * "Connection lost" only at ROOM_POLL_FAIL_THRESHOLD failures in a row, and
 * the first held one takes its hold plus ROOM_POLL_TIMEOUT_MS, so a dead
 * connection shows after about 43s in a clocked stage and 58s elsewhere,
 * against about 34-43s on the ladder (room-poll.test.ts states it, and
 * docs/DECISIONS.md's 2026-10-18 row accepts it).
 */
export function inhouseLongPoll(
  o: InhouseRoomPhaseInput & {
    version: string | null | undefined;
    urgent: boolean;
    failureCount?: number;
  },
): InhouseLongPoll | null {
  if (typeof o.version !== "string" || o.version.length === 0) return null;
  if (o.urgent || (o.failureCount ?? 0) > 0) return null;
  const { clocked, ownLobby } = inhouseRoomPhase(o);
  const holdMs =
    clocked && ownLobby
      ? INHOUSE.LONG_POLL_TIMED_HOLD_MS
      : INHOUSE.LONG_POLL_HOLD_MS;
  return {
    since: o.version,
    sinceNow:
      typeof o.serverNow === "number" && Number.isFinite(o.serverNow)
        ? o.serverNow
        : null,
    holdMs,
    timeoutMs: holdMs + ROOM_POLL_TIMEOUT_MS,
  };
}

/**
 * Long-poll replies in a row that came back UNHELD: the room had already
 * moved past the `since` the request sent, so the server answered at once
 * (the reply's `held` is false). A reply that was held resets it to 0. A
 * request that sent no `since` (`askedHold` false: the first, a retry, an
 * urgent one), or a reply that doesn't say (an old slot), leaves it as it
 * was: neither is news about how fast the room moves.
 */
export function inhouseUnheldStreak(
  prev: number,
  o: { askedHold: boolean; held: unknown },
): number {
  if (!o.askedHold || typeof o.held !== "boolean") return prev;
  return o.held ? 0 : prev + 1;
}

/**
 * The shortest wait between the starts of two long-poll requests. Normally
 * LONG_POLL_MIN_GAP_MS (1s). Every publish wakes every held tab, refused
 * and no-op mutations included, so one writer that keeps the version moving
 * (any signed-in account pressing Leave while not queued, up to the route's
 * 300 mutations a minute) would hold every visible tab at one request a
 * second, where the ladder costs one per 3-10s. Churn faster than the 1s gap
 * comes back unheld: from the second unheld reply in a row (`unheldStreak`,
 * inhouseUnheldStreak) the gap doubles per reply, up to the ladder rate for
 * the current phase (inhousePollCadence); a held reply puts it back to 1s.
 * A writer paced just slower than the gap (a no-op every 1-2s) gets every
 * request held and woken, so it still holds tabs at about one request a
 * second, bounded only by LONG_POLL_MIN_GAP_MS: accepted, since one client
 * can cost as much by polling directly within the per-IP state limit. A member in their own game's clocked stage
 * (ready check, vote, draft) keeps 1s: their changes come seconds apart and
 * each one is a deadline.
 */
export function inhouseLongPollGapMs(
  o: Parameters<typeof inhousePollCadence>[0] & { unheldStreak?: number },
): number {
  const min = INHOUSE.LONG_POLL_MIN_GAP_MS;
  const streak = Math.max(0, Math.floor(o.unheldStreak ?? 0));
  if (streak < 2) return min;
  const { clocked, ownLobby } = inhouseRoomPhase(o);
  if (clocked && ownLobby) return min;
  const ladder = inhousePollCadence(o).delayMs;
  const doubled = min * 2 ** Math.min(10, streak - 1);
  return Math.max(min, Math.min(ladder, doubled));
}

/**
 * How long the room waits after a state request settles before the next
 * one. A request that can long-poll next (`longPoll`: inhouseLongPoll was
 * not null) goes straight away, 0, which the room issues from the reply's
 * own continuation rather than a timer (hidden tabs clamp timers): no more
 * often than the long-poll gap (inhouseLongPollGapMs: LONG_POLL_MIN_GAP_MS,
 * longer while replies keep coming back unheld) after the previous one
 * started (`startedAgoMs`), so a version that keeps moving can't hot-loop.
 * Every other case, and every request that didn't land, a 429, offline and
 * a hidden tab with nothing at stake, waits on the ladder
 * (inhousePollCadence).
 */
export function inhousePollDelay(
  o: Parameters<typeof inhousePollCadence>[0] & {
    longPoll: boolean;
    startedAgoMs: number;
    /** inhouseUnheldStreak's count; absent, 0. */
    unheldStreak?: number;
  },
): number {
  const ladder = inhousePollCadence(o).delayMs;
  if (
    !o.longPoll ||
    o.rateLimited ||
    o.reached === false ||
    o.offline ||
    (o.hidden && !o.hasStake)
  ) {
    return ladder;
  }
  return Math.max(0, inhouseLongPollGapMs(o) - Math.max(0, o.startedAgoMs));
}

/**
 * Whether a tab coming back into view must ask afresh, unheld: after a hide
 * of ROOM_POLL_TIMEOUT_MS or more (a sleep, a phone in a pocket), a held
 * request may have died with its connection and given no sign (no `offline`
 * event, no reset), and its own deadline is up to its hold plus
 * ROOM_POLL_TIMEOUT_MS away (35s). The room releases it and sends one
 * unheld request, which restores the ladder's 10s bound on a refocus; a
 * quick alt-tab out of Dota costs nothing. `hiddenForMs` null: the tab
 * wasn't seen hidden.
 */
export function inhouseRefocusResync(hiddenForMs: number | null): boolean {
  return hiddenForMs !== null && hiddenForMs >= ROOM_POLL_TIMEOUT_MS;
}

/**
 * `controller`'s signal, which also aborts at `timeoutMs`
 * (AbortSignal.timeout): a room poll's deadline, plus a release the room can
 * pull (an action, a connectivity change, the loop's cleanup). Both rooms
 * poll through it. AbortSignal.any would do it, but older Safari lacks it.
 */
export function withDeadline(
  controller: AbortController,
  timeoutMs: number,
): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  deadline.addEventListener(
    "abort",
    () => controller.abort(deadline.reason),
    { once: true },
  );
  return controller.signal;
}

/**
 * Whether a draft-room tab polls the moment a clock it shows reaches zero.
 * Only a signed-in poll can settle the lot (the tick route runs the resolvers
 * for those alone), and only a captain or an admin has controls waiting on
 * the result: the next nomination, a re-bid, the admin tools. Every other tab
 * (signed out, a spectator, a player in the pool, a drafted player) catches
 * the sale on its next scheduled poll, at most POLL_WATCH_MS later. When every
 * signed-in tab polled at zero, a full US room sent about 63 polls at once per
 * sale, about 2.2 s of the box's one vCPU each time (audit 2026-10-17).
 */
export function draftPollsAtClockZero(viewer: {
  signedIn: boolean;
  /** A captain or an admin: the same test as draftPollCadence's `canAct`. */
  canAct: boolean;
}): boolean {
  return viewer.signedIn && viewer.canAct;
}

/**
 * The draft room's binding. Its "active" is the AUCTION's phase (PAUSED counts
 * as live, so a resume is caught at once), and its RATE is the viewer's role:
 * captains and admins, who act on a live lot, poll at the room's 2s; every
 * other viewer (a spectator, a player in the pool, a drafted player) at
 * POLL_WATCH_MS (5s). Every poll is a function call on the hosting budget
 * both leagues share (constants.ts); a bid resets a 30s clock, so a captain
 * still sees it with most of the clock left, and a watcher a few seconds on.
 */
export function draftPollCadence(
  o: Omit<RoomPollInput, "active"> & {
    /** `status === "IN_PROGRESS" || status === "PAUSED"`. */
    live: boolean;
    activeMs: number;
    /** A captain or an admin. Unknown (before the first payload) counts as
     *  acting, so nobody starts slow. */
    canAct?: boolean;
  },
): RoomPollCadence {
  const acts = o.canAct ?? true;
  const activeMs = acts
    ? o.activeMs
    : Math.max(o.activeMs, DRAFT_ROOM.POLL_WATCH_MS);
  return roomPollCadence(
    { ...o, active: o.live },
    {
      activeMs,
      idleMs: acts ? DRAFT_ROOM.POLL_IDLE_MS : DRAFT_ROOM.POLL_WATCH_IDLE_MS,
      keepaliveMs: acts
        ? DRAFT_ROOM.POLL_KEEPALIVE_MS
        : DRAFT_ROOM.POLL_WATCH_KEEPALIVE_MS,
      rateLimitedMs: DRAFT_ROOM.POLL_RATE_LIMITED_MS,
      // Rule 3, and a deliberate change from what this room used to do: it read
      // its cadence off `live`, which is re-initialised false on every tick and
      // only set inside the ok branch — so a FAILED poll in a live auction
      // dropped the room to the waiting-room rate for the whole outage. That
      // put the recovery poll 2.5x further away and doubled the time to flip
      // `disconnected`, which is the safety gate that disables bidding on
      // stale state.
      retryMs: activeMs,
      maxRetryMs: 30_000,
    },
  );
}
