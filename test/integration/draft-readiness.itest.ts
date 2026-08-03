import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
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
import {
  reinstateSignup,
  setDraftNight,
  withdrawSignup,
} from "@/app/actions/admin";
import { requireAdmin, requireUser } from "@/lib/auth";
import { DRAFT_READINESS, draftReadiness } from "@/lib/draft-readiness";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
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

function confirmation(revision = 1, at = DRAFT_ONE) {
  return fd({ draftRevision: revision, draftAtTs: at.getTime() });
}

describe("draft readiness confirmation", () => {
  beforeEach(() => {
    vi.mocked(requireUser).mockReset();
    vi.mocked(requireAdmin).mockReset();
  });
  afterEach(() => setRaceHook(null));

  it("stores an acknowledgement for the exact current schedule", async () => {
    const { registration } = await readyPlayer();

    const result = await confirmDraftReadiness({}, confirmation());

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
    const { registration } = await readyPlayer();
    const stranger = await makeUser("Different User");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(stranger));

    const wrongUser = await confirmDraftReadiness({}, confirmation());
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
    const standin = await confirmDraftReadiness({}, confirmation());
    expect(standin?.error).toMatch(/signup.*changed|reload/i);

    const stored = await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    expect(stored.draftConfirmedAt).toBeNull();
  });

  it("rejects malformed and stale browser values without changing the row", async () => {
    const { registration } = await readyPlayer();

    expect(
      (
        await confirmDraftReadiness(
          {},
          fd({ draftRevision: "x", draftAtTs: 1 }),
        )
      )?.error,
    ).toMatch(/reload/i);
    expect(
      (await confirmDraftReadiness({}, confirmation(0, DRAFT_ONE)))?.error,
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

    const result = await confirmDraftReadiness({}, confirmation());

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
    await confirmDraftReadiness({}, confirmation());

    const same = await setDraftNight(
      {},
      fd({ draftAt: "2026-08-08T15:00", draftAtTs: DRAFT_ONE.getTime() }),
    );
    expect(same?.error).toBeUndefined();
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .draftRevision,
    ).toBe(1);

    const changed = await setDraftNight(
      {},
      fd({ draftAt: "2026-08-08T18:00", draftAtTs: DRAFT_TWO.getTime() }),
    );
    expect(changed?.message).toMatch(/need to confirm/i);
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
      fd({ draftAt: "2026-08-08T15:00", draftAtTs: DRAFT_ONE.getTime() }),
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
  });

  it("preserves confirmation through normal edits but clears it on type changes and withdrawal", async () => {
    const { registration, user } = await readyPlayer();
    await confirmDraftReadiness({}, confirmation());

    const edited = await saveRegistration(
      {},
      fd({ type: "PLAYER", mmr: 3000, roles: "1", statement: "Still in" }),
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
    const { registration } = await readyPlayer();
    const admin = await makeUser("Admin", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    await confirmDraftReadiness({}, confirmation());

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
