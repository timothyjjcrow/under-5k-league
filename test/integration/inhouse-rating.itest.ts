import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An admin's inhouse MMR and medal for any player, signed up for the league
// or not (Tim, 2026-10-17): the action, the guarded save, and every queue
// write that must carry the admin's number (a join, a join the save lands in
// the middle of, the requeues).

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireAdmin: vi.fn(),
  // logAdminAction resolves its actor from the session.
  getSessionUser: vi.fn(async () => ({ id: "rating-admin", name: "Rating Admin" })),
}));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchRankTier: vi.fn(),
}));
// The queue's milestone ping is a best-effort send: stub the sender only.
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  sendInhouseDiscordMessage: vi.fn(async () => true),
}));

import { revalidatePath } from "next/cache";
import { setInhouseRating } from "@/app/actions/inhouse-admin";
import type { ActionResult } from "@/lib/action-result";
import { requireAdmin, type SessionUser } from "@/lib/auth";
import { INHOUSE_STATUS } from "@/lib/constants";
import { fetchRankTier } from "@/lib/dota";
import { INHOUSE_RATING_CHANGED } from "@/lib/inhouse-rating";
import { loadInhouseRatingPage } from "@/lib/inhouse-rating-service";
import {
  cancelLobby,
  declineMatch,
  joinQueue,
  loadInhouseJoinFacts,
} from "@/lib/inhouse-service";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { SETTING_KEYS } from "@/lib/settings";
import { makeSeason, makeUser, raceAll, sessionFor } from "./factories";

const ADMIN: SessionUser = {
  id: "rating-admin",
  steamId: "76561190000009300",
  name: "Rating Admin",
  avatar: null,
  role: "ADMIN",
};

/** The editor's form: by default a never-rated player gets 4,100 and Legend 4. */
function ratingForm(userId: string, fields: Record<string, string> = {}) {
  const form = new FormData();
  const all: Record<string, string> = {
    userId,
    mmr: "4100",
    medalMode: "manual",
    rankTier: "54",
    expectedMmr: "",
    expectedRankTier: "0",
    expectedRankTierManual: "0",
    ...fields,
  };
  for (const [key, value] of Object.entries(all)) form.set(key, value);
  return form;
}

/** Only the MMR, leaving an OpenDota medal (none) as it is. */
const MMR_ONLY = { medalMode: "automatic" };

async function stored(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { inhouseMmr: true, rankTier: true, rankTierManual: true },
  });
}

async function queuedMmr(userId: string) {
  const row = await prisma.inhouseQueueEntry.findUnique({ where: { userId } });
  return row?.mmr ?? null;
}

async function roomVersion() {
  const row = await prisma.setting.findUnique({
    where: { key: SETTING_KEYS.INHOUSE_ROOM_VERSION },
  });
  return row?.value ?? null;
}

/** Ten joins: the tenth forms a lobby in its ready check. */
async function formLobby(prefix: string) {
  const players = [];
  for (let i = 0; i < 10; i += 1) {
    const user = await makeUser(`${prefix} ${i}`);
    expect((await joinQueue(sessionFor(user), 2000 + i)).ok).toBe(true);
    players.push(user);
  }
  const lobby = await prisma.inhouseLobby.findFirstOrThrow({
    where: { status: INHOUSE_STATUS.READY_CHECK },
  });
  return { players, lobby };
}

beforeEach(() => {
  vi.mocked(requireAdmin).mockReset();
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN);
  vi.mocked(fetchRankTier).mockReset();
  vi.mocked(fetchRankTier).mockResolvedValue({
    ok: false,
    rankTier: null,
    fhUnavailable: null,
  });
  vi.mocked(revalidatePath).mockClear();
});

afterEach(() => setRaceHook(null));

describe("an admin's inhouse MMR and medal, signup or not", () => {
  it("saves a never-signed-up player's MMR and medal, publishes the room and logs it", async () => {
    const user = await makeUser("Inhouse Only");
    const versionBefore = await roomVersion();

    const result = await setInhouseRating({}, ratingForm(user.id));

    expect(result).toEqual({
      message: "Inhouse Only: inhouse MMR 4,100 from their next join · Legend 4 medal (manual).",
    });
    expect(await stored(user.id)).toEqual({
      inhouseMmr: 4100,
      rankTier: 54,
      rankTierManual: true,
    });
    // Nothing about the league changed: no signup was made for them.
    expect(await prisma.registration.count({ where: { userId: user.id } })).toBe(0);
    expect(await roomVersion()).not.toBe(versionBefore);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(
      await prisma.adminAction.findFirst({ where: { action: "setInhouseRating" } }),
    ).toMatchObject({
      actorName: "Rating Admin",
      summary:
        "Set Inhouse Only's inhouse MMR none → 4,100; Unranked medal (from OpenDota) → Legend 4 medal (manual)",
    });
  });

  it("is what every join uses, over a typed number and a league signup's, unclamped", async () => {
    const season = await makeSeason({ isActive: false, status: "COMPLETE" });
    const user = await makeUser("Herald Smurf");
    // Herald 1's window is 0-576: a typed 3,000 would be clamped to it.
    await prisma.user.update({ where: { id: user.id }, data: { rankTier: 11 } });
    await prisma.registration.create({
      data: { seasonId: season.id, userId: user.id, mmr: 2000 },
    });
    expect(
      (await setInhouseRating({}, ratingForm(user.id, { ...MMR_ONLY, expectedRankTier: "11" })))
        ?.message,
    ).toBeTruthy();

    expect(await loadInhouseJoinFacts(user.id)).toEqual({
      adminMmr: 4100,
      signupMmr: 2000,
      rankTier: 11,
    });
    expect(await joinQueue(sessionFor(user), 3000)).toEqual({ ok: true });
    expect(await queuedMmr(user.id)).toBe(4100);
  });

  it("hands the join back to what they type once cleared", async () => {
    const user = await makeUser("Cleared");
    await setInhouseRating({}, ratingForm(user.id, MMR_ONLY));
    const cleared = await setInhouseRating(
      {},
      ratingForm(user.id, { ...MMR_ONLY, mmr: "", expectedMmr: "4100" }),
    );
    expect(cleared).toEqual({
      message: "Cleared: inhouse MMR cleared from their next join · Unranked medal (from OpenDota).",
    });
    expect((await stored(user.id)).inhouseMmr).toBeNull();
    expect(await joinQueue(sessionFor(user), 2500)).toEqual({ ok: true });
    expect(await queuedMmr(user.id)).toBe(2500);
  });

  it("turns them away at the queue when it is over the cap, in the cap's words", async () => {
    const user = await makeUser("Too Good");
    const result = await setInhouseRating({}, ratingForm(user.id, { ...MMR_ONLY, mmr: "6000" }));
    expect(result?.message).toMatch(/ Over the 5,000 cap: they can't join the queue\.$/);
    expect(await joinQueue(sessionFor(user), 3000)).toEqual({
      ok: false,
      error:
        "Inhouses are for players up to 5,000 MMR, the same as the league: an admin set your inhouse MMR to 6,000.",
    });
    expect(await queuedMmr(user.id)).toBeNull();
  });

  it("corrects a medal both ways: a stale Divine let in, a Divine kept out", async () => {
    const stale = await makeUser("Stale Divine");
    await prisma.user.update({ where: { id: stale.id }, data: { rankTier: 75 } });
    expect((await joinQueue(sessionFor(stale), 3000)).ok).toBe(false);
    await setInhouseRating(
      {},
      ratingForm(stale.id, { mmr: "4200", rankTier: "62", expectedRankTier: "75" }),
    );
    expect(await joinQueue(sessionFor(stale), 0)).toEqual({ ok: true });
    expect(await queuedMmr(stale.id)).toBe(4200);

    const smurf = await makeUser("Real Divine");
    await setInhouseRating({}, ratingForm(smurf.id, { mmr: "", rankTier: "74" }));
    expect(await joinQueue(sessionFor(smurf), 2000)).toEqual({
      ok: false,
      error: expect.stringMatching(/your Divine 4 medal puts you above it\.$/),
    });
  });

  it("rewrites a queued player's spot at once, and leaves it on a clear", async () => {
    const user = await makeUser("Queued");
    expect((await joinQueue(sessionFor(user), 2000)).ok).toBe(true);

    const set = await setInhouseRating({}, ratingForm(user.id, MMR_ONLY));
    expect(set?.message).toBe(
      "Queued: inhouse MMR 4,100, their queue spot too · Unranked medal (from OpenDota).",
    );
    expect(await queuedMmr(user.id)).toBe(4100);

    // What they typed is gone, so the spot keeps the admin's number until
    // their next join.
    await setInhouseRating({}, ratingForm(user.id, { ...MMR_ONLY, mmr: "", expectedMmr: "4100" }));
    expect(await queuedMmr(user.id)).toBe(4100);
    expect(await joinQueue(sessionFor(user), 2200)).toEqual({ ok: true });
    expect(await queuedMmr(user.id)).toBe(2200);
  });

  it("goes back to OpenDota's medal only when OpenDota answers", async () => {
    const user = await makeUser("Manual Medal");
    await setInhouseRating({}, ratingForm(user.id, { mmr: "" }));
    const back = ratingForm(user.id, {
      mmr: "",
      medalMode: "automatic",
      expectedRankTier: "54",
      expectedRankTierManual: "1",
    });

    expect(await setInhouseRating({}, back)).toEqual({
      error: "OpenDota couldn't be reached. Nothing was changed: try again later.",
    });
    expect(await stored(user.id)).toEqual({
      inhouseMmr: null,
      rankTier: 54,
      rankTierManual: true,
    });

    vi.mocked(fetchRankTier).mockResolvedValueOnce({
      ok: true,
      rankTier: 33,
      fhUnavailable: false,
    });
    expect((await setInhouseRating({}, back))?.message).toMatch(
      /Crusader 3 medal \(from OpenDota\)\.$/,
    );
    expect(await stored(user.id)).toEqual({
      inhouseMmr: null,
      rankTier: 33,
      rankTierManual: false,
    });
    expect(fetchRankTier).toHaveBeenLastCalledWith(
      Number(BigInt(user.steamId) - BigInt("76561197960265728")),
    );
  });

  it("refuses an editor drawn before another change, and writes nothing", async () => {
    const user = await makeUser("Stale Editor");
    await prisma.user.update({ where: { id: user.id }, data: { inhouseMmr: 3000 } });
    expect(await setInhouseRating({}, ratingForm(user.id))).toEqual({
      error: INHOUSE_RATING_CHANGED,
    });
    expect(await stored(user.id)).toEqual({
      inhouseMmr: 3000,
      rankTier: null,
      rankTierManual: false,
    });
    expect(await prisma.adminAction.count()).toBe(0);
  });

  it("refuses a malformed form and a player who doesn't exist", async () => {
    const user = await makeUser("Typo");
    expect(await setInhouseRating({}, ratingForm(user.id, { mmr: "0" }))).toEqual({
      error: "Enter a whole-number MMR from 1 to 12,000, or leave it blank.",
    });
    expect(await setInhouseRating({}, ratingForm("no-such-player"))).toEqual({
      error: "That player no longer exists.",
    });
    expect((await stored(user.id)).inhouseMmr).toBeNull();
  });

  it("is for admins only", async () => {
    const user = await makeUser("Untouched");
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("UNAUTHORIZED"));
    expect(await setInhouseRating({}, ratingForm(user.id))).toEqual({
      error: "Not authorized",
    });
    expect(await stored(user.id)).toEqual({
      inhouseMmr: null,
      rankTier: null,
      rankTierManual: false,
    });
  });
});

// The claim: the stored rating the editor showed. Each rival lands between
// the save's read and its write, where only the claim's WHERE can see it.
describe("an admin's inhouse rating — the claim", () => {
  it("loses to a second admin's save that lands first", async () => {
    const user = await makeUser("Two Admins");
    let fired = false;
    setRaceHook(
      onceAt("inhouseRating.saveInhouseRating.beforeClaim", async () => {
        fired = true;
        const rival = await setInhouseRating({}, ratingForm(user.id, { mmr: "3600" }));
        expect(rival?.message).toBeTruthy();
      }),
    );
    expect(await setInhouseRating({}, ratingForm(user.id, { mmr: "4400" }))).toEqual({
      error: INHOUSE_RATING_CHANGED,
    });
    expect(fired).toBe(true);
    expect((await stored(user.id)).inhouseMmr).toBe(3600);
    expect(await prisma.adminAction.count({ where: { action: "setInhouseRating" } })).toBe(1);
  });

  it("loses to the worker's medal refresh, never writing an old medal back", async () => {
    const user = await makeUser("Refreshed");
    await prisma.user.update({ where: { id: user.id }, data: { rankTier: 31 } });
    let fired = false;
    setRaceHook(
      onceAt("inhouseRating.saveInhouseRating.beforeClaim", async () => {
        fired = true;
        // refreshPlayerData's own write: OpenDota's medal, unless manual.
        await prisma.user.updateMany({
          where: { id: user.id, rankTierManual: false },
          data: { rankTier: 45 },
        });
      }),
    );
    // Only the MMR changes; the medal stays OpenDota's as the editor saw it.
    const result = await setInhouseRating(
      {},
      ratingForm(user.id, { ...MMR_ONLY, expectedRankTier: "31" }),
    );
    expect(result).toEqual({ error: INHOUSE_RATING_CHANGED });
    expect(fired).toBe(true);
    expect(await stored(user.id)).toEqual({
      inhouseMmr: null,
      rankTier: 45,
      rankTierManual: false,
    });
  });

  it("racing admins: exactly one save lands", async () => {
    for (let round = 0; round < 5; round += 1) {
      const user = await makeUser(`Race ${round}`);
      const results = await raceAll([
        () => setInhouseRating({}, ratingForm(user.id, { mmr: "3100" })),
        () => setInhouseRating({}, ratingForm(user.id, { mmr: "3900" })),
      ]);
      const saved = results.filter((r) => r?.message);
      expect(saved, `round ${round}`).toHaveLength(1);
      expect(results.filter((r) => r?.error === INHOUSE_RATING_CHANGED)).toHaveLength(1);
      expect((await stored(user.id)).inhouseMmr).toBe(
        saved[0]?.message?.includes("3,100") ? 3100 : 3900,
      );
    }
  });
});

// The queue spot must carry the admin's number however the save and the
// player's own join interleave: the join reads it inside its transaction.
describe("an admin's inhouse MMR — the queue spot", () => {
  it("seeds a join that the save lands in the middle of", async () => {
    const user = await makeUser("Mid Join");
    let fired = false;
    setRaceHook(
      onceAt("inhouse.joinQueue.beforeWrite", async () => {
        fired = true;
        // No queue row yet, so the save's own rewrite finds nothing.
        const saved = await setInhouseRating({}, ratingForm(user.id, MMR_ONLY));
        expect(saved?.message).toMatch(/from their next join/);
      }),
    );
    expect(await joinQueue(sessionFor(user), 2000)).toEqual({ ok: true });
    expect(fired).toBe(true);
    expect(await queuedMmr(user.id)).toBe(4100);
  });

  it("racing a join and a save always leaves the spot at the stored number", async () => {
    for (let round = 0; round < 6; round += 1) {
      const user = await makeUser(`Join Race ${round}`);
      const [joined, saved] = await raceAll<ActionResult>([
        () => joinQueue(sessionFor(user), 2000),
        () => setInhouseRating({}, ratingForm(user.id, MMR_ONLY)),
      ]);
      expect(joined?.ok, `round ${round}`).toBe(true);
      const { inhouseMmr } = await stored(user.id);
      // A save that lost a serialization race says so and wrote nothing.
      expect(inhouseMmr === null ? saved?.error : saved?.message, `round ${round}`).toBeTruthy();
      expect(await queuedMmr(user.id), `round ${round}`).toBe(inhouseMmr ?? 2000);
    }
  });

  it("puts a cancelled game's player back at a number saved during the game", async () => {
    const { players, lobby } = await formLobby("Cancelled");
    await setInhouseRating({}, ratingForm(players[0].id, MMR_ONLY));
    expect(await cancelLobby(ADMIN, lobby.id)).toEqual({ ok: true });
    expect(await queuedMmr(players[0].id)).toBe(4100);
    expect(await queuedMmr(players[1].id)).toBe(2001);
  });

  it("puts a failed ready check's players back at a number saved during it", async () => {
    const { players, lobby } = await formLobby("Declined");
    await setInhouseRating({}, ratingForm(players[2].id, MMR_ONLY));
    expect((await declineMatch(sessionFor(players[9]), lobby.id)).ok).toBe(true);
    expect(await queuedMmr(players[2].id)).toBe(4100);
    expect(await queuedMmr(players[3].id)).toBe(2003);
    expect(await queuedMmr(players[9].id)).toBeNull();
  });
});

describe("/admin/inhouse-players' lists", () => {
  it("shows the queue, the latest players, then anyone else an admin rated", async () => {
    const season = await makeSeason();
    const queued = await makeUser("Queued Quinn");
    const played = await makeUser("Played Pat");
    const rated = await makeUser("Rated Rae");
    await makeUser("Nobody Ned");
    await prisma.registration.create({
      data: { seasonId: season.id, userId: queued.id, mmr: 3300 },
    });
    expect((await joinQueue(sessionFor(queued), 0)).ok).toBe(true);
    const lobby = await prisma.inhouseLobby.create({
      data: { status: INHOUSE_STATUS.COMPLETED, radiantTeam: 1, winnerTeam: 1 },
    });
    await prisma.inhouseLobbyPlayer.create({
      data: { lobbyId: lobby.id, userId: played.id, mmr: 2700, team: 1 },
    });
    await setInhouseRating({}, ratingForm(rated.id, MMR_ONLY));

    const page = await loadInhouseRatingPage(null);
    expect(page.results).toBeNull();
    expect(page.queued.map((r) => r.name)).toEqual(["Queued Quinn"]);
    expect(page.queued[0]).toMatchObject({ signupMmr: 3300, queuedMmr: 3300, adminMmr: null });
    expect(page.recent.map((r) => r.name)).toEqual(["Played Pat"]);
    expect(page.recent[0]).toMatchObject({ lastGameMmr: 2700, queuedMmr: null });
    expect(page.adminSet.map((r) => r.name)).toEqual(["Rated Rae"]);
    expect(page.adminSet[0].adminMmr).toBe(4100);
  });

  it("finds a player by any part of their name, their Steam ID or a profile link", async () => {
    // A real-sized account id (the factory's are a few digits, which no
    // profile link carries).
    const accountId = 123456789;
    const user = await prisma.user.create({
      data: {
        name: "SmurfLord",
        steamId: (BigInt("76561197960265728") + BigInt(accountId)).toString(),
      },
    });
    await makeUser("Someone Else");
    const names = async (q: string) =>
      (await loadInhouseRatingPage(q)).results?.map((r) => r.name);
    expect(await names("smurf")).toEqual(["SmurfLord"]);
    expect(await names("LORD")).toEqual(["SmurfLord"]);
    expect(await names(user.steamId)).toEqual(["SmurfLord"]);
    expect(await names(`https://steamcommunity.com/profiles/${user.steamId}/`)).toEqual([
      "SmurfLord",
    ]);
    expect(await names(`https://www.opendota.com/players/${accountId}`)).toEqual([
      "SmurfLord",
    ]);
    expect(await names(`https://www.dotabuff.com/players/${accountId}`)).toEqual([
      "SmurfLord",
    ]);
    expect(await names("nobody by this name")).toEqual([]);
  });
});
