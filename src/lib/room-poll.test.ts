import { describe, expect, it } from "vitest";
import {
  draftPollCadence,
  inhouseLongPoll,
  inhousePollCadence,
  inhousePollDelay,
} from "./room-poll";
import {
  DEFAULTS,
  DRAFT_ROOM,
  INHOUSE,
  INHOUSE_STATUS,
  ROOM_POLL_FAIL_THRESHOLD,
  ROOM_POLL_TIMEOUT_MS,
} from "./constants";

// Two ~1800-line client components' poll loops, with no unit-testable surface
// of their own (the vitest env is `node` — no jsdom), so these rules were
// asserted only by whatever a browser spec happened to reach. They are the
// difference between a queue spot held and a lobby lost, and between a captain
// seeing "reconnecting" and a captain bidding into a dead socket.

describe("inhousePollCadence", () => {
  const FAST = 1500;
  const IDLE = 10000;
  const base = { activeMs: FAST, idleMs: IDLE, reached: true };

  it("slows waiting queue refreshes while preserving every timed action phase", () => {
    expect(inhousePollCadence({
      ...base, hidden: false, hasStake: true, lobbyStatus: null,
    })).toEqual({ skip: false, delayMs: INHOUSE.POLL_QUEUE_MS });
    for (const lobbyStatus of [INHOUSE_STATUS.READY_CHECK, INHOUSE_STATUS.CAPTAIN_VOTE, INHOUSE_STATUS.DRAFTING]) {
      expect(inhousePollCadence({
        ...base, hidden: false, hasStake: true, lobbyStatus,
      })).toEqual({ skip: false, delayMs: FAST });
    }
    // Game setup has no clock: ten people joining a Dota lobby.
    expect(inhousePollCadence({
      ...base, hidden: false, hasStake: true, lobbyStatus: INHOUSE_STATUS.READY,
    })).toEqual({ skip: false, delayMs: INHOUSE.POLL_SETUP_MS });
    // Waiting is a long state: a queue that takes an afternoon to fill must
    // not poll like a ready check (the one box both leagues share,
    // constants.ts), yet the fallback still shows a forming ready check
    // within seconds of its 90s window.
    expect(INHOUSE.POLL_QUEUE_MS).toBeGreaterThan(FAST);
    expect(INHOUSE.POLL_QUEUE_MS).toBeLessThanOrEqual(5_000);
  });

  it("refreshes a player's own game in progress at the game rate, slower once hidden", () => {
    expect(inhousePollCadence({
      ...base, hidden: false, hasStake: true, inLobby: true,
      lobbyStatus: INHOUSE_STATUS.IN_PROGRESS,
    })).toEqual({ skip: false, delayMs: INHOUSE.POLL_GAME_MS });
    // Hidden: all ten players are in the Dota client.
    expect(inhousePollCadence({
      ...base, hidden: true, hasStake: true, inLobby: true,
      lobbyStatus: INHOUSE_STATUS.IN_PROGRESS,
    })).toEqual({ skip: false, delayMs: INHOUSE.POLL_GAME_KEEPALIVE_MS });
    // Nothing in a game is timed: slower than the queue, faster hidden-less.
    expect(INHOUSE.POLL_GAME_MS).toBeGreaterThan(INHOUSE.POLL_QUEUE_MS);
    expect(INHOUSE.POLL_GAME_KEEPALIVE_MS).toBeGreaterThan(INHOUSE.POLL_GAME_MS);
  });

  it("polls a queued player by their queue, not by the game they are shown", () => {
    // pollingLobby hands a queued player someone else's game. They wait for
    // their OWN lobby to form, so that game in progress must not slow them to
    // the game rate, and its draft only speeds up a tab they are watching.
    const queued = { ...base, hasStake: true, inLobby: false };
    expect(inhousePollCadence({
      ...queued, hidden: false, lobbyStatus: INHOUSE_STATUS.IN_PROGRESS,
    })).toEqual({ skip: false, delayMs: INHOUSE.POLL_QUEUE_MS });
    expect(inhousePollCadence({
      ...queued, hidden: false, lobbyStatus: INHOUSE_STATUS.DRAFTING,
    })).toEqual({ skip: false, delayMs: FAST });
    for (const lobbyStatus of [null, INHOUSE_STATUS.IN_PROGRESS, INHOUSE_STATUS.DRAFTING, INHOUSE_STATUS.READY_CHECK]) {
      expect(inhousePollCadence({ ...queued, hidden: true, lobbyStatus })).toEqual({
        skip: false, delayMs: INHOUSE.POLL_QUEUE_KEEPALIVE_MS,
      });
    }
  });

  it("keeps a hidden player in a timed stage of their own game on the vote-safe keepalive", () => {
    for (const lobbyStatus of [INHOUSE_STATUS.READY_CHECK, INHOUSE_STATUS.CAPTAIN_VOTE, INHOUSE_STATUS.DRAFTING, INHOUSE_STATUS.READY]) {
      for (const inLobby of [true, undefined]) {
        expect(inhousePollCadence({
          ...base, hidden: true, hasStake: true, inLobby, lobbyStatus,
        })).toEqual({ skip: false, delayMs: INHOUSE.POLL_KEEPALIVE_MS });
      }
    }
  });

  it("polls a READY game at the game rate once it is plausibly being played", () => {
    // Start is optional, so a game hosted by hand is READY for its whole
    // length. Setup (POLL_SETUP_MS) ends when the result scan's window opens.
    const scanOpensAt = Date.UTC(2026, 8, 28, 20, 15);
    const ready = { ...base, hidden: false, hasStake: true, lobbyStatus: INHOUSE_STATUS.READY, scanOpensAt };
    expect(inhousePollCadence({ ...ready, serverNow: scanOpensAt - 1 })).toEqual({
      skip: false, delayMs: INHOUSE.POLL_SETUP_MS,
    });
    for (const serverNow of [scanOpensAt, scanOpensAt + 40 * 60_000]) {
      expect(inhousePollCadence({ ...ready, serverNow })).toEqual({
        skip: false, delayMs: INHOUSE.POLL_GAME_MS,
      });
    }
    // An unknown window or clock keeps the setup rate.
    expect(inhousePollCadence({ ...ready, scanOpensAt: null, serverNow: scanOpensAt })).toEqual({
      skip: false, delayMs: INHOUSE.POLL_SETUP_MS,
    });
    expect(inhousePollCadence({ ...ready, serverNow: null })).toEqual({
      skip: false, delayMs: INHOUSE.POLL_SETUP_MS,
    });
    // A room that asks for something slower than setup's rate keeps it.
    expect(inhousePollCadence({ ...ready, activeMs: 8000, serverNow: scanOpensAt - 1 })).toEqual({
      skip: false, delayMs: 8000,
    });
    // Setup is minutes of joining a lobby, with no clock: above the fast
    // rate, yet quick enough that the Start answer or a cancel shows promptly.
    expect(INHOUSE.POLL_SETUP_MS).toBeGreaterThan(FAST);
    expect(INHOUSE.POLL_SETUP_MS).toBeLessThanOrEqual(INHOUSE.POLL_QUEUE_MS);
    // The window only speaks for READY: a draft past it is still a draft.
    expect(inhousePollCadence({
      ...ready, lobbyStatus: INHOUSE_STATUS.DRAFTING, serverNow: scanOpensAt + 1,
    })).toEqual({ skip: false, delayMs: FAST });
    // A spectator with no stake idles as before; a failed poll still retries fast.
    expect(inhousePollCadence({ ...ready, hasStake: false, serverNow: scanOpensAt })).toEqual({
      skip: false, delayMs: IDLE,
    });
    expect(inhousePollCadence({ ...ready, reached: false, serverNow: scanOpensAt })).toEqual({
      skip: false, delayMs: FAST,
    });
  });

  it("phase savings never slow a failed-poll retry", () => {
    for (const lobbyStatus of [null, INHOUSE_STATUS.IN_PROGRESS]) {
      expect(inhousePollCadence({
        ...base, hidden: false, hasStake: true, lobbyStatus, reached: false,
      })).toEqual({ skip: false, delayMs: FAST });
    }
    // A hidden queued tab keepalives by the queue, a hidden game by the game.
    expect(inhousePollCadence({
      ...base, hidden: true, hasStake: true, lobbyStatus: null,
    })).toEqual({ skip: false, delayMs: INHOUSE.POLL_QUEUE_KEEPALIVE_MS });
    expect(inhousePollCadence({
      ...base, hidden: true, hasStake: true, lobbyStatus: INHOUSE_STATUS.IN_PROGRESS,
    })).toEqual({ skip: false, delayMs: INHOUSE.POLL_GAME_KEEPALIVE_MS });
  });

  it("polls FAST for anyone with a stake — in a lobby OR in the queue", () => {
    // The people a filling queue / forming lobby matter to are in it. Seconds
    // decide accepts, votes and picks.
    expect(
      inhousePollCadence({ ...base, hidden: false, hasStake: true }),
    ).toEqual({
      skip: false,
      delayMs: FAST,
    });
  });

  it("polls IDLE-slow for a spectator, however busy the lobby is", () => {
    // Membership, not existence: five people watching a 45-minute game were
    // each firing 40 req/min because a lobby existed.
    expect(
      inhousePollCadence({ ...base, hidden: false, hasStake: false }),
    ).toEqual({
      skip: false,
      delayMs: IDLE,
    });
  });

  it("keeps a HIDDEN tab with a stake on the keepalive", () => {
    // That poll IS the presence heartbeat, and it carries the ready check's
    // chime + tab title. Stop it and the spot is dropped as "away".
    expect(
      inhousePollCadence({ ...base, hidden: true, hasStake: true }),
    ).toEqual({
      skip: false,
      delayMs: INHOUSE.POLL_KEEPALIVE_MS,
    });
  });

  it("every hidden-tab rate stays comfortably under the away cutoff", () => {
    // The binding case is a live game: all ten tabs are hidden (everyone is in
    // the Dota client), so the keepalive is the ONLY thing holding ten queue
    // spots — and Chrome clamps hidden timers toward once a minute.
    for (const ms of [
      INHOUSE.POLL_KEEPALIVE_MS,
      INHOUSE.POLL_QUEUE_KEEPALIVE_MS,
      INHOUSE.POLL_GAME_KEEPALIVE_MS,
      // A held request is the same heartbeat, at most this long apart.
      INHOUSE.LONG_POLL_HOLD_MS + ROOM_POLL_TIMEOUT_MS,
    ]) {
      expect(ms).toBeLessThan(INHOUSE.QUEUE_AWAY_SECONDS * 1000);
    }
  });

  it("the keepalives leave time to act in every pre-draft deadline", () => {
    // An accepted player in a timed stage must not sleep through the entire
    // shorter captain vote.
    expect(INHOUSE.POLL_KEEPALIVE_MS).toBeLessThan(INHOUSE.VOTE_SECONDS * 1000);
    // A lobby can form immediately after a queued player's hidden-tab poll.
    // The next one has to arrive with most of the accept clock left; the vote
    // can't open until that player has accepted.
    expect(INHOUSE.ACCEPT_SECONDS * 1000 - INHOUSE.POLL_QUEUE_KEEPALIVE_MS)
      .toBeGreaterThanOrEqual(60_000);
    expect(INHOUSE.POLL_KEEPALIVE_MS).toBeLessThanOrEqual(INHOUSE.POLL_QUEUE_KEEPALIVE_MS);
  });

  it("stops fetching entirely in a HIDDEN tab with nothing at stake", () => {
    // Browsers throttle background timers anyway, and the sitewide /api/sync
    // ping advances lobbies without this tab's help.
    expect(
      inhousePollCadence({ ...base, hidden: true, hasStake: false }),
    ).toEqual({
      skip: true,
      delayMs: IDLE,
    });
  });

  it("eases OFF after a 429 instead of hammering — even mid-lobby", () => {
    // Backing off prevents a temporary state-read limit from being held open
    // by the room's fast poll cadence. Mutations now have a separate bucket,
    // but the UI still needs a readable recovery path for its next state read.
    expect(
      inhousePollCadence({
        ...base,
        hidden: false,
        hasStake: true,
        rateLimited: true,
      }),
    ).toEqual({ skip: false, delayMs: INHOUSE.POLL_RECOVERY_MS });
  });

  it("a 429 outranks even the hidden-tab rules", () => {
    for (const hasStake of [true, false]) {
      expect(
        inhousePollCadence({
          ...base,
          hidden: true,
          hasStake,
          rateLimited: true,
        }),
      ).toEqual({ skip: false, delayMs: INHOUSE.POLL_RECOVERY_MS });
    }
  });

  it("recovers at the recovery rate, never faster than idling", () => {
    // A 429's back-off and a disconnected room's first backed-off retry keep
    // their 10 seconds whatever the spectator rate is.
    const room = { hidden: false, hasStake: false, activeMs: FAST };
    expect(INHOUSE.POLL_IDLE_MS).toBeGreaterThanOrEqual(INHOUSE.POLL_RECOVERY_MS);
    expect(inhousePollCadence({ ...room, rateLimited: true }).delayMs).toBe(
      INHOUSE.POLL_RECOVERY_MS,
    );
    expect(inhousePollCadence({
      ...room, reached: false, failureCount: ROOM_POLL_FAIL_THRESHOLD + 1, jitter: 0,
    }).delayMs).toBe(INHOUSE.POLL_RECOVERY_MS * 0.8);
  });

  it("retries at the FAST rate when a poll didn't land", () => {
    // Sustained failures are what flip `disconnected` (pollHealthAfter);
    // backing off would delay both the recovery and the diagnosis.
    expect(
      inhousePollCadence({
        ...base,
        hidden: false,
        hasStake: false,
        reached: false,
      }),
    ).toEqual({ skip: false, delayMs: FAST });
  });

  it("backs a disconnected room off with bounded jitter", () => {
    const low = inhousePollCadence({
      ...base,
      hidden: false,
      hasStake: true,
      reached: false,
      failureCount: ROOM_POLL_FAIL_THRESHOLD + 1,
      jitter: 0,
    });
    const high = inhousePollCadence({
      ...base,
      hidden: false,
      hasStake: true,
      reached: false,
      failureCount: 20,
      jitter: 1,
    });
    expect(low.delayMs).toBe(8_000);
    expect(high.delayMs).toBe(30_000);
  });

  it("does not issue requests while the browser is offline", () => {
    expect(
      inhousePollCadence({
        ...base,
        hidden: false,
        hasStake: true,
        offline: true,
      }),
    ).toEqual({ skip: true, delayMs: 30_000 });
  });

  it("defaults the idle rate to the INHOUSE constant", () => {
    expect(
      inhousePollCadence({ hidden: false, hasStake: false, activeMs: FAST })
        .delayMs,
    ).toBe(INHOUSE.POLL_IDLE_MS);
  });
});

describe("inhouseLongPoll", () => {
  const V = "3b2f6a1e-version";
  const calm = { version: V, urgent: false };

  it("holds only a request that can send back the version it shows", () => {
    // The first request has nothing to send; an old slot's reply carries no
    // version. Either way the server must answer at once, so the room never
    // hot-loops on a server that ignores `since`.
    for (const version of [null, undefined, ""]) {
      expect(inhouseLongPoll({ ...calm, version })).toBeNull();
    }
    expect(inhouseLongPoll({ ...calm, lobbyStatus: null })).toEqual({
      since: V,
      holdMs: INHOUSE.LONG_POLL_HOLD_MS,
      timeoutMs: INHOUSE.LONG_POLL_HOLD_MS + ROOM_POLL_TIMEOUT_MS,
    });
  });

  it("answers at once while something waits on the reply", () => {
    // A resync after going offline, an action in flight or awaiting its
    // reconciliation: their controls stay locked until a reply lands.
    expect(inhouseLongPoll({ ...calm, urgent: true })).toBeNull();
    // A retry has to diagnose a broken connection quickly.
    expect(inhouseLongPoll({ ...calm, failureCount: 1 })).toBeNull();
    expect(inhouseLongPoll({ ...calm, failureCount: 0 })).not.toBeNull();
  });

  it("asks for the short hold only in the member's own clocked stages", () => {
    for (const lobbyStatus of [
      INHOUSE_STATUS.READY_CHECK,
      INHOUSE_STATUS.CAPTAIN_VOTE,
      INHOUSE_STATUS.DRAFTING,
    ]) {
      for (const inLobby of [true, undefined]) {
        expect(inhouseLongPoll({ ...calm, lobbyStatus, inLobby })?.holdMs).toBe(
          INHOUSE.LONG_POLL_TIMED_HOLD_MS,
        );
      }
      // Someone else's clock (a queued player shown another game's draft).
      expect(inhouseLongPoll({ ...calm, lobbyStatus, inLobby: false })?.holdMs).toBe(
        INHOUSE.LONG_POLL_HOLD_MS,
      );
    }
    // Setup, a game being played and the queue have no clock of theirs.
    for (const lobbyStatus of [INHOUSE_STATUS.READY, INHOUSE_STATUS.IN_PROGRESS, null]) {
      expect(inhouseLongPoll({ ...calm, lobbyStatus, inLobby: true })?.holdMs).toBe(
        INHOUSE.LONG_POLL_HOLD_MS,
      );
    }
  });

  it("gives every held request its hold plus the poll deadline", () => {
    for (const lobbyStatus of [INHOUSE_STATUS.DRAFTING, null]) {
      const lp = inhouseLongPoll({ ...calm, lobbyStatus })!;
      expect(lp.timeoutMs).toBe(lp.holdMs + ROOM_POLL_TIMEOUT_MS);
      // The server never holds longer than it grants.
      expect(lp.holdMs).toBeLessThanOrEqual(INHOUSE.LONG_POLL_HOLD_MS);
    }
    // The clocked stages notice a dead connection inside the vote window.
    expect(INHOUSE.LONG_POLL_TIMED_HOLD_MS + ROOM_POLL_TIMEOUT_MS).toBeLessThan(
      INHOUSE.VOTE_SECONDS * 1000,
    );
    expect(INHOUSE.LONG_POLL_TIMED_HOLD_MS).toBeLessThan(INHOUSE.LONG_POLL_HOLD_MS);
  });
});

describe("inhousePollDelay", () => {
  const FAST = 1500;
  const settled = { activeMs: FAST, reached: true, hidden: false, hasStake: true };

  it("re-issues a long-poll straight away once its request has run the gap", () => {
    for (const startedAgoMs of [INHOUSE.LONG_POLL_MIN_GAP_MS, 25_000]) {
      expect(inhousePollDelay({ ...settled, longPoll: true, startedAgoMs })).toBe(0);
    }
    // A hidden tab with a stake long-polls too: its chime and title arrive
    // with the change, and no clamped timer stands in the way.
    expect(
      inhousePollDelay({ ...settled, hidden: true, longPoll: true, startedAgoMs: 5_000 }),
    ).toBe(0);
  });

  it("never starts two requests closer than the gap, so it can't hot-loop", () => {
    for (const startedAgoMs of [-50, 0, 1, 40, 999]) {
      const delay = inhousePollDelay({ ...settled, longPoll: true, startedAgoMs });
      expect(delay).toBeGreaterThan(0);
      expect(Math.max(0, startedAgoMs) + delay).toBe(INHOUSE.LONG_POLL_MIN_GAP_MS);
    }
    // Never faster than the clocked stages' fast poll.
    expect(INHOUSE.LONG_POLL_MIN_GAP_MS).toBeLessThanOrEqual(FAST);
  });

  it("falls back to the ladder whenever the next request can't be held", () => {
    // No version (an old slot during a release), something urgent, a failure:
    // inhouseLongPoll was null, and the ladder's rate is the delay, exactly.
    const cases = [
      { lobbyStatus: null },
      { lobbyStatus: INHOUSE_STATUS.IN_PROGRESS, inLobby: true },
      { lobbyStatus: INHOUSE_STATUS.READY },
      { lobbyStatus: INHOUSE_STATUS.DRAFTING },
      { hidden: true },
      { hasStake: false },
      { hasStake: false, hidden: true },
      { reached: false, failureCount: 2 },
      { rateLimited: true },
      { offline: true },
    ];
    for (const extra of cases) {
      const o = { ...settled, ...extra };
      expect(inhousePollDelay({ ...o, longPoll: false, startedAgoMs: 30_000 })).toBe(
        inhousePollCadence(o).delayMs,
      );
    }
  });

  it("uses the ladder after a 429, a failure, offline or a hidden spectator, even mid long-poll", () => {
    for (const extra of [
      { rateLimited: true },
      { reached: false },
      { offline: true },
      { hidden: true, hasStake: false },
    ]) {
      const o = { ...settled, ...extra };
      expect(inhousePollDelay({ ...o, longPoll: true, startedAgoMs: 30_000 })).toBe(
        inhousePollCadence(o).delayMs,
      );
    }
  });
});

describe("draftPollCadence", () => {
  const FAST = 1200;
  const base = { activeMs: FAST, reached: true };

  it("polls FAST while the auction is live for the viewers who act", () => {
    // Captains and admins bid, nominate and pause on a live lot. Unknown (no
    // payload yet) counts as acting, so nobody starts slow.
    expect(
      draftPollCadence({ ...base, hidden: false, hasStake: true, live: true, canAct: true }),
    ).toEqual({ skip: false, delayMs: FAST });
    expect(
      draftPollCadence({ ...base, hidden: false, hasStake: false, live: true }),
    ).toEqual({ skip: false, delayMs: FAST });
  });

  // Every poll is a function call on a hosting budget both leagues share; a
  // watcher sees bids a few seconds later.
  it("polls watchers (spectators, pool players) at the watch rate", () => {
    for (const hasStake of [false, true]) {
      expect(
        draftPollCadence({ ...base, hidden: false, hasStake, live: true, canAct: false }),
      ).toEqual({ skip: false, delayMs: DRAFT_ROOM.POLL_WATCH_MS });
      expect(
        draftPollCadence({ ...base, hidden: false, hasStake, live: false, canAct: false }),
      ).toEqual({ skip: false, delayMs: DRAFT_ROOM.POLL_WATCH_IDLE_MS });
    }
    // A hidden pool player keeps a slower keepalive for "on the block".
    expect(
      draftPollCadence({ ...base, hidden: true, hasStake: true, live: true, canAct: false }),
    ).toEqual({ skip: false, delayMs: DRAFT_ROOM.POLL_WATCH_KEEPALIVE_MS });
    // A failed poll retries at the watcher's own rate.
    expect(
      draftPollCadence({
        ...base,
        hidden: false,
        hasStake: false,
        live: false,
        reached: false,
        canAct: false,
      }),
    ).toEqual({ skip: false, delayMs: DRAFT_ROOM.POLL_WATCH_MS });
  });

  it("keeps the watch rate slow for the budget but well inside the 30s bid clock", () => {
    // A bid resets the clock, so a pool player watching their own lot still
    // follows it; the hosting budget asks for the slowest rate that holds.
    const bidClockMs = DEFAULTS.BID_TIMER_SECONDS * 1000;
    expect(DRAFT_ROOM.POLL_WATCH_MS).toBeGreaterThanOrEqual(5000);
    expect(DRAFT_ROOM.POLL_WATCH_MS).toBeLessThanOrEqual(bidClockMs / 6);
    expect(DRAFT_ROOM.POLL_WATCH_IDLE_MS).toBeGreaterThanOrEqual(DRAFT_ROOM.POLL_WATCH_MS);
  });

  it("counts a PAUSED auction as live so a resume is caught immediately", () => {
    // The caller passes `status === IN_PROGRESS || status === PAUSED`. Drop
    // PAUSED and ten captains stare at a parked strip for up to 3s after the
    // admin resumes — on a 30s lot clock.
    expect(
      draftPollCadence({ ...base, hidden: false, hasStake: true, live: true })
        .delayMs,
    ).toBe(FAST);
  });

  it("drops to the waiting-room rate when no auction is running", () => {
    expect(
      draftPollCadence({ ...base, hidden: false, hasStake: true, live: false }),
    ).toEqual({ skip: false, delayMs: DRAFT_ROOM.POLL_IDLE_MS });
  });

  it("keepalives a HIDDEN captain, and stops entirely for a hidden bystander", () => {
    // Stake here is captain / admin / still-in-the-pool: all three can have
    // the auction turn to them while they're looking at something else.
    expect(
      draftPollCadence({ ...base, hidden: true, hasStake: true, live: true }),
    ).toEqual({ skip: false, delayMs: DRAFT_ROOM.POLL_KEEPALIVE_MS });
    expect(
      draftPollCadence({ ...base, hidden: true, hasStake: false, live: true }),
    ).toEqual({ skip: true, delayMs: DRAFT_ROOM.POLL_IDLE_MS });
  });

  it("uses its own back-off rate after a 429, ahead of every other rule", () => {
    // /api/draft/tick's limiter is a fixed 60s window, so easing off is what
    // lets it drain instead of re-saturating it every 1.2s. Tripping
    // `disconnected` here instead would disable every bid control over a rate
    // limit — and /api/draft/bid isn't limited, so the bid would have landed.
    for (const hidden of [false, true]) {
      expect(
        draftPollCadence({
          ...base,
          hidden,
          hasStake: true,
          live: true,
          rateLimited: true,
        }),
      ).toEqual({ skip: false, delayMs: DRAFT_ROOM.POLL_RATE_LIMITED_MS });
    }
  });

  it("retries a FAILED poll at the fast rate, not the waiting-room rate", () => {
    // The fix. This room read its cadence off a `live` flag that is
    // re-initialised false every tick and only set inside the ok branch, so a
    // failed poll mid-auction rescheduled at POLL_IDLE_MS — putting the
    // recovery 2.5x further away and doubling the time to flip `disconnected`,
    // the gate that stops a captain bidding against stale state.
    expect(
      draftPollCadence({
        ...base,
        hidden: false,
        hasStake: true,
        live: false, // what the room reports on a failed poll
        reached: false,
      }),
    ).toEqual({ skip: false, delayMs: FAST });
  });

  it("backs off only after the disconnect threshold and caps the delay", () => {
    expect(
      draftPollCadence({
        ...base,
        hidden: false,
        hasStake: true,
        live: false,
        reached: false,
        failureCount: ROOM_POLL_FAIL_THRESHOLD,
        jitter: 1,
      }).delayMs,
    ).toBe(FAST);
    expect(
      draftPollCadence({
        ...base,
        hidden: false,
        hasStake: true,
        live: false,
        reached: false,
        failureCount: 20,
        jitter: 1,
      }).delayMs,
    ).toBe(30_000);
  });
});

// The cold-start hole was identical in both rooms and is worth stating once,
// against both bindings: `hasStake` is learned FROM a payload, so before the
// first one it is false for everybody.
describe("cold start (no request has ever left)", () => {
  it("fetches once from a tab that is HIDDEN at load, in both rooms", () => {
    // A cmd-clicked draft room, or an /inhouse tab restored with the session:
    // the pre-fetch gate would skip on `hidden && !hasStake` and the room would
    // never learn it had a captain in it — no keepalive, no tab-title flag, no
    // chime until the player happened to look at it.
    expect(
      inhousePollCadence({
        hidden: true,
        hasStake: false,
        coldStart: true,
        activeMs: 1500,
      }).skip,
    ).toBe(false);
    expect(
      draftPollCadence({
        hidden: true,
        hasStake: false,
        live: false,
        coldStart: true,
        activeMs: 1200,
      }).skip,
    ).toBe(false);
  });

  it("goes back to skipping once a request HAS left", () => {
    // Keyed off "nothing issued yet", not "nothing applied yet" — so a hidden
    // tab that cannot reach the server tries once and stops, rather than
    // turning into an unbounded background retry loop.
    expect(
      inhousePollCadence({
        hidden: true,
        hasStake: false,
        coldStart: false,
        activeMs: 1500,
      }).skip,
    ).toBe(true);
  });

  it("does not override a 429", () => {
    expect(
      inhousePollCadence({
        hidden: true,
        hasStake: false,
        coldStart: true,
        rateLimited: true,
        activeMs: 1500,
      }).delayMs,
    ).toBe(INHOUSE.POLL_RECOVERY_MS);
  });
});

// The two rooms run the same four rules in the same order but do NOT agree on
// every rate, and the differences are deliberate. Pinned here so the next
// person to "unify" them has to argue with a test rather than a comment.
describe("where the two rooms deliberately differ", () => {
  it("each room has its own 429 back-off", () => {
    // /api/draft/tick's window is 60s, so 8s of quiet drains it. The inhouse
    // room backs off 10s (its old idle rate), slower spectators or not.
    expect(DRAFT_ROOM.POLL_RATE_LIMITED_MS).not.toBe(DRAFT_ROOM.POLL_IDLE_MS);
    expect(
      inhousePollCadence({
        hidden: false,
        hasStake: true,
        rateLimited: true,
        activeMs: 1500,
      }).delayMs,
    ).toBe(INHOUSE.POLL_RECOVERY_MS);
  });

  it("'active' means the ROOM's phase in the draft, the VIEWER's stake inhouse", () => {
    // A spectator on a live lot polls fast; a spectator on a live lobby does
    // not. That is the whole difference, and it is why one boolean could not
    // serve both without lying about one of them.
    expect(
      draftPollCadence({
        hidden: false,
        hasStake: false,
        live: true,
        reached: true,
        activeMs: 1200,
      }).delayMs,
    ).toBe(1200);
    expect(
      inhousePollCadence({
        hidden: false,
        hasStake: false,
        reached: true,
        activeMs: 1500,
      }).delayMs,
    ).toBe(INHOUSE.POLL_IDLE_MS);
  });

  it("keeps the draft's auction cadence tighter than the inhouse keepalive", () => {
    // Both rooms can surface second-sensitive actions in a hidden tab. The
    // auction deliberately wakes more often; the inhouse still stays inside
    // its own shorter 25s vote window (asserted above).
    expect(DRAFT_ROOM.POLL_KEEPALIVE_MS).toBeLessThan(
      INHOUSE.POLL_KEEPALIVE_MS,
    );
  });
});
