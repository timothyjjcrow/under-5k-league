import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import {
  AUTO_SYNC,
  DEFAULTS,
  DRAFT_STATUS,
  INHOUSE,
  INHOUSE_ACTIVE_STATUSES,
  INHOUSE_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  ROLE,
  SCRIM_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import { steamIdToAccountId } from "@/lib/dota";
import { runResultSync } from "@/lib/result-sync-service";
import { nominatePlayer } from "@/lib/draft-service";
import { importGameForMatch, loadImportSkips, rememberImportSkip, syncLeagueGames } from "@/lib/match-import";
import { importScrimGame } from "@/lib/scrim-result-service";
import { SETTING_KEYS, weekReminderKey } from "@/lib/settings";
import {
  expireImportCandidates,
  IMPORT_CANDIDATE_MAX_ATTEMPTS,
  recordImportDecision,
  recordImportFetchFailure,
  saveImportEvidence,
} from "@/lib/import-candidates";
import {
  claimAnnouncementMarker,
  markAnnouncementSent,
} from "@/lib/announcement-marker";
import {
  expireClock,
  expireNominationClock,
  makeCaptain,
  makePlayer,
  makeSeason,
  makeTeam,
  makeUser,
  ON_POSTGRES,
  sessionFor,
  startDraftState,
} from "./factories";

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
    sendInhouseDiscordMessage: vi.fn(async () => true),
    deliverPendingLeagueAnnouncements: vi.fn(async () => ({
      attempted: 0,
      delivered: 0,
      pending: false,
    })),
  };
});
import {
  deliverPendingLeagueAnnouncements,
  sendDiscordMessage,
  sendInhouseDiscordMessage,
} from "@/lib/discord";
import {
  INHOUSE_ANNOUNCEMENT_KIND,
  INHOUSE_ANNOUNCEMENT_STATUS,
} from "@/lib/inhouse-announcement-outbox";

const mockRecent = vi.mocked(fetchRecentMatchIds);
const mockMatch = vi.mocked(fetchOpenDotaMatch);
const mockLeague = vi.mocked(fetchLeagueMatchIds);
const mockSend = vi.mocked(sendDiscordMessage);
const mockInhouseSend = vi.mocked(sendInhouseDiscordMessage);
const mockLeagueDrain = vi.mocked(deliverPendingLeagueAnnouncements);

beforeEach(() => {
  mockRecent.mockReset();
  mockRecent.mockResolvedValue([]);
  mockMatch.mockReset();
  mockMatch.mockResolvedValue(null);
  mockLeague.mockReset();
  mockLeague.mockResolvedValue([]);
  mockSend.mockClear();
  mockInhouseSend.mockReset();
  mockInhouseSend.mockResolvedValue(true);
  mockLeagueDrain.mockReset();
  mockLeagueDrain.mockResolvedValue({
    attempted: 0,
    delivered: 0,
    pending: false,
  });
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
  const radiantFillers = Array.from(
    { length: Math.max(0, 5 - homeAccts.length) },
    (_, i) => ({
      account_id: null,
      player_slot: homeAccts.length + i,
      hero_id: 100 + i,
      isRadiant: true,
      kills: 0,
      deaths: 0,
      assists: 0,
    }),
  );
  const direFillers = Array.from(
    { length: Math.max(0, 5 - awayAccts.length) },
    (_, i) => ({
      account_id: null,
      player_slot: 128 + awayAccts.length + i,
      hero_id: 110 + i,
      isRadiant: false,
      kills: 0,
      deaths: 0,
      assists: 0,
    }),
  );
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
      ...radiantFillers,
      ...direFillers,
    ],
  };
}

async function makeBookedScrim(opts: {
  seasonId: string;
  hostTeamId: string;
  awayTeamId: string;
  createdById: string;
  scheduledAt: Date;
  hostAccts: number[];
  awayAccts: number[];
}) {
  return prisma.scrim.create({
    data: {
      seasonId: opts.seasonId,
      hostTeamId: opts.hostTeamId,
      opponentTeamId: opts.awayTeamId,
      createdById: opts.createdById,
      scheduledAt: opts.scheduledAt,
      bestOf: 1,
      status: SCRIM_STATUS.SCHEDULED,
      participants: {
        create: [
          ...opts.hostAccts.map((dotaAccountId, index) => ({
            teamId: opts.hostTeamId,
            dotaAccountId,
            displayName: `Scrim host ${index + 1}`,
            guest: true,
            addedById: opts.createdById,
          })),
          ...opts.awayAccts.map((dotaAccountId, index) => ({
            teamId: opts.awayTeamId,
            dotaAccountId,
            displayName: `Scrim away ${index + 1}`,
            guest: true,
            addedById: opts.createdById,
          })),
        ],
      },
    },
  });
}

describe("result sync — league matches (integration)", () => {
  it("does not start work after the automation deadline", async () => {
    const out = await runResultSync({ deadlineMs: Date.now() - 1 });

    expect(out).toEqual({
      imported: 0,
      inhouse: false,
      draft: false,
      playoff: false,
      watch: false,
      cursor: null,
      issues: [],
      skipped: [
        "LEAGUE_BUDGET_EXHAUSTED",
        "INHOUSE_BUDGET_EXHAUSTED",
        "DRAFT_BUDGET_EXHAUSTED",
        "TIEBREAKER_BUDGET_EXHAUSTED",
        "PLAYOFF_BUDGET_EXHAUSTED",
        "REMINDER_BUDGET_EXHAUSTED",
        "NOTIFICATIONS_BUDGET_EXHAUSTED",
        "CURSOR_BUDGET_EXHAUSTED",
      ],
    });
    expect(mockRecent).not.toHaveBeenCalled();
    expect(mockMatch).not.toHaveBeenCalled();
    expect(mockLeague).not.toHaveBeenCalled();
    expect(mockLeagueDrain).not.toHaveBeenCalled();
  });

  it("bounds the durable league drain and reports a rejected transport", async () => {
    mockLeagueDrain.mockResolvedValue({
      attempted: 1,
      delivered: 0,
      pending: true,
    });

    const out = await runResultSync();

    expect(mockLeagueDrain).toHaveBeenCalledWith({ limit: 1 });
    expect(out.issues).toContain("LEAGUE_NOTIFICATION_DELIVERY_FAILED");
  });

  it("reports durable league work blocked by a missing webhook", async () => {
    mockLeagueDrain.mockResolvedValue({
      attempted: 0,
      delivered: 0,
      pending: true,
      blocked: "WEBHOOK_UNAVAILABLE",
    });

    const out = await runResultSync();

    expect(out.issues).toContain("LEAGUE_NOTIFICATION_DELIVERY_FAILED");
  });

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
      draft: false,
      playoff: false,
      watch: false,
      cursor: null,
      issues: [],
      skipped: [],
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

  // This seam needs two simultaneous writers against an MVCC database.
  // SQLite holds the outer writer lock until the interactive transaction
  // times out, so it cannot model the production serialization retry.
  it.runIf(ON_POSTGRES)(
    "retries when a reminder finalizes during the atomic first-game write",
    async () => {
      const { season, match, homeAccts, awayAccts } = await setupNight({
        offsetMs: -2 * HOUR,
      });
      const marker = await claimAnnouncementMarker(
        weekReminderKey(season.id, match.week, match.scheduledAt!.getTime()),
      );
      expect(marker).not.toBeNull();
      if (!marker) throw new Error("Reminder marker claim was not created");

      const G = 8880778;
      mockMatch.mockResolvedValue(
        odGame(G, homeAccts, awayAccts, Date.now() - HOUR),
      );

      let invalidationAttempts = 0;
      let reminderFinalized = false;
      setRaceHook(async (label) => {
        if (label !== "match-import.importGame.beforeReminderInvalidation") {
          return;
        }
        invalidationAttempts++;
        if (invalidationAttempts === 1) {
          // A different connection performs the reminder writer's real CAS
          // after import's Serializable snapshot, before its marker delete.
          reminderFinalized = await markAnnouncementSent(marker);
        }
      });

      let result: Awaited<ReturnType<typeof importGameForMatch>>;
      try {
        result = await importGameForMatch(match.id, String(G));
      } finally {
        setRaceHook(null);
      }

      expect(reminderFinalized).toBe(true);
      expect(invalidationAttempts).toBe(2); // first snapshot aborted, retry won
      expect(result).toMatchObject({ ok: true, decided: true });
      expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(1);
      expect(
        (
          await prisma.setting.findUniqueOrThrow({
            where: { key: marker.key },
          })
        ).value,
      ).toMatch(/^sent:v2:/);
    },
  );

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
    const { season, homeAccts, awayAccts } = await setupNight({
      offsetMs: -2 * HOUR,
    });
    // A second due fixture between other teams keeps the season "due" after
    // the first completes without creating an ambiguous same-pair kickoff.
    const third = await makeTeam(season.id, "Third", 2);
    const fourth = await makeTeam(season.id, "Fourth", 3);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 2,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: third.id,
        awayTeamId: fourth.id,
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

  it("retries league ids whose OpenDota detail row is not final yet", async () => {
    const { season, match, homeAccts, awayAccts } = await setupNight({
      offsetMs: -HOUR,
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "17175" },
    });
    const G = 6660007;
    const complete = odGame(
      G,
      homeAccts,
      awayAccts,
      Date.now() - 30 * 60_000,
    );
    mockLeague.mockResolvedValue([G]);
    mockMatch.mockResolvedValue({
      ...complete,
      players: complete.players.slice(0, 1),
    });

    const first = await syncLeagueGames(season.id, { auto: true });

    expect(first).toMatchObject({ imported: 0, scanned: 1 });
    expect(
      await prisma.setting.findUnique({
        where: { key: `leagueSyncSkip:${season.id}` },
      }),
    ).toBeNull();

    mockMatch.mockClear();
    mockMatch.mockResolvedValue(complete);
    const retried = await syncLeagueGames(season.id, { auto: true });

    expect(retried.imported).toBe(1);
    expect(mockMatch).toHaveBeenCalledTimes(1);
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(1);
  });

  it("does not attach an old ticket game outside the fixture window", async () => {
    const { season, match, homeAccts, awayAccts } = await setupNight({
      offsetMs: -HOUR,
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "17176" },
    });
    const G = 6660008;
    mockLeague.mockResolvedValue([G]);
    mockMatch.mockResolvedValue(
      odGame(G, homeAccts, awayAccts, Date.now() - 10 * 24 * HOUR),
    );

    const result = await syncLeagueGames(season.id, { auto: true });

    expect(result).toMatchObject({ imported: 0, scanned: 1 });
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(0);
    expect(
      await prisma.importCandidate.findUnique({
        where: { seasonId_dotaMatchId: { seasonId: season.id, dotaMatchId: String(G) } },
      }),
    ).toMatchObject({ status: "IGNORED", nextAttemptAt: expect.any(Date) });
  });

  it("keeps an old game with its completed meeting, not a future rematch", async () => {
    const { season, home, match, homeAccts, awayAccts } = await setupNight({
      offsetMs: 24 * HOUR,
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "17177" },
    });
    const oldKickoff = new Date(Date.now() - 24 * HOUR);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 0,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        bestOf: 1,
        scheduledAt: oldKickoff,
        status: MATCH_STATUS.COMPLETED,
        homeScore: 1,
        awayScore: 0,
        winnerTeamId: home.id,
        completedAt: new Date(),
      },
    });
    const G = 6660009;
    mockLeague.mockResolvedValue([G]);
    mockMatch.mockResolvedValue(
      odGame(G, homeAccts, awayAccts, oldKickoff.getTime()),
    );

    const result = await syncLeagueGames(season.id, { auto: true });

    expect(result).toMatchObject({ imported: 0, scanned: 1 });
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(0);
    expect(
      await prisma.importCandidate.findUnique({
        where: { seasonId_dotaMatchId: { seasonId: season.id, dotaMatchId: String(G) } },
      }),
    ).toMatchObject({ status: "IGNORED", nextAttemptAt: expect.any(Date) });
  });

  it("re-reads due fixtures only when this run owns the league-feed claim", async () => {
    const { season } = await setupNight({ offsetMs: -HOUR });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "17174" },
    });
    const matchReads = vi.spyOn(prisma.match, "findMany");
    const dueReadCount = () =>
      matchReads.mock.calls.filter(
        ([args]) => args?.select?.autoSyncedAt === true,
      ).length;

    try {
      const claimed = await runResultSync();
      expect(claimed.watch).toBe(true);
      expect(mockLeague).toHaveBeenCalledTimes(1);
      expect(dueReadCount()).toBe(2); // initial scan + post-feed refresh

      matchReads.mockClear();
      const throttled = await runResultSync();
      expect(throttled.watch).toBe(true);
      expect(mockLeague).toHaveBeenCalledTimes(1); // this run lost the claim
      expect(dueReadCount()).toBe(1); // reuse the authoritative initial scan
    } finally {
      matchReads.mockRestore();
    }
  });

  it("falls back to player accounts when a ticketed fixture is still missing after three hours", async () => {
    const { season, match, homeAccts, awayAccts } = await setupNight({
      offsetMs: -4 * HOUR,
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "17172" },
    });
    const G = 6660002;
    mockLeague.mockResolvedValue([]);
    mockRecent.mockResolvedValue([G]);
    mockMatch.mockResolvedValue(
      odGame(G, homeAccts, awayAccts, Date.now() - HOUR),
    );

    const out = await runResultSync();

    expect(out.imported).toBe(1);
    expect(mockLeague).toHaveBeenCalledTimes(1);
    expect(mockRecent).toHaveBeenCalled();
    const stored = await prisma.match.findUniqueOrThrow({
      where: { id: match.id },
      include: { games: true },
    });
    expect(stored.status).toBe(MATCH_STATUS.COMPLETED);
    expect(stored.games.map((game) => game.dotaMatchId)).toEqual([String(G)]);
  });

  it("uses player-account recovery immediately for a partial ticketed series", async () => {
    const { season, home, match, homeAccts, awayAccts } = await setupNight({
      offsetMs: -HOUR,
      bestOf: 2,
    });
    const G1 = 6660003;
    const G2 = 6660004;
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: String(G1),
        radiantWin: true,
        radiantTeamId: home.id,
        direTeamId: match.awayTeamId,
        winnerTeamId: home.id,
      },
    });
    await prisma.match.update({
      where: { id: match.id },
      data: {
        status: MATCH_STATUS.LIVE,
        homeScore: 1,
        winnerTeamId: null,
      },
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "17173" },
    });
    mockLeague.mockResolvedValue([]);
    mockRecent.mockResolvedValue([G1, G2]);
    mockMatch.mockImplementation(async (id) =>
      id === String(G2)
        ? odGame(G2, homeAccts, awayAccts, Date.now() - 10 * 60_000)
        : null,
    );

    const out = await runResultSync();

    expect(out.imported).toBe(1);
    expect(mockRecent).toHaveBeenCalled();
    const stored = await prisma.match.findUniqueOrThrow({
      where: { id: match.id },
      include: { games: true },
    });
    expect(stored.status).toBe(MATCH_STATUS.COMPLETED);
    expect(stored.homeScore).toBe(2);
    expect(stored.games.map((game) => game.dotaMatchId).sort()).toEqual([
      String(G1),
      String(G2),
    ]);
  });
});

describe("result sync — league feed outage (integration)", () => {
  it("logs only a stable code when a provider throws secret-shaped metadata", async () => {
    const secretCode = "SECRETLOOKINGTOKEN";
    const { season } = await setupNight({ offsetMs: -60 * 60_000 });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "18181" },
    });
    mockLeague.mockRejectedValue(
      Object.assign(new Error("provider failed"), { code: secretCode }),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runResultSync();

    expect(result.issues).toContain("LEAGUE_SYNC_FAILED");
    expect(log).toHaveBeenCalledWith(
      "[result-sync] league failed (STEP_FAILED)",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(secretCode);
  });

  // fetchLeagueMatchIds now signals unreachable as null (the
  // fetchRecentMatchIds contract). The auto path claims its throttle BEFORE
  // fetching, so without the rollback every outage tick cost one full
  // LEAGUE_INTERVAL_SECONDS; and the admin's manual toast implied "zero
  // league games" during a blip.
  it("rolls the burned throttle claim back so the next tick retries", async () => {
    const { season } = await setupNight({ offsetMs: -60 * 60_000 });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "18181" },
    });
    mockLeague.mockResolvedValue(null);

    await runResultSync();
    expect(mockLeague).toHaveBeenCalledTimes(1);
    // Claim rolled back — the throttle row is gone, so the very next run
    // re-claims instead of waiting out the interval.
    expect(
      await prisma.setting.findUnique({
        where: { key: SETTING_KEYS.LEAGUE_AUTO_SYNC_AT },
      }),
    ).toBeNull();

    mockLeague.mockResolvedValue([]);
    await runResultSync();
    expect(mockLeague).toHaveBeenCalledTimes(2); // retried immediately
    // A genuinely-empty feed keeps its claim (no rollback).
    expect(
      await prisma.setting.findUnique({
        where: { key: SETTING_KEYS.LEAGUE_AUTO_SYNC_AT },
      }),
    ).not.toBeNull();
  });

  it("syncLeagueGames reports unreachable with an error, empty without", async () => {
    const { season } = await setupNight({ offsetMs: -60 * 60_000 });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "18181" },
    });

    mockLeague.mockResolvedValue(null);
    const down = await syncLeagueGames(season.id);
    expect(down.unreachable).toBe(true);
    expect(down.error).toMatch(/unreachable/i);
    expect(down.imported).toBe(0);

    mockLeague.mockResolvedValue([]);
    const empty = await syncLeagueGames(season.id);
    expect(empty.unreachable).toBeUndefined();
    expect(empty.error).toBeUndefined();
  });
});

describe("result sync — draft clocks (integration)", () => {
  async function setupDraft(playerMmrs: number[]) {
    const season = await makeSeason({ teamSize: 2 });
    const first = await makeCaptain(season.id, "First", 10, 0);
    await makeCaptain(season.id, "Second", 10, 1);
    const players = [];
    for (const [i, mmr] of playerMmrs.entries()) {
      players.push(await makePlayer(season.id, `Pool${i}`, mmr));
    }
    await startDraftState(season.id);
    return { season, first, players };
  }

  it("keeps the site heartbeat fast while a future auction clock is live", async () => {
    const { season } = await setupDraft([4000]);
    const before = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });

    expect(await runResultSync()).toEqual({
      imported: 0,
      inhouse: false,
      draft: false,
      playoff: false,
      watch: true,
      cursor: null,
      issues: [],
      skipped: [],
    });

    const after = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(after.nominationEndsAt).toEqual(before.nominationEndsAt);
    expect(after.nominatedUserId).toBeNull();
  });

  it("auto-nominates when the nomination clock expires with no draft room open", async () => {
    const { season, players } = await setupDraft([3500, 4500]);
    await expireNominationClock(season.id);

    expect(await runResultSync()).toEqual({
      imported: 0,
      inhouse: false,
      draft: true,
      playoff: false,
      watch: true,
      cursor: null,
      issues: [],
      skipped: [],
    });

    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.status).toBe(DRAFT_STATUS.IN_PROGRESS);
    expect(draft.nominatedUserId).toBe(players[1].id); // highest-MMR available
    expect(draft.currentBid).toBe(DEFAULTS.MIN_BID);
    expect(draft.bidEndsAt?.getTime()).toBeGreaterThan(Date.now());
    expect(
      await prisma.bid.count({
        where: { draftId: draft.id, userId: players[1].id },
      }),
    ).toBe(1);
  });

  it("settles an expired lot and reports completion without a draft room open", async () => {
    const { season, first, players } = await setupDraft([4000]);
    expect(
      await nominatePlayer(
        season.id,
        sessionFor(first.user),
        players[0].id,
        DEFAULTS.MIN_BID,
      ),
    ).toEqual({ ok: true });
    await expireClock(season.id);

    expect(await runResultSync()).toEqual({
      imported: 0,
      inhouse: false,
      draft: true,
      playoff: false,
      watch: false,
      cursor: null,
      issues: [],
      skipped: [],
    });

    expect(
      await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } }),
    ).toMatchObject({ status: DRAFT_STATUS.COMPLETE, nominatedUserId: null });
    expect(
      await prisma.teamMember.findUniqueOrThrow({
        where: {
          seasonId_userId: { seasonId: season.id, userId: players[0].id },
        },
      }),
    ).toMatchObject({
      teamId: first.team.id,
      price: DEFAULTS.MIN_BID,
      isCaptain: false,
    });
    expect(
      await prisma.team.findUniqueOrThrow({ where: { id: first.team.id } }),
    ).toMatchObject({ budget: 10 - DEFAULTS.MIN_BID });
  });

  it("does not advance an orphaned live Draft row outside the Draft phase", async () => {
    const { season } = await setupDraft([4000]);
    await expireNominationClock(season.id);
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.REGULAR_SEASON },
    });

    expect(await runResultSync()).toEqual({
      imported: 0,
      inhouse: false,
      draft: false,
      playoff: false,
      watch: false,
      cursor: null,
      issues: [],
      skipped: [],
    });
    expect(
      await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } }),
    ).toMatchObject({
      status: DRAFT_STATUS.IN_PROGRESS,
      nominatedUserId: null,
    });
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

  it("clears a four-hour-static waiting queue with no room open", async () => {
    const user = await makeUser("Static queue");
    const staleAt = new Date(
      Date.now() - INHOUSE.QUEUE_IDLE_HOURS * HOUR - 60_000,
    );
    const entry = await prisma.inhouseQueueEntry.create({
      data: {
        userId: user.id,
        mmr: 3000,
        joinedAt: staleAt,
        // Fresh presence used to keep this row and every observer hot forever.
        lastSeenAt: new Date(),
      },
    });
    // The production rollback trigger correctly refreshes every actual insert;
    // backdate afterward to model four hours elapsing without queue activity.
    await prisma.inhouseQueueEntry.update({
      where: { id: entry.id },
      data: { idleExpiresAt: staleAt },
    });

    const out = await runResultSync();

    expect(await prisma.inhouseQueueEntry.count()).toBe(0);
    expect(out).toMatchObject({ inhouse: false, watch: false });
  });

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

  it("retries a failed durable inhouse announcement with no room or queue open", async () => {
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.COMPLETED,
        winnerTeam: 1,
        dotaMatchId: "7770999",
        completedAt: new Date(),
      },
    });
    const event = await prisma.inhouseAnnouncement.create({
      data: {
        lobbyId: lobby.id,
        kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
        sequence: 1,
        content: "retry me",
        resultMatchId: "7770999",
      },
    });
    mockInhouseSend.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    // Nothing else is active, but the durable backlog keeps the heartbeat on
    // its retry cadence instead of disappearing behind syncInhouse's idle exit.
    expect(await runResultSync()).toMatchObject({
      inhouse: false,
      watch: true,
      issues: ["INHOUSE_NOTIFICATION_DELIVERY_FAILED"],
    });
    const failed = await prisma.inhouseAnnouncement.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(failed).toMatchObject({
      status: INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
      attempts: 1,
    });

    await prisma.inhouseAnnouncement.update({
      where: { id: event.id },
      data: { availableAt: new Date(Date.now() - 1) },
    });
    expect(await runResultSync()).toMatchObject({
      inhouse: false,
      watch: false,
    });
    expect(
      await prisma.inhouseAnnouncement.findUniqueOrThrow({
        where: { id: event.id },
      }),
    ).toMatchObject({
      status: INHOUSE_ANNOUNCEMENT_STATUS.SENT,
      attempts: 2,
    });
    expect(mockInhouseSend).toHaveBeenCalledTimes(2);
  });

  it("waits out the minimum game length but keeps watching a live lobby", async () => {
    await setupLobby(2); // just started — can't be over
    mockRecent.mockResolvedValue([7770456]);

    const out = await runResultSync();
    expect(out.inhouse).toBe(false);
    expect(out.watch).toBe(true); // live lobby → fast client polling
    expect(mockRecent).not.toHaveBeenCalled();
  });

  it("surfaces an aborted inhouse scan and restores its exact throttle claim", async () => {
    const { lobby } = await setupLobby(INHOUSE.DETECT_MIN_MINUTES + 5);
    const previousDetectedAt = new Date(Date.now() - 60 * 60_000);
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: { detectedAt: previousDetectedAt },
    });
    const controller = new AbortController();
    mockRecent.mockImplementation(async () => {
      controller.abort();
      return [];
    });

    const out = await runResultSync({
      deadlineMs: Date.now() + 30_000,
      signal: controller.signal,
    });

    expect(out.skipped).toContain("INHOUSE_BUDGET_EXHAUSTED");
    expect(
      (
        await prisma.inhouseLobby.findUniqueOrThrow({
          where: { id: lobby.id },
          select: { detectedAt: true },
        })
      ).detectedAt,
    ).toEqual(previousDetectedAt);
    expect(mockMatch).not.toHaveBeenCalled();
  });

  it("resolves an EXPIRED ready check from any page view (frees the active slot)", async () => {
    // Ten queued from Discord, none kept /inhouse open: the check formed and
    // its clock ran out with nobody polling. runResultSync must resolve it —
    // a READY_CHECK is in INHOUSE_ACTIVE_STATUSES, so a stuck one would block
    // the next lobby forever and keep every parked dashboard fast-polling.
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.READY_CHECK,
        radiantTeam: 1,
        acceptEndsAt: new Date(Date.now() - 1000), // already expired
      },
    });
    for (let i = 0; i < INHOUSE.LOBBY_SIZE; i++) {
      const user = await makeUser(`RC${i}`);
      await prisma.inhouseLobbyPlayer.create({
        data: {
          lobbyId: lobby.id,
          userId: user.id,
          mmr: 3000,
          // Half accepted, half no-show — so it must FAIL, not advance.
          acceptedAt: i < 5 ? new Date() : null,
        },
      });
    }

    await runResultSync();

    const resolved = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(resolved.status).toBe(INHOUSE_STATUS.CANCELLED);
    // The active slot is free again and the five accepters are re-queued.
    expect(
      await prisma.inhouseLobby.count({
        where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      }),
    ).toBe(0);
    expect(await prisma.inhouseQueueEntry.count()).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// FAULT-INJECTED claim. The per-match claim re-asserts `status: not COMPLETED`
// at the WRITE, and racing real calls cannot exercise it: the global
// ROSTER_AUTO_SYNC_AT throttle serializes runs, so two pings never overlap
// inside the loop, and the "concurrent pings" test above therefore passes just
// as happily with the predicate deleted. The rival that matters comes from a
// DIFFERENT path entirely — whatever decides the series while this run is
// between its read and its write. The service yields at a labelled seam
// (src/lib/race-hook.ts) so that ordering is deterministic.
//
// Runs on SQLite too: the seam is between two plain queries, with no open
// transaction for the rival's connection to block on.
// ---------------------------------------------------------------------------
describe("result sync — a claim that needs a staged interleaving", () => {
  afterEach(() => setRaceHook(null));

  it("an aborted scan cannot roll back a newer worker's match cursor", async () => {
    const { match } = await setupNight({ offsetMs: -2 * HOUR });
    const controller = new AbortController();
    mockRecent.mockImplementation(async () => {
      controller.abort();
      return [];
    });
    const newerSyncedAt = new Date(Date.now() + 60_000);
    const newerAttempts = 7;
    let rivalCommitted = false;
    setRaceHook(
      onceAt("resultSync.syncDueMatches.beforeDeadlineRollback", async () => {
        await prisma.match.update({
          where: { id: match.id },
          data: {
            autoSyncedAt: newerSyncedAt,
            autoSyncAttempts: newerAttempts,
          },
        });
        rivalCommitted = true;
      }),
    );

    const out = await runResultSync({
      deadlineMs: Date.now() + 30_000,
      signal: controller.signal,
    });

    expect(rivalCommitted).toBe(true);
    expect(out.skipped).toContain("LEAGUE_BUDGET_EXHAUSTED");
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: match.id } }),
    ).toMatchObject({
      autoSyncedAt: newerSyncedAt,
      autoSyncAttempts: newerAttempts,
    });

    // The newer cursor is not just audit metadata: preserving it prevents an
    // immediate second full-roster OpenDota fan-out after this aborted call.
    mockRecent.mockClear();
    await runResultSync();
    expect(mockRecent).not.toHaveBeenCalled();
  });

  it("never scans a series DECIDED between the due read and the claim", async () => {
    const { home, match, homeAccts, awayAccts } = await setupNight({
      offsetMs: -2 * HOUR,
    });
    // A game IS out there on OpenDota — so if this run scans at all, it will
    // import it, over the top of a series somebody has already settled.
    const G = 8881234;
    mockRecent.mockResolvedValue([G]);
    mockMatch.mockResolvedValue(
      odGame(G, homeAccts, awayAccts, Date.now() - HOUR),
    );

    let fired = false;
    setRaceHook(
      onceAt("resultSync.syncDueMatches.beforeMatchClaim", async () => {
        fired = true;
        // An admin's forfeit ruling lands (a captain's manual import or the
        // league feed would land the same way). The match row is the only one
        // touched and nothing holds a lock on it.
        await prisma.match.update({
          where: { id: match.id },
          data: {
            status: MATCH_STATUS.COMPLETED,
            homeScore: 2,
            awayScore: 0,
            winnerTeamId: home.id,
          },
        });
      }),
    );

    const out = await runResultSync();
    expect(fired).toBe(true); // the seam was reached — not a vacuous pass
    expect(out.imported).toBe(0);
    // The decisive assertion: OpenDota was never asked. A decided series is
    // amended by an admin, never rewritten by a late roster scan.
    expect(mockRecent).not.toHaveBeenCalled();

    const m = await prisma.match.findUniqueOrThrow({
      where: { id: match.id },
      include: { games: true },
    });
    expect(m.games).toHaveLength(0);
    expect(m.status).toBe(MATCH_STATUS.COMPLETED);
    expect(m.homeScore).toBe(2); // the ruling stands, unreverted
    expect(m.awayScore).toBe(0);
    // Not even stamped: a COMPLETED match that carries a fresh scan time and a
    // backoff count reads, on the admin's auto-sync health card, as a fixture
    // still being worked — the one thing that card exists to rule out.
    expect(m.autoSyncedAt).toBeNull();
    expect(m.autoSyncAttempts).toBe(0);
  });
});

describe("league feed account preparation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses two identity reads for many fixtures and no registration attribution reads", async () => {
    const { season, match } = await setupNight({ offsetMs: -HOUR });
    await prisma.season.update({ where: { id: season.id }, data: { dotaLeagueId: "19180" } });
    await prisma.match.createMany({ data: Array.from({ length: 12 }, (_, index) => ({
      seasonId: season.id,
      week: index + 2,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: match.homeTeamId,
      awayTeamId: match.awayTeamId,
      bestOf: 1,
      scheduledAt: new Date(Date.now() + (index + 1) * 7 * 24 * HOUR),
    })) });
    // An unrelated finalized game requires classification but no import, so
    // these are precisely preparation reads, not final transaction checks.
    mockLeague.mockResolvedValue([991801]);
    mockMatch.mockResolvedValue(odGame(991801, [880001, 880002, 880003], [880004, 880005, 880006], Date.now()));
    const members = vi.spyOn(prisma.teamMember, "findMany");
    const standins = vi.spyOn(prisma.standinAssignment, "findMany");
    const registrants = vi.spyOn(prisma.registration, "findMany");
    const seasons = vi.spyOn(prisma.season, "findUnique");

    expect((await syncLeagueGames(season.id, { auto: true })).imported).toBe(0);
    expect(members).toHaveBeenCalledTimes(1);
    expect(standins).toHaveBeenCalledTimes(1);
    expect(registrants).not.toHaveBeenCalled();
    expect(seasons).toHaveBeenCalledTimes(1); // existing season context, reused
  });

  it("keeps a fixture's standin out of a rematch while preserving meeting ownership", async () => {
    const { season, match, homeAccts, awayAccts } = await setupNight({ offsetMs: -24 * HOUR });
    await prisma.season.update({ where: { id: season.id }, data: { dotaLeagueId: "19181" } });
    const cover = await makeUser("First fixture cover");
    const coverAccount = steamIdToAccountId(cover.steamId)!;
    const firstRoster = [homeAccts[0], homeAccts[1], coverAccount];
    await prisma.standinAssignment.create({ data: { matchId: match.id, teamId: match.homeTeamId, standinUserId: cover.id } });
    const rematch = await prisma.match.create({ data: {
      seasonId: season.id, week: 2, phase: MATCH_PHASE.REGULAR,
      homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId,
      bestOf: 1, scheduledAt: new Date(Date.now() - HOUR),
    } });
    mockLeague.mockResolvedValue([991811, 991812]);
    mockMatch.mockImplementation(async (id) => odGame(Number(id), firstRoster, awayAccts,
      id === "991811" ? match.scheduledAt!.getTime() : rematch.scheduledAt!.getTime()));

    expect((await syncLeagueGames(season.id, { auto: true })).imported).toBe(1);
    expect(await prisma.game.findFirst({ where: { matchId: match.id } })).toMatchObject({ dotaMatchId: "991811" });
    expect(await prisma.game.count({ where: { matchId: rematch.id } })).toBe(0);
    expect(await prisma.importCandidate.findFirst({ where: { dotaMatchId: "991812" } })).toMatchObject({ status: "IGNORED" });
  });

  it("does not prepare identities for closed or full fixtures", async () => {
    const { season, match } = await setupNight({ offsetMs: -HOUR });
    await prisma.season.update({ where: { id: season.id }, data: { dotaLeagueId: "19182" } });
    await prisma.match.update({ where: { id: match.id }, data: { status: MATCH_STATUS.COMPLETED } });
    const full = await prisma.match.create({ data: {
      seasonId: season.id, week: 2, phase: MATCH_PHASE.REGULAR, status: MATCH_STATUS.LIVE,
      homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId, bestOf: 1, scheduledAt: new Date(),
    } });
    await prisma.game.create({ data: { matchId: full.id, dotaMatchId: "991821", radiantWin: true } });
    mockLeague.mockResolvedValue([991822]);
    mockMatch.mockResolvedValue(odGame(991822, [880001, 880002, 880003], [880004, 880005, 880006], Date.now()));
    const members = vi.spyOn(prisma.teamMember, "findMany");
    const standins = vi.spyOn(prisma.standinAssignment, "findMany");
    expect((await syncLeagueGames(season.id, { auto: true })).imported).toBe(0);
    expect(members).not.toHaveBeenCalled();
    expect(standins).not.toHaveBeenCalled();
  });
});

describe("durable import reliability", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resumes a slow newest-first feed without refetching or assigning a partial series", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { season, match, homeAccts, awayAccts } = await setupNight({ offsetMs: -2 * HOUR, bestOf: 5 });
    await prisma.season.update({ where: { id: season.id }, data: { dotaLeagueId: "19191" } });
    const base = Date.now() - 2 * HOUR;
    const ids = [991005, 991004, 991003, 991002, 991001];
    mockLeague.mockResolvedValue(ids);
    mockMatch.mockImplementation(async (id) => {
      vi.setSystemTime(Date.now() + 9_000);
      return odGame(Number(id), homeAccts, awayAccts, base + (Number(id) - 991001) * 20 * 60_000);
    });

    const first = await syncLeagueGames(season.id, { auto: true, deadlineMs: Date.now() + 45_000 });
    expect(first).toMatchObject({ imported: 0, pending: true, deadlineReached: true });
    expect(await prisma.game.count()).toBe(0);
    expect(await prisma.importCandidate.count({ where: { status: "READY" } })).toBe(4);

    const second = await syncLeagueGames(season.id, { auto: true, deadlineMs: Date.now() + 45_000 });
    expect(second.imported).toBe(3); // first three wins clinch; two bonus games stay out
    expect(mockMatch).toHaveBeenCalledTimes(5); // each successful provider fetch exactly once
    const stored = await prisma.game.findMany({ where: { matchId: match.id }, orderBy: { startTime: "asc" } });
    expect(stored.map((game) => game.dotaMatchId)).toEqual(["991001", "991002", "991003"]);
    expect(await prisma.importCandidate.count({ where: { dotaMatchId: { in: stored.map((game) => game.dotaMatchId) } } })).toBe(0);
  });

  it("retains concurrent exclusions and legacy memory, and rolls back failed corrections", async () => {
    const season = await makeSeason();
    await prisma.setting.create({ data: { key: `importSkip:${season.id}`, value: JSON.stringify(["legacy"]) } });
    await Promise.all([rememberImportSkip(season.id, "removed-a"), rememberImportSkip(season.id, "removed-b")]);
    expect([...(await loadImportSkips(season.id))].sort()).toEqual(["legacy", "removed-a", "removed-b"]);
    await expect(prisma.$transaction(async (tx) => {
      await rememberImportSkip(season.id, "rolled-back", tx);
      throw new Error("correction failed");
    })).rejects.toThrow("correction failed");
    expect((await loadImportSkips(season.id)).has("rolled-back")).toBe(false);
  });

  it("rechecks the committed kickoff after a reschedule during provider IO", async () => {
    const { match, homeAccts, awayAccts } = await setupNight({ offsetMs: -HOUR });
    const details = odGame(991101, homeAccts, awayAccts, match.scheduledAt!.getTime());
    mockMatch.mockImplementation(async () => {
      await prisma.match.update({ where: { id: match.id }, data: { scheduledAt: new Date(Date.now() + 30 * 24 * HOUR) } });
      return details;
    });
    const result = await importGameForMatch(match.id, String(details.match_id), { enforceFixtureWindow: true });
    expect(result).toMatchObject({ ok: false, code: "STALE_FIXTURE", error: expect.stringMatching(/outside.*window/i) });
    expect(await prisma.game.count()).toBe(0);
    expect(await prisma.dotaMatchClaim.count()).toBe(0);
  });

  it("honors an exclusion created after discovery and before assignment", async () => {
    const { season, match, homeAccts, awayAccts } = await setupNight({ offsetMs: -HOUR });
    mockMatch.mockImplementation(async () => {
      await rememberImportSkip(season.id, "991102");
      return odGame(991102, homeAccts, awayAccts, match.scheduledAt!.getTime());
    });
    expect(await importGameForMatch(match.id, "991102", { respectImportSkips: true }))
      .toMatchObject({ ok: false, code: "ADMIN_SUPPRESSED" });
    expect(await prisma.game.count()).toBe(0);
  });

  it("retries exhausted Serializable conflicts using the saved payload", async () => {
    const { season, match, homeAccts, awayAccts } = await setupNight({ offsetMs: -HOUR });
    await prisma.season.update({ where: { id: season.id }, data: { dotaLeagueId: "19192" } });
    mockLeague.mockResolvedValue([991201]);
    mockMatch.mockResolvedValue(odGame(991201, homeAccts, awayAccts, match.scheduledAt!.getTime()));
    const transaction = vi.spyOn(prisma, "$transaction").mockRejectedValue(Object.assign(new Error("serialization conflict"), { code: "P2034" }));
    const first = await syncLeagueGames(season.id, { auto: true });
    expect(first).toMatchObject({ imported: 0, pending: true });
    expect(transaction).toHaveBeenCalledTimes(3);
    transaction.mockRestore();
    const candidate = await prisma.importCandidate.findUniqueOrThrow({ where: { seasonId_dotaMatchId: { seasonId: season.id, dotaMatchId: "991201" } } });
    expect(candidate).toMatchObject({ status: "RETRYABLE", reason: "RETRYABLE", payload: expect.any(String) });
    expect(await prisma.setting.findUnique({ where: { key: `leagueSyncSkip:${season.id}` } })).toBeNull();
    await prisma.importCandidate.update({ where: { id: candidate.id }, data: { nextAttemptAt: new Date(0) } });
    const second = await syncLeagueGames(season.id, { auto: true });
    expect(second.imported).toBe(1);
    expect(mockMatch).toHaveBeenCalledTimes(1);
  });

  it("quarantines repeated provider failures without evicting administrator exclusions", async () => {
    const season = await makeSeason();
    for (let i = 0; i < IMPORT_CANDIDATE_MAX_ATTEMPTS; i++) {
      await recordImportFetchFailure(season.id, "991301", "PROVIDER_UNAVAILABLE");
    }
    const failed = await prisma.importCandidate.findUniqueOrThrow({ where: { seasonId_dotaMatchId: { seasonId: season.id, dotaMatchId: "991301" } } });
    expect(failed).toMatchObject({ status: "NEEDS_REVIEW", attempts: IMPORT_CANDIDATE_MAX_ATTEMPTS, payload: null });
    await rememberImportSkip(season.id, "991302");
    await prisma.importCandidate.update({ where: { id: failed.id }, data: { expiresAt: new Date(0) } });
    await expireImportCandidates();
    expect(await prisma.importCandidate.count()).toBe(0);
    expect((await loadImportSkips(season.id)).has("991302")).toBe(true);
  });

  it("does not let a quarantined fixture monopolize the roster fallback", async () => {
    const { season, match, homeAccts, awayAccts } = await setupNight({ offsetMs: -5 * HOUR });
    await prisma.match.update({ where: { id: match.id }, data: { autoSyncedAt: new Date(0) } });
    const secondHome = await makeTeam(season.id, "Second Home", 2);
    const secondAway = await makeTeam(season.id, "Second Away", 3);
    const otherHome: number[] = [], otherAway: number[] = [];
    for (const [team, accounts] of [[secondHome, otherHome], [secondAway, otherAway]] as const) {
      for (let i = 0; i < 3; i++) {
        const user = await makeUser(`Other ${team.id} ${i}`);
        await prisma.teamMember.create({ data: { seasonId: season.id, teamId: team.id, userId: user.id, price: 0 } });
        accounts.push(steamIdToAccountId(user.steamId)!);
      }
    }
    const second = await prisma.match.create({ data: {
      seasonId: season.id, homeTeamId: secondHome.id, awayTeamId: secondAway.id,
      week: 1, phase: MATCH_PHASE.REGULAR, bestOf: 1,
      scheduledAt: match.scheduledAt, autoSyncedAt: new Date(1),
    } });
    await prisma.importCandidate.create({ data: {
      seasonId: season.id, dotaMatchId: "991401", status: "NEEDS_REVIEW", reason: "PROVIDER_UNAVAILABLE",
      attempts: IMPORT_CANDIDATE_MAX_ATTEMPTS, expiresAt: new Date(Date.now() + 24 * HOUR),
    } });
    await saveImportEvidence(season.id, odGame(991402, otherHome, otherAway, second.scheduledAt!.getTime()));
    mockRecent.mockImplementation(async (account) => [...homeAccts, ...awayAccts].includes(account) ? [991401] : [991402]);

    expect((await runResultSync({ deadlineMs: Date.now() + 45_000 })).imported).toBe(0);
    const attempted = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(attempted.autoSyncAttempts).toBe(0);
    expect(attempted.autoSyncedAt!.getTime()).toBeGreaterThan(1);
    await backdateThrottle(SETTING_KEYS.ROSTER_AUTO_SYNC_AT, HOUR);
    expect((await runResultSync({ deadlineMs: Date.now() + 45_000 })).imported).toBe(1);
    expect(await prisma.game.count({ where: { matchId: second.id } })).toBe(1);
    expect(mockMatch).not.toHaveBeenCalled();
  });

  it("reconsiders an earlier cached game immediately after a kickoff repair", async () => {
    const { season, match, homeAccts, awayAccts } = await setupNight({ offsetMs: 30 * 24 * HOUR });
    await prisma.season.update({ where: { id: season.id }, data: { dotaLeagueId: "19193" } });
    const kickoff = Date.now() - 2 * HOUR;
    const first = { ...odGame(991501, homeAccts, awayAccts, kickoff), radiant_win: false };
    const bonus = odGame(991502, homeAccts, awayAccts, kickoff + HOUR);
    mockLeague.mockResolvedValue([991501]);
    mockMatch.mockImplementation(async (id) => id === "991501" ? first : bonus);
    expect((await syncLeagueGames(season.id, { auto: true })).imported).toBe(0);
    expect(await prisma.importCandidate.findFirst({ where: { dotaMatchId: "991501" } })).toMatchObject({ status: "IGNORED" });
    await prisma.match.update({ where: { id: match.id }, data: { scheduledAt: new Date(kickoff) } });
    mockLeague.mockResolvedValue([991502, 991501]);
    expect((await syncLeagueGames(season.id, { auto: true })).imported).toBe(1);
    expect((await prisma.game.findMany()).map((row) => row.dotaMatchId)).toEqual(["991501"]);
    expect(mockMatch).toHaveBeenCalledTimes(2); // cached earlier game was reclassified, not refetched
  });

  it("fences stale decisions and late provider success against administrator recovery", async () => {
    const { season, match, homeAccts, awayAccts } = await setupNight({ offsetMs: -HOUR });
    const details = odGame(991601, homeAccts, awayAccts, match.scheduledAt!.getTime());
    const beforeRetry = await saveImportEvidence(season.id, details);
    expect(beforeRetry).not.toBeNull();
    await prisma.importCandidate.update({ where: { id: beforeRetry!.id }, data: { revision: { increment: 1 }, status: "READY", reason: null } });
    await recordImportDecision(beforeRetry!, "NO_ELIGIBLE_FIXTURE");
    expect(await prisma.importCandidate.findUnique({ where: { id: beforeRetry!.id } })).toMatchObject({ status: "READY", revision: 1 });

    const beforeIgnore = await prisma.importCandidate.findUniqueOrThrow({ where: { id: beforeRetry!.id } });
    await rememberImportSkip(season.id, "991601");
    expect(await saveImportEvidence(season.id, details, beforeIgnore)).toBeNull();
    await recordImportFetchFailure(season.id, "991601", "LATE_PROVIDER_FAILURE");
    expect(await prisma.importCandidate.findUnique({ where: { id: beforeRetry!.id } })).toMatchObject({ status: "IGNORED", reason: "ADMIN_SUPPRESSED", payload: null });
    await prisma.dotaMatchClaim.create({ data: { dotaMatchId: "991602", kind: "LEAGUE", contextId: match.id } });
    await recordImportFetchFailure(season.id, "991602", "LATE_PROVIDER_FAILURE");
    expect(await prisma.importCandidate.findFirst({ where: { dotaMatchId: "991602" } })).toBeNull();
  });
});

describe("syncLeagueGames — booked scrim ownership", () => {
  it("remembers a scrim-only feed game without blocking manual scrim import", async () => {
    const { season, home, away } = await setupNight({
      offsetMs: -5 * HOUR,
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "18187" },
    });
    const SCRIM_GAME = 6664001;
    const hostAccts = [770_001, 770_002, 770_003];
    const awayAccts = [880_001, 880_002, 880_003];
    const kickoff = new Date(Date.now() - HOUR);
    const scrim = await makeBookedScrim({
      seasonId: season.id,
      hostTeamId: home.id,
      awayTeamId: away.id,
      createdById: home.captainId,
      scheduledAt: kickoff,
      hostAccts,
      awayAccts,
    });
    const fetched = odGame(
      SCRIM_GAME,
      hostAccts,
      awayAccts,
      kickoff.getTime(),
    );
    mockLeague.mockResolvedValue([SCRIM_GAME]);
    mockMatch.mockResolvedValue(fetched);

    const first = await syncLeagueGames(season.id, { auto: true });

    expect(first).toMatchObject({ imported: 0, scanned: 1 });
    expect(mockMatch).toHaveBeenCalledTimes(1);
    expect(
      await prisma.importCandidate.findUnique({
        where: { seasonId_dotaMatchId: { seasonId: season.id, dotaMatchId: String(SCRIM_GAME) } },
      }),
    ).toMatchObject({ status: "IGNORED", nextAttemptAt: expect.any(Date) });
    // This is deliberately not the shared admin-removal skip read by the
    // scrim scanner. The official feed must not hide the game from scrims.
    expect(
      await prisma.setting.findUnique({
        where: { key: `importSkip:${season.id}` },
      }),
    ).toBeNull();

    mockMatch.mockClear();
    await syncLeagueGames(season.id, { auto: true });
    expect(mockMatch).not.toHaveBeenCalled();

    mockMatch.mockResolvedValue(fetched);
    const imported = await importScrimGame(
      { id: home.captainId, role: ROLE.USER },
      scrim.id,
      String(SCRIM_GAME),
    );
    expect(imported).toMatchObject({ ok: true, imported: 1 });
    expect(mockMatch).toHaveBeenCalledTimes(1);
  });

  it("remembers an equidistant game that fits both official and scrim lineups", async () => {
    const { season, home, away, match, homeAccts, awayAccts } =
      await setupNight({ offsetMs: -HOUR });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "18188" },
    });
    const SCRIM_GAME = 6664002;
    const kickoff = match.scheduledAt!;
    await makeBookedScrim({
      seasonId: season.id,
      hostTeamId: home.id,
      awayTeamId: away.id,
      createdById: home.captainId,
      scheduledAt: kickoff,
      hostAccts: homeAccts,
      awayAccts,
    });
    mockLeague.mockResolvedValue([SCRIM_GAME]);
    mockMatch.mockResolvedValue(
      odGame(SCRIM_GAME, homeAccts, awayAccts, kickoff.getTime()),
    );

    const result = await syncLeagueGames(season.id, { auto: true });

    expect(result).toMatchObject({ imported: 0, scanned: 1 });
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(0);
    expect(
      await prisma.importCandidate.findUnique({
        where: { seasonId_dotaMatchId: { seasonId: season.id, dotaMatchId: String(SCRIM_GAME) } },
      }),
    ).toMatchObject({ status: "IGNORED", nextAttemptAt: expect.any(Date) });

    mockMatch.mockClear();
    await syncLeagueGames(season.id, { auto: true });
    expect(mockMatch).not.toHaveBeenCalled();
  });
});

describe("syncLeagueGames — the clinch-stop applies to the league feed too", () => {
  // The feed lists NEWEST FIRST, so a "one for fun" game after a decided night
  // used to import BEFORE the real games — the series wasn't COMPLETED yet, so
  // nothing refused it, and a 2-0 went into the record as 2-1 (wrong gameDiff
  // tiebreak, bogus box score in career stats, wrong Discord post). Candidates
  // are now buffered per fixture and run through pickSeriesGames — the same
  // session-split + clinch-stop the roster-scan path has always had.
  it("starts no league-feed request when the automation deadline is too close", async () => {
    const season = await makeSeason();
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "18184" },
    });
    mockLeague.mockClear();

    const result = await syncLeagueGames(season.id, {
      auto: true,
      deadlineMs: Date.now() + 100,
    });

    expect(result).toMatchObject({
      imported: 0,
      scanned: 0,
      deadlineReached: true,
    });
    expect(mockLeague).not.toHaveBeenCalled();
  });

  it("bulk-checks recorded feed ids across every season", async () => {
    const { season, match } = await setupNight({ offsetMs: -HOUR });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "18186" },
    });
    const foreignSeason = await makeSeason({
      isActive: false,
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    const foreignHome = await makeTeam(foreignSeason.id, "Foreign Home", 0);
    const foreignAway = await makeTeam(foreignSeason.id, "Foreign Away", 1);
    const foreignMatch = await prisma.match.create({
      data: {
        seasonId: foreignSeason.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: foreignHome.id,
        awayTeamId: foreignAway.id,
        bestOf: 1,
      },
    });
    const LOCAL = 6660005;
    const FOREIGN = 6660006;
    await prisma.game.createMany({
      data: [
        {
          matchId: match.id,
          dotaMatchId: String(LOCAL),
          radiantWin: true,
        },
        {
          matchId: foreignMatch.id,
          dotaMatchId: String(FOREIGN),
          radiantWin: false,
        },
      ],
    });
    mockLeague.mockResolvedValue([FOREIGN, LOCAL, FOREIGN]);
    const findMany = vi.spyOn(prisma.game, "findMany");
    const findUnique = vi.spyOn(prisma.game, "findUnique");

    try {
      const result = await syncLeagueGames(season.id, { auto: true });

      expect(result).toMatchObject({ imported: 0, scanned: 3 });
      expect(mockMatch).not.toHaveBeenCalled();
      expect(findUnique).not.toHaveBeenCalled();
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenCalledWith({
        where: {
          dotaMatchId: { in: [String(FOREIGN), String(LOCAL)] },
        },
        select: { dotaMatchId: true },
      });
    } finally {
      findMany.mockRestore();
      findUnique.mockRestore();
    }
  });

  it("drops the bonus game after a decided Bo3, whatever the feed order", async () => {
    const { season, match, home, homeAccts, awayAccts } = await setupNight({
      offsetMs: -2 * HOUR,
      bestOf: 3,
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "18182" },
    });
    const G1 = 6661001;
    const G2 = 6661002;
    const BONUS = 6661003;
    const now = Date.now();
    const games: Record<string, ReturnType<typeof odGame>> = {
      [String(G1)]: odGame(G1, homeAccts, awayAccts, now - 3 * HOUR),
      [String(G2)]: odGame(G2, homeAccts, awayAccts, now - 2.5 * HOUR),
      // The loser wins the fun one — recorded, it turns 2-0 into 2-1.
      [String(BONUS)]: {
        ...odGame(BONUS, homeAccts, awayAccts, now - 2 * HOUR),
        radiant_win: false,
      },
    };
    mockLeague.mockResolvedValue([BONUS, G2, G1]); // newest first, like OpenDota
    mockMatch.mockImplementation(async (id) => games[id] ?? null);

    const res = await syncLeagueGames(season.id, { auto: true });

    expect(res.imported).toBe(2);
    const m = await prisma.match.findUniqueOrThrow({
      where: { id: match.id },
      include: { games: true },
    });
    expect(m.status).toBe(MATCH_STATUS.COMPLETED);
    expect(m.homeScore).toBe(2);
    expect(m.awayScore).toBe(0);
    expect(m.winnerTeamId).toBe(home.id);
    expect(m.games.map((g) => g.dotaMatchId).sort()).toEqual([
      String(G1),
      String(G2),
    ]);

    // The dropped bonus game is remembered — the automatic feed never
    // refetches a game it has already judged.
    const ignored = await prisma.importCandidate.findUnique({
      where: { seasonId_dotaMatchId: { seasonId: season.id, dotaMatchId: String(BONUS) } },
    });
    expect(ignored).toMatchObject({ status: "IGNORED", nextAttemptAt: expect.any(Date) });
  });

  it("drops a warmup scrim hours before the real series (session split)", async () => {
    const { season, match, home, homeAccts, awayAccts } = await setupNight({
      offsetMs: -2 * HOUR,
      bestOf: 3,
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "18183" },
    });
    const WARMUP = 6662001;
    const G1 = 6662002;
    const G2 = 6662003;
    const now = Date.now();
    const games: Record<string, ReturnType<typeof odGame>> = {
      [String(WARMUP)]: {
        ...odGame(WARMUP, homeAccts, awayAccts, now - 9 * HOUR),
        radiant_win: false,
      },
      [String(G1)]: odGame(G1, homeAccts, awayAccts, now - 2 * HOUR),
      [String(G2)]: odGame(G2, homeAccts, awayAccts, now - 1.5 * HOUR),
    };
    mockLeague.mockResolvedValue([G2, G1, WARMUP]);
    mockMatch.mockImplementation(async (id) => games[id] ?? null);

    const res = await syncLeagueGames(season.id, { auto: true });

    expect(res.imported).toBe(2);
    const m = await prisma.match.findUniqueOrThrow({
      where: { id: match.id },
      include: { games: true },
    });
    expect(m.homeScore).toBe(2);
    expect(m.awayScore).toBe(0);
    expect(m.winnerTeamId).toBe(home.id);
    expect(m.games.map((g) => g.dotaMatchId).sort()).toEqual([
      String(G1),
      String(G2),
    ]);
  });

  it("keeps two Bo2 lobbies separated by more than four hours", async () => {
    const { season, match, home, homeAccts, awayAccts } = await setupNight({
      offsetMs: -7 * HOUR,
      bestOf: 2,
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "18185" },
    });
    const G1 = 6663001;
    const G2 = 6663002;
    const games: Record<string, ReturnType<typeof odGame>> = {
      [String(G1)]: odGame(G1, homeAccts, awayAccts, Date.now() - 6 * HOUR),
      [String(G2)]: odGame(G2, homeAccts, awayAccts, Date.now() - HOUR),
    };
    mockLeague.mockResolvedValue([G2, G1]);
    mockMatch.mockImplementation(async (id) => games[id] ?? null);

    const res = await syncLeagueGames(season.id, { auto: true });

    expect(res.imported).toBe(2);
    const stored = await prisma.match.findUniqueOrThrow({
      where: { id: match.id },
      include: { games: true },
    });
    expect(stored.status).toBe(MATCH_STATUS.COMPLETED);
    expect(stored.homeScore).toBe(2);
    expect(stored.winnerTeamId).toBe(home.id);
    expect(stored.games.map((game) => game.dotaMatchId).sort()).toEqual([
      String(G1),
      String(G2),
    ]);
  });
});

describe("result sync — playoff reconciliation", () => {
  it("builds the next round when a committed result lost its post-commit effect", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.PLAYOFFS });
    const teams = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        makeTeam(season.id, `Reconcile ${index}`, index),
      ),
    );
    await prisma.match.createMany({
      data: [
        {
          seasonId: season.id,
          week: 8,
          phase: MATCH_PHASE.PLAYOFF,
          bracketSlot: "R0M0",
          homeTeamId: teams[0].id,
          awayTeamId: teams[3].id,
          status: MATCH_STATUS.COMPLETED,
          homeScore: 2,
          winnerTeamId: teams[0].id,
          bestOf: 3,
        },
        {
          seasonId: season.id,
          week: 8,
          phase: MATCH_PHASE.PLAYOFF,
          bracketSlot: "R0M1",
          homeTeamId: teams[1].id,
          awayTeamId: teams[2].id,
          status: MATCH_STATUS.COMPLETED,
          homeScore: 2,
          winnerTeamId: teams[1].id,
          bestOf: 3,
        },
      ],
    });

    const out = await runResultSync();

    expect(out.playoff).toBe(true);
    expect(out.cursor).not.toBeNull();

    const final = await prisma.match.findFirst({
      where: { seasonId: season.id, bracketSlot: "R1M0" },
    });
    expect(final).toMatchObject({
      phase: MATCH_PHASE.FINAL,
      homeTeamId: teams[0].id,
      awayTeamId: teams[1].id,
      status: MATCH_STATUS.SCHEDULED,
    });

    const again = await runResultSync();
    expect(again.playoff).toBe(false);
    expect(again.cursor).toBe(out.cursor);
  });

  it("reports a crown even when its post-commit announcement throws", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.PLAYOFFS });
    const champion = await makeTeam(season.id, "Crown winner", 0);
    const runnerUp = await makeTeam(season.id, "Crown runner-up", 1);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 9,
        phase: MATCH_PHASE.FINAL,
        bracketSlot: "R0M0",
        homeTeamId: champion.id,
        awayTeamId: runnerUp.id,
        status: MATCH_STATUS.COMPLETED,
        homeScore: 3,
        winnerTeamId: champion.id,
        bestOf: 5,
      },
    });
    mockSend.mockRejectedValueOnce(new Error("transport exploded"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let out!: Awaited<ReturnType<typeof runResultSync>>;

    try {
      out = await runResultSync();
    } finally {
      consoleError.mockRestore();
    }

    expect(out.playoff).toBe(true);
    expect(out.cursor).not.toBeNull();
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({
      status: SEASON_STATUS.COMPLETE,
      championTeamId: champion.id,
    });
  });
});
