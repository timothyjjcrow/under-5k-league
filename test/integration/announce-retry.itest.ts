import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { announceSeriesResultOnce } from "@/lib/match-import";
import {
  markWeekHonorsStale,
  maybeAnnounceWeekHonors,
} from "@/lib/honors-service";
import * as honorsReadinessService from "@/lib/honors-readiness-service";
import { maybeAnnounceUpcomingWeek } from "@/lib/reminder-service";
import { runResultSync } from "@/lib/result-sync-service";
import { announceChampionOnce } from "@/lib/playoff-service";
import { championAnnouncedKey } from "@/lib/settings";
import {
  makeSeason,
  makeTeam,
  makeUser,
  ON_POSTGRES,
  raceAll,
} from "./factories";

// A Discord blip (timeout, 5xx, revoked webhook) must never permanently eat a
// once-only announcement: every claim-then-send path releases its idempotency
// marker when the send fails, so the next trigger retries — and a successful
// send still can't double-post.

vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return {
    ...actual,
    getWebhookUrl: vi.fn(async () => "https://discord.test/hook"),
    sendDiscordMessage: vi.fn(async () => true),
  };
});
import { getWebhookUrl, sendDiscordMessage } from "@/lib/discord";
const mockSend = vi.mocked(sendDiscordMessage);
const mockHook = vi.mocked(getWebhookUrl);

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue(true);
  mockHook.mockReset();
  mockHook.mockResolvedValue("https://discord.test/hook");
});

const markerCount = (prefix: string) =>
  prisma.setting.count({ where: { key: { startsWith: prefix } } });

describe("series-result announcement retry", () => {
  async function setupDecidedMatch() {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: home.id,
        awayTeamId: away.id,
        homeScore: 2,
        awayScore: 0,
        status: MATCH_STATUS.COMPLETED,
        winnerTeamId: home.id,
      },
    });
    return {
      id: match.id,
      homeTeamId: home.id,
      awayTeamId: away.id,
      homeScore: 2,
      awayScore: 0,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
    };
  }

  it("flags the marker failed on a bad send; a retry claims it exactly once", async () => {
    const match = await setupDecidedMatch();
    mockSend.mockResolvedValue(false); // Discord down

    expect(await announceSeriesResultOnce(match)).toBe(false);
    const failed = await prisma.setting.findUnique({
      where: { key: `resultAnnounced:${match.id}` },
    });
    expect(failed?.value).toMatch(/^failed:/); // flagged, not lost

    mockSend.mockResolvedValue(true); // Discord back
    expect(await announceSeriesResultOnce(match)).toBe(true);
    const sent = await prisma.setting.findUnique({
      where: { key: `resultAnnounced:${match.id}` },
    });
    expect(sent?.value).not.toMatch(/^failed:/);
    // …and it stays once-only afterwards.
    expect(await announceSeriesResultOnce(match)).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(2); // 1 failed + 1 success
  });

  it("the sync sweep retries a failed announcement — no import needed", async () => {
    const match = await setupDecidedMatch();
    mockSend.mockResolvedValue(false);
    await announceSeriesResultOnce(match); // marker now failed:

    // Discord recovers; the next sitewide sync ping drains the retry queue —
    // crucial because the run whose send failed is the run that COMPLETED
    // the match, so no import path would ever call announce again.
    mockSend.mockResolvedValue(true);
    await runResultSync();

    const marker = await prisma.setting.findUnique({
      where: { key: `resultAnnounced:${match.id}` },
    });
    expect(marker?.value).not.toMatch(/^failed:/);
    const messages = mockSend.mock.calls.map((c) => c[0]);
    expect(messages.filter((s) => s.startsWith("⚔️"))).toHaveLength(2); // fail + retry
    // A second sweep has nothing to do.
    await prisma.setting.deleteMany({
      where: { key: "announceRetryAt" }, // un-throttle
    });
    await runResultSync();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("never burns the marker when no webhook is configured", async () => {
    const match = await setupDecidedMatch();
    mockHook.mockResolvedValue(null);
    expect(await announceSeriesResultOnce(match)).toBe(false);
    expect(await markerCount(`resultAnnounced:${match.id}`)).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();

    // Webhook wired up later → the announcement still goes out.
    mockHook.mockResolvedValue("https://discord.test/hook");
    expect(await announceSeriesResultOnce(match)).toBe(true);
  });
});

describe("weekly-honors announcement retry", () => {
  async function setupCompletedWeek() {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const star = await makeUser("Star Carry");
    const homePlayers = [
      star,
      ...(await Promise.all(
        Array.from({ length: 4 }, (_, index) => makeUser(`Home ${index + 2}`)),
      )),
    ];
    const awayPlayers = await Promise.all(
      Array.from({ length: 5 }, (_, index) => makeUser(`Away ${index + 1}`)),
    );
    await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: home.id,
        userId: star.id,
        isCaptain: false,
        price: 10,
      },
    });
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: home.id,
        awayTeamId: away.id,
        homeScore: 1,
        awayScore: 0,
        status: MATCH_STATUS.COMPLETED,
        winnerTeamId: home.id,
      },
    });
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: `${Date.now()}`,
        radiantWin: true,
        radiantTeamId: home.id,
        direTeamId: away.id,
        winnerTeamId: home.id,
        players: JSON.stringify([
          ...homePlayers.map((player, index) => ({
            accountId: index + 1,
            userId: player.id,
            teamId: home.id,
            isRadiant: true,
            heroId: index + 1,
            kills: index === 0 ? 10 : 2,
            deaths: 1,
            assists: index === 0 ? 8 : 4,
            gpm: index === 0 ? 550 : 400,
            lastHits: 200,
          })),
          ...awayPlayers.map((player, index) => ({
            accountId: index + 101,
            userId: player.id,
            teamId: away.id,
            isRadiant: false,
            heroId: index + 101,
            kills: 1,
            deaths: 5,
            assists: 2,
            gpm: 300,
            lastHits: 100,
          })),
        ]),
      },
    });
    return { season, match };
  }

  it("retries after a failed send, then stays once-only", async () => {
    const { season } = await setupCompletedWeek();
    mockSend.mockResolvedValue(false);

    await maybeAnnounceWeekHonors(season.id, 1);
    const failed = await prisma.setting.findUnique({
      where: { key: `honorsAnnounced:${season.id}:1` },
    });
    expect(failed?.value).toMatch(/^failed:honors:initial:/);

    mockSend.mockResolvedValue(true);
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(await markerCount(`honorsAnnounced:${season.id}:1`)).toBe(1);
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(mockSend).toHaveBeenCalledTimes(2); // 1 failed + 1 success

    // No webhook → quiet, marker untouched (nothing burned).
    await prisma.setting.deleteMany({
      where: { key: `honorsAnnounced:${season.id}:1` },
    });
    mockHook.mockResolvedValue(null);
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(await markerCount(`honorsAnnounced:${season.id}:1`)).toBe(0);
  });

  it("holds a final week until every played series has a valid 5v5 box score", async () => {
    const { season, match } = await setupCompletedWeek();
    await prisma.game.updateMany({
      where: { matchId: match.id },
      data: { players: "[]" },
    });

    await maybeAnnounceWeekHonors(season.id, 1);

    expect(mockSend).not.toHaveBeenCalled();
    expect(await markerCount(`honorsAnnounced:${season.id}:1`)).toBe(0);
  });

  it("reclaims a stale award once and labels the replacement as a correction", async () => {
    const { season } = await setupCompletedWeek();
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(mockSend).toHaveBeenCalledTimes(1);

    await prisma.$transaction((tx) => markWeekHonorsStale(tx, season.id, 1));
    await raceAll([
      () => maybeAnnounceWeekHonors(season.id, 1),
      () => maybeAnnounceWeekHonors(season.id, 1),
    ]);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1][0]).toMatch(
      /Correction: Week 1 honors have been updated/i,
    );
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it.skipIf(!ON_POSTGRES)(
    "lets only one worker claim the same stale award snapshot",
    async () => {
      const { season } = await setupCompletedWeek();
      const marker = `honorsAnnounced:${season.id}:1`;
      await prisma.setting.create({
        data: { key: marker, value: "stale:shared-snapshot" },
      });
      const originalFind = prisma.setting.findUnique.bind(prisma.setting);
      let reads = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      const findSpy = vi.spyOn(prisma.setting, "findUnique").mockImplementation(
        (async (args: Parameters<typeof originalFind>[0]) => {
          const row = await originalFind(args);
          if (args.where.key === marker && reads < 2) {
            reads += 1;
            if (reads === 2) release();
            await bothRead;
          }
          return row;
        }) as never,
      );

      try {
        await Promise.all([
          maybeAnnounceWeekHonors(season.id, 1),
          maybeAnnounceWeekHonors(season.id, 1),
        ]);
      } finally {
        findSpy.mockRestore();
      }

      expect(reads).toBe(2);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0]).toMatch(/Correction: Week 1 honors/i);
    },
  );

  it("keeps a failed correction retryable without posting it twice", async () => {
    const { season } = await setupCompletedWeek();
    await maybeAnnounceWeekHonors(season.id, 1);
    await prisma.$transaction((tx) => markWeekHonorsStale(tx, season.id, 1));
    mockSend.mockResolvedValueOnce(false);
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(
      await prisma.setting.findUnique({
        where: { key: `honorsAnnounced:${season.id}:1` },
      }),
    ).toMatchObject({
      value: expect.stringMatching(/^failed:honors:corrected:/),
    });

    await runResultSync();
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(mockSend).toHaveBeenCalledTimes(3); // initial + failed + one retry
  });

  it("does not overwrite a newer correction claim when its readiness recheck fails", async () => {
    const { season } = await setupCompletedWeek();
    const marker = `honorsAnnounced:${season.id}:1`;
    const rivalClaim = "claim:honors:corrected:rival-worker";
    const originalReadiness =
      honorsReadinessService.getSeasonHonorReadiness.bind(
        honorsReadinessService,
      );
    let reads = 0;
    const readinessSpy = vi
      .spyOn(honorsReadinessService, "getSeasonHonorReadiness")
      .mockImplementation(async (...args) => {
        const result = await originalReadiness(...args);
        reads += 1;
        if (reads === 2) {
          // Model result repair plus the next heartbeat reclaiming the stale
          // marker while this worker still holds its old readiness snapshot.
          await prisma.setting.update({
            where: { key: marker },
            data: { value: rivalClaim },
          });
          return [];
        }
        return result;
      });

    try {
      await maybeAnnounceWeekHonors(season.id, 1);
    } finally {
      readinessSpy.mockRestore();
    }

    expect(reads).toBe(2);
    expect(mockSend).not.toHaveBeenCalled();
    expect(
      await prisma.setting.findUniqueOrThrow({ where: { key: marker } }),
    ).toMatchObject({ value: rivalClaim });
  });

  it.each([
    [false, "failed send"],
    [true, "accepted send"],
  ])(
    "preserves a repair marker across an in-flight %s",
    async (accepted) => {
      const { season } = await setupCompletedWeek();
      const marker = `honorsAnnounced:${season.id}:1`;
      let release!: (accepted: boolean) => void;
      let started!: () => void;
      const heldSend = new Promise<boolean>((resolve) => {
        release = resolve;
      });
      const sendStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      mockSend.mockImplementationOnce(async () => {
        started();
        return heldSend;
      });

      const announcing = maybeAnnounceWeekHonors(season.id, 1);
      await sendStarted;
      await prisma.$transaction((tx) =>
        markWeekHonorsStale(tx, season.id, 1),
      );
      release(accepted);
      await announcing;

      expect(
        (
          await prisma.setting.findUniqueOrThrow({ where: { key: marker } })
        ).value,
      ).toMatch(/^stale:/);

      // The next heartbeat owns a correction regardless of whether Discord
      // accepted or rejected the obsolete in-flight publication.
      await maybeAnnounceWeekHonors(season.id, 1);
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[1][0]).toMatch(/Correction: Week 1 honors/i);
    },
  );
});

describe("week-reminder announcement retry", () => {
  it("releases the week marker on a failed send so the next load retries", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: home.id,
        awayTeamId: away.id,
        scheduledAt: new Date(Date.now() + 4 * 3600_000),
      },
    });

    mockSend.mockResolvedValue(false);
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(false);
    expect(await markerCount(`weekReminder:${season.id}:1`)).toBe(0);

    mockSend.mockResolvedValue(true);
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    expect(await markerCount(`weekReminder:${season.id}:1`)).toBe(1);
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(false); // once-only
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe("the missing-team exit stamps failed: instead of burning the marker", () => {
  // Practically unreachable while the match exists (Match→Team is
  // FK-RESTRICT), but the bare `return false` after the claim was the one
  // path violating this file's "a failed send never permanently eats an
  // announcement" rule: the marker held a plain timestamp the retry sweep
  // refuses to re-claim. It now stamps failed:<iso> — retryable if the match
  // is alive, swept as an orphan if it was deleted mid-flight.
  it("stamps failed: when a team row is missing, and never sends", async () => {
    const out = await announceSeriesResultOnce({
      id: "ghost-match-1",
      homeTeamId: "no-such-team-a",
      awayTeamId: "no-such-team-b",
      homeScore: 2,
      awayScore: 0,
      week: 1,
      phase: "REGULAR",
    });
    expect(out).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    const marker = await prisma.setting.findUniqueOrThrow({
      where: { key: "resultAnnounced:ghost-match-1" },
    });
    expect(marker.value.startsWith("failed:")).toBe(true);
  });
});

describe("champion announcement retry", () => {
  // The crowning has exactly ONE natural trigger, ever: advancePlayoffBracket
  // early-returns unless the season is PLAYOFFS, and the crowning claim has
  // just set it COMPLETE. So before the marker existed, one failed send ate
  // the message of the season permanently — no path re-triggered it.
  async function crownedSeason() {
    const season = await makeSeason({ status: SEASON_STATUS.COMPLETE });
    const champ = await makeTeam(season.id, "Winners", 0);
    await prisma.season.update({
      where: { id: season.id },
      data: { championTeamId: champ.id },
    });
    return { season, champ };
  }

  it("stamps failed: on a dead webhook, then a later sweep announces it", async () => {
    const { season } = await crownedSeason();
    mockSend.mockResolvedValue(false);

    expect(await announceChampionOnce(season.id)).toBe(false);
    const marker = await prisma.setting.findUniqueOrThrow({
      where: { key: championAnnouncedKey(season.id) },
    });
    expect(marker.value).toMatch(/^failed:/);

    // Discord comes back; the sitewide sweep re-claims exactly this marker.
    mockSend.mockReset();
    mockSend.mockResolvedValue(true);
    await runResultSync();

    const sent = mockSend.mock.calls.map((c) => String(c[0]));
    expect(sent.some((m) => m.includes("champions"))).toBe(true);
    const after = await prisma.setting.findUniqueOrThrow({
      where: { key: championAnnouncedKey(season.id) },
    });
    expect(after.value).not.toMatch(/^failed:/);
  });

  it("never announces twice once it has succeeded", async () => {
    const { season } = await crownedSeason();
    expect(await announceChampionOnce(season.id)).toBe(true);
    mockSend.mockReset();
    mockSend.mockResolvedValue(true);

    expect(await announceChampionOnce(season.id)).toBe(false);
    await runResultSync();

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not announce a stored champion that conflicts with the saved final", async () => {
    const { season, champ: storedChampion } = await crownedSeason();
    const actualWinner = await makeTeam(season.id, "Actual winners", 1);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: "FINAL",
        bracketSlot: "R0M0",
        status: "COMPLETED",
        homeTeamId: actualWinner.id,
        awayTeamId: storedChampion.id,
        homeScore: 3,
        awayScore: 1,
        winnerTeamId: actualWinner.id,
        bestOf: 5,
      },
    });
    mockSend.mockClear();

    expect(await announceChampionOnce(season.id)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    expect(
      await prisma.setting.findUnique({
        where: { key: championAnnouncedKey(season.id) },
      }),
    ).toBeNull();
  });

  it("a webhook configured after crowning announces on the next sync", async () => {
    // The league that wires Discord up later must still get its champion.
    const { season } = await crownedSeason();
    mockHook.mockResolvedValue("");

    expect(await announceChampionOnce(season.id)).toBe(false);
    expect(
      await prisma.setting.findUnique({
        where: { key: championAnnouncedKey(season.id) },
      }),
    ).toBeNull();

    mockHook.mockResolvedValue("https://discord.test/hook");
    mockSend.mockClear();
    await runResultSync();

    expect(
      mockSend.mock.calls.some((call) => String(call[0]).includes("champions")),
    ).toBe(true);
    expect(
      await prisma.setting.findUnique({
        where: { key: championAnnouncedKey(season.id) },
      }),
    ).not.toBeNull();
  });

  it("drops the marker instead of retrying forever when the season was un-crowned", async () => {
    // Reset playoffs un-crowns; a stale failed marker would otherwise occupy a
    // sweep slot on every run — the orphan lesson from the series sweep.
    const { season } = await crownedSeason();
    mockSend.mockResolvedValue(false);
    await announceChampionOnce(season.id);
    await prisma.season.update({
      where: { id: season.id },
      data: { championTeamId: null, status: SEASON_STATUS.PLAYOFFS },
    });

    expect(await announceChampionOnce(season.id)).toBe(false);
    expect(
      await prisma.setting.findUnique({
        where: { key: championAnnouncedKey(season.id) },
      }),
    ).toBeNull();
  });
});
