import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Two of the standin MMR rule's loopholes, closed on the signup side:
//  * after the draft a player's own signup MMR is fixed (it is what the rule
//    measures cover by), so saveRegistration keeps the stored number on an
//    existing signup, says so, and leaves corrections to the admin forms;
//  * a standin who leaves (leaveLeague, or an admin's withdrawSignup) takes
//    their PENDING requests with them, each asking captain told, since a
//    request left waiting holds a seat nobody can agree to.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  getSessionUser: vi.fn(async () => ({
    id: "standin-mmr-admin",
    name: "Standin MMR Admin",
  })),
}));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchPlayerRankTier: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  sendDiscordMessage: vi.fn(async () => true),
}));
// A test can make the request cleanup lose its claim, as it does when a
// captain answers in the gap (on Postgres; SQLite can't interleave a rival
// inside an open transaction). Everything else is the real service.
const cleanup = vi.hoisted(() => ({ loseClaim: false }));
vi.mock("@/lib/standin-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/standin-service")>();
  return {
    ...actual,
    cancelPendingStandinRequests: async (
      ...args: Parameters<typeof actual.cancelPendingStandinRequests>
    ) => {
      const rows = await actual.cancelPendingStandinRequests(...args);
      if (cleanup.loseClaim) throw new actual.StandinRequestsChangedError();
      return rows;
    },
  };
});

import { leaveLeague, saveRegistration } from "@/app/actions/registration";
import {
  setPlayerRank,
  setRegistrationMmr,
  withdrawSignup,
} from "@/app/actions/admin-roster";
import { requireAdmin, requireUser } from "@/lib/auth";
import { sendDiscordMessage } from "@/lib/discord";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import {
  approveStandinRequest,
  assignStandinGuarded,
} from "@/lib/standin-service";
import { prisma } from "@/lib/prisma";
import {
  makeSeason,
  makeTeam,
  makeUser,
  raceAll,
  sessionFor,
} from "./factories";

function form(fields: Record<string, string | number>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
}

async function regFor(seasonId: string, userId: string) {
  return prisma.registration.findUniqueOrThrow({
    where: { seasonId_userId: { seasonId, userId } },
  });
}

let admin: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  vi.mocked(requireUser).mockReset();
  vi.mocked(requireAdmin).mockReset();
  admin = await makeUser("League Admin", "ADMIN");
  vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
  vi.mocked(sendDiscordMessage).mockReset();
  vi.mocked(sendDiscordMessage).mockResolvedValue(true);
  cleanup.loseClaim = false;
});
afterEach(() => setRaceHook(null));

describe("saveRegistration — a player's own MMR is locked after the draft", () => {
  /** A season in `status` with one existing signup for a signed-in user. */
  async function signedUp(opts: {
    status: string;
    draftStatus?: string | null;
    type?: "PLAYER" | "STANDIN";
    regStatus?: string;
    mmr?: number;
    rankTier?: number | null;
  }) {
    const season = await makeSeason({ status: opts.status });
    if (opts.draftStatus) {
      await prisma.draft.create({
        data: { seasonId: season.id, status: opts.draftStatus },
      });
    }
    const user = await makeUser("Signed Up");
    if (opts.rankTier != null) {
      await prisma.user.update({
        where: { id: user.id },
        data: { rankTier: opts.rankTier },
      });
    }
    const reg = await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: opts.type ?? "PLAYER",
        status: opts.regStatus ?? "ACTIVE",
        mmr: opts.mmr ?? 4200,
        roles: "",
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
    return { season, user, reg };
  }

  it("keeps a full player's stored MMR mid-season, lands the rest, and says so", async () => {
    const { season, user } = await signedUp({
      status: "REGULAR_SEASON",
      draftStatus: "COMPLETE",
    });

    const res = await saveRegistration(
      {},
      form({ type: "PLAYER", mmr: 3000, roles: "2", about: "new note" }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe(
      "Signup updated · MMR is locked after the draft — kept 4,200. Ask a league admin to change it.",
    );
    const reg = await regFor(season.id, user.id);
    expect(reg.mmr).toBe(4200);
    expect(reg.roles).toBe("2"); // the harmless edits still land
    expect(reg.captainNote).toBe("new note");
  });

  it("keeps a standin's too — lowering it would dodge the other captain's say", async () => {
    const { season, user } = await signedUp({
      status: "PLAYOFFS",
      type: "STANDIN",
      mmr: 3400,
    });

    const res = await saveRegistration({}, form({ type: "STANDIN", mmr: 3250 }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/MMR is locked after the draft — kept 3,400/);
    expect((await regFor(season.id, user.id)).mmr).toBe(3400);
  });

  it("locks as soon as the auction completes, while the season still reads DRAFT", async () => {
    const { season, user } = await signedUp({
      status: "DRAFT",
      draftStatus: "COMPLETE",
      type: "STANDIN",
    });

    const res = await saveRegistration({}, form({ type: "STANDIN", mmr: 1000 }));

    expect(res?.message).toMatch(/locked after the draft/);
    expect((await regFor(season.id, user.id)).mmr).toBe(4200);
  });

  it("is no way round to withdraw and rejoin with a new number", async () => {
    const { season, user } = await signedUp({
      status: "REGULAR_SEASON",
      type: "STANDIN",
      regStatus: "WITHDRAWN",
      mmr: 3600,
    });

    const res = await saveRegistration({}, form({ type: "STANDIN", mmr: 2000 }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/kept 3,600/);
    const reg = await regFor(season.id, user.id);
    expect(reg.status).toBe("ACTIVE");
    expect(reg.mmr).toBe(3600);
  });

  it("reads the disabled box (no field submitted) as unchanged, with no note", async () => {
    const { season, user } = await signedUp({
      status: "REGULAR_SEASON",
      mmr: 3800,
    });

    // What /me posts once the box is disabled: every field but mmr.
    const res = await saveRegistration(
      {},
      form({ type: "PLAYER", roles: "4" }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe("Signup updated");
    const reg = await regFor(season.id, user.id);
    expect(reg.mmr).toBe(3800);
    expect(reg.roles).toBe("4");
  });

  it("never re-clamps the kept number against the medal", async () => {
    // An admin set 4,800 over a Herald 1 medal (window 0–576). Kept means
    // untouched: snapping it to the medal now would undo the admin's call.
    const { season, user } = await signedUp({
      status: "REGULAR_SEASON",
      mmr: 4800,
      rankTier: 11,
    });

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 300 }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).not.toMatch(/medal/);
    expect((await regFor(season.id, user.id)).mmr).toBe(4800);
  });

  it("never judges the ceiling on what was typed under the lock", async () => {
    const { season, user } = await signedUp({ status: "REGULAR_SEASON" });

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 6000 }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/kept 4,200/);
    expect((await regFor(season.id, user.id)).mmr).toBe(4200);
  });

  it("lets a player an admin set over the ceiling keep saving, the admin's number standing", async () => {
    // The ceiling judges numbers a player enters. Under the lock this save
    // stores the admin's 5,200, so refusing it ("you entered 5,200", with
    // the box disabled) bricked every profile edit for the rest of the season.
    const { season, user } = await signedUp({
      status: "REGULAR_SEASON",
      draftStatus: "COMPLETE",
      mmr: 5200,
    });

    // What /me posts with the box disabled: every field but mmr.
    const fromMe = await saveRegistration(
      {},
      form({ type: "PLAYER", roles: "3", about: "still here" }),
    );
    expect(fromMe?.error).toBeUndefined();
    expect(fromMe?.message).toBe("Signup updated");
    let reg = await regFor(season.id, user.id);
    expect(reg.mmr).toBe(5200);
    expect(reg.roles).toBe("3");
    expect(reg.captainNote).toBe("still here");

    // A stale tab or a replayed POST that still carries the box is kept the
    // same way, and the toast says so.
    const typed = await saveRegistration(
      {},
      form({ type: "PLAYER", mmr: 5200, roles: "1" }),
    );
    expect(typed?.error).toBeUndefined();
    expect(typed?.message).toBe("Signup updated");
    const lowered = await saveRegistration(
      {},
      form({ type: "PLAYER", mmr: 3000, roles: "2" }),
    );
    expect(lowered?.error).toBeUndefined();
    expect(lowered?.message).toMatch(/kept 5,200/);
    reg = await regFor(season.id, user.id);
    expect(reg.mmr).toBe(5200);
    expect(reg.roles).toBe("2");
  });

  it("keeps every other gate on a kept number over the ceiling", async () => {
    // A withdrawn standin rejoining is a fresh admission: a Divine 3+ medal
    // still refuses it, kept number or not.
    const { season, user } = await signedUp({
      status: "REGULAR_SEASON",
      type: "STANDIN",
      regStatus: "WITHDRAWN",
      mmr: 5200,
      rankTier: 80,
    });

    const rejoin = await saveRegistration({}, form({ type: "STANDIN" }));
    expect(rejoin?.error).toMatch(/medal puts you above/);
    expect((await regFor(season.id, user.id)).status).toBe("WITHDRAWN");

    // …and a standin still can't make themselves a full player mid-season.
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: null },
    });
    const upgrade = await saveRegistration({}, form({ type: "PLAYER" }));
    expect(upgrade?.error).toBe("Player signups are closed for this season");
    const reg = await regFor(season.id, user.id);
    expect(reg.type).toBe("STANDIN");
    expect(reg.status).toBe("WITHDRAWN");
  });

  it("a tab left open across an aborted draft keeps the number, saying nothing about MMR", async () => {
    // The tab rendered while the lock held, so its box is disabled and posts
    // no mmr field. An admin then aborts the draft (the season goes back to
    // SIGNUPS and the auction to NOT_STARTED), lifting the lock. The save
    // from that tab used to read the missing field as a cleared box: 0 with
    // no medal, silently, or the medal's floor with one.
    for (const rankTier of [null, 53] as const) {
      const { season, user } = await signedUp({
        status: "DRAFT",
        draftStatus: "COMPLETE",
        mmr: 4200,
        rankTier, // Legend 3: a window of 2,965–3,964, under the stored 4,200
      });
      await prisma.draft.update({
        where: { seasonId: season.id },
        data: { status: "NOT_STARTED" },
      });
      await prisma.season.update({
        where: { id: season.id },
        data: { status: "SIGNUPS" },
      });

      const res = await saveRegistration(
        {},
        form({ type: "PLAYER", roles: "5", about: "after the abort" }),
      );

      expect(res?.error).toBeUndefined();
      expect(res?.message).toBe("Signup updated");
      const reg = await regFor(season.id, user.id);
      expect(reg.mmr).toBe(4200);
      expect(reg.roles).toBe("5");
      expect(reg.captainNote).toBe("after the abort");
      await prisma.season.update({
        where: { id: season.id },
        data: { isActive: false },
      });
    }
  });

  it("still clears a box the player blanked while unlocked", async () => {
    // A blank box sends the field (""), unlike a disabled one: that is the
    // player saying "unknown", judged as typed.
    const { season, user } = await signedUp({ status: "SIGNUPS", mmr: 3300 });

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: "" }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id)).mmr).toBe(0);
  });

  it("still refuses when an admin's correction lands mid-save, keeping theirs", async () => {
    // The kept number is the one this request read. An admin correcting it in
    // the gap is a real change, so the save refuses rather than writing the
    // old number back over it.
    const { season, user, reg } = await signedUp({ status: "REGULAR_SEASON" });
    let fired = false;
    setRaceHook(
      onceAt("registration.saveRegistration.beforeWrite", async () => {
        fired = true;
        const res = await setRegistrationMmr(
          {},
          form({ registrationId: reg.id, mmr: 4500 }),
        );
        expect(res?.error).toBeUndefined();
      }),
    );

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 3000 }));

    expect(fired).toBe(true);
    expect(res?.error).toMatch(/Your MMR changed while you submitted/);
    expect((await regFor(season.id, user.id)).mmr).toBe(4500);
  });

  it("stays editable during signups and draft setup", async () => {
    for (const draftStatus of [null, "NOT_STARTED"] as const) {
      const { season, user } = await signedUp({
        status: draftStatus ? "DRAFT" : "SIGNUPS",
        draftStatus,
        mmr: 3000,
      });

      const res = await saveRegistration(
        {},
        form({ type: "PLAYER", mmr: 3500 }),
      );

      expect(res?.error).toBeUndefined();
      expect(res?.message).not.toMatch(/locked/);
      expect((await regFor(season.id, user.id)).mmr).toBe(3500);
      await prisma.season.update({
        where: { id: season.id },
        data: { isActive: false },
      });
    }
  });

  it("lets a NEW standin registering mid-season set their own", async () => {
    const season = await makeSeason({ status: "REGULAR_SEASON" });
    const user = await makeUser("Late Standin");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "STANDIN", mmr: 2800 }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe("Registered as a standin");
    expect((await regFor(season.id, user.id)).mmr).toBe(2800);
  });

  it("leaves the admin forms free to change it", async () => {
    const { season, user, reg } = await signedUp({
      status: "REGULAR_SEASON",
      draftStatus: "COMPLETE",
    });

    const viaMmr = await setRegistrationMmr(
      {},
      form({ registrationId: reg.id, mmr: 3900 }),
    );
    expect(viaMmr?.error).toBeUndefined();
    expect((await regFor(season.id, user.id)).mmr).toBe(3900);

    // The rank editor on the admin signup lists (setPlayerRank).
    const viaEditor = await setPlayerRank(
      {},
      form({
        registrationId: reg.id,
        mmr: 3700,
        expectedMmr: 3900,
        expectedRankTier: 0,
        expectedRankTierManual: "0",
        medalMode: "manual",
        rankTier: 54,
      }),
    );
    expect(viaEditor?.error).toBeUndefined();
    expect((await regFor(season.id, user.id)).mmr).toBe(3700);

    // …and the player's next save keeps the admin's number.
    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 5000 }));
    expect(res?.message).toMatch(/kept 3,700/);
    expect((await regFor(season.id, user.id)).mmr).toBe(3700);
  });
});

describe("a standin who leaves takes their PENDING requests with them", () => {
  const HOME_CAPTAIN_DISCORD = "710000000000000001";
  const AWAY_CAPTAIN_DISCORD = "710000000000000002";

  /**
   * Mid-season: the leaving standin "Sub Lee" has PENDING requests from both
   * captains on unplayed fixtures, plus rows the withdrawal must not touch: a
   * request on a played fixture, an already-declined one, another standin's,
   * and one in an older season.
   */
  async function standinWithRequests() {
    const season = await makeSeason({ status: "REGULAR_SEASON", teamSize: 2 });
    const home = await makeTeam(season.id, "Home Side", 0);
    const away = await makeTeam(season.id, "Away Side", 1);
    await prisma.user.update({
      where: { id: home.captainId },
      data: { discordId: HOME_CAPTAIN_DISCORD },
    });
    await prisma.user.update({
      where: { id: away.captainId },
      data: { discordId: AWAY_CAPTAIN_DISCORD },
    });
    const rostered = async (teamId: string, name: string) => {
      const user = await makeUser(name);
      await prisma.registration.create({
        data: { seasonId: season.id, userId: user.id, mmr: 2000 },
      });
      await prisma.teamMember.create({
        data: { seasonId: season.id, teamId, userId: user.id, price: 5 },
      });
      return user;
    };
    const homePlayer = await rostered(home.id, "Home Player");
    const awayPlayer = await rostered(away.id, "Away Player");
    const standin = async (name: string) => {
      const user = await makeUser(name);
      const reg = await prisma.registration.create({
        data: {
          seasonId: season.id,
          userId: user.id,
          type: "STANDIN",
          status: "ACTIVE",
          mmr: 4000,
        },
      });
      return { user, reg };
    };
    const sub = await standin("Sub Lee");
    const otherSub = await standin("Other Sub");
    const fixture = (week: number, status = "SCHEDULED") =>
      prisma.match.create({
        data: {
          seasonId: season.id,
          week,
          phase: "REGULAR",
          homeTeamId: home.id,
          awayTeamId: away.id,
          status,
          scheduledAt: new Date(Date.UTC(2030, 0, week * 7, 20)),
        },
      });
    const week2 = await fixture(2);
    const week3 = await fixture(3);
    const played = await fixture(1, "COMPLETED");
    const request = (data: {
      matchId: string;
      teamId: string;
      standinUserId: string;
      replacingUserId: string;
      requestedById: string;
      status?: string;
    }) =>
      prisma.standinRequest.create({
        data: { standinMmr: 4000, baselineMmr: 2000, ...data },
      });
    const fromHome = await request({
      matchId: week2.id,
      teamId: home.id,
      standinUserId: sub.user.id,
      replacingUserId: homePlayer.id,
      requestedById: home.captainId,
    });
    const fromAway = await request({
      matchId: week3.id,
      teamId: away.id,
      standinUserId: sub.user.id,
      replacingUserId: awayPlayer.id,
      requestedById: away.captainId,
    });
    const untouched = [
      await request({
        matchId: played.id,
        teamId: home.id,
        standinUserId: sub.user.id,
        replacingUserId: homePlayer.id,
        requestedById: home.captainId,
      }),
      await request({
        matchId: week3.id,
        teamId: home.id,
        standinUserId: sub.user.id,
        replacingUserId: homePlayer.id,
        requestedById: home.captainId,
        status: "DECLINED",
      }),
      await request({
        matchId: week2.id,
        teamId: away.id,
        standinUserId: otherSub.user.id,
        replacingUserId: awayPlayer.id,
        requestedById: away.captainId,
      }),
    ];
    // Last season's leftover, on a fixture that never got played.
    const old = await makeSeason({ name: "Old Season", isActive: false });
    const oldMatch = await prisma.match.create({
      data: {
        seasonId: old.id,
        week: 9,
        phase: "REGULAR",
        homeTeamId: home.id,
        awayTeamId: away.id,
      },
    });
    untouched.push(
      await request({
        matchId: oldMatch.id,
        teamId: home.id,
        standinUserId: sub.user.id,
        replacingUserId: homePlayer.id,
        requestedById: home.captainId,
      }),
    );
    return { season, home, away, sub, fromHome, fromAway, untouched };
  }

  type Fixture = Awaited<ReturnType<typeof standinWithRequests>>;

  async function expectOnlyTheirsClosed(fx: Fixture, actorId: string) {
    for (const id of [fx.fromHome.id, fx.fromAway.id]) {
      const row = await prisma.standinRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe("CANCELLED");
      expect(row.decidedById).toBe(actorId);
      expect(row.decidedAt).not.toBeNull();
    }
    for (const before of fx.untouched) {
      const row = await prisma.standinRequest.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(row.status).toBe(before.status);
      expect(row.decidedAt).toBeNull();
    }
  }

  /** One post per closed request, each pinging only that request's captain. */
  function expectAskingCaptainsTold() {
    const calls = vi.mocked(sendDiscordMessage).mock.calls;
    expect(calls).toHaveLength(2);
    const byCaptain = new Map(
      calls.map(([content, mentions]) => [
        JSON.stringify(mentions?.users ?? []),
        content,
      ]),
    );
    for (const discordId of [HOME_CAPTAIN_DISCORD, AWAY_CAPTAIN_DISCORD]) {
      const content = byCaptain.get(JSON.stringify([discordId]));
      expect(content).toMatch(/Sub Lee\*\* left the league/);
      expect(content).toMatch(/is off/);
    }
  }

  it("leaveLeague closes them, tells each asking captain, and says how many", async () => {
    const fx = await standinWithRequests();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(fx.sub.user));

    const res = await leaveLeague({}, new FormData());

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe(
      "Withdrawn from this season · 2 standin requests for you were cancelled",
    );
    expect((await regFor(fx.season.id, fx.sub.user.id)).status).toBe(
      "WITHDRAWN",
    );
    await expectOnlyTheirsClosed(fx, fx.sub.user.id);
    expectAskingCaptainsTold();
  });

  it("admin withdrawSignup closes them too, and logs the count", async () => {
    const fx = await standinWithRequests();

    const res = await withdrawSignup(
      {},
      form({ registrationId: fx.sub.reg.id }),
    );

    expect(res?.error).toBeUndefined();
    // The undo hint beside it must not promise the requests back.
    expect(res?.message).toMatch(
      /; use Reinstate to undo · 2 pending standin requests for them were cancelled \(Reinstate doesn't bring requests back\)$/,
    );
    expect((await regFor(fx.season.id, fx.sub.user.id)).status).toBe(
      "REMOVED",
    );
    await expectOnlyTheirsClosed(fx, admin.id);
    expectAskingCaptainsTold();
    const log = await prisma.adminAction.findFirstOrThrow({
      where: { action: "withdrawSignup" },
    });
    expect(log.summary).toBe(
      "Removed Sub Lee's standin signup; cancelled 2 pending standin requests for them",
    );
  });

  it("posts nothing and says nothing extra when there was no request", async () => {
    const fx = await standinWithRequests();
    await prisma.standinRequest.updateMany({
      where: { id: { in: [fx.fromHome.id, fx.fromAway.id] } },
      data: { status: "DECLINED" },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(fx.sub.user));

    const res = await leaveLeague({}, new FormData());

    expect(res?.message).toBe("Withdrawn from this season");
    expect(sendDiscordMessage).not.toHaveBeenCalled();
  });

  it("still refuses a standin with a booking, cancelling nothing", async () => {
    const fx = await standinWithRequests();
    await prisma.standinAssignment.create({
      data: {
        matchId: fx.fromHome.matchId,
        teamId: fx.home.id,
        standinUserId: fx.sub.user.id,
        replacingUserId: fx.fromHome.replacingUserId,
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(fx.sub.user));

    const self = await leaveLeague({}, new FormData());
    const byAdmin = await withdrawSignup(
      {},
      form({ registrationId: fx.sub.reg.id }),
    );

    expect(self?.error).toMatch(/booked to stand in/);
    expect(byAdmin?.error).toMatch(/standing in for an unplayed match/);
    expect((await regFor(fx.season.id, fx.sub.user.id)).status).toBe("ACTIVE");
    expect(
      await prisma.standinRequest.count({
        where: { id: { in: [fx.fromHome.id, fx.fromAway.id] }, status: "PENDING" },
      }),
    ).toBe(2);
    expect(sendDiscordMessage).not.toHaveBeenCalled();
  });

  it("a lost request claim rolls the withdrawal back on both paths", async () => {
    // Past the withdrawal's write a short claim must THROW: a returned
    // refusal would commit a withdrawn standin whose requests still wait.
    const fx = await standinWithRequests();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(fx.sub.user));
    cleanup.loseClaim = true;

    const self = await leaveLeague({}, new FormData());
    const byAdmin = await withdrawSignup(
      {},
      form({ registrationId: fx.sub.reg.id }),
    );

    expect(self?.error).toBe(
      "A captain just answered a request for you to stand in — reload and try again.",
    );
    expect(byAdmin?.error).toBe(
      "A captain just answered a request for Sub Lee to stand in — reload and try again.",
    );
    expect((await regFor(fx.season.id, fx.sub.user.id)).status).toBe("ACTIVE");
    expect(
      await prisma.standinRequest.count({
        where: { id: { in: [fx.fromHome.id, fx.fromAway.id] }, status: "PENDING" },
      }),
    ).toBe(2);
    expect(sendDiscordMessage).not.toHaveBeenCalled();
    expect(
      await prisma.adminAction.count({ where: { action: "withdrawSignup" } }),
    ).toBe(0);
  });

  it("a booking that lands in the gap refuses the withdrawal and keeps the requests", async () => {
    // The cancellation shares the withdrawal's transaction: the re-count
    // refusing it must leave every request as it was.
    const fx = await standinWithRequests();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(fx.sub.user));
    let fired = false;
    setRaceHook(
      onceAt("registration.leaveLeague.beforeWithdraw", async () => {
        fired = true;
        await prisma.standinAssignment.create({
          data: {
            matchId: fx.fromHome.matchId,
            teamId: fx.home.id,
            standinUserId: fx.sub.user.id,
            replacingUserId: fx.fromHome.replacingUserId,
          },
        });
      }),
    );

    const res = await leaveLeague({}, new FormData());

    expect(fired).toBe(true);
    expect(res?.error).toMatch(/just been assigned/);
    expect(
      await prisma.standinRequest.count({
        where: { id: { in: [fx.fromHome.id, fx.fromAway.id] }, status: "PENDING" },
      }),
    ).toBe(2);
    expect(sendDiscordMessage).not.toHaveBeenCalled();
  });
});

// Raced: on Postgres the two run at once; on SQLite one after the other.
// Either order is legal, but never a WITHDRAWN standin with the request
// agreed (or booked), nor one whose request is still waiting.
describe("leaving vs an agree, raced (meaningful on Postgres only)", () => {
  it("ends as exactly one of the two outcomes", async () => {
    for (let round = 0; round < 3; round++) {
      const season = await makeSeason({ status: "REGULAR_SEASON", teamSize: 2 });
      const home = await makeTeam(season.id, `Race Home ${round}`, 0);
      const away = await makeTeam(season.id, `Race Away ${round}`, 1);
      const seat = await makeUser(`Seat ${round}`);
      await prisma.registration.create({
        data: { seasonId: season.id, userId: seat.id, mmr: 2000 },
      });
      await prisma.teamMember.create({
        data: { seasonId: season.id, teamId: home.id, userId: seat.id, price: 5 },
      });
      const sub = await makeUser(`Ringer ${round}`);
      await prisma.registration.create({
        data: {
          seasonId: season.id,
          userId: sub.id,
          type: "STANDIN",
          status: "ACTIVE",
          mmr: 4000,
        },
      });
      const match = await prisma.match.create({
        data: {
          seasonId: season.id,
          week: 1,
          phase: "REGULAR",
          homeTeamId: home.id,
          awayTeamId: away.id,
          scheduledAt: new Date("2030-02-01T20:00:00Z"),
        },
      });
      const asked = await assignStandinGuarded({
        matchId: match.id,
        standinUserId: sub.id,
        replacingUserId: seat.id,
        actingCaptainId: home.captainId,
      });
      expect(asked.ok && asked.pending).toBe(true);
      const request = await prisma.standinRequest.findFirstOrThrow({
        where: { matchId: match.id },
      });
      vi.mocked(requireUser).mockResolvedValue(sessionFor(sub));

      await raceAll<unknown>([
        () =>
          approveStandinRequest({
            requestId: request.id,
            actingCaptainId: away.captainId,
          }),
        () => leaveLeague({}, new FormData()),
      ]);

      const reg = await regFor(season.id, sub.id);
      const after = await prisma.standinRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      const booked = await prisma.standinAssignment.count({
        where: { standinUserId: sub.id },
      });
      if (reg.status === "WITHDRAWN") {
        expect(after.status).toBe("CANCELLED");
        expect(booked).toBe(0);
      } else {
        expect(reg.status).toBe("ACTIVE");
        // Agreed and booked, or (a serialization loser on both sides)
        // still waiting with nobody booked.
        expect(
          (after.status === "APPROVED" && booked === 1) ||
            (after.status === "PENDING" && booked === 0),
        ).toBe(true);
      }
      await prisma.season.update({
        where: { id: season.id },
        data: { isActive: false },
      });
    }
  });
});
