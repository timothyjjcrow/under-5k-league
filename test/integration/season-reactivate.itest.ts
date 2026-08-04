import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { DRAFT_STATUS, SEASON_STATUS } from "@/lib/constants";
import { resumeDraft } from "@/lib/draft-service";
import { getActiveSeason, reactivateSeason } from "@/lib/season";
import {
  makeSeason,
  makeUser,
  ON_POSTGRES,
  raceAll,
  sessionFor,
} from "./factories";

// Reactivation is an offseason restore, not an alternate one-click way to
// archive whichever live season happens to be current. Admins enter offseason
// through the authoritative completed handoff or the explicit cancellation
// command first, then choose the historical season to restore here.

describe("reactivateSeason (integration)", () => {
  it("refuses to replace an active season or bypass explicit cancellation", async () => {
    const target = await makeSeason({
      name: "Season 9",
      status: SEASON_STATUS.PLAYOFFS,
      isActive: false,
    });
    const current = await makeSeason({
      name: "Season 10",
      status: SEASON_STATUS.SIGNUPS,
      isActive: true,
    });

    const result = await reactivateSeason(target.id, target.updatedAt);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/enter the offseason/i);
    expect((await getActiveSeason())?.id).toBe(current.id);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: target.id } }),
    ).toMatchObject({ isActive: false, status: SEASON_STATUS.PLAYOFFS });
    expect(
      await prisma.setting.findUnique({ where: { key: "resultChangedAt" } }),
    ).toBeNull();
  });

  it("refuses unknown and already-active seasons", async () => {
    const current = await makeSeason({ isActive: true });
    expect(await reactivateSeason("nope", new Date(0))).toEqual({
      ok: false,
      error: "Unknown season",
    });
    const already = await reactivateSeason(current.id, current.updatedAt);
    expect(already.ok).toBe(false);
    expect((await getActiveSeason())?.id).toBe(current.id);
  });

  it("restores an archived season from a real offseason without changing its phase", async () => {
    const target = await makeSeason({
      name: "Saved regular season",
      status: SEASON_STATUS.REGULAR_SEASON,
      isActive: false,
    });

    const result = await reactivateSeason(target.id, target.updatedAt);

    expect(result).toEqual({
      ok: true,
      id: target.id,
      name: target.name,
      status: SEASON_STATUS.REGULAR_SEASON,
      draftParked: false,
    });
    expect((await getActiveSeason())?.id).toBe(target.id);
    expect((await getActiveSeason())?.status).toBe(
      SEASON_STATUS.REGULAR_SEASON,
    );
    expect(await prisma.season.count({ where: { isActive: true } })).toBe(1);
    expect(
      await prisma.setting.findUnique({ where: { key: "resultChangedAt" } }),
    ).not.toBeNull();
  });

  it("refuses a target that changed after the history page rendered", async () => {
    const target = await makeSeason({ name: "Archived", isActive: false });
    await prisma.season.update({
      where: { id: target.id },
      // Pin a distinct revision; SQLite can perform both writes within the
      // same millisecond, which makes an implicit @updatedAt-only test flaky.
      data: {
        name: "Archived corrected",
        updatedAt: new Date(target.updatedAt.getTime() + 1_000),
      },
    });

    const result = await reactivateSeason(target.id, target.updatedAt);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/archived season changed/i);
    expect(await prisma.season.count({ where: { isActive: true } })).toBe(0);
  });

  it("refuses an invalid rendered revision", async () => {
    const target = await makeSeason({ isActive: false });
    expect(await reactivateSeason(target.id, new Date("invalid"))).toMatchObject({
      ok: false,
    });
  });

  it.skipIf(ON_POSTGRES)(
    "refuses legacy multiple-active corruption",
    async () => {
      const target = await makeSeason({ isActive: false });
      await makeSeason({ name: "Current A", isActive: true });
      await makeSeason({ name: "Current B", isActive: true });
      const result = await reactivateSeason(target.id, target.updatedAt);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/more than one season/i);
      expect(await prisma.season.count({ where: { isActive: true } })).toBe(2);
    },
  );

  it.runIf(ON_POSTGRES)(
    "has a database barrier against a second active season",
    async () => {
      await makeSeason({ name: "Current A", isActive: true });
      await expect(
        makeSeason({ name: "Current B", isActive: true }),
      ).rejects.toMatchObject({ code: "P2002" });
      expect(await prisma.season.count({ where: { isActive: true } })).toBe(1);
    },
  );

  it("parks a legacy live auction before activation, then resumes with one fresh clock", async () => {
    const target = await makeSeason({
      name: "Legacy archived draft",
      status: SEASON_STATUS.DRAFT,
      isActive: false,
    });
    await prisma.draft.create({
      data: {
        seasonId: target.id,
        status: DRAFT_STATUS.IN_PROGRESS,
        nominatorTeamId: "legacy-nominator",
        nominatedUserId: "legacy-player",
        currentBid: 17,
        currentBidTeamId: "legacy-bidder",
        bidEndsAt: new Date(Date.now() - 60_000),
      },
    });

    const result = await reactivateSeason(target.id, target.updatedAt);

    expect(result).toMatchObject({ ok: true, draftParked: true });
    expect(
      await prisma.draft.findUniqueOrThrow({ where: { seasonId: target.id } }),
    ).toMatchObject({
      status: DRAFT_STATUS.PAUSED,
      nominatedUserId: "legacy-player",
      currentBid: 17,
      currentBidTeamId: "legacy-bidder",
      bidEndsAt: null,
      nominationEndsAt: null,
    });

    const admin = sessionFor(await makeUser("Restore Admin", "ADMIN"));
    expect((await resumeDraft(target.id, admin)).ok).toBe(true);
    const resumed = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: target.id },
    });
    expect(resumed.status).toBe(DRAFT_STATUS.IN_PROGRESS);
    expect(resumed.bidEndsAt?.getTime()).toBeGreaterThan(Date.now());
    expect(resumed.nominationEndsAt).toBeNull();
  });

  it.each([DRAFT_STATUS.NOT_STARTED, DRAFT_STATUS.COMPLETE])(
    "preserves a %s draft when restoring its archived season",
    async (draftStatus) => {
      const target = await makeSeason({
        name: `Archived ${draftStatus} draft`,
        status: SEASON_STATUS.DRAFT,
        isActive: false,
      });
      await prisma.draft.create({
        data: { seasonId: target.id, status: draftStatus },
      });

      const result = await reactivateSeason(target.id, target.updatedAt);

      expect(result).toMatchObject({ ok: true, draftParked: false });
      expect(
        await prisma.draft.findUniqueOrThrow({
          where: { seasonId: target.id },
        }),
      ).toMatchObject({
        status: draftStatus,
        bidEndsAt: null,
        nominationEndsAt: null,
      });
    },
  );

  it("serializes two offseason restores so exactly one historical season becomes active", async () => {
    const first = await makeSeason({ name: "Archived A", isActive: false });
    const second = await makeSeason({ name: "Archived B", isActive: false });

    const results = await raceAll([
      () => reactivateSeason(first.id, first.updatedAt),
      () => reactivateSeason(second.id, second.updatedAt),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const active = await prisma.season.findMany({ where: { isActive: true } });
    expect(active).toHaveLength(1);
    expect([first.id, second.id]).toContain(active[0]?.id);
  });
});
