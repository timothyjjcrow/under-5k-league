/**
 * Ending a half-played scrim series at its current score. Either captain or
 * a verified admin can do it, only while the series is LIVE, and the one
 * guarded claim re-asserts the score it judged — so a game recorded between
 * the read and the write wins instead of being frozen out. The seams sit
 * before a single statement (no transaction), so they run on SQLite too.
 */
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  ROLE,
  SCRIM_STATUS,
  SEASON_STATUS,
  TEAM_STAFF_ROLE,
} from "@/lib/constants";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { endScrimSeries } from "@/lib/scrim-service";
import { makeCaptain, makeSeason, makeUser } from "./factories";

afterEach(() => setRaceHook(null));

async function series(options: {
  bestOf: number;
  hostScore: number;
  awayScore: number;
  status?: string;
}) {
  // A test that needs a second series is done with the first by then, and
  // only one season can be active.
  await prisma.season.updateMany({
    where: { isActive: true },
    data: { isActive: false },
  });
  const season = await makeSeason({
    status: SEASON_STATUS.REGULAR_SEASON,
    teamSize: 5,
  });
  const host = await makeCaptain(season.id, "Host Cap", 100, 0);
  const away = await makeCaptain(season.id, "Away Cap", 100, 1);
  const scrim = await prisma.scrim.create({
    data: {
      seasonId: season.id,
      hostTeamId: host.team.id,
      opponentTeamId: away.team.id,
      createdById: host.user.id,
      scheduledAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      bestOf: options.bestOf,
      status: options.status ?? SCRIM_STATUS.LIVE,
      hostScore: options.hostScore,
      awayScore: options.awayScore,
    },
  });
  return { host, away, scrim };
}

const row = (id: string) => prisma.scrim.findUniqueOrThrow({ where: { id } });

describe("ending a scrim series early (integration)", () => {
  it("lets either captain end it at the current score, with the leader as winner", async () => {
    const { host, scrim } = await series({
      bestOf: 3,
      hostScore: 1,
      awayScore: 0,
    });

    const ended = await endScrimSeries(host.user.id, false, scrim.id);

    expect(ended).toEqual({
      message: `Series ended at 1–0. ${host.team.name} win it.`,
      hostScore: 1,
      awayScore: 0,
      winnerTeamId: host.team.id,
    });
    expect(await row(scrim.id)).toMatchObject({
      status: SCRIM_STATUS.COMPLETED,
      hostScore: 1,
      awayScore: 0,
      winnerTeamId: host.team.id,
    });
    await expect(
      endScrimSeries(host.user.id, false, scrim.id),
    ).rejects.toThrow("This scrim series is already final");
  });

  it("ends a level series as a draw, from the other captain or an admin", async () => {
    const level = await series({ bestOf: 5, hostScore: 1, awayScore: 1 });
    expect(
      await endScrimSeries(level.away.user.id, false, level.scrim.id),
    ).toMatchObject({
      message: "Series ended level at 1–1, with no winner.",
      winnerTeamId: null,
    });
    expect(await row(level.scrim.id)).toMatchObject({
      status: SCRIM_STATUS.COMPLETED,
      winnerTeamId: null,
    });

    const trailing = await series({ bestOf: 3, hostScore: 0, awayScore: 1 });
    const admin = await makeUser("Scrim Admin", ROLE.ADMIN);
    expect(
      await endScrimSeries(admin.id, true, trailing.scrim.id),
    ).toMatchObject({ winnerTeamId: trailing.away.team.id });
  });

  it("refuses coaches, other players, and a series that isn't in progress", async () => {
    const { host, scrim } = await series({
      bestOf: 3,
      hostScore: 1,
      awayScore: 0,
    });
    const coach = await makeUser("Host Coach");
    await prisma.teamStaff.create({
      data: {
        teamId: host.team.id,
        userId: coach.id,
        role: TEAM_STAFF_ROLE.COACH,
      },
    });
    const stranger = await makeUser("Someone Else");
    // A stale admin flag from the session is re-checked against the database.
    for (const [viewerId, isAdmin] of [
      [coach.id, false],
      [stranger.id, false],
      [stranger.id, true],
    ] as const) {
      await expect(endScrimSeries(viewerId, isAdmin, scrim.id)).rejects.toThrow(
        "Only either team's captain or an admin can end this series",
      );
    }
    expect((await row(scrim.id)).status).toBe(SCRIM_STATUS.LIVE);

    const booked = await series({
      bestOf: 3,
      hostScore: 0,
      awayScore: 0,
      status: SCRIM_STATUS.SCHEDULED,
    });
    await expect(
      endScrimSeries(booked.host.user.id, false, booked.scrim.id),
    ).rejects.toThrow("cancel an unplayed scrim instead");
    expect((await row(booked.scrim.id)).status).toBe(SCRIM_STATUS.SCHEDULED);
  });

  it("loses to a game recorded between its read and its claim", async () => {
    const { away, scrim } = await series({
      bestOf: 5,
      hostScore: 1,
      awayScore: 1,
    });
    let fired = false;
    setRaceHook(
      onceAt("scrim.endSeries.beforeClaim", async () => {
        fired = true;
        // The rival: an import records game 3 for the host.
        await prisma.scrim.update({
          where: { id: scrim.id },
          data: { hostScore: 2 },
        });
      }),
    );

    await expect(
      endScrimSeries(away.user.id, false, scrim.id),
    ).rejects.toThrow(
      "A game was just recorded and the score is now 2–1 — check it, then end the series if you still want to",
    );
    expect(fired).toBe(true);
    // Blind, the stale 1–1 draw would have been written over the 2–1 lead.
    expect(await row(scrim.id)).toMatchObject({
      status: SCRIM_STATUS.LIVE,
      hostScore: 2,
      awayScore: 1,
      winnerTeamId: null,
    });
  });

  it("loses to a game that finished the series in the gap", async () => {
    const { host, away, scrim } = await series({
      bestOf: 3,
      hostScore: 1,
      awayScore: 1,
    });
    let fired = false;
    setRaceHook(
      onceAt("scrim.endSeries.beforeClaim", async () => {
        fired = true;
        await prisma.scrim.update({
          where: { id: scrim.id },
          data: {
            awayScore: 2,
            status: SCRIM_STATUS.COMPLETED,
            winnerTeamId: away.team.id,
          },
        });
      }),
    );

    await expect(
      endScrimSeries(host.user.id, false, scrim.id),
    ).rejects.toThrow("This series just finished at 1–2 — nothing to end");
    expect(fired).toBe(true);
    expect(await row(scrim.id)).toMatchObject({
      status: SCRIM_STATUS.COMPLETED,
      hostScore: 1,
      awayScore: 2,
      winnerTeamId: away.team.id,
    });
  });
});
