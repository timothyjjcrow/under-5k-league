import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({ id: "admin", name: "Admin" })),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { generateSchedule } from "@/app/actions/admin";
import type { ActionResult } from "@/lib/action-result";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  SCRIM_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import {
  advancePlayoffBracket,
  createPlayoffBracket,
} from "@/lib/playoff-service";
import { prisma } from "@/lib/prisma";
import { upcomingMatchNight } from "@/lib/schedule";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  recordMatch,
} from "./factories";

const empty: ActionResult = {};

function fd(values: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.append(key, value);
  return form;
}

async function confirmedScrim(options: {
  seasonId: string;
  hostTeamId: string;
  opponentTeamId: string;
  createdById: string;
  scheduledAt: Date;
  status?: string;
}) {
  return prisma.scrim.create({
    data: {
      seasonId: options.seasonId,
      hostTeamId: options.hostTeamId,
      opponentTeamId: options.opponentTeamId,
      createdById: options.createdById,
      scheduledAt: options.scheduledAt,
      status: options.status ?? SCRIM_STATUS.SCHEDULED,
    },
  });
}

async function completedRegularSeason(firstMatchNight: Date) {
  const season = await makeSeason({
    status: SEASON_STATUS.REGULAR_SEASON,
    minTeams: 4,
  });
  await prisma.season.update({
    where: { id: season.id },
    data: { firstMatchNight },
  });
  const teams = [];
  for (let index = 0; index < 4; index += 1) {
    teams.push(await makeTeam(season.id, `Team ${index + 1}`, index));
  }
  const matches = await generateRegularSchedule(season.id);
  for (const match of matches) await recordMatch(match.id, 2, 0);
  return { season, teams, matches };
}

describe("official fixture creation respects confirmed scrims", () => {
  it("preserves the old regular schedule when generation would double-book a team", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    const teams = [];
    for (let index = 0; index < 4; index += 1) {
      teams.push(await makeTeam(season.id, `Team ${index + 1}`, index));
    }
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });
    const oldSchedule = await generateRegularSchedule(season.id);
    const firstNight = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await confirmedScrim({
      seasonId: season.id,
      hostTeamId: teams[0].id,
      opponentTeamId: teams[1].id,
      createdById: teams[0].captainId,
      scheduledAt: firstNight,
    });

    const result = await generateSchedule(
      empty,
      fd({
        expectedActiveSeasonId: season.id,
        firstNight: firstNight.toISOString(),
        firstNightTs: String(firstNight.getTime()),
      }),
    );

    expect(result?.error).toMatch(/booked scrim within four hours/i);
    const after = await prisma.match.findMany({
      where: { seasonId: season.id },
      orderBy: { id: "asc" },
    });
    expect(after.map((match) => match.id).sort()).toEqual(
      oldSchedule.map((match) => match.id).sort(),
    );
    expect(after.every((match) => match.scheduledAt == null)).toBe(true);
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .firstMatchNight,
    ).toBeNull();
  });

  it("refuses first-round playoff creation without tearing down league state", async () => {
    const firstNight = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const { season, teams, matches } = await completedRegularSeason(firstNight);
    const firstPlayoffWeek = Math.max(...matches.map((match) => match.week)) + 1;
    const playoffNight = upcomingMatchNight(
      firstNight,
      firstPlayoffWeek,
      Date.now(),
    );
    const scrim = await confirmedScrim({
      seasonId: season.id,
      hostTeamId: teams[0].id,
      opponentTeamId: teams[1].id,
      createdById: teams[0].captainId,
      scheduledAt: playoffNight,
    });

    await expect(createPlayoffBracket(season.id)).rejects.toThrow(
      /playoff team has a booked scrim within four hours/i,
    );
    expect(
      await prisma.match.count({
        where: {
          seasonId: season.id,
          phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
        },
      }),
    ).toBe(0);
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } })).status,
    ).toBe(SEASON_STATUS.REGULAR_SEASON);

    await prisma.scrim.update({
      where: { id: scrim.id },
      data: { status: SCRIM_STATUS.CANCELLED },
    });
    await expect(createPlayoffBracket(season.id)).resolves.toBeDefined();
  });

  it("leaves an advancing round retryable until its live scrim conflict clears", async () => {
    const firstNight = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const { season, teams } = await completedRegularSeason(firstNight);
    await createPlayoffBracket(season.id);
    const semifinals = await prisma.match.findMany({
      where: { seasonId: season.id, bracketSlot: { startsWith: "R0M" } },
      orderBy: { bracketSlot: "asc" },
    });
    expect(semifinals).toHaveLength(2);
    for (const semifinal of semifinals) await recordMatch(semifinal.id, 2, 0);

    const finalWeek = Math.max(...semifinals.map((match) => match.week)) + 1;
    const finalNight = upcomingMatchNight(firstNight, finalWeek, Date.now());
    const finalistIds = semifinals.map((match) => match.homeTeamId);
    const scrim = await confirmedScrim({
      seasonId: season.id,
      hostTeamId: finalistIds[0],
      opponentTeamId: teams.find((team) => team.id !== finalistIds[0])!.id,
      createdById: teams.find((team) => team.id === finalistIds[0])!.captainId,
      scheduledAt: finalNight,
      status: SCRIM_STATUS.LIVE,
    });

    await expect(advancePlayoffBracket(season.id)).resolves.toBe(false);
    expect(
      await prisma.match.count({
        where: { seasonId: season.id, bracketSlot: { startsWith: "R1M" } },
      }),
    ).toBe(0);
    expect(
      await prisma.setting.findUnique({
        where: { key: `playoffRoundBuilt:${season.id}:1` },
      }),
    ).toBeNull();

    await prisma.scrim.update({
      where: { id: scrim.id },
      data: { status: SCRIM_STATUS.COMPLETED },
    });
    await expect(advancePlayoffBracket(season.id)).resolves.toBe(true);
    expect(
      await prisma.match.count({
        where: { seasonId: season.id, bracketSlot: { startsWith: "R1M" } },
      }),
    ).toBe(1);
  });
});
