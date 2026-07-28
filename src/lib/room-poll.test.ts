import { describe, expect, it } from "vitest";
import { draftPollCadence, inhousePollCadence } from "./room-poll";
import { DRAFT_ROOM, INHOUSE } from "./constants";

// Two ~1800-line client components' poll loops, with no unit-testable surface
// of their own (the vitest env is `node` — no jsdom), so these rules were
// asserted only by whatever a browser spec happened to reach. They are the
// difference between a queue spot held and a lobby lost, and between a captain
// seeing "reconnecting" and a captain bidding into a dead socket.

describe("inhousePollCadence", () => {
  const FAST = 1500;
  const IDLE = 10000;
  const base = { activeMs: FAST, idleMs: IDLE, reached: true };

  it("polls FAST for anyone with a stake — in a lobby OR in the queue", () => {
    // The people a filling queue / forming lobby matter to are in it. Seconds
    // decide accepts, votes and picks.
    expect(inhousePollCadence({ ...base, hidden: false, hasStake: true })).toEqual({
      skip: false,
      delayMs: FAST,
    });
  });

  it("polls IDLE-slow for a spectator, however busy the lobby is", () => {
    // Membership, not existence: five people watching a 45-minute game were
    // each firing 40 req/min because a lobby existed.
    expect(inhousePollCadence({ ...base, hidden: false, hasStake: false })).toEqual({
      skip: false,
      delayMs: IDLE,
    });
  });

  it("keeps a HIDDEN tab with a stake on the keepalive", () => {
    // That poll IS the presence heartbeat, and it carries the ready check's
    // chime + tab title. Stop it and the spot is dropped as "away".
    expect(inhousePollCadence({ ...base, hidden: true, hasStake: true })).toEqual({
      skip: false,
      delayMs: INHOUSE.POLL_KEEPALIVE_MS,
    });
  });

  it("the keepalive stays comfortably under the away cutoff", () => {
    // The binding case is a live game: all ten tabs are hidden (everyone is in
    // the Dota client), so the keepalive is the ONLY thing holding ten queue
    // spots — and Chrome clamps hidden timers toward once a minute.
    expect(INHOUSE.POLL_KEEPALIVE_MS).toBeLessThan(
      INHOUSE.QUEUE_AWAY_SECONDS * 1000,
    );
  });

  it("stops fetching entirely in a HIDDEN tab with nothing at stake", () => {
    // Browsers throttle background timers anyway, and the sitewide /api/sync
    // ping advances lobbies without this tab's help.
    expect(inhousePollCadence({ ...base, hidden: true, hasStake: false })).toEqual({
      skip: true,
      delayMs: IDLE,
    });
  });

  it("eases OFF after a 429 instead of hammering — even mid-lobby", () => {
    // The route's speed bump is per-IP and a queued tab polls 40/min, so one
    // household or NAT crosses it just by having a lobby. Retrying at the fast
    // rate kept the fixed window saturated so it never cleared, and ACCEPT
    // (which shares the bucket) stayed unreachable for the whole ready check.
    expect(
      inhousePollCadence({ ...base, hidden: false, hasStake: true, rateLimited: true }),
    ).toEqual({ skip: false, delayMs: IDLE });
  });

  it("a 429 outranks even the hidden-tab rules", () => {
    for (const hasStake of [true, false]) {
      expect(
        inhousePollCadence({ ...base, hidden: true, hasStake, rateLimited: true }),
      ).toEqual({ skip: false, delayMs: IDLE });
    }
  });

  it("retries at the FAST rate when a poll didn't land", () => {
    // Sustained failures are what flip `disconnected` (pollHealthAfter);
    // backing off would delay both the recovery and the diagnosis.
    expect(
      inhousePollCadence({ ...base, hidden: false, hasStake: false, reached: false }),
    ).toEqual({ skip: false, delayMs: FAST });
  });

  it("defaults the idle rate to the INHOUSE constant", () => {
    expect(
      inhousePollCadence({ hidden: false, hasStake: false, activeMs: FAST }).delayMs,
    ).toBe(INHOUSE.POLL_IDLE_MS);
  });
});

describe("draftPollCadence", () => {
  const FAST = 1200;
  const base = { activeMs: FAST, reached: true };

  it("polls FAST while the auction is live, for spectators too", () => {
    // The draft's "active" is the ROOM's phase, not the viewer's stake: a
    // player watching the lot they might be nominated into needs the same
    // 1.2s cadence a captain does.
    expect(
      draftPollCadence({ ...base, hidden: false, hasStake: false, live: true }),
    ).toEqual({ skip: false, delayMs: FAST });
  });

  it("counts a PAUSED auction as live so a resume is caught immediately", () => {
    // The caller passes `status === IN_PROGRESS || status === PAUSED`. Drop
    // PAUSED and ten captains stare at a parked strip for up to 3s after the
    // admin resumes — on a 30s lot clock.
    expect(
      draftPollCadence({ ...base, hidden: false, hasStake: true, live: true }).delayMs,
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
        draftPollCadence({ ...base, hidden, hasStake: true, live: true, rateLimited: true }),
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
    ).toBe(INHOUSE.POLL_IDLE_MS);
  });
});

// The two rooms run the same four rules in the same order but do NOT agree on
// every rate, and the differences are deliberate. Pinned here so the next
// person to "unify" them has to argue with a test rather than a comment.
describe("where the two rooms deliberately differ", () => {
  it("the draft has its own 429 back-off; the inhouse room reuses its idle rate", () => {
    // /api/draft/tick's window is 60s, so 8s of quiet drains it; the inhouse
    // idle rate is already 10s and needs no separate number.
    expect(DRAFT_ROOM.POLL_RATE_LIMITED_MS).not.toBe(DRAFT_ROOM.POLL_IDLE_MS);
    expect(
      inhousePollCadence({
        hidden: false,
        hasStake: true,
        rateLimited: true,
        activeMs: 1500,
      }).delayMs,
    ).toBe(INHOUSE.POLL_IDLE_MS);
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

  it("the draft keepalives faster, because its clocks are shorter", () => {
    // 30s lot clock vs a 45s ready check: the hidden-tab rates are sized to
    // the thing each room can miss.
    expect(DRAFT_ROOM.POLL_KEEPALIVE_MS).toBeLessThan(INHOUSE.POLL_KEEPALIVE_MS);
  });
});
