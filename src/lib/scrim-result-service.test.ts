import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenDotaMatch, OpenDotaPlayer } from "./dota";

const mocks = vi.hoisted(() => ({
  scrimFindUnique: vi.fn(),
  scrimFindMany: vi.fn(),
  scrimUpdate: vi.fn(),
  matchFindMany: vi.fn(),
  teamStaffFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  claimFindUnique: vi.fn(),
  claimFindMany: vi.fn(),
  claimCreate: vi.fn(),
  gameFindUnique: vi.fn(),
  gameFindMany: vi.fn(),
  scrimGameFindUnique: vi.fn(),
  scrimGameFindMany: vi.fn(),
  scrimGameCreate: vi.fn(),
  transaction: vi.fn(),
  fetchOpenDotaMatch: vi.fn(),
  fetchRecentMatchIds: vi.fn(),
  claimProviderCooldown: vi.fn(),
}));

function databaseMock() {
  return {
    scrim: {
      findUnique: mocks.scrimFindUnique,
      findMany: mocks.scrimFindMany,
      update: mocks.scrimUpdate,
    },
    match: { findMany: mocks.matchFindMany },
    teamStaff: { findFirst: mocks.teamStaffFindFirst },
    user: { findUnique: mocks.userFindUnique },
    dotaMatchClaim: {
      findUnique: mocks.claimFindUnique,
      findMany: mocks.claimFindMany,
      create: mocks.claimCreate,
    },
    game: {
      findUnique: mocks.gameFindUnique,
      findMany: mocks.gameFindMany,
    },
    scrimGame: {
      findUnique: mocks.scrimGameFindUnique,
      findMany: mocks.scrimGameFindMany,
      create: mocks.scrimGameCreate,
    },
  };
}

vi.mock("./prisma", () => ({
  prisma: { ...databaseMock(), $transaction: mocks.transaction },
}));

vi.mock("./dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dota")>();
  return {
    ...actual,
    fetchOpenDotaMatch: mocks.fetchOpenDotaMatch,
    fetchRecentMatchIds: mocks.fetchRecentMatchIds,
  };
});

vi.mock("./settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settings")>();
  return { ...actual, claimProviderCooldown: mocks.claimProviderCooldown };
});

import { SCRIM_STATUS } from "./constants";
import {
  SCRIM_DETECT_WINDOW_AFTER_MS,
  SCRIM_DETECT_WINDOW_BEFORE_MS,
  buildScrimIdentitySnapshot,
  importScrimGame,
  isWithinScrimResultWindow,
  selectCommonRecentMatchIds,
} from "./scrim-result-service";

const kickoff = new Date("2026-08-18T03:00:00.000Z");

function participant(
  teamId: string,
  dotaAccountId: number,
  options: { guest?: boolean; userId?: string | null; minutes?: number } = {},
) {
  return {
    teamId,
    dotaAccountId,
    displayName: `Player ${dotaAccountId}`,
    guest: options.guest ?? false,
    userId:
      options.userId === undefined ? `user-${dotaAccountId}` : options.userId,
    createdAt: new Date(kickoff.getTime() + (options.minutes ?? 0) * 60_000),
  };
}

function scrim(overrides: Record<string, unknown> = {}) {
  return {
    id: "scrim-1",
    seasonId: "season-1",
    hostTeamId: "host",
    opponentTeamId: "away",
    scheduledAt: kickoff,
    bestOf: 1,
    status: SCRIM_STATUS.SCHEDULED,
    hostScore: 0,
    awayScore: 0,
    winnerTeamId: null,
    season: { isActive: true, status: "REGULAR_SEASON" },
    hostTeam: { captainId: "captain-host" },
    opponentTeam: { captainId: "captain-away" },
    participants: [
      participant("host", 1),
      participant("host", 2),
      participant("host", 3),
      participant("away", 6),
      participant("away", 7),
      participant("away", 8),
    ],
    games: [],
    ...overrides,
  };
}

function player(accountId: number, radiant: boolean): OpenDotaPlayer {
  return {
    account_id: accountId,
    player_slot: radiant ? 0 : 128,
    isRadiant: radiant,
    hero_id: accountId,
    kills: 1,
    deaths: 2,
    assists: 3,
  };
}

function dotaMatch(): OpenDotaMatch {
  return {
    match_id: 8_123_456_789,
    radiant_win: true,
    duration: 2400,
    start_time: Math.floor((kickoff.getTime() + 60 * 60_000) / 1000),
    radiant_score: 30,
    dire_score: 20,
    players: [
      player(1, true),
      player(2, true),
      player(3, true),
      player(99, true),
      player(100, true),
      player(6, false),
      player(7, false),
      player(8, false),
      player(101, false),
      player(102, false),
    ],
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.scrimFindUnique.mockResolvedValue(scrim());
  mocks.scrimFindMany.mockResolvedValue([]);
  mocks.scrimUpdate.mockResolvedValue({});
  mocks.matchFindMany.mockResolvedValue([]);
  mocks.teamStaffFindFirst.mockResolvedValue(null);
  mocks.userFindUnique.mockResolvedValue({ role: "USER" });
  mocks.claimFindUnique.mockResolvedValue(null);
  mocks.claimFindMany.mockResolvedValue([]);
  mocks.claimCreate.mockResolvedValue({});
  mocks.gameFindUnique.mockResolvedValue(null);
  mocks.gameFindMany.mockResolvedValue([]);
  mocks.scrimGameFindUnique.mockResolvedValue(null);
  mocks.scrimGameFindMany.mockResolvedValue([]);
  mocks.scrimGameCreate.mockResolvedValue({});
  mocks.fetchOpenDotaMatch.mockResolvedValue(dotaMatch());
  mocks.fetchRecentMatchIds.mockResolvedValue([]);
  mocks.claimProviderCooldown.mockResolvedValue("claimed");
  mocks.transaction.mockImplementation(async (callback) =>
    callback(databaseMock()),
  );
});

describe("scrim result discovery helpers", () => {
  it("counts roster snapshots and account-only guests while keeping guests off user profiles", () => {
    const rows = [
      participant("host", 1),
      participant("host", 2),
      participant("host", 3, { guest: true, userId: null, minutes: 5 }),
      participant("away", 6),
      participant("away", 7),
      participant("away", 8),
    ];
    const identity = buildScrimIdentitySnapshot(rows, "host", "away");

    expect(identity.hostSet).toEqual(new Set([1, 2, 3]));
    expect(identity.awaySet).toEqual(new Set([6, 7, 8]));
    expect(identity.scanHostIds).toContain(3);
    expect(identity.registeredAccountMap.has(3)).toBe(false);
    expect(identity.participantByAccount.get(3)?.teamId).toBe("host");
  });

  it("only returns match IDs present in histories from both teams", () => {
    expect(
      selectCommonRecentMatchIds(
        [
          { teamId: "host", accountId: 1, matchIds: [10, 20, 20] },
          { teamId: "host", accountId: 2, matchIds: [10, 30] },
          { teamId: "away", accountId: 6, matchIds: [10, 20, 40] },
          { teamId: "away", accountId: 7, matchIds: [10, 40] },
        ],
        "host",
        "away",
      ),
    ).toEqual([10, 20]);
  });

  it("enforces the inclusive -12h/+36h kickoff window", () => {
    const scheduled = kickoff.getTime();
    expect(
      isWithinScrimResultWindow(
        (scheduled - SCRIM_DETECT_WINDOW_BEFORE_MS) / 1000,
        scheduled,
      ),
    ).toBe(true);
    expect(
      isWithinScrimResultWindow(
        (scheduled + SCRIM_DETECT_WINDOW_AFTER_MS) / 1000,
        scheduled,
      ),
    ).toBe(true);
    expect(
      isWithinScrimResultWindow(
        (scheduled - SCRIM_DETECT_WINDOW_BEFORE_MS - 1000) / 1000,
        scheduled,
      ),
    ).toBe(false);
  });
});

describe("manual scrim game import", () => {
  it("atomically claims the match, stores separate scrim stats, and finalizes its own score", async () => {
    const guestScrim = scrim({
      participants: [
        participant("host", 1),
        participant("host", 2),
        participant("host", 3, { guest: true, userId: null }),
        participant("away", 6),
        participant("away", 7),
        participant("away", 8),
      ],
    });
    mocks.scrimFindUnique.mockResolvedValue(guestScrim);

    const result = await importScrimGame(
      { id: "captain-host", role: "USER" },
      "scrim-1",
      "https://www.opendota.com/matches/8123456789",
    );

    expect(result).toMatchObject({
      ok: true,
      imported: 1,
      hostScore: 1,
      awayScore: 0,
      winnerTeamId: "host",
      status: SCRIM_STATUS.COMPLETED,
    });
    expect(mocks.claimCreate).toHaveBeenCalledWith({
      data: {
        dotaMatchId: "8123456789",
        kind: "SCRIM",
        contextId: "scrim-1",
      },
    });
    expect(mocks.scrimGameCreate).toHaveBeenCalledOnce();
    const savedPlayers = JSON.parse(
      mocks.scrimGameCreate.mock.calls[0][0].data.players,
    );
    expect(
      savedPlayers.find((row: { accountId: number }) => row.accountId === 3),
    ).toMatchObject({
      userId: null,
      teamId: "host",
    });
    expect(
      savedPlayers.find((row: { accountId: number }) => row.accountId === 99),
    ).toMatchObject({
      userId: null,
      teamId: null,
    });
    expect(mocks.scrimUpdate).toHaveBeenCalledWith({
      where: { id: "scrim-1" },
      data: {
        hostScore: 1,
        awayScore: 0,
        winnerTeamId: "host",
        status: SCRIM_STATUS.COMPLETED,
      },
    });
  });

  it("re-checks captain or coach authority after the OpenDota fetch", async () => {
    mocks.scrimFindUnique.mockResolvedValueOnce(scrim()).mockResolvedValueOnce(
      scrim({
        hostTeam: { captainId: "new-host-captain" },
        opponentTeam: { captainId: "captain-away" },
      }),
    );

    const result = await importScrimGame(
      { id: "captain-host", role: "USER" },
      "scrim-1",
      "8123456789",
    );

    expect(result).toEqual({
      ok: false,
      error: "You no longer captain or coach either team in this scrim",
    });
    expect(mocks.claimCreate).not.toHaveBeenCalled();
    expect(mocks.scrimGameCreate).not.toHaveBeenCalled();
  });

  it("rejects a legacy official Game row before spending an OpenDota call", async () => {
    mocks.gameFindUnique.mockResolvedValue({
      dotaMatchId: "8123456789",
      matchId: "league-match-1",
    });

    const result = await importScrimGame(
      { id: "captain-host", role: "USER" },
      "scrim-1",
      "8123456789",
    );

    expect(result).toEqual({
      ok: false,
      error: "That game is already recorded as an official league game",
    });
    expect(mocks.fetchOpenDotaMatch).not.toHaveBeenCalled();
    expect(mocks.claimProviderCooldown).not.toHaveBeenCalled();
  });

  it("refuses a game closer to an official meeting between the same teams", async () => {
    const game = dotaMatch();
    game.start_time = Math.floor((kickoff.getTime() + 90 * 60_000) / 1000);
    mocks.fetchOpenDotaMatch.mockResolvedValue(game);
    mocks.matchFindMany.mockResolvedValue([
      { scheduledAt: new Date(kickoff.getTime() + 60 * 60_000) },
    ]);

    const result = await importScrimGame(
      { id: "captain-host", role: "USER" },
      "scrim-1",
      "8123456789",
    );

    expect(result).toMatchObject({ ok: false });
    if (!result.ok)
      expect(result.error).toMatch(
        /closer to another scrim or official match/i,
      );
    expect(mocks.claimCreate).not.toHaveBeenCalled();
  });

  it("ignores a closer scrim that is one second outside its own result window", async () => {
    const game = dotaMatch();
    game.start_time = Math.floor(
      (kickoff.getTime() + SCRIM_DETECT_WINDOW_AFTER_MS) / 1000,
    );
    mocks.fetchOpenDotaMatch.mockResolvedValue(game);
    mocks.scrimFindMany.mockResolvedValue([
      {
        scheduledAt: new Date(
          game.start_time * 1000 + SCRIM_DETECT_WINDOW_BEFORE_MS + 1000,
        ),
      },
    ]);

    const result = await importScrimGame(
      { id: "captain-host", role: "USER" },
      "scrim-1",
      "8123456789",
    );

    expect(result).toMatchObject({ ok: true, imported: 1 });
    expect(mocks.claimCreate).toHaveBeenCalledOnce();
  });

  it("still refuses a closer scrim at the inclusive before-window boundary", async () => {
    const game = dotaMatch();
    game.start_time = Math.floor(
      (kickoff.getTime() + SCRIM_DETECT_WINDOW_AFTER_MS) / 1000,
    );
    mocks.fetchOpenDotaMatch.mockResolvedValue(game);
    mocks.scrimFindMany.mockResolvedValue([
      {
        scheduledAt: new Date(
          game.start_time * 1000 + SCRIM_DETECT_WINDOW_BEFORE_MS,
        ),
      },
    ]);

    const result = await importScrimGame(
      { id: "captain-host", role: "USER" },
      "scrim-1",
      "8123456789",
    );

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toMatch(
        /closer to another scrim or official match/i,
      );
    }
    expect(mocks.claimCreate).not.toHaveBeenCalled();
  });
});
