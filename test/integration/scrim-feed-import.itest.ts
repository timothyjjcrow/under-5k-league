import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  DOTA_MATCH_KIND,
  MATCH_PHASE,
  SCRIM_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import { SETTING_KEYS } from "@/lib/settings";
import { steamIdToAccountId, type OpenDotaMatch } from "@/lib/dota";
import { SCRIM_CANDIDATE_REASON, syncLeagueGames } from "@/lib/match-import";
import { runResultSync } from "@/lib/result-sync-service";
import { recordScrimGamesFromFeed } from "@/lib/scrim-result-service";
import { SCRIM_FEED_CLOSES_AFTER_MS } from "@/lib/scrim-window";
import { makeSeason, makeTeam, makeUser } from "./factories";

// A scrim hosted with the season's ticket is in the league feed. The feed
// hands it to the scrim importer, which records it on its scrim by itself:
// no captain presses anything (docs/features/stats-and-side-games.md#scrims).

vi.mock("@/lib/dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota")>();
  return {
    ...actual,
    fetchOpenDotaMatch: vi.fn(),
    fetchRecentMatchIds: vi.fn(async () => [] as number[]),
    fetchLeagueMatchIds: vi.fn(async () => [] as number[]),
    fetchRecentMatches: vi.fn(async () => []),
  };
});
vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return {
    ...actual,
    getWebhookUrl: vi.fn(async () => null),
    sendDiscordMessage: vi.fn(async () => true),
    deliverPendingLeagueAnnouncements: vi.fn(async () => ({
      attempted: 0,
      delivered: 0,
      pending: false,
    })),
  };
});
import { fetchLeagueMatchIds, fetchOpenDotaMatch } from "@/lib/dota";

const mockLeague = vi.mocked(fetchLeagueMatchIds);
const mockMatch = vi.mocked(fetchOpenDotaMatch);
const HOUR = 3_600_000;
const TICKET = "20413";

beforeEach(() => {
  mockLeague.mockReset();
  mockLeague.mockResolvedValue([]);
  mockMatch.mockReset();
  mockMatch.mockResolvedValue(null);
});

/**
 * A ticketed regular season, two teams of three rostered players, and one
 * booked scrim between them `offsetMs` from now, its lineups snapshotted the
 * way joinScrim does.
 */
async function bookedScrimNight(opts: {
  offsetMs: number;
  bestOf?: number;
  status?: string;
  ticket?: string | null;
}) {
  const season = await makeSeason({
    teamSize: 3,
    status: SEASON_STATUS.REGULAR_SEASON,
    dotaLeagueId: opts.ticket === undefined ? TICKET : opts.ticket,
  });
  const host = await makeTeam(season.id, "Host", 0);
  const away = await makeTeam(season.id, "Away", 1);
  const accounts = { host: [] as number[], away: [] as number[] };
  const participants: {
    teamId: string;
    userId: string;
    dotaAccountId: number;
    displayName: string;
  }[] = [];
  for (const [team, list, tag] of [
    [host, accounts.host, "H"],
    [away, accounts.away, "A"],
  ] as const) {
    for (let i = 0; i < 3; i++) {
      const user = await makeUser(`Scrim${tag}${i}`);
      await prisma.teamMember.create({
        data: {
          seasonId: season.id,
          teamId: team.id,
          userId: user.id,
          isCaptain: false,
          price: 0,
        },
      });
      const dotaAccountId = steamIdToAccountId(user.steamId)!;
      list.push(dotaAccountId);
      participants.push({
        teamId: team.id,
        userId: user.id,
        dotaAccountId,
        displayName: user.name,
      });
    }
  }
  const scrim = await prisma.scrim.create({
    data: {
      seasonId: season.id,
      hostTeamId: host.id,
      opponentTeamId: away.id,
      createdById: host.captainId,
      scheduledAt: new Date(Date.now() + opts.offsetMs),
      bestOf: opts.bestOf ?? 1,
      status: opts.status ?? SCRIM_STATUS.SCHEDULED,
      participants: { create: participants },
    },
  });
  return { season, host, away, scrim, accounts };
}

/** A finished game: `radiant` accounts win on Radiant against `dire`. */
function game(
  matchId: number,
  radiant: number[],
  dire: number[],
  startTimeMs: number,
): OpenDotaMatch {
  const side = (accounts: number[], radiantSide: boolean) => [
    ...accounts.map((account_id, i) => ({
      account_id,
      player_slot: (radiantSide ? 0 : 128) + i,
      hero_id: (radiantSide ? 1 : 20) + i,
      isRadiant: radiantSide,
      kills: 5,
      deaths: 1,
      assists: 3,
    })),
    ...Array.from({ length: 5 - accounts.length }, (_, i) => ({
      account_id: null,
      player_slot: (radiantSide ? 0 : 128) + accounts.length + i,
      hero_id: (radiantSide ? 40 : 60) + i,
      isRadiant: radiantSide,
      kills: 0,
      deaths: 0,
      assists: 0,
    })),
  ];
  return {
    match_id: matchId,
    radiant_win: true,
    duration: 2_000,
    start_time: Math.floor(startTimeMs / 1_000),
    radiant_score: 30,
    dire_score: 20,
    players: [...side(radiant, true), ...side(dire, false)],
  } as OpenDotaMatch;
}

function serveFeed(games: OpenDotaMatch[]) {
  mockLeague.mockResolvedValue(games.map((g) => g.match_id));
  mockMatch.mockImplementation(
    async (id: string) => games.find((g) => String(g.match_id) === id) ?? null,
  );
}

describe("ticketed scrim games record themselves from the league feed", () => {
  it("records a game on a night with no league match, with nobody pressing anything", async () => {
    const { season, host, scrim, accounts } = await bookedScrimNight({
      offsetMs: -HOUR,
    });
    const G = 9_100_000_001;
    serveFeed([game(G, accounts.host, accounts.away, Date.now() - 50 * 60_000)]);

    await runResultSync();

    expect(mockLeague).toHaveBeenCalledWith(TICKET, expect.anything());
    const recorded = await prisma.scrim.findUniqueOrThrow({
      where: { id: scrim.id },
      include: { games: true },
    });
    expect(recorded).toMatchObject({
      status: SCRIM_STATUS.COMPLETED,
      hostScore: 1,
      awayScore: 0,
      winnerTeamId: host.id,
    });
    expect(recorded.games.map((g) => g.dotaMatchId)).toEqual([String(G)]);
    // A scrim game: the global claim says so, and no league table sees it.
    expect(
      await prisma.dotaMatchClaim.findUnique({ where: { dotaMatchId: String(G) } }),
    ).toMatchObject({ kind: DOTA_MATCH_KIND.SCRIM, contextId: scrim.id });
    expect(await prisma.game.count()).toBe(0);
    // The evidence row says why the official path left it alone, without
    // counting as a feed game /admin reports as set aside.
    expect(
      await prisma.importCandidate.findUnique({
        where: {
          seasonId_dotaMatchId: { seasonId: season.id, dotaMatchId: String(G) },
        },
      }),
    ).toMatchObject({ status: "IGNORED", reason: SCRIM_CANDIDATE_REASON });
  });

  it("records a best-of-two's games in play order and ends the series", async () => {
    const { away, scrim, accounts } = await bookedScrimNight({
      offsetMs: -2 * HOUR,
      bestOf: 2,
    });
    const first = game(9_100_000_011, accounts.host, accounts.away, Date.now() - 100 * 60_000);
    // Game two: the away team on Radiant, and they win it.
    const second = game(9_100_000_012, accounts.away, accounts.host, Date.now() - 50 * 60_000);
    // The feed lists newest first.
    serveFeed([second, first]);

    await runResultSync();

    const recorded = await prisma.scrim.findUniqueOrThrow({
      where: { id: scrim.id },
      include: { games: { orderBy: { startTime: "asc" } } },
    });
    expect(recorded.games.map((g) => g.dotaMatchId)).toEqual([
      String(first.match_id),
      String(second.match_id),
    ]);
    expect(recorded.games[1]!.winnerTeamId).toBe(away.id);
    expect(recorded).toMatchObject({
      status: SCRIM_STATUS.COMPLETED,
      hostScore: 1,
      awayScore: 1,
      winnerTeamId: null,
    });
  });

  it("leaves the feed alone once a scrim's feed window has closed", async () => {
    const { accounts } = await bookedScrimNight({
      offsetMs: -SCRIM_FEED_CLOSES_AFTER_MS - HOUR,
    });
    serveFeed([game(9_100_000_021, accounts.host, accounts.away, Date.now() - 9 * HOUR)]);

    await runResultSync();

    expect(mockLeague).not.toHaveBeenCalled();
    expect(await prisma.scrimGame.count()).toBe(0);
  });

  it("never reads the feed for a scrim on a season without a ticket", async () => {
    await bookedScrimNight({ offsetMs: -HOUR, ticket: null });

    await runResultSync();

    expect(mockLeague).not.toHaveBeenCalled();
  });

  it("records nothing on a scrim that was cancelled", async () => {
    const { season, accounts } = await bookedScrimNight({
      offsetMs: -HOUR,
      status: SCRIM_STATUS.CANCELLED,
    });
    serveFeed([game(9_100_000_031, accounts.host, accounts.away, Date.now() - 50 * 60_000)]);

    // The night's league match keeps the feed due; the cancelled scrim
    // can't take the game.
    const result = await syncLeagueGames(season.id, { auto: true });
    expect(result.scrimCandidates).toBeUndefined();
    expect(await prisma.scrimGame.count()).toBe(0);
  });

  it("waits for a complete feed pass before recording a scrim's games", async () => {
    const { season, scrim, accounts } = await bookedScrimNight({
      offsetMs: -2 * HOUR,
      bestOf: 2,
    });
    const first = game(9_100_000_041, accounts.host, accounts.away, Date.now() - 100 * 60_000);
    const second = game(9_100_000_042, accounts.host, accounts.away, Date.now() - 50 * 60_000);
    mockLeague.mockResolvedValue([second.match_id, first.match_id]);
    // OpenDota doesn't have game one's details yet.
    mockMatch.mockImplementation(async (id: string) =>
      id === String(second.match_id) ? second : null,
    );

    const partial = await syncLeagueGames(season.id, { auto: true });
    expect(partial).toMatchObject({ pending: true });
    expect(partial.scrimCandidates).toBeUndefined();
    expect(await prisma.scrimGame.count({ where: { scrimId: scrim.id } })).toBe(0);

    // Once both games are there, both record, in play order.
    serveFeed([second, first]);
    await prisma.importCandidate.updateMany({
      where: { seasonId: season.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const complete = await syncLeagueGames(season.id, { auto: true });
    expect(complete.scrimCandidates).toHaveLength(2);
    const recorded = await recordScrimGamesFromFeed(
      season.id,
      complete.scrimCandidates!,
    );
    expect(recorded).toEqual({ imported: 2, scrimIds: [scrim.id] });
    const games = await prisma.scrimGame.findMany({
      where: { scrimId: scrim.id },
      orderBy: { startTime: "asc" },
    });
    expect(games.map((g) => g.dotaMatchId)).toEqual([
      String(first.match_id),
      String(second.match_id),
    ]);
  });

  it("gives a league match its own game, not the scrim booked the night before", async () => {
    const { season, host, away, scrim, accounts } = await bookedScrimNight({
      offsetMs: -20 * HOUR,
    });
    // Tonight's league fixture between the same two teams.
    const fixture = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: host.id,
        awayTeamId: away.id,
        bestOf: 1,
        scheduledAt: new Date(Date.now() - HOUR),
      },
    });
    const tonight = game(9_100_000_051, accounts.host, accounts.away, Date.now() - 50 * 60_000);
    serveFeed([tonight]);

    const result = await syncLeagueGames(season.id, { auto: true });

    expect(result.imported).toBe(1);
    expect(result.scrimCandidates).toBeUndefined();
    expect(await prisma.game.count({ where: { matchId: fixture.id } })).toBe(1);
    expect(await prisma.scrimGame.count({ where: { scrimId: scrim.id } })).toBe(0);
  });

  it("records nothing a second time once the game is in", async () => {
    const { scrim, accounts } = await bookedScrimNight({ offsetMs: -HOUR, bestOf: 3 });
    const G = 9_100_000_061;
    serveFeed([game(G, accounts.host, accounts.away, Date.now() - 50 * 60_000)]);

    await runResultSync();
    await prisma.setting.deleteMany({
      where: { key: SETTING_KEYS.LEAGUE_AUTO_SYNC_AT },
    });
    await runResultSync();

    expect(await prisma.scrimGame.count({ where: { scrimId: scrim.id } })).toBe(1);
    expect(
      await prisma.scrim.findUniqueOrThrow({ where: { id: scrim.id } }),
    ).toMatchObject({ status: SCRIM_STATUS.LIVE, hostScore: 1, awayScore: 0 });
  });
});
