import { DRAFT_ROOM, INHOUSE, INHOUSE_STATUS, ROOM_POLL_FAIL_THRESHOLD } from "./constants";
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

/**
 * Membership controls background updates; the phase controls foreground speed.
 * Only ready checks, captain votes and draft picks need the fast rate. Game
 * setup (READY) is timed only in that it ends: it polls at `POLL_SETUP_MS`
 * (or a slower `activeMs`), and ends when a READY lobby is plausibly being
 * played (inhouseReadyInPlay): Start is optional, so a game hosted by hand
 * stays READY for its whole length and must poll at the game rate like
 * IN_PROGRESS.
 *
 * Every other state is a long wait, so it polls slowly: each poll is a
 * function call on the Vercel Hobby plan both leagues share (constants.ts).
 * Whose game `lobbyStatus` describes decides which wait it is. A player in
 * their own game waits on nothing timed (`POLL_GAME_MS`, hidden or not). A
 * queued player sees someone else's game (`pollingLobby`) but is waiting for
 * their own lobby to form: `POLL_QUEUE_MS`, or the fast rate while that game
 * drafts, and `POLL_QUEUE_KEEPALIVE_MS` hidden, which only the accept window
 * binds. A spectator idles at `POLL_IDLE_MS`.
 */
export function inhousePollCadence(
  o: Omit<RoomPollInput, "active"> & {
    activeMs: number;
    idleMs?: number;
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
  },
): RoomPollCadence {
  const idleMs = o.idleMs ?? INHOUSE.POLL_IDLE_MS;
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
  const playing = inGame && ownLobby;
  const setup = timedPhase && o.lobbyStatus === INHOUSE_STATUS.READY;
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
        ? INHOUSE.POLL_GAME_MS
        : INHOUSE.POLL_QUEUE_KEEPALIVE_MS;
  return roomPollCadence(o, {
    activeMs,
    idleMs,
    keepaliveMs,
    // The inhouse route has no separate back-off rate. These two keep the
    // 10s they had when the idle rate was 10s, so the slower spectator rate
    // never slows a recovery.
    rateLimitedMs: INHOUSE.POLL_RECOVERY_MS,
    retryFloorMs: INHOUSE.POLL_RECOVERY_MS,
    retryMs: o.activeMs,
    maxRetryMs: 30_000,
  });
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
