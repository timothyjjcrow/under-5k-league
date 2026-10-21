import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(),
}));

import { closeRollCall, openRollCall } from "@/app/actions/admin-season";
import { answerRollCallAction, takeBackRollCallAction } from "@/app/actions/roll-call";
import { getSessionUser, requireAdmin, requireUser } from "@/lib/auth";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { slotLabel, type PollSlot } from "@/lib/match-night-poll";
import { createPoll } from "@/lib/match-night-poll-service";
import { prisma } from "@/lib/prisma";
import {
  answerRollCall,
  loadAdminRollCall,
  loadHomeRollCall,
  takeBackRollCall,
} from "@/lib/roll-call-service";
import { SIGN_IN_REQUIRED } from "@/lib/sign-in";
import { LEAGUE_LOCALE } from "@/lib/zoned-time";
import {
  makeCaptain,
  makePlayer,
  makeSeason,
  makeUser,
  raceAll,
  sessionFor,
} from "./factories";

const SAT_14: PollSlot = { day: 6, minute: 14 * 60 };
const SUN_14: PollSlot = { day: 0, minute: 14 * 60 };
const label = (slot: PollSlot) => slotLabel(slot, LEAGUE_CONFIG.timeZone, LEAGUE_LOCALE);
const NIGHT = label(SAT_14);

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

let admin: Awaited<ReturnType<typeof makeUser>>;
let season: Awaited<ReturnType<typeof makeSeason>>;

/** The stale-form claim /admin's buttons post, read fresh. */
async function seasonClaim() {
  const row = await prisma.season.findUniqueOrThrow({ where: { id: season.id } });
  return {
    expectedActiveSeasonId: row.id,
    expectedSeasonUpdatedAt: row.updatedAt.toISOString(),
  };
}

async function open() {
  const result = await openRollCall(null, form(await seasonClaim()));
  expect(result).toMatchObject({ message: expect.stringMatching(/Roll call open/) });
}

function as(user: Awaited<ReturnType<typeof makeUser>>) {
  vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
}

beforeEach(async () => {
  season = await makeSeason({ name: "Season 2" });
  await prisma.season.update({ where: { id: season.id }, data: { matchSchedule: NIGHT } });
  admin = await makeUser("Roll Admin", "ADMIN");
  vi.mocked(requireAdmin).mockReset();
  vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
  vi.mocked(requireUser).mockReset();
  vi.mocked(getSessionUser).mockReset();
  vi.mocked(getSessionUser).mockResolvedValue(sessionFor(admin));
});

describe("the roll call", () => {
  it("lists every draft signup and captain, and moves a player to in when they answer", async () => {
    const amy = await makePlayer(season.id, "Amy", 3000);
    const bo = await makePlayer(season.id, "bo", 3000);
    const { user: cap } = await makeCaptain(season.id, "Cap", 100, 1);
    const standin = await makeUser("Standin");
    await prisma.registration.create({
      data: { seasonId: season.id, userId: standin.id, type: "STANDIN", status: "ACTIVE" },
    });

    expect(await loadHomeRollCall(null, Date.now())).toBeNull();
    await open();

    const before = await loadHomeRollCall(null, Date.now());
    expect(before?.night).toBe(NIGHT);
    expect(before?.slot?.key).toBe("6@840");
    expect(before?.locked).toEqual([]);
    expect(before?.waiting.map((p) => p.name)).toEqual(["Amy", "bo", "Cap"]);
    expect(before?.viewer).toBe("signed-out");

    as(amy);
    const answered = await answerRollCallAction(null, form({ night: NIGHT }));
    expect(answered).toEqual({
      message: `You're in. Match night is ${NIGHT}. See you on the first one.`,
    });

    const after = await loadHomeRollCall(amy, Date.now());
    expect(after?.locked.map((p) => p.id)).toEqual([amy.id]);
    expect(after?.waiting.map((p) => p.id)).toEqual([bo.id, cap.id]);
    expect(after?.viewer).toBe("in");
    expect(after?.answeredAtMs).toEqual(expect.any(Number));
    expect((await loadHomeRollCall(bo, Date.now()))?.viewer).toBe("owed");
    expect((await loadHomeRollCall(standin, Date.now()))?.viewer).toBe("not-listed");

    // A second tap keeps the first answer's time.
    const first = await prisma.rollCallAnswer.findUniqueOrThrow({
      where: { seasonId_userId: { seasonId: season.id, userId: amy.id } },
    });
    expect(await answerRollCallAction(null, form({ night: NIGHT }))).toEqual({
      message: "You're already in.",
    });
    const again = await prisma.rollCallAnswer.findUniqueOrThrow({
      where: { seasonId_userId: { seasonId: season.id, userId: amy.id } },
    });
    expect(again.answeredAt).toEqual(first.answeredAt);
  });

  it("refuses a standin, a player not signed up, a night that moved and a closed roll call", async () => {
    const amy = await makePlayer(season.id, "Amy", 3000);
    const standin = await makeUser("Standin");
    await prisma.registration.create({
      data: { seasonId: season.id, userId: standin.id, type: "STANDIN", status: "ACTIVE" },
    });
    const visitor = await makeUser("Visitor");

    // Closed: nothing to answer yet.
    as(amy);
    expect(await answerRollCallAction(null, form({ night: NIGHT }))).toEqual({
      error: "The roll call is closed.",
    });

    await open();
    for (const user of [standin, visitor]) {
      as(user);
      expect(await answerRollCallAction(null, form({ night: NIGHT }))).toEqual({
        error: expect.stringMatching(/for players signed up for the draft/),
      });
    }
    as(amy);
    expect(await answerRollCallAction(null, form({ night: label(SUN_14) }))).toEqual({
      error: expect.stringMatching(/Match night changed since this page loaded: it's now/),
    });
    expect(await answerRollCallAction(null, form({ night: "" }))).toEqual({
      error: "Reload the page and try again.",
    });
    vi.mocked(requireUser).mockRejectedValue(new Error("no session"));
    expect(await answerRollCallAction(null, form({ night: NIGHT }))).toEqual({
      error: SIGN_IN_REQUIRED,
    });
    expect(await prisma.rollCallAnswer.count()).toBe(0);
  });

  it("asks again when the night moves, but not when it is only reworded", async () => {
    const amy = await makePlayer(season.id, "Amy", 3000);
    await open();
    await answerRollCall({ userId: amy.id, seenNight: NIGHT });

    await prisma.season.update({
      where: { id: season.id },
      data: { matchSchedule: "Saturday 2pm PT" },
    });
    expect((await loadHomeRollCall(amy, Date.now()))?.viewer).toBe("in");

    await prisma.season.update({
      where: { id: season.id },
      data: { matchSchedule: label(SUN_14) },
    });
    const moved = await loadHomeRollCall(amy, Date.now());
    expect(moved?.viewer).toBe("renew");
    expect(moved?.locked).toEqual([]);

    as(amy);
    expect(await answerRollCallAction(null, form({ night: label(SUN_14) }))).toEqual({
      message: `You're in for the new match night: ${label(SUN_14)}.`,
    });
    expect((await loadHomeRollCall(amy, Date.now()))?.viewer).toBe("in");
  });

  it("counts an answer only while its player is signed up", async () => {
    const amy = await makePlayer(season.id, "Amy", 3000);
    await open();
    await answerRollCall({ userId: amy.id, seenNight: NIGHT });
    await prisma.registration.updateMany({
      where: { seasonId: season.id, userId: amy.id },
      data: { status: "WITHDRAWN" },
    });
    expect((await loadHomeRollCall(null, Date.now()))?.locked).toEqual([]);
    await prisma.registration.updateMany({
      where: { seasonId: season.id, userId: amy.id },
      data: { status: "ACTIVE" },
    });
    expect((await loadHomeRollCall(null, Date.now()))?.locked.map((p) => p.id)).toEqual([
      amy.id,
    ]);
  });

  it("takes an answer back, even once the roll call has closed", async () => {
    const amy = await makePlayer(season.id, "Amy", 3000);
    await open();
    await answerRollCall({ userId: amy.id, seenNight: NIGHT });
    expect(
      await closeRollCall(null, form(await seasonClaim())),
    ).toMatchObject({ message: expect.stringMatching(/every answer is kept/) });
    expect(await loadHomeRollCall(amy, Date.now())).toBeNull();
    expect(await prisma.rollCallAnswer.count()).toBe(1);

    // Reopening shows the kept answer.
    await open();
    expect((await loadHomeRollCall(amy, Date.now()))?.viewer).toBe("in");

    await closeRollCall(null, form(await seasonClaim()));
    as(amy);
    expect(await takeBackRollCallAction(null, form({}))).toMatchObject({
      message: expect.stringMatching(/off the roll call/),
    });
    expect(await takeBackRollCallAction(null, form({}))).toEqual({
      message: "You weren't on the roll call.",
    });
    expect(await prisma.rollCallAnswer.count()).toBe(0);
  });

  it("stores one row when two taps race", async () => {
    const amy = await makePlayer(season.id, "Amy", 3000);
    await open();
    const results = await raceAll([
      () => answerRollCall({ userId: amy.id, seenNight: NIGHT }),
      () => answerRollCall({ userId: amy.id, seenNight: NIGHT }),
    ]);
    expect(results.map((r) => r.night)).toEqual([NIGHT, NIGHT]);
    expect(await prisma.rollCallAnswer.count()).toBe(1);
    expect(await takeBackRollCall({ userId: amy.id })).toEqual({ outcome: "out" });
  });
});

describe("opening and closing the roll call", () => {
  it("refuses while a match-night poll decides the night, and hides an open roll call when one opens", async () => {
    await makePlayer(season.id, "Amy", 3000);
    const poll = await createPoll({
      question: "When should match night be?",
      slots: [SAT_14, SUN_14],
      closesAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      createdById: admin.id,
    });
    expect(poll.ok).toBe(true);
    expect(await openRollCall(null, form(await seasonClaim()))).toEqual({
      error: expect.stringMatching(/match-night poll is still deciding/),
    });

    await prisma.matchNightPoll.deleteMany();
    await open();
    expect(await loadHomeRollCall(null, Date.now())).not.toBeNull();
    await createPoll({
      question: "When should match night be?",
      slots: [SAT_14, SUN_14],
      closesAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      createdById: admin.id,
    });
    expect(await loadHomeRollCall(null, Date.now())).toBeNull();
    const adminView = await loadAdminRollCall(Date.now());
    expect(adminView).toMatchObject({ open: true, live: false });
    expect(adminView?.cannotOpen).toMatch(/poll/);
  });

  it("runs only during signups and the draft", async () => {
    await prisma.season.update({ where: { id: season.id }, data: { status: "DRAFT" } });
    await open();
    expect(await loadHomeRollCall(null, Date.now())).not.toBeNull();
    await prisma.season.update({ where: { id: season.id }, data: { status: "REGULAR_SEASON" } });
    expect(await loadHomeRollCall(null, Date.now())).toBeNull();
    await closeRollCall(null, form(await seasonClaim()));
    expect(await openRollCall(null, form(await seasonClaim()))).toEqual({
      error: expect.stringMatching(/during signups and the draft/),
    });
  });

  it("refuses a stale form and a non-admin", async () => {
    const stale = await seasonClaim();
    await prisma.season.update({ where: { id: season.id }, data: { name: "Season 2b" } });
    expect(await openRollCall(null, form(stale))).toEqual({
      error: expect.stringMatching(/changed while this page was open/),
    });
    vi.mocked(requireAdmin).mockRejectedValue(new Error("not admin"));
    expect(await openRollCall(null, form(await seasonClaim()))).toEqual({
      error: "Not authorized",
    });
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } })).rollCallOpenedAt,
    ).toBeNull();
  });

  it("gives the admin the players still to answer as Discord mentions", async () => {
    const amy = await makePlayer(season.id, "Amy", 3000);
    const bo = await makePlayer(season.id, "bo", 3000);
    const cy = await makePlayer(season.id, "Cy", 3000);
    await makePlayer(season.id, "Dee", 3000);
    await prisma.user.update({ where: { id: bo.id }, data: { discordId: "111222333444555666" } });
    await prisma.user.update({ where: { id: cy.id }, data: { discordName: "cy.dota" } });
    await open();
    await answerRollCall({ userId: amy.id, seenNight: NIGHT });
    const adminView = await loadAdminRollCall(Date.now());
    expect(adminView?.waitingMentions).toBe("<@111222333444555666> @cy.dota Dee");
    expect(adminView?.view?.locked.map((p) => p.name)).toEqual(["Amy"]);
  });
});
