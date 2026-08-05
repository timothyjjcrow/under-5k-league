import { DRAFT_ROOM, INHOUSE, ROOM_POLL_FAIL_THRESHOLD } from "./constants";

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
 *     the auction being IN_PROGRESS or PAUSED — a spectator watching a live
 *     lot still needs 1.2s polling, while a captain staring at a finished
 *     draft does not. For the inhouse room the two coincide (the lobby only
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
      Math.max(rates.idleMs, rates.retryMs * 2 ** exponent),
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
 * The inhouse room's binding. Its "active" IS the viewer's membership: five
 * people watching a 45-minute game were each firing 40 req/min because a lobby
 * existed, while anyone IN the queue must stay fast — a filling queue is
 * exactly when responsiveness decides whether a game happens.
 */
export function inhousePollCadence(
  o: Omit<RoomPollInput, "active"> & { activeMs: number; idleMs?: number },
): RoomPollCadence {
  const idleMs = o.idleMs ?? INHOUSE.POLL_IDLE_MS;
  return roomPollCadence(o, {
    activeMs: o.activeMs,
    idleMs,
    keepaliveMs: INHOUSE.POLL_KEEPALIVE_MS,
    // The inhouse route has no separate back-off rate; its idle rate is
    // already 10s, which drains the window.
    rateLimitedMs: idleMs,
    retryMs: o.activeMs,
    maxRetryMs: 30_000,
  });
}

/**
 * The draft room's binding. Its "active" is the AUCTION's phase, not the
 * viewer's — a spectator watching a live lot still needs the 1.2s cadence, and
 * PAUSED counts as live so a resume is caught immediately rather than up to
 * three seconds later.
 */
export function draftPollCadence(
  o: Omit<RoomPollInput, "active"> & {
    /** `status === "IN_PROGRESS" || status === "PAUSED"`. */
    live: boolean;
    activeMs: number;
  },
): RoomPollCadence {
  return roomPollCadence(
    { ...o, active: o.live },
    {
      activeMs: o.activeMs,
      idleMs: DRAFT_ROOM.POLL_IDLE_MS,
      keepaliveMs: DRAFT_ROOM.POLL_KEEPALIVE_MS,
      rateLimitedMs: DRAFT_ROOM.POLL_RATE_LIMITED_MS,
      // Rule 3, and a deliberate change from what this room used to do: it read
      // its cadence off `live`, which is re-initialised false on every tick and
      // only set inside the ok branch — so a FAILED poll in a live auction
      // dropped the room to the waiting-room rate for the whole outage. That
      // put the recovery poll 2.5x further away and doubled the time to flip
      // `disconnected`, which is the safety gate that disables bidding on
      // stale state.
      retryMs: o.activeMs,
      maxRetryMs: 30_000,
    },
  );
}
