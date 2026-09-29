/**
 * A game an admin removes stays removed on every path except the admin's own
 * overrides ("Add game" and "Auto-fetch games" on the match).
 *
 * A captain pasting a removed game's id on the match page used to bring it
 * straight back. The test runs the real removeGame action so the suppression
 * under test is exactly the one an admin's click writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({ id: "test-admin", name: "Test administrator", role: "ADMIN", steamId: "76561198000000000", avatar: null })),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));
// Keep the real module (steamIdToAccountId, parseMatchId) but stub the network.
vi.mock("@/lib/dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota")>();
  return {
    ...actual,
    fetchOpenDotaMatch: vi.fn(),
    fetchRecentMatchIds: vi.fn(async () => [] as number[]),
    fetchLeagueMatchIds: vi.fn(async () => [] as number[]),
  };
});

import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { fetchOpenDotaMatch, steamIdToAccountId } from "@/lib/dota";
import { reportImportGame } from "@/lib/match-report-service";
import { importGameAction, removeGame } from "@/app/actions/admin-schedule-results";
import type { ActionResult } from "@/lib/action-result";
import { makeSeason, makeTeam, makeUser } from "./factories";

const mockMatch = vi.mocked(fetchOpenDotaMatch);

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
};
const empty: ActionResult = {};
const HOUR = 3600_000;

beforeEach(() => {
  mockMatch.mockReset();
  mockMatch.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

/** Two three-player teams and a Bo1 that kicked off two hours ago. */
async function setupNight() {
  const season = await makeSeason({
    teamSize: 3,
    status: SEASON_STATUS.REGULAR_SEASON,
  });
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);
  const accounts = new Map<string, number[]>();
  for (const [team, tag] of [[home, "H"], [away, "A"]] as const) {
    const list: number[] = [];
    for (let i = 0; i < 3; i++) {
      const user = await makeUser(`Removal${tag}${i}`);
      await prisma.teamMember.create({
        data: { seasonId: season.id, teamId: team.id, userId: user.id, price: 0 },
      });
      list.push(steamIdToAccountId(user.steamId)!);
    }
    accounts.set(team.id, list);
  }
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: home.id,
      awayTeamId: away.id,
      bestOf: 1,
      scheduledAt: new Date(Date.now() - 2 * HOUR),
    },
  });
  const game = (id: number) => ({
    match_id: id,
    radiant_win: true,
    duration: 2000,
    start_time: Math.floor((match.scheduledAt!.getTime() + 15 * 60_000) / 1000),
    radiant_score: 30,
    dire_score: 20,
    players: [
      ...accounts.get(home.id)!.map((a, i) => ({
        account_id: a, player_slot: i, hero_id: i + 1, isRadiant: true,
        kills: 5, deaths: 1, assists: 3,
      })),
      ...accounts.get(away.id)!.map((a, i) => ({
        account_id: a, player_slot: 128 + i, hero_id: 10 + i, isRadiant: false,
        kills: 1, deaths: 5, assists: 2,
      })),
      // Anonymous fillers: a finished game has all ten players.
      ...[0, 1].flatMap((i) => [
        { account_id: null, player_slot: 3 + i, hero_id: 20 + i, isRadiant: true, kills: 0, deaths: 0, assists: 0 },
        { account_id: null, player_slot: 131 + i, hero_id: 30 + i, isRadiant: false, kills: 0, deaths: 0, assists: 0 },
      ]),
    ],
  });
  return { season, home, away, match, game };
}

async function removeOnlyGame(matchId: string) {
  const stored = await prisma.game.findFirstOrThrow({ where: { matchId } });
  const res = await removeGame(empty, fd({ gameId: stored.id }));
  expect(res?.error).toBeUndefined();
  expect(await prisma.game.count({ where: { matchId } })).toBe(0);
}

describe("a removed game stays removed", () => {
  it("refuses a captain who pastes the removed game's id, with a clear message", async () => {
    const { home, away, match, game } = await setupNight();
    mockMatch.mockResolvedValue(game(8810001));
    expect(await reportImportGame(home.captainId, match.id, "8810001"))
      .toMatchObject({ ok: true });
    await removeOnlyGame(match.id);
    expect(
      (await prisma.match.findUniqueOrThrow({ where: { id: match.id } })).status,
    ).not.toBe(MATCH_STATUS.COMPLETED);
    mockMatch.mockClear();

    // The other captain: the first one's lookup cooldown is not the guard.
    await expect(reportImportGame(away.captainId, match.id, "8810001"))
      .resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/admin removed this game.*ask an admin/i),
      });
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(0);
    // Refused before any OpenDota call, so the captain's cooldown is untouched.
    expect(mockMatch).not.toHaveBeenCalled();

    // The admin's own Add game is still the way back.
    const readded = await importGameAction(
      empty,
      fd({ matchId: match.id, dotaMatchRef: "8810001" }),
    );
    expect(readded).toMatchObject({ ok: true });
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(1);
  });
});
