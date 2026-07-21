import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  AUTO_SYNC,
  INHOUSE,
  INHOUSE_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import { steamIdToAccountId } from "@/lib/dota";
import { runResultSync } from "@/lib/result-sync-service";
import { SETTING_KEYS } from "@/lib/settings";
import { makeSeason, makeTeam, makeUser } from "./factories";

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
import {
  fetchLeagueMatchIds,
  fetchOpenDotaMatch,
  fetchRecentMatchIds,
} from "@/lib/dota";

// Keep the formatters real; stub the webhook lookup + the network send so the
// series announcement can be asserted on.
vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return {
    ...actual,
    getWebhookUrl: vi.fn(async () => "https://discord.test/hook"),
    sendDiscordMessage: vi.fn(async () => true),
  };
});
import { sendDiscordMessage } from "@/lib/discord";

const mockRecent = vi.mocked(fetchRecentMatchIds);
const mockMatch = vi.mocked(fetchOpenDotaMatch);
const mockLeague = vi.mocked(fetchLeagueMatchIds);
const mockSend = vi.mocked(sendDiscordMessage);

beforeEach(() => {
  mockRecent.mockReset();
  mockRecent.mockResolvedValue([]);
  mockMatch.mockReset();
  mockMatch.mockResolvedValue(null);
  mockLeague.mockReset();
  mockLeague.mockResolvedValue([]);
  mockSend.mockClear();
});

/** Series-result announcements only (honors etc. use different formatters). */
const seriesAnnouncements = () =>
  mockSend.mock.calls.map((c) => c[0]).filter((s) => s.startsWith("⚔️"));

/** Age a global throttle Setting so the next run can claim it again. */
const backdateThrottle = (key: string, agoMs: number) =>
  prisma.setting.update({
    where: { key },
    data: { value: new Date(Date.now() - agoMs).toISOString() },
  });

const HOUR = 3600_000;

/** Two rostered teams + one scheduled match, kickoff `offsetMs` from now. */
async function setupNight(opts: {
  offsetMs: number | null;
  status?: string;
  bestOf?: number;
}) {
  const season = await makeSeason({
    teamSize: 3,
    status: opts.status ?? SEASON_STATUS.REGULAR_SEASON,
  });
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);
  const homeAccts: number[] = [];
  const awayAccts: number[] = [];
  for (const [team, accts, tag] of [
    [home, homeAccts, "H"],
    [away, awayAccts, "A"],
  ] as const) {
    for (let i = 0; i < 3; i++) {
      const user = await makeUser(`Sync${tag}${i}`);
      await prisma.teamMember.create({
        data: {
          seasonId: season.id,
          teamId: team.id,
          userId: user.id,
          isCaptain: false,
          price: 0,
        },
      });
      accts.push(steamIdToAccountId(user.steamId)!);
    }
  }
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: home.id,
      awayTeamId: away.id,
      bestOf: opts.bestOf ?? 1,
      scheduledAt:
        opts.offsetMs === null ? null : new Date(Date.now() + opts.offsetMs),
    },
  });
  return { season, home, away, match, homeAccts, awayAccts };
}

/** An OpenDota game: home on Radiant (winning), away on Dire. */
function odGame(
  matchId: number,
  homeAccts: number[],
  awayAccts: number[],
  startTimeMs: number,
) {
  return {
    match_id: matchId,
    radiant_win: true,
    duration: 2000,
    start_time: Math.floor(startTimeMs / 1000),
    radiant_score: 30,
    dire_score: 20,
    players: [
      ...homeAccts.map((a, i) => ({
        account_id: a,
        player_slot: i,
        hero_id: i + 1,
        isRadiant: true,
        kills: 5,
        deaths: 1,
        assists: 3,
      })),
      ...awayAccts.map((a, i) => ({
        account_id: a,
        player_slot: 128 + i,
        hero_id: 10 + i,
        isRadiant: false,
        kills: 1,
        deaths: 5,
        assists: 2,
      })),
    ],
  };
}

describe("result sync — league matches (integration)", () => {
  it("imports a due match's game with no human input and announces it once", async () => {
    const { home, match, homeAccts, awayAccts } = await setupNight({
      offsetMs: -2 * HOUR,
    });
    const G = 8880001;
    mockRecent.mockResolvedValue([G]);
    mockMatch.mockResolvedValue(
      odGame(G, homeAccts, awayAccts, Date.now() - HOUR),
    );

    const out = await runResultSync();
    expect(out.imported).toBe(1);
    expect(out.watch).toBe(true);
    // The change cursor moved — this is what tells every OTHER parked client
    // (whose polls all lost the claim race) to refresh.
    expect(out.cursor).not.toBeNull();

    const m = await prisma.match.findUniqueOrThrow({
      where: { id: match.id },
      include: { games: true },
    });
    expect(m.status).toBe(MATCH_STATUS.COMPLETED);
    expect(m.winnerTeamId).toBe(home.id);
    expect(m.games).toHaveLength(1);
    expect(m.autoSyncedAt).not.toBeNull();
    expect(m.autoSyncAttempts).toBe(0); // productive scan resets the backoff

    // The result reached Discord exactly once, with the idempotency marker set.
    expect(seriesAnnouncements()).toHaveLength(1);
    expect(seriesAnnouncements()[0]).toContain("Home");
    expect(
      await prisma.setting.findUnique({
        where: { key: `resultAnnounced:${match.id}` },
      }),
    ).not.toBeNull();

    // The match is decided — the next ping goes idle and never rescans it,
    // and the cursor holds steady (no phantom refresh signals).
    mockRecent.mockClear();
    const again = await runResultSync();
    expect(again).toMatchObject({ imported: 0, inhouse: false, watch: false });
    expect(again.cursor).toBe(out.cursor);
    expect(mockRecent).not.toHaveBeenCalled();
  });

  it("a Bo3 keeps scanning across throttled runs until the series is decided", async () => {
    const { match, homeAccts, awayAccts } = await setupNight({
      offsetMs: -2 * HOUR,
      bestOf: 3,
    });
    const G1 = 9990001;
    const G2 = 9990002;
    const game1 = odGame(G1, homeAccts, awayAccts, Date.now() - 90 * 60_000);
    const game2 = odGame(G2, homeAccts, awayAccts, Date.now() - 30 * 60_000);

    // Run 1: only game 1 is on OpenDota yet — series goes LIVE at 1-0.
    mockRecent.mockResolvedValue([G1]);
    mockMatch.mockImplementation(async (id) =>
      id === String(G1) ? game1 : id === String(G2) ? game2 : null,
    );
    expect((await runResultSync()).imported).toBe(1);
    let m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.status).toBe(MATCH_STATUS.LIVE);
    expect(m.homeScore).toBe(1);
    expect(seriesAnnouncements()).toHaveLength(0); // not decided — quiet

    // Run 2, immediately: the per-match claim throttles the rescan.
    mockRecent.mockClear();
    const throttled = await runResultSync();
    expect(throttled.imported).toBe(0);
    expect(throttled.watch).toBe(true); // still in-window → keep polling fast
    expect(mockRecent).not.toHaveBeenCalled();

    // Interval passes (backdate the per-match claim AND the global scan gap);
    // game 2 has appeared: 2-0, done.
    await prisma.match.update({
      where: { id: match.id },
      data: { autoSyncedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await backdateThrottle(SETTING_KEYS.ROSTER_AUTO_SYNC_AT, 10 * 60_000);
    mockRecent.mockResolvedValue([G1, G2]);
    expect((await runResultSync()).imported).toBe(1);
    m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.status).toBe(MATCH_STATUS.COMPLETED);
    expect(m.homeScore).toBe(2);
    expect(m.awayScore).toBe(0);
    expect(seriesAnnouncements()).toHaveLength(1);
    expect(seriesAnnouncements()[0]).toContain("2–0");
  });

  it("stays quiet outside the window, off-phase, and for unscheduled matches", async () => {
    // Kickoff still ahead.
    await setupNight({ offsetMs: 2 * HOUR });
    expect(await runResultSync()).toEqual({
      imported: 0,
      inhouse: false,
      watch: false,
      cursor: null,
    });

    // Window long closed (3 days ago).
    await prisma.match.updateMany({
      data: { scheduledAt: new Date(Date.now() - 72 * HOUR) },
    });
    expect((await runResultSync()).watch).toBe(false);

    // Right phase of night, wrong phase of season.
    await prisma.season.updateMany({
      data: { status: SEASON_STATUS.SIGNUPS },
    });
    await prisma.match.updateMany({
      data: { scheduledAt: new Date(Date.now() - 2 * HOUR) },
    });
    expect((await runResultSync()).watch).toBe(false);

    // No kickoff time at all — nothing to window a scan around.
    await prisma.season.updateMany({
      data: { status: SEASON_STATUS.REGULAR_SEASON },
    });
    await prisma.match.updateMany({ data: { scheduledAt: null } });
    expect((await runResultSync()).watch).toBe(false);

    expect(mockRecent).not.toHaveBeenCalled();
    expect(mockMatch).not.toHaveBeenCalled();
  });

  it("concurrent pings race to one claim — the game imports exactly once", async () => {
    const { match, homeAccts, awayAccts } = await setupNight({
      offsetMs: -2 * HOUR,
    });
    const G = 8880777;
    mockRecent.mockResolvedValue([G]);
    mockMatch.mockResolvedValue(
      odGame(G, homeAccts, awayAccts, Date.now() - HOUR),
    );

    const [a, b] = await Promise.all([runResultSync(), runResultSync()]);
    expect(a.imported + b.imported).toBe(1);
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(1);
    expect(seriesAnnouncements()).toHaveLength(1);
  });

  it("backs off exponentially on empty scans and resets on a productive one", async () => {
    const { match, homeAccts, awayAccts } = await setupNight({
      offsetMs: -2 * HOUR,
      bestOf: 3,
    });

    // Nothing on OpenDota yet — the scan is empty and counts an attempt.
    expect((await runResultSync()).imported).toBe(0);
    let m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.autoSyncAttempts).toBe(1);

    // Stale by more than one base interval, but attempts=1 doubles the
    // required gap — the match must NOT be claimed again yet.
    await prisma.match.update({
      where: { id: match.id },
      data: {
        autoSyncedAt: new Date(
          Date.now() - (AUTO_SYNC.MATCH_INTERVAL_SECONDS + 60) * 1000,
        ),
      },
    });
    await backdateThrottle(SETTING_KEYS.ROSTER_AUTO_SYNC_AT, 10 * 60_000);
    mockRecent.mockClear();
    expect((await runResultSync()).imported).toBe(0);
    expect(mockRecent).not.toHaveBeenCalled();
    m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.autoSyncAttempts).toBe(1); // untouched — never claimed

    // Past the doubled interval it scans again; an import resets the backoff.
    await prisma.match.update({
      where: { id: match.id },
      data: {
        autoSyncedAt: new Date(
          Date.now() - (2 * AUTO_SYNC.MATCH_INTERVAL_SECONDS + 60) * 1000,
        ),
      },
    });
    await backdateThrottle(SETTING_KEYS.ROSTER_AUTO_SYNC_AT, 10 * 60_000);
    const G = 8881234;
    mockRecent.mockResolvedValue([G]);
    mockMatch.mockResolvedValue(
      odGame(G, homeAccts, awayAccts, Date.now() - HOUR),
    );
    expect((await runResultSync()).imported).toBe(1);
    m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.autoSyncAttempts).toBe(0);
  });

  it("league path never rewrites a COMPLETED match and remembers rejected ids", async () => {
    const { season, match, home, homeAccts, awayAccts } = await setupNight({
      offsetMs: -2 * HOUR,
      bestOf: 3,
    });
    // A second due fixture (between two OTHER teams, so nothing classifies
    // against it) keeps the season in its watch window throughout.
    const t3 = await makeTeam(season.id, "Third", 2);
    const t4 = await makeTeam(season.id, "Fourth", 3);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 2,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: t3.id,
        awayTeamId: t4.id,
        scheduledAt: new Date(Date.now() - HOUR),
      },
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "18181" },
    });

    // Game 1 imports normally; then the admin rules the series 2-0 (forfeit).
    const G1 = 5551001;
    const G2 = 5551002;
    const game1 = odGame(G1, homeAccts, awayAccts, Date.now() - 90 * 60_000);
    const game2 = odGame(G2, homeAccts, awayAccts, Date.now() - 30 * 60_000);
    mockLeague.mockResolvedValue([G1]);
    mockMatch.mockImplementation(async (id) =>
      id === String(G1) ? game1 : id === String(G2) ? game2 : null,
    );
    expect((await runResultSync()).imported).toBe(1);
    await prisma.match.update({
      where: { id: match.id },
      data: {
        status: MATCH_STATUS.COMPLETED,
        homeScore: 2,
        awayScore: 0,
        winnerTeamId: home.id,
      },
    });

    // The forfeited-but-played game 2 shows up in the league feed: the auto
    // sync must fetch it once, refuse it, and never touch the ruling.
    mockLeague.mockResolvedValue([G1, G2]);
    await backdateThrottle(SETTING_KEYS.LEAGUE_AUTO_SYNC_AT, 10 * 60_000);
    expect((await runResultSync()).imported).toBe(0);
    const m = await prisma.match.findUniqueOrThrow({
      where: { id: match.id },
      include: { games: true },
    });
    expect(m.status).toBe(MATCH_STATUS.COMPLETED);
    expect(m.homeScore).toBe(2);
    expect(m.winnerTeamId).toBe(home.id);
    expect(m.games).toHaveLength(1);

    // …and G2 is in skip memory now — the next run doesn't refetch it.
    mockMatch.mockClear();
    await backdateThrottle(SETTING_KEYS.LEAGUE_AUTO_SYNC_AT, 10 * 60_000);
    await runResultSync();
    expect(mockMatch).not.toHaveBeenCalled();
  });

  it("uses the cheap league-id path (globally throttled) when one is set", async () => {
    const { season, match, homeAccts, awayAccts } = await setupNight({
      offsetMs: -2 * HOUR,
    });
    // A second due fixture keeps the season "due" after the first completes.
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 2,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        scheduledAt: new Date(Date.now() - HOUR),
      },
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "17171" },
    });
    const G = 6660001;
    mockLeague.mockResolvedValue([G]);
    mockMatch.mockResolvedValue(
      odGame(G, homeAccts, awayAccts, Date.now() - 90 * 60_000),
    );

    const out = await runResultSync();
    expect(out.imported).toBe(1);
    expect(mockLeague).toHaveBeenCalledTimes(1);
    expect(mockRecent).not.toHaveBeenCalled(); // roster scan skipped entirely

    // Immediately again: the global Setting claim throttles the league call.
    const again = await runResultSync();
    expect(again.imported).toBe(0);
    expect(again.watch).toBe(true);
    expect(mockLeague).toHaveBeenCalledTimes(1);
  });
});

describe("result sync — inhouse (integration)", () => {
  /** Hand-build an IN_PROGRESS 5v5 lobby (team 1 = Radiant). */
  async function setupLobby(startedMinutesAgo: number) {
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.IN_PROGRESS,
        radiantTeam: 1,
        // The lobby predates its game — detection floors candidates at createdAt.
        createdAt: new Date(Date.now() - (startedMinutesAgo + 10) * 60_000),
        startedAt: new Date(Date.now() - startedMinutesAgo * 60_000),
      },
    });
    const team1: number[] = [];
    const team2: number[] = [];
    for (let i = 0; i < INHOUSE.LOBBY_SIZE; i++) {
      const user = await makeUser(`IH${i}`);
      const team = i < INHOUSE.TEAM_SIZE ? 1 : 2;
      await prisma.inhouseLobbyPlayer.create({
        data: {
          lobbyId: lobby.id,
          userId: user.id,
          team,
          isCaptain: i % INHOUSE.TEAM_SIZE === 0,
          mmr: 3000,
        },
      });
      (team === 1 ? team1 : team2).push(steamIdToAccountId(user.steamId)!);
    }
    return { lobby, team1, team2 };
  }

  it("closes a finished inhouse game from any page view — no room open", async () => {
    const { lobby, team1, team2 } = await setupLobby(
      INHOUSE.DETECT_MIN_MINUTES + 5,
    );
    const G = 7770123;
    mockRecent.mockResolvedValue([G]);
    mockMatch.mockResolvedValue(
      odGame(G, team1, team2, Date.now() - 5 * 60_000),
    );

    const out = await runResultSync();
    expect(out.inhouse).toBe(true);
    expect(out.watch).toBe(false); // lobby closed, nothing left to watch
    expect(out.cursor).not.toBeNull(); // parked clients everywhere repaint

    const done = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(done.status).toBe(INHOUSE_STATUS.COMPLETED);
    expect(done.winnerTeam).toBe(1); // team 1 was Radiant, radiant_win
    expect(done.boxScore).not.toBeNull();
  });

  it("waits out the minimum game length but keeps watching a live lobby", async () => {
    await setupLobby(2); // just started — can't be over
    mockRecent.mockResolvedValue([7770456]);

    const out = await runResultSync();
    expect(out.inhouse).toBe(false);
    expect(out.watch).toBe(true); // live lobby → fast client polling
    expect(mockRecent).not.toHaveBeenCalled();
  });
});
