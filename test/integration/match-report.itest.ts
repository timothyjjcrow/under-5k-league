import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, SEASON_STATUS } from "@/lib/constants";
import { steamIdToAccountId } from "@/lib/dota";
import { reportAutoDetect, reportImportGame } from "@/lib/match-report-service";
import { providerCooldownKey } from "@/lib/settings";
import { makeSeason, makeTeam, makeUser, raceAll } from "./factories";

// Keep the real module (steamIdToAccountId, parseMatchId) but stub the network.
vi.mock("@/lib/dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota")>();
  return {
    ...actual,
    fetchOpenDotaMatch: vi.fn(),
    fetchRecentMatchIds: vi.fn(async () => [] as number[]),
  };
});
import { fetchOpenDotaMatch, fetchRecentMatchIds } from "@/lib/dota";

afterEach(() => {
  vi.mocked(fetchOpenDotaMatch).mockReset();
  vi.mocked(fetchRecentMatchIds).mockReset();
});

const CAPTAIN_KICKOFF = new Date("2026-08-06T02:00:00.000Z");
const CAPTAIN_GAME_START =
  Math.floor(CAPTAIN_KICKOFF.getTime() / 1000) + 15 * 60;

/** Two rostered teams + a scheduled match; returns accounts for OD fixtures. */
async function setupMatch() {
  const season = await makeSeason({
    teamSize: 3,
    status: SEASON_STATUS.REGULAR_SEASON,
  });
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);
  const homeAccts: number[] = [];
  const awayAccts: number[] = [];
  for (let i = 0; i < 3; i++) {
    const user = await makeUser(`RH${i}`);
    await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: home.id,
        userId: user.id,
        isCaptain: false,
        price: 0,
      },
    });
    homeAccts.push(steamIdToAccountId(user.steamId)!);
  }
  for (let i = 0; i < 3; i++) {
    const user = await makeUser(`RA${i}`);
    await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: away.id,
        userId: user.id,
        isCaptain: false,
        price: 0,
      },
    });
    awayAccts.push(steamIdToAccountId(user.steamId)!);
  }
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: home.id,
      awayTeamId: away.id,
      scheduledAt: CAPTAIN_KICKOFF,
    },
  });
  return { season, home, away, match, homeAccts, awayAccts };
}

function odGame(
  matchId: number,
  homeAccts: number[],
  awayAccts: number[],
  startTime = CAPTAIN_GAME_START,
) {
  return {
    match_id: matchId,
    radiant_win: true,
    duration: 2000,
    start_time: startTime,
    radiant_score: 30,
    dire_score: 20,
    players: [
      ...homeAccts.map((a, i) => ({
        account_id: a,
        player_slot: i,
        hero_id: 1,
        isRadiant: true,
        kills: 1,
        deaths: 0,
        assists: 0,
      })),
      ...awayAccts.map((a, i) => ({
        account_id: a,
        player_slot: 128 + i,
        hero_id: 2,
        isRadiant: false,
        kills: 0,
        deaths: 1,
        assists: 0,
      })),
    ],
  };
}

describe("match-report service (integration)", () => {
  it("rejects non-captains and never touches the match", async () => {
    const { match } = await setupMatch();
    const rando = await makeUser("ReportRando");
    await expect(
      reportImportGame(rando.id, match.id, "5550001"),
    ).rejects.toThrow(/two captains/);
    await expect(reportAutoDetect(rando.id, match.id)).rejects.toThrow(
      /two captains/,
    );
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(0);
  });

  it("rejects reporting on a COMPLETED match", async () => {
    const { home, match } = await setupMatch();
    await prisma.match.update({
      where: { id: match.id },
      data: { status: "COMPLETED", homeScore: 2, awayScore: 0 },
    });
    await expect(
      reportImportGame(home.captainId, match.id, "5550001"),
    ).rejects.toThrow(/already recorded/);
  });

  it("a captain imports the finished game — result + series roll up", async () => {
    const { home, away, match, homeAccts, awayAccts } = await setupMatch();
    vi.mocked(fetchOpenDotaMatch).mockResolvedValue(
      odGame(5550001, homeAccts, awayAccts),
    );

    // Either captain works — use the away one to prove it's not home-only.
    const res = await reportImportGame(away.captainId, match.id, "5550001");
    expect(res).toEqual({ ok: true, message: expect.any(String) });

    const m = await prisma.match.findUniqueOrThrow({
      where: { id: match.id },
      include: { games: true },
    });
    expect(m.games).toHaveLength(1);
    expect(m.winnerTeamId).toBe(home.id); // home = radiant, radiant won
    expect(m.status).toBe("COMPLETED");

    // A second report on the now-finished match is refused by the guard.
    await expect(
      reportImportGame(home.captainId, match.id, "5550001"),
    ).rejects.toThrow(/already recorded/);
  });

  it("elects one exact-ID lookup when a captain races different IDs", async () => {
    const { home, match } = await setupMatch();
    vi.mocked(fetchOpenDotaMatch).mockResolvedValue(null);

    const results = await raceAll([
      () => reportImportGame(home.captainId, match.id, "5550010"),
      () => reportImportGame(home.captainId, match.id, "5550011"),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: false,
          error: expect.stringMatching(/could(?:n't| not) fetch/i),
        }),
        expect.objectContaining({
          ok: false,
          error: expect.stringMatching(/wait about a minute/i),
        }),
      ]),
    );
    // The submitted ID is deliberately not part of the claim key: changing it
    // cannot fan out provider work across tabs or serverless instances.
    expect(vi.mocked(fetchOpenDotaMatch)).toHaveBeenCalledTimes(1);
    expect(
      await prisma.setting.findUnique({
        where: {
          key: providerCooldownKey(
            "open-dota-match-import",
            home.captainId,
            `fixture:${match.id}`,
          ),
        },
      }),
    ).not.toBeNull();
  });

  it("refuses the old captain when captaincy changes during the OpenDota fetch", async () => {
    const { home, match, homeAccts, awayAccts } = await setupMatch();
    let markFetchStarted!: () => void;
    let releaseFetch!: (game: ReturnType<typeof odGame>) => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.mocked(fetchOpenDotaMatch).mockImplementation(async () => {
      markFetchStarted();
      return new Promise<ReturnType<typeof odGame>>((resolve) => {
        releaseFetch = resolve;
      });
    });

    const pending = reportImportGame(home.captainId, match.id, "5550002");
    await fetchStarted;

    const replacement = await makeUser("ReplacementCaptain");
    await prisma.team.update({
      where: { id: home.id },
      data: { captainId: replacement.id },
    });
    releaseFetch(odGame(5550002, homeAccts, awayAccts));

    await expect(pending).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/no longer captain/i),
    });
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(0);
  });

  it("refuses a captain-entered game outside the fixture result window", async () => {
    const { home, match, homeAccts, awayAccts } = await setupMatch();
    const sevenDaysAfterKickoff =
      Math.floor(CAPTAIN_KICKOFF.getTime() / 1000) + 7 * 24 * 60 * 60;
    vi.mocked(fetchOpenDotaMatch).mockResolvedValue(
      odGame(5550003, homeAccts, awayAccts, sevenDaysAfterKickoff),
    );

    await expect(
      reportImportGame(home.captainId, match.id, "5550003"),
    ).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/outside this fixture's result window/i),
    });
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(0);
  });

  it("refuses a captain-entered game claimed by a closer same-team fixture", async () => {
    const { season, home, away, match, homeAccts, awayAccts } =
      await setupMatch();
    const rematchKickoff = new Date(
      CAPTAIN_KICKOFF.getTime() + 2 * 24 * 60 * 60 * 1000,
    );
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 2,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: away.id,
        awayTeamId: home.id,
        scheduledAt: rematchKickoff,
      },
    });
    vi.mocked(fetchOpenDotaMatch).mockResolvedValue(
      odGame(
        5550004,
        homeAccts,
        awayAccts,
        Math.floor(rematchKickoff.getTime() / 1000) + 10 * 60,
      ),
    );

    await expect(
      reportImportGame(home.captainId, match.id, "5550004"),
    ).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/closer to another meeting/i),
    });
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(0);
  });

  it("reports an off-phase auto-detect before any OpenDota roster call", async () => {
    const { season, home, match } = await setupMatch();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.PLAYOFFS },
    });

    await expect(reportAutoDetect(home.captainId, match.id)).rejects.toThrow(
      /results are locked/i,
    );
    expect(vi.mocked(fetchRecentMatchIds)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchOpenDotaMatch)).not.toHaveBeenCalled();

    // The invalid phase must not consume the legitimate captain's allowance.
    const key = providerCooldownKey(
      "open-dota-match-scan",
      home.captainId,
      match.id,
    );
    expect(await prisma.setting.findUnique({ where: { key } })).toBeNull();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.REGULAR_SEASON },
    });
    vi.mocked(fetchRecentMatchIds).mockResolvedValue([]);
    await expect(reportAutoDetect(home.captainId, match.id)).resolves.toEqual({
      ok: true,
      message: expect.stringMatching(/no matching games/i),
    });
    expect(vi.mocked(fetchRecentMatchIds)).toHaveBeenCalled();
  });

  it("elects one roster scan across concurrent tabs and server instances", async () => {
    const { home, match } = await setupMatch();
    vi.mocked(fetchRecentMatchIds).mockResolvedValue([]);

    const results = await raceAll([
      () => reportAutoDetect(home.captainId, match.id),
      () => reportAutoDetect(home.captainId, match.id),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          message: expect.stringMatching(/no matching games/i),
        }),
        expect.objectContaining({
          ok: false,
          error: expect.stringMatching(/three minutes/i),
        }),
      ]),
    );
    // Six roster accounts, once. The losing caller performs no provider work.
    expect(vi.mocked(fetchRecentMatchIds)).toHaveBeenCalledTimes(6);
    expect(vi.mocked(fetchOpenDotaMatch)).not.toHaveBeenCalled();
  });

  it("reports an unreachable OpenDota roster scan as an error", async () => {
    const { home, match } = await setupMatch();
    vi.mocked(fetchRecentMatchIds).mockResolvedValue(null);

    await expect(reportAutoDetect(home.captainId, match.id)).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/couldn't reach OpenDota/i),
    });
    expect(vi.mocked(fetchRecentMatchIds)).toHaveBeenCalled();
    expect(vi.mocked(fetchOpenDotaMatch)).not.toHaveBeenCalled();
  });

  it("surfaces invalid references and non-matching games as errors", async () => {
    const { home, match, homeAccts, awayAccts } = await setupMatch();
    const bad = await reportImportGame(home.captainId, match.id, "not-a-ref");
    expect(bad).toEqual({
      ok: false,
      error: expect.stringMatching(/valid match id/),
    });
    expect(
      await prisma.setting.findUnique({
        where: {
          key: providerCooldownKey(
            "open-dota-match-import",
            home.captainId,
            `fixture:${match.id}`,
          ),
        },
      }),
    ).toBeNull();

    // A real fetch that isn't these two teams gets refused by classifyGame.
    const strangers = [991111, 992222, 993333];
    vi.mocked(fetchOpenDotaMatch).mockResolvedValue(
      odGame(7770001, strangers, awayAccts),
    );
    const wrong = await reportImportGame(home.captainId, match.id, "7770001");
    expect(wrong.ok).toBe(false);
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(0);
    void homeAccts;
  });
});

describe("captain reporting — archived seasons are admin-only", () => {
  it("refuses a captain import once the match's season is archived", async () => {
    // An import here still runs recomputeSeries → the bracket and every
    // cross-season board, silently rewriting a finished season's history.
    // Amending archives is deliberate admin work (/admin's import controls).
    const { season, home, match } = await setupMatch();
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });
    await expect(
      reportImportGame(home.captainId, match.id, "8123456789"),
    ).rejects.toThrow(/archived season/i);
    await expect(reportAutoDetect(home.captainId, match.id)).rejects.toThrow(
      /archived season/i,
    );
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(0);
  });
});
