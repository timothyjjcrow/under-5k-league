import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { generateSchedule } from "@/app/actions/admin-schedule-results";
import { sendDiscordMessage } from "@/lib/discord";
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

async function linkDiscord(userId: string, discordId: string) {
  await prisma.user.update({ where: { id: userId }, data: { discordId } });
}

/** The scrim-override announcements sent so far: [content, mentions]. */
function scrimYieldSends() {
  return vi
    .mocked(sendDiscordMessage)
    .mock.calls.filter(([content]) => content.includes(" scrim on "));
}

beforeEach(() => {
  vi.mocked(sendDiscordMessage).mockClear();
});

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

    // The refusal names the booking to cancel, not just "a booked scrim".
    expect(result?.error).toContain(
      `within four hours of the ${teams[0].name} vs ${teams[1].name} scrim on `,
    );
    expect(result?.error).toMatch(
      /\. Cancel that scrim on its page, then generate the schedule again\.$/,
    );
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

  it("builds the first playoff round anyway and cancels the clashing booked scrim", async () => {
    const firstNight = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const { season, teams, matches } = await completedRegularSeason(firstNight);
    const firstPlayoffWeek = Math.max(...matches.map((match) => match.week)) + 1;
    const playoffNight = upcomingMatchNight(
      firstNight,
      firstPlayoffWeek,
      Date.now(),
    );
    await linkDiscord(teams[0].captainId, "900000000000000001");
    await linkDiscord(teams[1].captainId, "900000000000000002");
    const scrim = await confirmedScrim({
      seasonId: season.id,
      hostTeamId: teams[0].id,
      opponentTeamId: teams[1].id,
      createdById: teams[0].captainId,
      scheduledAt: playoffNight,
    });

    const outcome = await createPlayoffBracket(season.id);

    // League fixtures win: the bracket exists and the practice booking is off.
    expect(
      await prisma.match.count({
        where: {
          seasonId: season.id,
          phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
        },
      }),
    ).toBe(2);
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } })).status,
    ).toBe(SEASON_STATUS.PLAYOFFS);
    expect(
      (await prisma.scrim.findUniqueOrThrow({ where: { id: scrim.id } })).status,
    ).toBe(SCRIM_STATUS.CANCELLED);
    // The admin's toast names the scrim…
    expect(outcome.scrimNotes).toHaveLength(1);
    expect(outcome.scrimNotes[0]).toContain(
      `Cancelled the ${teams[0].name} vs ${teams[1].name} scrim on `,
    );
    // …and both of its captains are pinged, nobody else.
    const sends = scrimYieldSends();
    expect(sends).toHaveLength(1);
    expect(sends[0][0]).toContain("was cancelled");
    expect([...(sends[0][1]?.users ?? [])].sort()).toEqual([
      "900000000000000001",
      "900000000000000002",
    ]);
    expect(
      await prisma.adminAction.findFirst({
        where: { seasonId: season.id, action: "yieldScrimsToPlayoffs" },
      }),
    ).toMatchObject({ summary: outcome.scrimNotes[0] });
  });

  it("builds the next round when a clashing scrim is booked, cancelling it", async () => {
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
    const host = teams.find((team) => team.id === finalistIds[0])!;
    const practicePartner = teams.find((team) => team.id !== finalistIds[0])!;
    const booked = await confirmedScrim({
      seasonId: season.id,
      hostTeamId: host.id,
      opponentTeamId: practicePartner.id,
      createdById: host.captainId,
      scheduledAt: finalNight,
    });
    // A booking of the same team at a different night is not in the way.
    const later = await confirmedScrim({
      seasonId: season.id,
      hostTeamId: host.id,
      opponentTeamId: practicePartner.id,
      createdById: host.captainId,
      scheduledAt: new Date(finalNight.getTime() + 5 * 60 * 60 * 1000),
    });

    await expect(advancePlayoffBracket(season.id)).resolves.toBe(true);
    expect(
      await prisma.match.count({
        where: { seasonId: season.id, bracketSlot: { startsWith: "R1M" } },
      }),
    ).toBe(1);
    const statuses = new Map(
      (
        await prisma.scrim.findMany({
          where: { id: { in: [booked.id, later.id] } },
          select: { id: true, status: true },
        })
      ).map((row) => [row.id, row.status]),
    );
    expect(statuses.get(booked.id)).toBe(SCRIM_STATUS.CANCELLED);
    expect(statuses.get(later.id)).toBe(SCRIM_STATUS.SCHEDULED);
    const sends = scrimYieldSends();
    expect(sends).toHaveLength(1);
    expect(sends[0][0]).toContain("the grand final");
    const log = await prisma.adminAction.findFirstOrThrow({
      where: { seasonId: season.id, action: "yieldScrimsToPlayoffs" },
    });
    expect(log.actorName).toBe("League automation");
    expect(log.summary).toContain(
      `Cancelled the ${host.name} vs ${practicePartner.name} scrim on `,
    );
  });

  it("builds the next round past a live scrim, keeping its games and reporting it", async () => {
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

    await expect(advancePlayoffBracket(season.id)).resolves.toBe(true);
    expect(
      await prisma.match.count({
        where: { seasonId: season.id, bracketSlot: { startsWith: "R1M" } },
      }),
    ).toBe(1);
    expect(
      await prisma.setting.findUnique({
        where: { key: `playoffRoundBuilt:${season.id}:1` },
      }),
    ).not.toBeNull();
    expect(
      (await prisma.scrim.findUniqueOrThrow({ where: { id: scrim.id } })).status,
    ).toBe(SCRIM_STATUS.LIVE);
    const sends = scrimYieldSends();
    expect(sends).toHaveLength(1);
    expect(sends[0][0]).toContain("is still in progress");
    expect(sends[0][0]).toContain(`/scrims/${scrim.id}`);

    // Idempotent: a later reconciler pass neither rebuilds nor re-announces.
    await expect(advancePlayoffBracket(season.id)).resolves.toBe(false);
    expect(scrimYieldSends()).toHaveLength(1);
  });
});
