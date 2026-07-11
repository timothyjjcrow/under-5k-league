import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  cancelReschedule,
  proposeReschedule,
  respondReschedule,
} from "@/lib/reschedule-service";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  makeUser,
  recordMatch,
} from "./factories";

const NIGHT = new Date("2026-08-01T19:00:00Z");

/** A two-team season with one scheduled match; returns captains + match. */
async function setupMatch() {
  const season = await makeSeason();
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);
  const [match] = await generateRegularSchedule(season.id);
  return { season, home, away, match };
}

async function pendingFor(matchId: string) {
  return prisma.rescheduleRequest.findFirst({
    where: { matchId, status: "PENDING" },
  });
}

describe("reschedule service (integration)", () => {
  it("captain proposes; a newer proposal supersedes the old one", async () => {
    const { home, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const first = await pendingFor(match.id);
    expect(first?.proposedTime.getTime()).toBe(NIGHT.getTime());

    const later = new Date(NIGHT.getTime() + 3600_000);
    await proposeReschedule(home.captainId, match.id, later);
    const requests = await prisma.rescheduleRequest.findMany({
      where: { matchId: match.id },
      orderBy: { createdAt: "asc" },
    });
    expect(requests.map((r) => r.status).sort()).toEqual([
      "CANCELLED",
      "PENDING",
    ]);
    expect((await pendingFor(match.id))?.proposedTime.getTime()).toBe(
      later.getTime(),
    );
  });

  it("rejects proposals from non-captains and on played matches", async () => {
    const { home, away, match } = await setupMatch();
    const rando = await makeUser("Rando");
    await expect(
      proposeReschedule(rando.id, match.id, NIGHT),
    ).rejects.toThrow(/two captains/);

    await recordMatch(match.id, 2, 0);
    await expect(
      proposeReschedule(home.captainId, match.id, NIGHT),
    ).rejects.toThrow(/already played/);
    void away;
  });

  it("opposing captain accepts → match retimed, request ACCEPTED", async () => {
    const { home, away, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);

    const accepted = await respondReschedule(
      away.captainId,
      pending!.id,
      true,
    );
    expect(accepted).not.toBeNull();
    expect(accepted!.newTime.getTime()).toBe(NIGHT.getTime());

    const updated = await prisma.match.findUnique({
      where: { id: match.id },
    });
    expect(updated?.scheduledAt?.getTime()).toBe(NIGHT.getTime());
    const request = await prisma.rescheduleRequest.findUnique({
      where: { id: pending!.id },
    });
    expect(request?.status).toBe("ACCEPTED");
  });

  it("proposer cannot accept their own proposal", async () => {
    const { home, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    await expect(
      respondReschedule(home.captainId, pending!.id, true),
    ).rejects.toThrow(/opposing captain/);
  });

  it("decline keeps the current time and closes the request", async () => {
    const { home, away, match } = await setupMatch();
    const before = (
      await prisma.match.findUnique({ where: { id: match.id } })
    )?.scheduledAt;
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);

    const result = await respondReschedule(away.captainId, pending!.id, false);
    expect(result).toBeNull();
    const after = await prisma.match.findUnique({ where: { id: match.id } });
    expect(after?.scheduledAt?.getTime() ?? null).toBe(
      before?.getTime() ?? null,
    );
    expect(
      (await prisma.rescheduleRequest.findUnique({ where: { id: pending!.id } }))
        ?.status,
    ).toBe("DECLINED");
  });

  it("only the proposer or an admin can withdraw", async () => {
    const { home, away, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);

    await expect(
      cancelReschedule(away.captainId, pending!.id, false),
    ).rejects.toThrow(/proposer/);
    await cancelReschedule(away.captainId, pending!.id, true); // admin override
    expect(
      (await prisma.rescheduleRequest.findUnique({ where: { id: pending!.id } }))
        ?.status,
    ).toBe("CANCELLED");
  });
});
