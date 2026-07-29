/**
 * The audit log and the season export — the two safety nets that answer
 * "what did I press?" and "is the data still anywhere?".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", name: "Boss" })),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(async () => ({ id: "admin1", name: "Boss" })),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { prisma } from "@/lib/prisma";
import { logAdminAction, recentAdminActions } from "@/lib/admin-log";
import { generateSchedule, removeCaptain } from "@/app/actions/admin";
import { MATCH_PHASE, SEASON_STATUS } from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  makeUser,
  resetDb,
} from "./factories";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
};
const empty: ActionResult = {};

beforeEach(resetDb);

describe("logAdminAction", () => {
  it("records the actor from the session without being passed one", async () => {
    await logAdminAction({ action: "testThing", summary: "did a thing" });
    const [row] = await recentAdminActions(5);
    expect(row.actorName).toBe("Boss");
    expect(row.actorId).toBe("admin1");
    expect(row.action).toBe("testThing");
  });

  // Rule 1: a missing log line is a far smaller problem than a mutation that
  // fails halfway because its logging threw.
  it("never throws, even when the write fails", async () => {
    const spy = vi
      .spyOn(prisma.adminAction, "create")
      .mockRejectedValueOnce(new Error("db gone"));
    await expect(
      logAdminAction({ action: "x", summary: "y" }),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("returns newest first", async () => {
    await logAdminAction({ action: "first", summary: "1" });
    await logAdminAction({ action: "second", summary: "2" });
    const rows = await recentAdminActions(5);
    expect(rows[0].action).toBe("second");
  });

  it("truncates a runaway summary rather than refusing to log", async () => {
    await logAdminAction({ action: "big", summary: "x".repeat(2000) });
    const [row] = await recentAdminActions(1);
    expect(row.summary.length).toBeLessThanOrEqual(500);
  });
});

describe("destructive actions leave a trail", () => {
  async function seasonWithSchedule() {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    for (let i = 0; i < 4; i++) await makeTeam(season.id, `Team ${i + 1}`, i + 1);
    const matches = await generateRegularSchedule(season.id);
    return { season, matches };
  }

  it("generateSchedule records the collateral it cleared", async () => {
    const { season, matches } = await seasonWithSchedule();
    const player = await makeUser("RSVP");
    await prisma.matchAvailability.create({
      data: { matchId: matches[0].id, userId: player.id, status: "IN" },
    });

    await generateSchedule(empty, fd({ firstNight: "" }));

    const [row] = await recentAdminActions(1);
    expect(row.action).toBe("generateSchedule");
    expect(row.summary).toMatch(/1 check-in/);
    expect(row.seasonId).toBe(season.id);
  });

  it("removeCaptain records that it cleared the whole schedule", async () => {
    const { season } = await seasonWithSchedule();
    const doomed = await prisma.team.findFirstOrThrow({
      where: { seasonId: season.id },
    });

    await removeCaptain(empty, fd({ teamId: doomed.id }));

    const [row] = await recentAdminActions(1);
    expect(row.action).toBe("removeCaptain");
    expect(row.summary).toMatch(/whole schedule was cleared/i);
  });

  // The record of a deletion has to OUTLIVE the thing deleted — AdminAction
  // deliberately has no FK to Season, or the cascade would erase the one line
  // explaining where the season went.
  it("a deletion record survives the season it describes", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.COMPLETE });
    await logAdminAction({
      action: "deleteSeason",
      summary: `PERMANENTLY DELETED season "${season.name}"`,
      seasonId: season.id,
    });
    await prisma.season.delete({ where: { id: season.id } });

    const [row] = await recentAdminActions(1);
    expect(row.action).toBe("deleteSeason");
    expect(row.seasonId).toBe(season.id);
  });
});
