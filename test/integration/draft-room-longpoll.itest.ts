import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The draft room's long-poll through the real tick route and database: a
// tick that sends back the version its client shows is held until the room
// changes, the auction's clock wakes its viewer, or its hold, then answered
// from the server instance's one shared copy of the room. These hold it to
// "instant, the same reply a fresh read gives, and no more requests than
// changes":
//
// - a bid answers every held tick well under a second, signed in or out;
// - a server action loaded as ANOTHER module instance (a `next start`
//   process loads src/lib twice) wakes it as fast;
// - a version moved where no publish here ran (the other release slot) is
//   caught by the watch;
// - at a lot's zero a captain's held tick wakes and settles it, and the
//   settle's publish wakes everyone else; with no captain or admin in the
//   room a pool player's tick settles it after the due retry; a signed-out
//   tick never settles anything;
// - a clock that ran out after the reply the client shows answers at once;
// - a captain coming back into the room shows on every tab at once;
// - every viewer's reply from the shared copy equals a fresh read;
// - a client that goes away ends its hold and gets no tick;
// - looping clients make about one request per change, plus one per hold.

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getSessionUser: vi.fn(async () => null),
    requireUser: vi.fn(),
    requireAdmin: vi.fn(),
  };
});
vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return { ...actual, sendDiscordMessage: vi.fn(async () => true) };
});

import { prisma } from "@/lib/prisma";
import { DRAFT_ROOM, DRAFT_STATUS } from "@/lib/constants";
import { getSessionUser, type SessionUser } from "@/lib/auth";
import { getDraftState, nominatePlayer } from "@/lib/draft-service";
import {
  publishDraftRoomChange,
  readDraftRoomVersion,
} from "@/lib/draft-room-version";
import { heldDraftRoomRequests } from "@/lib/draft-room-wait";
import { SETTING_KEYS } from "@/lib/settings";
import { POST as tickPOST } from "@/app/api/draft/tick/route";
import { POST as bidPOST } from "@/app/api/draft/bid/route";
import {
  makeCaptain,
  makePlayer,
  makeSeason,
  makeUser,
  sessionFor,
  startDraftState,
} from "./factories";

// Each request runs as its own viewer, even while others run beside it.
const viewer = new AsyncLocalStorage<SessionUser | null>();
const mockSession = vi.mocked(getSessionUser);

beforeEach(() => {
  mockSession.mockReset().mockImplementation(async () => viewer.getStore() ?? null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Reply = { status: number; json: Record<string, unknown> | null; ms: number };

/** POST /api/draft/<path> as `session`, timed. */
async function post(
  session: SessionUser | null,
  path: "tick" | "bid",
  body: Record<string, unknown>,
  signal?: AbortSignal,
  route: typeof tickPOST = path === "tick" ? tickPOST : bidPOST,
): Promise<Reply> {
  const started = Date.now();
  const res = await viewer.run(session, () =>
    route(
      new NextRequest(`http://localhost:3000/api/draft/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify(body),
        signal,
      }),
    ),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, ms: Date.now() - started };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Until `n` ticks are held in this process. */
async function untilHeld(n: number) {
  for (let i = 0; i < 300 && heldDraftRoomRequests() < n; i++) await sleep(10);
  expect(heldDraftRoomRequests()).toBe(n);
}

/** Well under the 2s watch: what "instant" has to mean here. */
const INSTANT_MS = 1_000;

/**
 * A live auction: two captains, four players in the pool, captain A on the
 * nomination clock. Published, so the room has a version.
 */
async function liveDraft() {
  const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
  const a = await makeCaptain(season.id, "Captain A", 100, 0);
  const b = await makeCaptain(season.id, "Captain B", 100, 1);
  const pool = [];
  for (let i = 0; i < 4; i++) pool.push(await makePlayer(season.id, `Pool ${i}`, 4000 - i * 100));
  await startDraftState(season.id);
  await publishDraftRoomChange();
  const admin = await makeUser("Admin", "ADMIN");
  const spectator = await makeUser("Spectator");
  return {
    season,
    a: { ...a, session: sessionFor(a.user) },
    b: { ...b, session: sessionFor(b.user) },
    pool: pool.map((user) => ({ user, session: sessionFor(user) })),
    admin: sessionFor(admin),
    spectator: sessionFor(spectator),
  };
}

/** A plain tick, and the version it names. */
async function plainTick(seasonId: string, session: SessionUser | null) {
  const res = await post(session, "tick", { seasonId });
  expect(res.status).toBe(200);
  const version = res.json?.roomVersion;
  expect(typeof version).toBe("string");
  return { state: res.json!, version: version as string };
}

/** A held tick for `since`, still running. */
function heldTick(
  seasonId: string,
  session: SessionUser | null,
  since: string,
  holdMs: number = DRAFT_ROOM.LONG_POLL_HOLD_MS,
  sinceNow?: number,
  signal?: AbortSignal,
) {
  return post(session, "tick", { seasonId, since, holdMs, sinceNow }, signal);
}

/** Captain A nominates the pool's first player at $1. */
async function openLot(d: Awaited<ReturnType<typeof liveDraft>>) {
  const res = await nominatePlayer(d.season.id, d.a.session, d.pool[0].user.id, 1);
  expect(res.ok).toBe(true);
}

/** The lot's bid clock, moved to `inMs` from now and published. */
async function lotEndsIn(seasonId: string, inMs: number) {
  const endsAt = new Date(Date.now() + inMs);
  await prisma.draft.update({ where: { seasonId }, data: { bidEndsAt: endsAt } });
  await publishDraftRoomChange();
  // The plain ticks before may have taken the 2s settle claim.
  await prisma.setting.deleteMany({
    where: { key: SETTING_KEYS.DRAFT_ROOM_MAINTENANCE_AT },
  });
  return endsAt;
}

describe("the draft long-poll: a held tick answers when the room changes", () => {
  it("a bid answers every held tick at once, with the new version", async () => {
    const d = await liveDraft();
    await openLot(d);
    // The captain first: their first tick of the auction records them in
    // the room, which publishes (the room showed them away).
    await plainTick(d.season.id, d.a.session);
    const captain = await plainTick(d.season.id, d.a.session);
    const anonymous = await plainTick(d.season.id, null);
    const poolPlayer = await plainTick(d.season.id, d.pool[1].session);
    expect(poolPlayer.version).toBe(anonymous.version);
    expect(captain.version).toBe(anonymous.version);

    const holds = [
      heldTick(d.season.id, null, anonymous.version),
      heldTick(d.season.id, d.pool[1].session, poolPlayer.version),
      heldTick(d.season.id, d.a.session, captain.version, DRAFT_ROOM.LONG_POLL_ACTOR_HOLD_MS),
    ];
    await untilHeld(3);
    await sleep(300);
    expect(heldDraftRoomRequests()).toBe(3);

    const shown = captain.state as {
      draftVersion: number;
      nominatedUserId: string;
      currentLotId: string | null;
      currentBid: number;
      currentBidTeamId: string;
      bidEndsAt: number;
    };
    const bid = await post(d.b.session, "bid", {
      seasonId: d.season.id,
      amount: 5,
      draftVersion: shown.draftVersion,
      nominatedUserId: shown.nominatedUserId,
      currentLotId: shown.currentLotId,
      currentBid: shown.currentBid,
      currentBidTeamId: shown.currentBidTeamId,
      bidEndsAt: shown.bidEndsAt,
    });
    expect(bid.status).toBe(200);
    const bidAt = Date.now();
    const replies = await Promise.all(holds);
    // From the bid's response to the held replies: coalesce, jitter, tick.
    expect(Date.now() - bidAt).toBeLessThan(INSTANT_MS);
    for (const reply of replies) {
      expect(reply.status).toBe(200);
      expect(reply.json?.roomVersion).not.toBe(anonymous.version);
      expect(reply.json?.currentBid).toBe(5);
      expect(reply.json?.currentBidTeamId).toBe(d.b.team.id);
      // Held, then woken: the client's back-off resets on it.
      expect(reply.json?.held).toBe(true);
    }
    expect(heldDraftRoomRequests()).toBe(0);
    // A plain tick, and one whose `since` the room has moved past, were not.
    expect(anonymous.state.held).toBe(false);
    const behind = await heldTick(d.season.id, null, anonymous.version);
    expect(behind.ms).toBeLessThan(INSTANT_MS);
    expect(behind.json?.held).toBe(false);
  });

  it("a server action in another module instance wakes the route's held tick as fast", async () => {
    const d = await liveDraft();
    await openLot(d);
    const before = await plainTick(d.season.id, d.pool[1].session);

    // Pages and server actions: a second copy of every module, in this
    // process. Only the registry on globalThis (and the database) is shared.
    vi.resetModules();
    const actions = await import("@/app/actions/admin-captains-draft");
    vi.mocked((await import("@/lib/auth")).requireAdmin).mockResolvedValue(d.admin);
    const held = heldTick(d.season.id, d.pool[1].session, before.version);
    await untilHeld(1);

    const fd = new FormData();
    fd.set("expectedActiveSeasonId", d.season.id);
    const pausedAt = Date.now();
    expect((await actions.pauseDraftAction({}, fd))?.error).toBeUndefined();
    const reply = await held;
    expect(Date.now() - pausedAt).toBeLessThan(INSTANT_MS);
    expect(reply.status).toBe(200);
    expect(reply.json?.roomVersion).not.toBe(before.version);
    expect(reply.json?.status).toBe(DRAFT_STATUS.PAUSED);
  });

  it("the watch catches a version moved outside this process (the other release slot)", async () => {
    const d = await liveDraft();
    const { version } = await plainTick(d.season.id, null);
    const held = heldTick(d.season.id, null, version);
    await untilHeld(1);
    // The other slot's publish: the row moves, nothing here is told.
    await prisma.setting.update({
      where: { key: SETTING_KEYS.DRAFT_ROOM_VERSION },
      data: { value: "the-other-slots-version" },
    });
    const reply = await held;
    expect(reply.json?.roomVersion).toBe("the-other-slots-version");
    expect(reply.ms).toBeLessThan(
      DRAFT_ROOM.LONG_POLL_WATCH_MS + DRAFT_ROOM.LONG_POLL_JITTER_MS + INSTANT_MS,
    );
  });

  it("a fresh database holds under its token, and its first publish answers", async () => {
    const season = await makeSeason({ teamSize: 3 });
    await makeCaptain(season.id, "Captain A", 100, 0);
    expect(await readDraftRoomVersion()).toBeNull();
    const { version } = await plainTick(season.id, null);
    expect(version).toBe("none");
    const held = heldTick(season.id, null, version);
    await untilHeld(1);
    await publishDraftRoomChange();
    const reply = await held;
    expect(reply.ms).toBeLessThan(INSTANT_MS);
    expect(reply.json?.roomVersion).not.toBe("none");
  });

  it("a draft publish never wakes an inhouse hold, nor the reverse", async () => {
    const { publishInhouseRoomChange } = await import("@/lib/inhouse-room-version");
    const { heldInhouseRoomRequests } = await import("@/lib/inhouse-room-wait");
    const d = await liveDraft();
    const { version } = await plainTick(d.season.id, null);
    const held = heldTick(d.season.id, null, version, 1_500);
    await untilHeld(1);
    await publishInhouseRoomChange();
    await sleep(DRAFT_ROOM.LONG_POLL_COALESCE_MS + DRAFT_ROOM.LONG_POLL_JITTER_MS + 200);
    expect(heldDraftRoomRequests()).toBe(1);
    expect(heldInhouseRoomRequests()).toBe(0);
    const reply = await held;
    // It ran to its own hold, unchanged.
    expect(reply.json?.roomVersion).toBe(version);
    expect(reply.ms).toBeGreaterThanOrEqual(1_490);
  });
});

describe("the draft long-poll: a held tick ends by itself", () => {
  it("at the hold the client asked for, under the same version", async () => {
    const d = await liveDraft();
    const { version } = await plainTick(d.season.id, null);
    const reply = await heldTick(d.season.id, null, version, 600);
    expect(reply.status).toBe(200);
    expect(reply.json?.roomVersion).toBe(version);
    expect(reply.ms).toBeGreaterThanOrEqual(590);
    expect(reply.ms).toBeLessThan(600 + DRAFT_ROOM.LONG_POLL_JITTER_MS + INSTANT_MS);
  });

  it("at the lot's zero a captain's tick settles it, and its publish wakes everyone else", async () => {
    const d = await liveDraft();
    await openLot(d);
    const { version } = await plainTick(d.season.id, d.b.session);
    const endsAt = await lotEndsIn(d.season.id, 1_500);
    const now = await readDraftRoomVersion();
    const [captain, poolPlayer, anonymous] = await Promise.all([
      heldTick(d.season.id, d.b.session, now!, DRAFT_ROOM.LONG_POLL_ACTOR_HOLD_MS),
      heldTick(d.season.id, d.pool[1].session, now!),
      heldTick(d.season.id, null, now!),
    ]);
    expect(version).not.toBe(now);
    const settledAt = endsAt.getTime();
    // The captain woke just after zero and settled the lot: the player sold
    // to captain A's team (the only bid).
    const late = Date.now() - settledAt;
    expect(late).toBeLessThan(INSTANT_MS + DRAFT_ROOM.LONG_POLL_CLOCK_GRACE_MS);
    expect(captain.json?.nominatedUserId).toBeNull();
    expect(
      (captain.json?.teams as { id: string; members: { userId: string }[] }[])
        .find((t) => t.id === d.a.team.id)!
        .members.some((m) => m.userId === d.pool[0].user.id),
    ).toBe(true);
    // The others were woken by that settle's publish, before the pool
    // player's own fallback wake at zero plus the due retry.
    expect(Date.now()).toBeLessThan(settledAt + DRAFT_ROOM.LONG_POLL_DUE_RETRY_MS);
    for (const reply of [poolPlayer, anonymous]) {
      expect(reply.json?.nominatedUserId).toBeNull();
      expect(reply.json?.roomVersion).not.toBe(now);
    }
    expect(poolPlayer.json?.held).toBe(true);
    expect(anonymous.json?.held).toBe(true);
  });

  it("with no captain or admin in the room, a pool player's tick settles the lot after the due retry", async () => {
    const d = await liveDraft();
    await openLot(d);
    const endsAt = await lotEndsIn(d.season.id, 800);
    const now = await readDraftRoomVersion();
    const [poolPlayer, anonymous] = await Promise.all([
      heldTick(d.season.id, d.pool[1].session, now!),
      heldTick(d.season.id, null, now!),
    ]);
    const late = Date.now() - endsAt.getTime();
    expect(late).toBeGreaterThanOrEqual(DRAFT_ROOM.LONG_POLL_DUE_RETRY_MS - 50);
    expect(late).toBeLessThan(DRAFT_ROOM.LONG_POLL_DUE_RETRY_MS + INSTANT_MS);
    for (const reply of [poolPlayer, anonymous]) {
      expect(reply.json?.nominatedUserId).toBeNull();
    }
    expect(
      await prisma.teamMember.count({ where: { userId: d.pool[0].user.id } }),
    ).toBe(1);
  });

  it("a signed-out tick never settles a lot: it holds to its hold", async () => {
    const d = await liveDraft();
    await openLot(d);
    const endsAt = await lotEndsIn(d.season.id, 300);
    const now = await readDraftRoomVersion();
    const reply = await heldTick(d.season.id, null, now!, 1_500);
    expect(Date.now()).toBeGreaterThan(endsAt.getTime() + 1_000);
    expect(reply.ms).toBeGreaterThanOrEqual(1_490);
    // Still on the block: nobody signed in asked.
    expect(reply.json?.nominatedUserId).toBe(d.pool[0].user.id);
    expect(await prisma.teamMember.count({ where: { userId: d.pool[0].user.id } })).toBe(0);
  });

  it("at once for a clock that ran out after the reply the client shows", async () => {
    const d = await liveDraft();
    await openLot(d);
    const shownAt = Date.now();
    await lotEndsIn(d.season.id, -500);
    const now = await readDraftRoomVersion();
    // The client shows a reply from before the lot closed: it is stale.
    const reply = await heldTick(
      d.season.id,
      d.b.session,
      now!,
      DRAFT_ROOM.LONG_POLL_ACTOR_HOLD_MS,
      shownAt - 1_000,
    );
    expect(reply.ms).toBeLessThan(INSTANT_MS);
    expect(reply.json?.held).toBe(true);
    // It settled the lot on the way.
    expect(reply.json?.nominatedUserId).toBeNull();
  });

  it("when its client goes away: no tick, nothing left held", async () => {
    const d = await liveDraft();
    const { version } = await plainTick(d.season.id, null);
    const controller = new AbortController();
    const held = heldTick(d.season.id, null, version, 20_000, undefined, controller.signal);
    await untilHeld(1);
    controller.abort();
    const reply = await held;
    expect(reply.status).toBe(204);
    expect(reply.ms).toBeLessThan(INSTANT_MS);
    expect(heldDraftRoomRequests()).toBe(0);
  });
});

describe("the draft room's shared copy", () => {
  it("serves every viewer the reply a fresh read gives them", async () => {
    const d = await liveDraft();
    await openLot(d);
    // The nominee has a Discord, which only some viewers may see.
    await prisma.user.update({
      where: { id: d.pool[0].user.id },
      data: { discordName: "pool0#1", discordId: "900000000000000123" },
    });
    // A standin registrant counts as an active registrant.
    const standin = await makeUser("Standin");
    await prisma.registration.create({
      data: { seasonId: d.season.id, userId: standin.id, type: "STANDIN", status: "ACTIVE", mmr: 3000 },
    });
    // A drafted player: sell pool 3 to captain B by hand (rows only).
    await prisma.teamMember.create({
      data: { seasonId: d.season.id, teamId: d.b.team.id, userId: d.pool[3].user.id, price: 3 },
    });
    await publishDraftRoomChange();
    const viewers: [string, SessionUser | null][] = [
      ["signed out", null],
      ["a spectator with no signup", d.spectator],
      ["a pool player", d.pool[1].session],
      ["the nominee", d.pool[0].session],
      ["a drafted player", d.pool[3].session],
      ["a standin", sessionFor(standin)],
      ["a captain", d.a.session],
      ["an admin", d.admin],
    ];
    // Warm the copy, then compare each viewer's tick with a fresh read.
    await plainTick(d.season.id, null);
    const strip = (state: Record<string, unknown> | null) => {
      const { now: _now, roomVersion: _v, held: _h, ...rest } = state ?? {};
      return rest;
    };
    let sawContact = 0;
    for (const [label, session] of viewers) {
      const tick = await plainTick(d.season.id, session);
      const fresh = await getDraftState(d.season.id, session, { resolveDeadlines: false });
      expect(strip(tick.state), label).toEqual(strip(fresh as unknown as Record<string, unknown>));
      const nominee = tick.state.nominatedPlayer as { discordName: string } | null;
      if (nominee?.discordName) sawContact += 1;
    }
    // The gating ran per viewer: the nominee, the active registrants and the
    // admin see the Discord; signed out and the unregistered spectator don't.
    expect(sawContact).toBe(6);
  });

  it("a captain coming back into the room shows on every open tab at once", async () => {
    const d = await liveDraft();
    const before = await plainTick(d.season.id, d.pool[1].session);
    const teamA = () =>
      (before.state.teams as { id: string; captainInRoom: boolean | null }[]).find(
        (t) => t.id === d.a.team.id,
      )!;
    expect(teamA().captainInRoom).toBe(false);
    const held = heldTick(d.season.id, d.pool[1].session, before.version);
    await untilHeld(1);
    await plainTick(d.season.id, d.a.session);
    const backAt = Date.now();
    const reply = await held;
    expect(Date.now() - backAt).toBeLessThan(INSTANT_MS);
    const shownA = (reply.json?.teams as { id: string; captainInRoom: boolean | null }[]).find(
      (t) => t.id === d.a.team.id,
    )!;
    expect(shownA.captainInRoom).toBe(true);
  });
});

describe("the draft long-poll's request volume", () => {
  it("looping clients make about one request per change, plus one per hold", async () => {
    const d = await liveDraft();
    await openLot(d);
    let stop = false;
    const counts = [0, 0, 0];
    const loops = [null, d.pool[1].session, d.pool[2].session].map(async (session, i) => {
      let { version } = await plainTick(d.season.id, session);
      counts[i] += 1;
      while (!stop) {
        const reply = await heldTick(d.season.id, session, version, 4_000);
        counts[i] += 1;
        version = reply.json?.roomVersion as string;
      }
    });
    await untilHeld(3);
    // Six changes, half a second apart: the bids of a short bidding war.
    let price = 1;
    for (let change = 0; change < 6; change++) {
      await sleep(500);
      const state = await getDraftState(d.season.id, null, { resolveDeadlines: false });
      const bidder = state!.currentBidTeamId === d.a.team.id ? d.b : d.a;
      price += 1;
      const { placeBid } = await import("@/lib/draft-service");
      expect((await placeBid(d.season.id, bidder.session, price)).ok).toBe(true);
    }
    await sleep(800);
    stop = true;
    // Let the last holds end (4s), then count.
    await Promise.all(loops);
    for (const count of counts) {
      // One plain tick, one per change (each woken hold answers it), and the
      // final hold that ran out: no polling between changes.
      expect(count).toBeGreaterThanOrEqual(7);
      expect(count).toBeLessThanOrEqual(9);
    }
  }, 30_000);
});
