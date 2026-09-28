/**
 * changeCaptain: before the draft, hand a team to a different signup without
 * deleting it. The team row (name, logo, draft-order slot, budget) is what the
 * old remove + re-add path threw away, so every test checks it survived.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { prisma } from "@/lib/prisma";
import { changeCaptain } from "@/app/actions/admin-captains-draft";
import { getSessionUser, requireAdmin } from "@/lib/auth";
import { sendDiscordMessage } from "@/lib/discord";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { DRAFT_STATUS, SEASON_STATUS } from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import {
  makeCaptain,
  makePlayer,
  makeSeason,
  makeUser,
  raceAll,
  sessionFor,
} from "./factories";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
};
const empty: ActionResult = {};

beforeEach(async () => {
  const admin = await makeUser("Tim", "ADMIN");
  vi.mocked(requireAdmin).mockReset();
  vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
  vi.mocked(getSessionUser).mockReset();
  vi.mocked(getSessionUser).mockResolvedValue(sessionFor(admin));
  vi.mocked(sendDiscordMessage).mockClear();
});
afterEach(() => setRaceHook(null));

/** A signups-phase season with two captains and one uncaptained signup. */
async function preDraft() {
  const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
  const zai = await makeCaptain(season.id, "Zai", 100, 0);
  const other = await makeCaptain(season.id, "Other", 100, 1);
  const mira = await makePlayer(season.id, "Mira", 3200);
  return { season, zai, other, mira };
}

const swap = (
  seasonId: string,
  teamId: string,
  expectedCaptainUserId: string,
  newCaptainUserId: string,
) =>
  changeCaptain(
    empty,
    fd({
      teamId,
      expectedActiveSeasonId: seasonId,
      expectedCaptainUserId,
      newCaptainUserId,
    }),
  );

async function captainSeats(teamId: string) {
  return prisma.teamMember.findMany({
    where: { teamId },
    select: { userId: true, isCaptain: true, price: true },
  });
}

describe("changeCaptain — swaps who captains a team before the draft", () => {
  it("keeps the team row and seats the new captain in the old one's place", async () => {
    const { season, zai, mira } = await preDraft();
    await prisma.team.update({
      where: { id: zai.team.id },
      data: {
        name: "Radiant Raccoons",
        logoUrl: "https://cdn.example/raccoon.png",
        budget: 140,
      },
    });

    const res = await swap(season.id, zai.team.id, zai.user.id, mira.id);

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe(
      "Mira now captains Radiant Raccoons. Zai is back in the player pool.",
    );
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: zai.team.id },
    });
    expect(team).toMatchObject({
      captainId: mira.id,
      name: "Radiant Raccoons",
      logoUrl: "https://cdn.example/raccoon.png",
      draftOrder: 0,
      budget: 140,
    });
    expect(await captainSeats(team.id)).toEqual([
      { userId: mira.id, isCaptain: true, price: 0 },
    ]);
    // Zai is an ordinary signup again: still ACTIVE, on no roster.
    expect(
      await prisma.registration.findUniqueOrThrow({
        where: { seasonId_userId: { seasonId: season.id, userId: zai.user.id } },
      }),
    ).toMatchObject({ status: "ACTIVE", type: "PLAYER" });
    expect(
      await prisma.teamMember.count({ where: { userId: zai.user.id } }),
    ).toBe(0);
    // Roster history: Zai's tenure closed, Mira's opened as a designation.
    const tenures = await prisma.rosterTenure.findMany({
      where: { teamId: team.id },
      orderBy: { recordedAt: "asc" },
    });
    expect(
      tenures.map((t) => ({
        userId: t.userId,
        open: t.openKey !== null,
        kind: t.acquisitionKind,
        endReason: t.endReason,
      })),
    ).toEqual([
      {
        userId: zai.user.id,
        open: false,
        kind: "LEGACY_CAPTURE",
        endReason: "PRE_DRAFT_CAPTAIN_CHANGED",
      },
      {
        userId: mira.id,
        open: true,
        kind: "CAPTAIN_DESIGNATION",
        endReason: null,
      },
    ]);
    const audit = await prisma.adminAction.findFirstOrThrow({
      where: { action: "changeCaptain" },
    });
    expect(audit.summary).toBe(
      'Changed the captain of "Radiant Raccoons" from Zai to Mira',
    );
    expect(sendDiscordMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendDiscordMessage).mock.calls[0][0]).toContain(
      "you now captain Radiant Raccoons",
    );
  });

  it("moves a name still generated from the old captain to the new one", async () => {
    const { season, zai, mira } = await preDraft();

    const res = await swap(season.id, zai.team.id, zai.user.id, mira.id);

    expect(res?.message).toBe(
      "Mira now captains Mira's Team (renamed from Zai's Team). Zai is back in the player pool.",
    );
    expect(
      (await prisma.team.findUniqueOrThrow({ where: { id: zai.team.id } }))
        .name,
    ).toBe("Mira's Team");
  });

  it("works in the DRAFT phase until the auction starts", async () => {
    const { season, zai, mira } = await preDraft();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.DRAFT },
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.NOT_STARTED },
    });

    const res = await swap(season.id, zai.team.id, zai.user.id, mira.id);

    expect(res?.error).toBeUndefined();
    expect(
      (await prisma.team.findUniqueOrThrow({ where: { id: zai.team.id } }))
        .captainId,
    ).toBe(mira.id);
  });
});

describe("changeCaptain — refusals leave everything as it was", () => {
  async function unchanged(teamId: string, captainId: string) {
    expect(
      (await prisma.team.findUniqueOrThrow({ where: { id: teamId } }))
        .captainId,
    ).toBe(captainId);
    expect(await captainSeats(teamId)).toEqual([
      { userId: captainId, isCaptain: true, price: 0 },
    ]);
    expect(sendDiscordMessage).not.toHaveBeenCalled();
    expect(
      await prisma.adminAction.count({ where: { action: "changeCaptain" } }),
    ).toBe(0);
  }

  it("refuses once the auction has started", async () => {
    const { season, zai, mira } = await preDraft();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.DRAFT },
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.IN_PROGRESS },
    });

    const res = await swap(season.id, zai.team.id, zai.user.id, mira.id);

    expect(res?.error).toMatch(/auction is live/i);
    await unchanged(zai.team.id, zai.user.id);
  });

  it("refuses a player who already captains a team", async () => {
    const { season, zai, other } = await preDraft();

    const res = await swap(season.id, zai.team.id, zai.user.id, other.user.id);

    expect(res?.error).toBe("Other already captains a team");
    await unchanged(zai.team.id, zai.user.id);
  });

  it("refuses someone who isn't an active player signup", async () => {
    const { season, zai } = await preDraft();
    const standin = await makeUser("Stan");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: standin.id,
        type: "STANDIN",
        status: "ACTIVE",
      },
    });

    const res = await swap(season.id, zai.team.id, zai.user.id, standin.id);

    expect(res?.error).toBe("Stan isn't an active player signup this season");
    await unchanged(zai.team.id, zai.user.id);
  });

  it("refuses a stale page whose captain already changed", async () => {
    const { season, zai, mira } = await preDraft();
    const late = await makePlayer(season.id, "Late", 2500);

    // Page rendered when Zai captained; another admin handed it to Late.
    expect((await swap(season.id, zai.team.id, zai.user.id, late.id))?.error)
      .toBeUndefined();
    vi.mocked(sendDiscordMessage).mockClear();
    const res = await swap(season.id, zai.team.id, zai.user.id, mira.id);

    expect(res?.error).toMatch(/captain already changed/i);
    expect(
      (await prisma.team.findUniqueOrThrow({ where: { id: zai.team.id } }))
        .captainId,
    ).toBe(late.id);
    expect(
      await prisma.teamMember.count({ where: { userId: mira.id } }),
    ).toBe(0);
  });
});

describe("changeCaptain — a Start draft landing mid-click wins (seam)", () => {
  it("re-reads the draft inside its transaction and refuses", async () => {
    const { season, zai, mira } = await preDraft();
    let fired = false;
    setRaceHook(
      onceAt("admin.changeCaptain.beforeTx", async () => {
        fired = true;
        await prisma.season.update({
          where: { id: season.id },
          data: { status: SEASON_STATUS.DRAFT },
        });
        await prisma.draft.create({
          data: { seasonId: season.id, status: DRAFT_STATUS.IN_PROGRESS },
        });
      }),
    );

    const res = await swap(season.id, zai.team.id, zai.user.id, mira.id);

    expect(fired).toBe(true);
    expect(res?.error).toMatch(/auction is live/i);
    expect(
      (await prisma.team.findUniqueOrThrow({ where: { id: zai.team.id } }))
        .captainId,
    ).toBe(zai.user.id);
    expect(
      await prisma.teamMember.count({ where: { userId: mira.id } }),
    ).toBe(0);
  });
});

describe("changeCaptain — two admins changing the same team at once (raced)", () => {
  it("elects one new captain and leaves exactly one captain seat", async () => {
    // Postgres runs these concurrently (raceAll); SQLite runs them in turn,
    // where the second is a stale page. Either way one wins.
    for (let round = 0; round < 3; round++) {
      const { season, zai, mira } = await preDraft();
      const late = await makePlayer(season.id, `Late ${round}`, 2500);

      const results = await raceAll([
        () => swap(season.id, zai.team.id, zai.user.id, mira.id),
        () => swap(season.id, zai.team.id, zai.user.id, late.id),
      ]);

      expect(results.filter((r) => !r?.error)).toHaveLength(1);
      const team = await prisma.team.findUniqueOrThrow({
        where: { id: zai.team.id },
      });
      expect([mira.id, late.id]).toContain(team.captainId);
      expect(await captainSeats(team.id)).toEqual([
        { userId: team.captainId, isCaptain: true, price: 0 },
      ]);
      await prisma.teamMember.deleteMany();
      await prisma.rosterTenure.deleteMany();
      await prisma.team.deleteMany();
      await prisma.registration.deleteMany();
      await prisma.season.deleteMany();
    }
  });
});
