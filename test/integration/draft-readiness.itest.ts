import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  sendDiscordMessage: vi.fn(async () => true),
}));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchPlayerRankTier: vi.fn(async () => null),
}));

import {
  confirmDraftReadiness,
  leaveLeague,
  saveRegistration,
} from "@/app/actions/registration";
import { setDraftNight } from "@/app/actions/admin-captains-draft";
import {
  reinstateSignup,
  setRegistrationMmr,
  withdrawSignup,
} from "@/app/actions/admin-roster";
import { requireAdmin, requireUser } from "@/lib/auth";
import { DRAFT_READINESS, draftReadiness } from "@/lib/draft-readiness";
import { sendDiscordMessage } from "@/lib/discord";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import { formatLeagueTime } from "@/lib/zoned-time";
import { makeSeason, makeUser, sessionFor } from "./factories";

function fd(fields: Record<string, string | number>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, String(value));
  }
  return form;
}

const DRAFT_ONE = new Date("2026-08-08T22:00:00.000Z");
const DRAFT_TWO = new Date("2026-08-09T01:00:00.000Z");

async function readyPlayer() {
  const season = await makeSeason({
    status: "SIGNUPS",
    draftAt: DRAFT_ONE,
    draftRevision: 1,
  });
  const user = await makeUser("Ready Player");
  const registration = await prisma.registration.create({
    data: {
      seasonId: season.id,
      userId: user.id,
      type: "PLAYER",
      status: "ACTIVE",
      mmr: 3000,
    },
  });
  vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
  return { season, user, registration };
}

function confirmation(
  expectedActiveSeasonId: string,
  revision = 1,
  at = DRAFT_ONE,
) {
  return fd({
    expectedActiveSeasonId,
    draftRevision: revision,
    draftAtTs: at.getTime(),
  });
}

describe("draft readiness confirmation", () => {
  beforeEach(() => {
    vi.mocked(requireUser).mockReset();
    vi.mocked(requireAdmin).mockReset();
  });
  afterEach(() => setRaceHook(null));

  it("stores an acknowledgement for the exact current schedule", async () => {
    const { season, registration } = await readyPlayer();

    const result = await confirmDraftReadiness({}, confirmation(season.id));

    expect(result?.error).toBeUndefined();
    expect(result?.message).toMatch(/ready for draft confirmed/i);
    const stored = await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    expect(stored.draftConfirmedRevision).toBe(1);
    expect(stored.draftConfirmedFor?.getTime()).toBe(DRAFT_ONE.getTime());
    expect(stored.draftConfirmedAt).toBeInstanceOf(Date);
    expect(draftReadiness(stored, 1)).toBe(DRAFT_READINESS.READY);
  });

  it("derives identity and refuses a different user or a standin", async () => {
    const { season, registration } = await readyPlayer();
    const stranger = await makeUser("Different User");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(stranger));

    const wrongUser = await confirmDraftReadiness({}, confirmation(season.id));
    expect(wrongUser?.error).toMatch(/signup.*changed|reload/i);

    await prisma.registration.update({
      where: { id: registration.id },
      data: { type: "STANDIN" },
    });
    const owner = await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
      include: { user: true },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(owner.user));
    const standin = await confirmDraftReadiness({}, confirmation(season.id));
    expect(standin?.error).toMatch(/signup.*changed|reload/i);

    const stored = await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    expect(stored.draftConfirmedAt).toBeNull();
  });

  it("rejects malformed and stale browser values without changing the row", async () => {
    const { season, registration } = await readyPlayer();

    expect(
      (
        await confirmDraftReadiness(
          {},
          fd({
            expectedActiveSeasonId: season.id,
            draftRevision: "x",
            draftAtTs: 1,
          }),
        )
      )?.error,
    ).toMatch(/reload/i);
    expect(
      (await confirmDraftReadiness({}, confirmation(season.id, 0, DRAFT_ONE)))
        ?.error,
    ).toMatch(/draft time changed/i);

    const stored = await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    expect(stored.draftConfirmedAt).toBeNull();
  });

  it("loses safely when the admin changes the schedule after the action reads it", async () => {
    const { season, registration } = await readyPlayer();
    let fired = false;
    setRaceHook(
      onceAt("registration.confirmDraftReadiness.beforeWrite", async () => {
        fired = true;
        await prisma.season.update({
          where: { id: season.id },
          data: {
            draftAt: DRAFT_TWO,
            draftRevision: { increment: 1 },
          },
        });
      }),
    );

    const result = await confirmDraftReadiness({}, confirmation(season.id));

    expect(fired).toBe(true);
    expect(result?.error).toMatch(/changed|reload/i);
    const stored = await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    expect(stored.draftConfirmedAt).toBeNull();
  });

  it("increments the schedule revision only for real changes and makes old confirmations stale", async () => {
    const { season, registration } = await readyPlayer();
    const admin = await makeUser("Admin", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    vi.mocked(sendDiscordMessage).mockClear();
    await confirmDraftReadiness({}, confirmation(season.id));

    const same = await setDraftNight(
      {},
      fd({
        expectedActiveSeasonId: season.id,
        draftAt: "2026-08-08T15:00",
        draftAtTs: DRAFT_ONE.getTime(),
      }),
    );
    expect(same?.error).toBeUndefined();
    expect(sendDiscordMessage).not.toHaveBeenCalled();
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .draftRevision,
    ).toBe(1);

    const changed = await setDraftNight(
      {},
      fd({
        expectedActiveSeasonId: season.id,
        draftAt: "2026-08-08T18:00",
        draftAtTs: DRAFT_TWO.getTime(),
      }),
    );
    expect(changed?.message).toMatch(/need to confirm/i);
    // The toast restates the night on the league's clock, zone named, so an
    // admin whose own clock differs can see what they actually saved.
    expect(changed?.message).toContain(formatLeagueTime(DRAFT_TWO));
    // Stuck behind a webhook outage, the post is dropped once the night passes.
    expect(sendDiscordMessage).toHaveBeenLastCalledWith(
      expect.stringMatching(/previous confirmations expired.*\/me/i),
      undefined,
      { expiresAt: DRAFT_TWO },
    );
    let current = await prisma.season.findUniqueOrThrow({
      where: { id: season.id },
    });
    let stored = await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    expect(current.draftRevision).toBe(2);
    expect(draftReadiness(stored, current.draftRevision)).toBe(
      DRAFT_READINESS.STALE,
    );

    // Changing away and back is still a new acknowledgement cycle; comparing
    // dates alone would incorrectly revive the old confirmation here.
    await setDraftNight(
      {},
      fd({
        expectedActiveSeasonId: season.id,
        draftAt: "2026-08-08T15:00",
        draftAtTs: DRAFT_ONE.getTime(),
      }),
    );
    current = await prisma.season.findUniqueOrThrow({
      where: { id: season.id },
    });
    stored = await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    expect(current.draftRevision).toBe(3);
    expect(draftReadiness(stored, current.draftRevision)).toBe(
      DRAFT_READINESS.STALE,
    );
    expect(sendDiscordMessage).toHaveBeenCalledTimes(2);
  });

  it("announces when a scheduled draft night is cleared", async () => {
    const { season } = await readyPlayer();
    const admin = await makeUser("Cancellation Admin", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    vi.mocked(sendDiscordMessage).mockClear();

    const result = await setDraftNight(
      {},
      fd({ expectedActiveSeasonId: season.id, draftAt: "", draftAtTs: "" }),
    );

    expect(result?.message).toMatch(/cleared/i);
    expect(sendDiscordMessage).toHaveBeenCalledWith(
      expect.stringMatching(/scheduled.*draft night was cleared/i),
    );
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({ draftAt: null, draftRevision: 2 });
  });

  it("preserves confirmation through normal edits but clears it on type changes and withdrawal", async () => {
    const { season, registration, user } = await readyPlayer();
    await confirmDraftReadiness({}, confirmation(season.id));

    const edited = await saveRegistration(
      {},
      fd({ type: "PLAYER", mmr: 3000, roles: "1", about: "Still in" }),
    );
    expect(edited?.error).toBeUndefined();
    expect(
      (
        await prisma.registration.findUniqueOrThrow({
          where: { id: registration.id },
        })
      ).draftConfirmedRevision,
    ).toBe(1);

    const changedType = await saveRegistration(
      {},
      fd({ type: "STANDIN", mmr: 3000 }),
    );
    expect(changedType?.error).toBeUndefined();
    let stored = await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    expect(stored.draftConfirmedAt).toBeNull();

    await prisma.registration.update({
      where: { id: registration.id },
      data: {
        type: "PLAYER",
        draftConfirmedRevision: 1,
        draftConfirmedAt: new Date(),
        draftConfirmedFor: DRAFT_ONE,
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
    const left = await leaveLeague({}, new FormData());
    expect(left?.error).toBeUndefined();
    stored = await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    expect(stored.status).toBe("WITHDRAWN");
    expect(stored.draftConfirmedAt).toBeNull();
  });

  it("clears confirmation across admin removal and reinstatement", async () => {
    const { season, registration } = await readyPlayer();
    const admin = await makeUser("Admin", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    await confirmDraftReadiness({}, confirmation(season.id));

    const removed = await withdrawSignup(
      {},
      fd({ registrationId: registration.id }),
    );
    expect(removed?.error).toBeUndefined();
    let stored = await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    expect(stored.status).toBe("REMOVED");
    expect(stored.draftConfirmedAt).toBeNull();

    const reinstated = await reinstateSignup(
      {},
      fd({ registrationId: registration.id }),
    );
    expect(reinstated?.error).toBeUndefined();
    stored = await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    expect(stored.status).toBe("ACTIVE");
    expect(stored.draftConfirmedAt).toBeNull();
  });
});

/** The hidden fields /me posts with the signup form while a draft time shows. */
function signupSeeing(
  seasonId: string,
  fields: Record<string, string | number>,
  revision = 1,
  at = DRAFT_ONE,
) {
  return fd({
    ...fields,
    seenDraftSeasonId: seasonId,
    seenDraftRevision: revision,
    seenDraftAtTs: at.getTime(),
  });
}

describe("joining the draft pool confirms the draft time the form showed", () => {
  beforeEach(() => {
    vi.mocked(requireUser).mockReset();
    vi.mocked(requireAdmin).mockReset();
  });
  afterEach(() => setRaceHook(null));

  async function scheduledSeason() {
    return makeSeason({
      status: "SIGNUPS",
      draftAt: DRAFT_ONE,
      draftRevision: 1,
    });
  }

  it("stamps a new full player's signup ready for the time they saw", async () => {
    const season = await scheduledSeason();
    const user = await makeUser("Fresh Joiner");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const result = await saveRegistration(
      {},
      signupSeeing(season.id, { type: "PLAYER", mmr: 3000 }),
    );

    expect(result?.error).toBeUndefined();
    expect(result?.message).toMatch(/ready for draft night/i);
    const stored = await prisma.registration.findUniqueOrThrow({
      where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
    });
    expect(stored.draftConfirmedRevision).toBe(1);
    expect(stored.draftConfirmedFor?.getTime()).toBe(DRAFT_ONE.getTime());
    expect(draftReadiness(stored, 1)).toBe(DRAFT_READINESS.READY);
  });

  it("leaves a stale tab's signup unconfirmed after the admin moved the time", async () => {
    const season = await scheduledSeason();
    // The page was rendered at revision 1; the admin has since moved it.
    await prisma.season.update({
      where: { id: season.id },
      data: { draftAt: DRAFT_TWO, draftRevision: 2 },
    });
    const user = await makeUser("Stale Tab");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const result = await saveRegistration(
      {},
      signupSeeing(season.id, { type: "PLAYER", mmr: 3000 }),
    );

    // They still join; only the confirmation waits for the current time.
    expect(result?.error).toBeUndefined();
    expect(result?.message).not.toMatch(/ready for draft night/i);
    const stored = await prisma.registration.findUniqueOrThrow({
      where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
    });
    expect(stored.status).toBe("ACTIVE");
    expect(stored.draftConfirmedAt).toBeNull();
  });

  it("confirms nothing for a standin, another season's form, or a plain edit", async () => {
    const season = await scheduledSeason();
    const standin = await makeUser("Standin Joiner");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(standin));
    expect(
      (
        await saveRegistration(
          {},
          signupSeeing(season.id, { type: "STANDIN", mmr: 3000 }),
        )
      )?.error,
    ).toBeUndefined();

    const otherSeason = await makeUser("Other Season Tab");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(otherSeason));
    expect(
      (
        await saveRegistration(
          {},
          signupSeeing("some-older-season", { type: "PLAYER", mmr: 3000 }),
        )
      )?.error,
    ).toBeUndefined();

    // Signed up before the time was posted: an edit is not a confirmation.
    const earlier = await makeUser("Earlier Signup");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: earlier.id,
        type: "PLAYER",
        status: "ACTIVE",
        mmr: 3000,
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(earlier));
    expect(
      (
        await saveRegistration(
          {},
          signupSeeing(season.id, { type: "PLAYER", mmr: 3000, roles: "2" }),
        )
      )?.error,
    ).toBeUndefined();

    const rows = await prisma.registration.findMany({
      where: {
        seasonId: season.id,
        userId: { in: [standin.id, otherSeason.id, earlier.id] },
      },
    });
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.draftConfirmedAt).toBeNull();
  });

  it("confirms a withdrawn player who rejoins, and a standin who steps up", async () => {
    const season = await scheduledSeason();
    const returning = await makeUser("Comes Back");
    const steppingUp = await makeUser("Steps Up");
    for (const [user, type, status] of [
      [returning, "PLAYER", "WITHDRAWN"],
      [steppingUp, "STANDIN", "ACTIVE"],
    ] as const) {
      await prisma.registration.create({
        data: { seasonId: season.id, userId: user.id, type, status, mmr: 3000 },
      });
      vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
      const result = await saveRegistration(
        {},
        signupSeeing(season.id, { type: "PLAYER", mmr: 3000 }),
      );
      expect(result?.error).toBeUndefined();
      const stored = await prisma.registration.findUniqueOrThrow({
        where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
      });
      expect(stored).toMatchObject({ type: "PLAYER", status: "ACTIVE" });
      expect(draftReadiness(stored, 1)).toBe(DRAFT_READINESS.READY);
    }
  });

  it("confirms nothing once the auction has finished", async () => {
    const season = await makeSeason({
      status: "DRAFT",
      draftAt: DRAFT_ONE,
      draftRevision: 1,
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: "COMPLETE" },
    });
    // A former full player may rejoin the free-agent pool after the draft,
    // but there is no draft time left to confirm.
    const user = await makeUser("Post Draft Return");
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

    const result = await saveRegistration(
      {},
      signupSeeing(season.id, { type: "PLAYER", mmr: 3000 }),
    );

    expect(result?.error).toBeUndefined();
    const stored = await prisma.registration.findUniqueOrThrow({
      where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
    });
    expect(stored.status).toBe("ACTIVE");
    expect(stored.draftConfirmedAt).toBeNull();
  });
});

describe("signup administration phase locks", () => {
  beforeEach(async () => {
    vi.mocked(requireAdmin).mockReset();
    const admin = await makeUser("Signup Admin", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
  });
  afterEach(() => setRaceHook(null));

  it("refuses to move draft night after the auction starts", async () => {
    const season = await makeSeason({
      status: "DRAFT",
      draftAt: DRAFT_ONE,
      draftRevision: 2,
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: "IN_PROGRESS" },
    });

    const result = await setDraftNight(
      {},
      fd({
        expectedActiveSeasonId: season.id,
        draftAt: "2026-08-08T18:00",
        draftAtTs: DRAFT_TWO.getTime(),
      }),
    );

    expect(result?.error).toMatch(/auction is live.*locked/i);
    const stored = await prisma.season.findUniqueOrThrow({
      where: { id: season.id },
    });
    expect(stored.draftAt?.getTime()).toBe(DRAFT_ONE.getTime());
    expect(stored.draftRevision).toBe(2);
  });

  it("does not inject a removed full player into a live auction", async () => {
    const season = await makeSeason({ status: "DRAFT" });
    const user = await makeUser("Removed During Draft");
    const registration = await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "REMOVED",
        mmr: 3000,
      },
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: "PAUSED" },
    });

    const result = await reinstateSignup(
      {},
      fd({ registrationId: registration.id }),
    );

    expect(result?.error).toMatch(/live draft.*player pool/i);
    expect(
      (
        await prisma.registration.findUniqueOrThrow({
          where: { id: registration.id },
        })
      ).status,
    ).toBe("REMOVED");
  });

  it("refuses reinstatement after completion for either registration type", async () => {
    const season = await makeSeason({ status: "COMPLETE" });
    const user = await makeUser("Historical Standin");
    const registration = await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "STANDIN",
        status: "REMOVED",
        mmr: 2000,
      },
    });

    const result = await reinstateSignup(
      {},
      fd({ registrationId: registration.id }),
    );
    expect(result?.error).toMatch(/season is complete.*historical/i);
    expect(
      (
        await prisma.registration.findUniqueOrThrow({
          where: { id: registration.id },
        })
      ).status,
    ).toBe("REMOVED");
  });

  it("does not overwrite a signup status that changes before reinstatement writes", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await makeUser("Changed In The Gap");
    const registration = await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "REMOVED",
        mmr: 3000,
      },
    });
    setRaceHook(
      onceAt("admin.reinstateSignup.beforeWrite", async () => {
        await prisma.registration.update({
          where: { id: registration.id },
          data: { status: "WITHDRAWN" },
        });
      }),
    );

    const result = await reinstateSignup(
      {},
      fd({ registrationId: registration.id }),
    );
    expect(result?.error).toMatch(/just changed.*reload/i);
    expect(
      (
        await prisma.registration.findUniqueOrThrow({
          where: { id: registration.id },
        })
      ).status,
    ).toBe("WITHDRAWN");
  });

  it("locks full-player MMR during the auction but keeps standin corrections available", async () => {
    const season = await makeSeason({ status: "DRAFT" });
    const player = await makeUser("Live Player MMR");
    const standin = await makeUser("Live Standin MMR");
    const [playerReg, standinReg] = await Promise.all([
      prisma.registration.create({
        data: {
          seasonId: season.id,
          userId: player.id,
          type: "PLAYER",
          status: "ACTIVE",
          mmr: 3000,
        },
      }),
      prisma.registration.create({
        data: {
          seasonId: season.id,
          userId: standin.id,
          type: "STANDIN",
          status: "ACTIVE",
          mmr: 2000,
        },
      }),
    ]);
    await prisma.draft.create({
      data: { seasonId: season.id, status: "IN_PROGRESS" },
    });

    const blocked = await setRegistrationMmr(
      {},
      fd({ registrationId: playerReg.id, mmr: 3500 }),
    );
    const allowed = await setRegistrationMmr(
      {},
      fd({ registrationId: standinReg.id, mmr: 2300 }),
    );

    expect(blocked?.error).toMatch(/auction is live.*locked/i);
    expect(allowed?.error).toBeUndefined();
    expect(
      (
        await prisma.registration.findUniqueOrThrow({
          where: { id: playerReg.id },
        })
      ).mmr,
    ).toBe(3000);
    expect(
      (
        await prisma.registration.findUniqueOrThrow({
          where: { id: standinReg.id },
        })
      ).mmr,
    ).toBe(2300);
  });
});
