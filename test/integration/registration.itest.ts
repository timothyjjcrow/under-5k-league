import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

// The action calls revalidatePath (Next request scope), requireUser (cookies),
// and — for new signups — fetchPlayerRankTier (network). Stub all three so we
// can drive the real saveRegistration end-to-end against the test DB.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(), requireAdmin: vi.fn() }));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchPlayerRankTier: vi.fn(async () => null),
}));

import { leaveLeague, saveRegistration } from "@/app/actions/registration";
import { setRegistrationMmr, withdrawSignup } from "@/app/actions/admin";
import { requireAdmin, requireUser } from "@/lib/auth";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { fetchPlayerRankTier } from "@/lib/dota";
import { prisma } from "@/lib/prisma";
import { makeUser, makeSeason, sessionFor } from "./factories";

function form(fields: Record<string, string | number>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
}

async function regFor(seasonId: string, userId: string) {
  return prisma.registration.findUnique({
    where: { seasonId_userId: { seasonId, userId } },
  });
}

describe("saveRegistration — MMR soft limit / hard ceiling", () => {
  beforeEach(() => vi.mocked(requireUser).mockReset());

  it("lets a player ABOVE the 4.5K soft limit sign up (reviewed, not blocked)", async () => {
    const season = await makeSeason({ maxMmr: 4500, status: "SIGNUPS" });
    const user = await makeUser("Above Soft Limit");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 4700 }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBeTruthy();
    const reg = await regFor(season.id, user.id);
    expect(reg?.status).toBe("ACTIVE");
    expect(reg?.type).toBe("PLAYER");
    expect(reg?.mmr).toBe(4700);
  });

  it("rejects a player OVER the 5000 hard ceiling and records no signup", async () => {
    const season = await makeSeason({ maxMmr: 4500, status: "SIGNUPS" });
    const user = await makeUser("Immortal Smurf");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 5200 }));

    expect(res?.error).toMatch(/over 5000/);
    expect(await regFor(season.id, user.id)).toBeNull();
  });

  it("allows a player exactly AT the hard ceiling", async () => {
    const season = await makeSeason({ maxMmr: 4500, status: "SIGNUPS" });
    const user = await makeUser("Right At The Line");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 5000 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(5000);
  });

  it("still blocks 5K+ even with no soft limit set", async () => {
    const season = await makeSeason({ maxMmr: 0, status: "SIGNUPS" });
    const user = await makeUser("Way Too High");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 8000 }));

    expect(res?.error).toMatch(/over 5000/);
    expect(await regFor(season.id, user.id)).toBeNull();
  });
});

// Medal MMR validation: the gate judges the RAW claim + medal, then a
// gate-approved claim outside the medal's plausible window (clampMmrToRank,
// ≤1000 MMR wide) is stored as the window's floor.
describe("saveRegistration — medal MMR validation", () => {
  beforeEach(() => {
    vi.mocked(requireUser).mockReset();
    vi.mocked(fetchPlayerRankTier).mockReset();
    vi.mocked(fetchPlayerRankTier).mockResolvedValue(null);
  });

  async function medaled(name: string, rankTier: number) {
    const user = await makeUser(name);
    await prisma.user.update({ where: { id: user.id }, data: { rankTier } });
    return user;
  }

  it("snaps an inflated claim to the medal window's floor and says so", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Fibber", 54); // Legend 4 → window 3119–4118
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 4900 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(3119);
    // The toast must own the rewrite — silently changing a typed value reads
    // as a bug to the player.
    expect(res?.message).toMatch(/3119/);
    expect(res?.message).toMatch(/Legend 4/);
  });

  it("keeps a claim the medal finds plausible, without a note", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Honest", 54);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 4000 }));

    expect((await regFor(season.id, user.id))?.mmr).toBe(4000);
    expect(res?.message).not.toMatch(/range/);
  });

  it("estimates a blank MMR from the medal instead of storing unknown", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Left It Blank", 54);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 0 }));

    expect((await regFor(season.id, user.id))?.mmr).toBe(3119);
    expect(res?.message).toMatch(/estimated/i);
  });

  it("still rejects a RAW claim over the hard ceiling — the clamp never launders it", async () => {
    // Gate first, clamp second: a 5200 claim is judged as 5200 (rejected),
    // never as its medal floor. Otherwise overstating would be the way IN —
    // the bigger the lie, the lower the clamped number the gate would see.
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Tall Tale", 54);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 5200 }));

    expect(res?.error).toMatch(/over 5000/);
    expect(await regFor(season.id, user.id)).toBeNull();
  });

  it("rejects a 5K+ medal outright — sandbagging a low claim doesn't help", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    for (const [name, tier] of [
      ["Immortal Lurker", 80],
      ["Divine Five", 75],
    ] as const) {
      const user = await medaled(name, tier);
      vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
      const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 3000 }));
      expect(res?.error).toMatch(/medal puts you above/);
      expect(await regFor(season.id, user.id)).toBeNull();
    }
  });

  it("clamps standin signups too", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Standin Fibber", 54);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "STANDIN", mmr: 4900 }));

    expect(res?.error).toBeUndefined();
    const reg = await regFor(season.id, user.id);
    expect(reg?.type).toBe("STANDIN");
    expect(reg?.mmr).toBe(3119);
  });

  it("clears an implausible claim to unknown when the medal floor is 0", async () => {
    // Herald 1's window is 0–576: a 3000 claim snaps to 0, the unknown
    // sentinel — the toast owns that (captains judge by the medal).
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Humble Herald", 11);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 3000 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(0);
    expect(res?.message).toMatch(/left unknown/i);
  });

  it("never re-clamps an untouched resubmit — admin corrections survive edits", async () => {
    // An admin corrected this stale-medal player to 4800 (Herald 1 window is
    // 0–576). Editing roles resubmits the prefilled 4800 — it must stand.
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Admin Fixed", 11);
    await prisma.registration.create({
      data: { seasonId: season.id, userId: user.id, mmr: 4800 },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration(
      {},
      form({ type: "PLAYER", mmr: 4800, roles: "1" }),
    );

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(4800);
    expect(res?.message).not.toMatch(/unknown|range/);

    // Typing a DIFFERENT number is a fresh self-report — the medal check runs.
    const res2 = await saveRegistration(
      {},
      form({ type: "PLAYER", mmr: 4700 }),
    );
    expect(res2?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(0);
  });

  it("validates against a medal fetched during THIS signup", async () => {
    // No stored medal — the new-signup OpenDota fetch runs BEFORE the clamp,
    // so a fresh medal already polices the very first claim.
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await makeUser("Fresh Medal");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
    vi.mocked(fetchPlayerRankTier).mockResolvedValue(54);

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 900 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(3119);
    const dbUser = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(dbUser.rankTier).toBe(54);
    // The adjustment note names the medal — the fetched-medal label must not
    // make the toast say "Legend 4" twice.
    expect(res?.message?.match(/Legend 4/g)).toHaveLength(1);
  });

  it("clamps signup edits from the stored medal without re-fetching", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Editor", 54);
    await prisma.registration.create({
      data: { seasonId: season.id, userId: user.id, mmr: 4000 },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 4900 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(3119);
    // Edits never re-hit OpenDota (API budget rule).
    expect(vi.mocked(fetchPlayerRankTier)).not.toHaveBeenCalled();
  });

  it("changes nothing for a player with no medal on file", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await makeUser("Unranked");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 4700 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(4700);
  });
});

// REMOVED is the only irreversible signup state — the moderation one. Its
// entire enforcement is the `status: { not: REMOVED }` predicate on the update
// claim; the upsert underneath writes ACTIVE unconditionally, so a removed
// player who reloads /me and resubmits the form must be refused BY THAT WHERE.
// (There used to be a read-time `if` above it saying the same thing, which
// meant no test could ever reach the guard that actually matters.)
describe("saveRegistration — an admin REMOVAL is not self-reversible", () => {
  beforeEach(() => vi.mocked(requireUser).mockReset());

  async function removedPlayer() {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await makeUser("Shown The Door");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "REMOVED",
        mmr: 3000,
        roles: "carry",
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
    return { season, user };
  }

  it("refuses the resubmit and leaves the signup REMOVED", async () => {
    const { season, user } = await removedPlayer();

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 4200 }));

    expect(res?.error).toMatch(/admin removed your signup/i);
    const reg = await regFor(season.id, user.id);
    expect(reg?.status).toBe("REMOVED");
    // Nothing from the form landed either — a refused write that still stored
    // the new MMR/roles would let a removed player edit their pool entry.
    expect(reg?.mmr).toBe(3000);
    expect(reg?.roles).toBe("carry");
  });

  it("does not let them slip back in as a STANDIN either", async () => {
    // Standins are accepted in every phase, so this is the open door if the
    // refusal were keyed off anything but the row's own status.
    const { season, user } = await removedPlayer();

    const res = await saveRegistration({}, form({ type: "STANDIN", mmr: 2000 }));

    expect(res?.error).toMatch(/admin removed your signup/i);
    const reg = await regFor(season.id, user.id);
    expect(reg?.status).toBe("REMOVED");
    expect(reg?.type).toBe("PLAYER");
  });

  it("still lets a SELF-withdrawn player come back", async () => {
    // The other half of the contract: WITHDRAWN is a change of mind, not a
    // sanction, so the same claim must let it through.
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await makeUser("Changed My Mind");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "WITHDRAWN",
        mmr: 3000,
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 3100 }));

    expect(res?.error).toBeUndefined();
    const reg = await regFor(season.id, user.id);
    expect(reg?.status).toBe("ACTIVE");
    expect(reg?.mmr).toBe(3100);
  });
});

// The admin override is the escape hatch when the medal check is wrong
// (stale medal, recalibration): it stores the raw value, never clamps, and
// only FLAGS a medal mismatch in its message.
describe("setRegistrationMmr — advisory-only admin override", () => {
  beforeEach(() => {
    vi.mocked(requireAdmin).mockReset();
    vi.mocked(requireAdmin).mockResolvedValue(
      sessionFor({ id: "admin", steamId: "1", name: "Admin", role: "ADMIN" }),
    );
  });

  async function registered(rankTier: number | null, mmr: number) {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await makeUser("Corrected");
    if (rankTier != null) {
      await prisma.user.update({ where: { id: user.id }, data: { rankTier } });
    }
    const reg = await prisma.registration.create({
      data: { seasonId: season.id, userId: user.id, mmr },
    });
    return { season, user, reg };
  }

  it("stores an out-of-window value RAW and flags the mismatch", async () => {
    const { reg } = await registered(11, 500); // Herald 1, window 0–576
    const res = await setRegistrationMmr(
      {},
      form({ registrationId: reg.id, mmr: 4800 }),
    );

    expect(res?.error).toBeUndefined();
    const after = await prisma.registration.findUniqueOrThrow({
      where: { id: reg.id },
    });
    expect(after.mmr).toBe(4800); // never clamped
    expect(res?.message).toMatch(/heads up/i);
    expect(res?.message).toMatch(/Herald 1/);
  });

  it("stays quiet for an in-window value", async () => {
    const { reg } = await registered(54, 3000);
    const res = await setRegistrationMmr(
      {},
      form({ registrationId: reg.id, mmr: 4000 }),
    );

    expect(res?.error).toBeUndefined();
    expect(
      (await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } }))
        .mmr,
    ).toBe(4000);
    expect(res?.message).not.toMatch(/heads up/i);
  });
});

// The self-serve withdraw path. A standin who still owes cover used to be able
// to walk out silently: the registration flipped to WITHDRAWN, the
// StandinAssignment survived, and matchNightRoster kept swapping the covered
// player out for someone no longer in the league — so the team looked staffed
// right up to kickoff while /me stopped reminding the ex-standin entirely.
describe("leaveLeague — a standin can't walk out on cover they owe", () => {
  beforeEach(() => vi.mocked(requireUser).mockReset());

  async function standinWithCover(matchStatus: string) {
    const season = await makeSeason({
      teamSize: 5,
      status: "REGULAR_SEASON",
    });
    const capA = await makeUser("Cap A");
    const capB = await makeUser("Cap B");
    const alpha = await prisma.team.create({
      data: { seasonId: season.id, name: "Alpha", captainId: capA.id, budget: 100, draftOrder: 0 },
    });
    const bravo = await prisma.team.create({
      data: { seasonId: season.id, name: "Bravo", captainId: capB.id, budget: 100, draftOrder: 1 },
    });
    const covered = await makeUser("Covered Player");
    await prisma.registration.create({
      data: { seasonId: season.id, userId: covered.id, type: "PLAYER", status: "ACTIVE", mmr: 3000 },
    });
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: alpha.id, userId: covered.id, price: 10 },
    });
    const standin = await makeUser("The Standin");
    await prisma.registration.create({
      data: { seasonId: season.id, userId: standin.id, type: "STANDIN", status: "ACTIVE", mmr: 2500 },
    });
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 4,
        phase: "REGULAR",
        homeTeamId: alpha.id,
        awayTeamId: bravo.id,
        bestOf: 2,
        status: matchStatus,
      },
    });
    await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: alpha.id,
        standinUserId: standin.id,
        replacingUserId: covered.id,
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(standin));
    return { season, standin };
  }

  it("refuses, naming the assignment, while the match is unplayed", async () => {
    const { season, standin } = await standinWithCover("SCHEDULED");

    const res = await leaveLeague({}, new FormData());

    // Self-serve wording: second person, and it prescribes an action the
    // standin can actually take (ask, not remove — they hold no remove control).
    expect(res?.error).toMatch(/booked to stand in for an unplayed match/i);
    expect(res?.error).toMatch(/captain or an admin/i);
    const reg = await prisma.registration.findUniqueOrThrow({
      where: { seasonId_userId: { seasonId: season.id, userId: standin.id } },
    });
    expect(reg.status).toBe("ACTIVE");
  });

  it("allows the withdrawal once that match has been played", async () => {
    const { season, standin } = await standinWithCover("COMPLETED");

    const res = await leaveLeague({}, new FormData());

    expect(res?.error).toBeUndefined();
    const reg = await prisma.registration.findUniqueOrThrow({
      where: { seasonId_userId: { seasonId: season.id, userId: standin.id } },
    });
    expect(reg.status).not.toBe("ACTIVE");
  });
});

// Everything leaveLeague checks — cover owed, captaincy, a roster seat, the
// signup being active at all — is judged on rows read several statements before
// the write. The write re-asserts only ONE of them, and this is why: an admin
// REMOVAL landing in that gap is the single rival whose result must not be
// overwritten, because REMOVED is the only signup state a player cannot clear
// themselves. Turn it into WITHDRAWN and they just re-register.
//
// The gate can't be the thing that catches it (it ran before the removal
// existed) and racing can't steer it, so the rival commits at the seam.
describe("leaveLeague — an admin removal in the gap is not overwritten", () => {
  beforeEach(() => {
    vi.mocked(requireUser).mockReset();
    vi.mocked(requireAdmin).mockReset();
  });
  afterEach(() => setRaceHook(null));

  it("loses to the removal and leaves the signup REMOVED", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const admin = await makeUser("Admin", "ADMIN");
    const user = await makeUser("Leaving Anyway");
    const reg = await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "ACTIVE",
        mmr: 3000,
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));

    let fired = false;
    setRaceHook(
      onceAt("registration.leaveLeague.beforeWithdraw", async () => {
        fired = true;
        // The admin's removal commits between the gate and the write. Nothing
        // is open here — the withdrawal's transaction starts after this
        // returns — so the rival is a plain committed write, on either engine.
        const res = await withdrawSignup({}, form({ registrationId: reg.id }));
        expect(res?.error).toBeUndefined();
      }),
    );

    const res = await leaveLeague({}, new FormData());

    expect(fired).toBe(true); // the seam was reached — not a vacuous pass
    expect(res?.error).toBeTruthy();
    expect(res?.message).toBeUndefined();
    const after = await regFor(season.id, user.id);
    expect(after?.status).toBe("REMOVED");
  });

  it("still withdraws normally when nothing races it", async () => {
    // The claim must not be so tight that the ordinary path stops working —
    // the same assertion the seam test would pass vacuously without.
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await makeUser("Just Leaving");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "ACTIVE",
        mmr: 3000,
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await leaveLeague({}, new FormData());

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.status).toBe("WITHDRAWN");
  });
});

// The mirror image of the seam above: admin withdrawSignup's transaction used
// to re-count only standin cover, then write REMOVED with a blind
// update({where:{id}}) — no seat re-check (a draft sale or signFreeAgent in
// the gap left the player REMOVED while seated, a state nothing repairs) and
// no status predicate (a concurrent self-withdrawal was silently stamped
// over). Both rivals commit at the pre-transaction seam, so these run on
// SQLite too.
describe("admin withdrawSignup — the write re-asserts the seat and the status", () => {
  beforeEach(() => {
    vi.mocked(requireUser).mockReset();
    vi.mocked(requireAdmin).mockReset();
  });
  afterEach(() => setRaceHook(null));

  async function activeSignup() {
    const season = await makeSeason({ status: "SIGNUPS" });
    const admin = await makeUser("Admin", "ADMIN");
    const user = await makeUser("Target");
    const reg = await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "ACTIVE",
        mmr: 3000,
      },
    });
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
    return { season, admin, user, reg };
  }

  it("refuses when the player is rostered in the gap, leaving them ACTIVE", async () => {
    const { season, user, reg } = await activeSignup();
    const team = await prisma.team.create({
      data: {
        seasonId: season.id,
        name: "Late Buyers",
        captainId: (await makeUser("Cap")).id,
        budget: 100,
        draftOrder: 0,
      },
    });

    let fired = false;
    setRaceHook(
      onceAt("admin.withdrawSignup.beforeTx", async () => {
        fired = true;
        // The auction sale / free-agent signing commits in the gap. Plain
        // committed write on its own connection — nothing is open yet.
        await prisma.teamMember.create({
          data: {
            seasonId: season.id,
            teamId: team.id,
            userId: user.id,
            price: 5,
          },
        });
      }),
    );

    const res = await withdrawSignup({}, form({ registrationId: reg.id }));

    expect(fired).toBe(true); // seam reached — not a vacuous pass
    expect(res?.error).toMatch(/on a roster/i);
    const after = await prisma.registration.findUniqueOrThrow({
      where: { id: reg.id },
    });
    expect(after.status).toBe("ACTIVE"); // never REMOVED-while-seated
  });

  it("loses to a self-withdrawal in the gap instead of stamping over it", async () => {
    // Kills the status-predicate mutant: with a blind update this test sees
    // REMOVED — the admin's write overwrote a state the player chose and can
    // reverse, with neither side told.
    const { reg } = await activeSignup();

    let fired = false;
    setRaceHook(
      onceAt("admin.withdrawSignup.beforeTx", async () => {
        fired = true;
        await prisma.registration.update({
          where: { id: reg.id },
          data: { status: "WITHDRAWN" },
        });
      }),
    );

    const res = await withdrawSignup({}, form({ registrationId: reg.id }));

    expect(fired).toBe(true);
    expect(res?.error).toMatch(/just changed/i);
    const after = await prisma.registration.findUniqueOrThrow({
      where: { id: reg.id },
    });
    expect(after.status).toBe("WITHDRAWN"); // the player's choice stands
  });

  it("still removes normally when nothing races it", async () => {
    const { reg } = await activeSignup();

    const res = await withdrawSignup({}, form({ registrationId: reg.id }));

    expect(res?.error).toBeUndefined();
    const after = await prisma.registration.findUniqueOrThrow({
      where: { id: reg.id },
    });
    expect(after.status).toBe("REMOVED");
  });
});

describe("saveRegistration — no player/standin flips while the auction runs", () => {
  // The pool is live property of the draft engine: the on-the-block player
  // flipping to STANDIN rendered a headless lot in every room, and the sale
  // still charged the team. The write-time backstop (resolveExpiredNomination
  // voiding a non-PLAYER lot) is tested in draft.itest.ts; this is the
  // player-facing refusal.
  async function liveDraftSeason(draftStatus: string) {
    const season = await makeSeason({ status: "DRAFT" });
    await prisma.draft.create({
      data: { seasonId: season.id, status: draftStatus },
    });
    const user = await makeUser("Mid Draft Flipper");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "ACTIVE",
        mmr: 3000,
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
    return { season, user };
  }

  it("refuses PLAYER→STANDIN while the draft is IN_PROGRESS", async () => {
    const { season, user } = await liveDraftSeason("IN_PROGRESS");
    const res = await saveRegistration({}, form({ type: "STANDIN", mmr: 3000 }));
    expect(res?.error).toMatch(/draft is running/i);
    expect((await regFor(season.id, user.id))?.type).toBe("PLAYER");
  });

  it("refuses while PAUSED too — parked is still live", async () => {
    const { season, user } = await liveDraftSeason("PAUSED");
    const res = await saveRegistration({}, form({ type: "STANDIN", mmr: 3000 }));
    expect(res?.error).toMatch(/draft is running/i);
    expect((await regFor(season.id, user.id))?.type).toBe("PLAYER");
  });

  it("allows the flip again once the draft is COMPLETE (if unrostered)", async () => {
    const { season, user } = await liveDraftSeason("COMPLETE");
    const res = await saveRegistration({}, form({ type: "STANDIN", mmr: 3000 }));
    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.type).toBe("STANDIN");
  });

  it("a same-type edit is untouched by the lock", async () => {
    const { season, user } = await liveDraftSeason("IN_PROGRESS");
    const res = await saveRegistration(
      {},
      form({ type: "PLAYER", mmr: 3000, roles: "1" }),
    );
    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.type).toBe("PLAYER");
  });
});

describe("saveRegistration — a late medal must not brick an admitted signup", () => {
  // The lockout, end to end: a player is admitted while rankTier is null (a
  // private profile, or OpenDota down at signup), the admin's warn-only Sync
  // ranks later fills in Divine 3+/Immortal, and the admin KEEPS them. Before
  // this, every subsequent submit failed the gate — roles, heroes, statement,
  // captain note and the standin flip were all permanently unsaveable, while
  // /me told them the league couldn't take their signup at all.
  beforeEach(() => vi.mocked(requireUser).mockReset());

  async function admittedThenFlagged() {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await makeUser("Late Immortal");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
    // Admitted with no medal on file.
    const first = await saveRegistration(
      {},
      form({ type: "PLAYER", mmr: 3000, roles: "1" }),
    );
    expect(first?.error).toBeUndefined();
    // …then the admin's rank sync fills one in that proves 5K+.
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: 80 },
    });
    return { season, user };
  }

  it("lets them keep editing their signup", async () => {
    const { season, user } = await admittedThenFlagged();

    // `roles` is a repeated field (formData.getAll), so one valid key here.
    const res = await saveRegistration(
      {},
      form({ type: "PLAYER", mmr: 3000, roles: "2", statement: "still here" }),
    );

    expect(res?.error).toBeUndefined();
    const reg = await regFor(season.id, user.id);
    expect(reg?.roles).toBe("2");
    expect(reg?.statement).toBe("still here");
    expect(reg?.status).toBe("ACTIVE");
  });

  it("still refuses a BRAND-NEW signup carrying the same medal", async () => {
    // The anti-sandbagging line is untouched for admissions.
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await makeUser("Fresh Immortal");
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: 80 },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 3000 }));

    expect(res?.error).toMatch(/medal puts you above/);
    expect(await regFor(season.id, user.id)).toBeNull();
  });

  it("does not let them re-enter the pool after withdrawing", async () => {
    // WITHDRAWN is a re-ENTRY, judged as a fresh admission — otherwise the
    // exemption would be a door back in for exactly the players the ceiling
    // exists to keep out.
    const { season, user } = await admittedThenFlagged();
    await prisma.registration.updateMany({
      where: { seasonId: season.id, userId: user.id },
      data: { status: "WITHDRAWN" },
    });

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 3000 }));

    expect(res?.error).toMatch(/medal puts you above/);
    expect((await regFor(season.id, user.id))?.status).toBe("WITHDRAWN");
  });

  it("a withdrawal landing mid-save can't be revived by the tightened claim", async () => {
    // The write-time half: the exemption was judged against a row read several
    // round trips back. If they withdraw from another tab in the gap, the
    // ACTIVE-only claim refuses rather than reviving them — which for this
    // player would be a re-admission the gate itself would have refused.
    const { season, user } = await admittedThenFlagged();
    let fired = false;
    setRaceHook(
      onceAt("registration.saveRegistration.beforeWrite", async () => {
        fired = true;
        await prisma.registration.updateMany({
          where: { seasonId: season.id, userId: user.id },
          data: { status: "WITHDRAWN" },
        });
      }),
    );

    const res = await saveRegistration(
      {},
      form({ type: "PLAYER", mmr: 3000, roles: "3" }),
    );

    expect(fired).toBe(true);
    expect(res?.error).toMatch(/isn't active any more/i);
    const reg = await regFor(season.id, user.id);
    expect(reg?.status).toBe("WITHDRAWN"); // not revived
    expect(reg?.roles).not.toBe("3"); // and the edit didn't land either
    expect(reg?.statement).toBe(""); // nothing from this submit landed
  });
});

// Draft-night locks: while the auction is LIVE or PAUSED the pool is being
// sold from, so an existing signup can't change what the engine reads —
// the type flip (long-standing), and now the MMR figure and a WITHDRAWN
// player's re-entry (both found by the 2026-08-01 pre-draft audit: the /me
// UI blocked re-entry but a replayed POST didn't, and a mid-auction MMR
// rewrite had no admin counter because the Edit-MMR forms hide at start).
describe("saveRegistration — draft-night locks (live auction)", () => {
  beforeEach(() => vi.mocked(requireUser).mockReset());

  async function liveDraftSeason(draftStatus = "IN_PROGRESS") {
    const season = await makeSeason({ status: "DRAFT" });
    await prisma.draft.create({
      data: { seasonId: season.id, status: draftStatus },
    });
    return season;
  }

  it("freezes MMR while the auction runs — the edit lands, the number doesn't, the toast says so", async () => {
    const season = await liveDraftSeason();
    const user = await makeUser("Mid Draft Editor");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "ACTIVE",
        mmr: 4400,
        roles: "",
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration(
      {},
      form({ type: "PLAYER", mmr: 1500, statement: "new goals" }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/MMR is locked/);
    const reg = await regFor(season.id, user.id);
    expect(reg?.mmr).toBe(4400); // getDraftState re-reads this every poll
    expect(reg?.statement).toBe("new goals"); // the harmless edit still lands
  });

  it("freezes MMR while the auction is merely PAUSED too", async () => {
    const season = await liveDraftSeason("PAUSED");
    const user = await makeUser("Paused Editor");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "ACTIVE",
        mmr: 3200,
        roles: "",
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 100 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(3200);
  });

  it("a WITHDRAWN player can't re-enter the live pool with a direct resubmit", async () => {
    const season = await liveDraftSeason();
    const user = await makeUser("Mid Draft Reviver");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "WITHDRAWN",
        mmr: 3000,
        roles: "",
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 3000 }));

    expect(res?.error).toMatch(/rejoining the player pool/i);
    expect((await regFor(season.id, user.id))?.status).toBe("WITHDRAWN");
  });

  it("the re-entry lock lifts once the draft completes", async () => {
    const season = await liveDraftSeason("COMPLETE");
    const user = await makeUser("Post Draft Returner");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "WITHDRAWN",
        mmr: 3000,
        roles: "",
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 3000 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.status).toBe("ACTIVE");
  });
});

// The two scope refinements the diff review caught: the freeze is for what
// the AUCTION reads (ACTIVE PLAYER rows), and the revival door must not
// swallow the REMOVED claim's honest message.
describe("saveRegistration — draft-night lock scope", () => {
  beforeEach(() => vi.mocked(requireUser).mockReset());

  it("a STANDIN's MMR edit is NOT frozen mid-draft — their typo fixes stay live", async () => {
    const season = await makeSeason({ status: "DRAFT" });
    await prisma.draft.create({
      data: { seasonId: season.id, status: "IN_PROGRESS" },
    });
    const user = await makeUser("Standin Typo Fixer");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "STANDIN",
        status: "ACTIVE",
        mmr: 320, // the classic dropped digit
        roles: "",
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "STANDIN", mmr: 3200 }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).not.toMatch(/MMR is locked/);
    expect((await regFor(season.id, user.id))?.mmr).toBe(3200);
  });

  it("a REMOVED player mid-draft still gets the admin-removed message, not a reopening promise", async () => {
    const season = await makeSeason({ status: "DRAFT" });
    await prisma.draft.create({
      data: { seasonId: season.id, status: "IN_PROGRESS" },
    });
    const user = await makeUser("Moderated Mid Draft");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "REMOVED",
        mmr: 3000,
        roles: "",
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 3000 }));

    expect(res?.error).toMatch(/admin removed your signup/i);
    expect(res?.error).not.toMatch(/reopens once it finishes/i);
    expect((await regFor(season.id, user.id))?.status).toBe("REMOVED");
  });
});
