import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE } from "@/lib/constants";
import { steamIdToAccountId } from "@/lib/dota";
import {
  reportAutoDetect,
  reportImportGame,
} from "@/lib/match-report-service";
import { makeSeason, makeTeam, makeUser } from "./factories";

// Keep the real module (steamIdToAccountId, parseMatchId) but stub the network.
vi.mock("@/lib/dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota")>();
  return {
    ...actual,
    fetchOpenDotaMatch: vi.fn(),
    fetchRecentMatchIds: vi.fn(async () => [] as number[]),
  };
});
import { fetchOpenDotaMatch } from "@/lib/dota";

afterEach(() => vi.mocked(fetchOpenDotaMatch).mockReset());

/** Two rostered teams + a scheduled match; returns accounts for OD fixtures. */
async function setupMatch() {
  const season = await makeSeason({ teamSize: 3 });
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
    },
  });
  return { season, home, away, match, homeAccts, awayAccts };
}

function odGame(matchId: number, homeAccts: number[], awayAccts: number[]) {
  return {
    match_id: matchId,
    radiant_win: true,
    duration: 2000,
    start_time: 1,
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

  it("surfaces invalid references and non-matching games as errors", async () => {
    const { home, match, homeAccts, awayAccts } = await setupMatch();
    const bad = await reportImportGame(home.captainId, match.id, "not-a-ref");
    expect(bad).toEqual({ ok: false, error: expect.stringMatching(/valid match id/) });

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
