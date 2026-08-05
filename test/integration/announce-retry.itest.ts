import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { onceAt, setRaceHook } from "@/lib/race-hook";
import {
  claimAnnouncementMarker,
  markAnnouncementSent,
} from "@/lib/announcement-marker";

// A Discord blip (timeout, 5xx, revoked webhook) must never permanently eat a
// once-only announcement: every claim-then-send path leaves an explicitly
// retryable marker when durable acceptance fails, so the next worker retries —
// and a successful send still cannot double-post.

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

afterEach(() => setRaceHook(null));

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
        completedAt: new Date(),
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
    const failedEvent = /^failed:v2:([^:]+):/.exec(failed?.value ?? "")?.[1];
    expect(failedEvent).toBeTruthy(); // flagged, not lost
    const firstDedupeKey = mockSend.mock.calls[0]?.[2]?.dedupeKey;
    expect(firstDedupeKey).toMatch(new RegExp(`${failedEvent}$`));

    mockSend.mockResolvedValue(true); // Discord back
    expect(await announceSeriesResultOnce(match)).toBe(true);
    const sent = await prisma.setting.findUnique({
      where: { key: `resultAnnounced:${match.id}` },
    });
    expect(sent?.value).toMatch(new RegExp(`^sent:v2:${failedEvent}:`));
    // Retrying the same marker generation must address the same durable event,
    // so a crash after enqueue cannot create a second outbox row.
    expect(mockSend.mock.calls[1]?.[2]?.dedupeKey).toBe(firstDedupeKey);
    // …and it stays once-only afterwards.
    expect(await announceSeriesResultOnce(match)).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(2); // 1 failed + 1 success
  });

  it("treats historical sent markers and active v2 claims as final/in flight", async () => {
    const match = await setupDecidedMatch();
    const key = `resultAnnounced:${match.id}`;
    await prisma.setting.create({
      data: { key, value: "2026-08-04T00:00:00.000Z" },
    });

    expect(await announceSeriesResultOnce(match)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();

    const eventId = "11111111-1111-4111-8111-111111111111";
    const ownerId = "22222222-2222-4222-8222-222222222222";
    const activeClaim = `claim:v2:${Date.now() + 60_000}:${eventId}:${ownerId}`;
    await prisma.setting.update({
      where: { key },
      data: { value: activeClaim },
    });

    expect(await announceSeriesResultOnce(match)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    expect(
      (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
    ).toBe(activeClaim);
  });

  it("a stale marker reclaimer cannot overwrite a rival finalized generation", async () => {
    const key = "resultAnnounced:marker-reclaim-race";
    const eventId = "12121212-1212-4212-8212-121212121212";
    const oldOwner = "34343434-3434-4434-8434-343434343434";
    await prisma.setting.create({
      data: {
        key,
        value: `claim:v2:1:${eventId}:${oldOwner}`,
      },
    });

    let rivalFinalized = false;
    setRaceHook(
      onceAt(
        "announcement-marker.claimAnnouncementMarker.beforeReclaim",
        async () => {
          // The real rival reclaims the same expired generation with a new
          // owner, then finalizes it while the outer caller still holds the
          // old value it read. onceAt prevents this nested claim from staging
          // itself recursively.
          const rival = await claimAnnouncementMarker(key);
          if (!rival) throw new Error("Rival marker reclaim did not win");
          expect(rival.eventId).toBe(eventId);
          rivalFinalized = await markAnnouncementSent(rival, 1234);
        },
      ),
    );

    const stale = await claimAnnouncementMarker(key);

    expect(rivalFinalized).toBe(true);
    expect(stale).toBeNull();
    expect(
      (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
    ).toBe(`sent:v2:${eventId}:1234`);
  });

  it("recovers an expired v2 claim with the same event identity", async () => {
    const match = await setupDecidedMatch();
    const key = `resultAnnounced:${match.id}`;
    const eventId = "33333333-3333-4333-8333-333333333333";
    const ownerId = "44444444-4444-4444-8444-444444444444";
    await prisma.setting.create({
      data: {
        key,
        value: `claim:v2:${Date.now() - 1}:${eventId}:${ownerId}`,
      },
    });

    expect(await announceSeriesResultOnce(match)).toBe(true);
    expect(mockSend.mock.calls[0]?.[2]?.dedupeKey).toMatch(
      new RegExp(`${eventId}$`),
    );
    expect(
      (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
    ).toMatch(new RegExp(`^sent:v2:${eventId}:`));
  });

  it("never finalizes over a rival marker value", async () => {
    const match = await setupDecidedMatch();
    const key = `resultAnnounced:${match.id}`;
    const rivalValue = "sent:v2:rival-generation:123";
    mockSend.mockImplementation(async () => {
      await prisma.setting.update({
        where: { key },
        data: { value: rivalValue },
      });
      return true;
    });

    expect(await announceSeriesResultOnce(match)).toBe(false);
    expect(
      (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
    ).toBe(rivalValue);
  });

  it("never stamps failure over a rival marker value", async () => {
    const match = await setupDecidedMatch();
    const key = `resultAnnounced:${match.id}`;
    const rivalValue = "sent:v2:rival-generation:456";
    mockSend.mockImplementation(async () => {
      await prisma.setting.update({
        where: { key },
        data: { value: rivalValue },
      });
      return false;
    });

    expect(await announceSeriesResultOnce(match)).toBe(false);
    expect(
      (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
    ).toBe(rivalValue);
  });

  it("recovers a legacy failed marker into a fenced v2 generation", async () => {
    const match = await setupDecidedMatch();
    const key = `resultAnnounced:${match.id}`;
    await prisma.setting.create({
      data: { key, value: "failed:2026-08-04T00:00:00.000Z" },
    });

    expect(await announceSeriesResultOnce(match)).toBe(true);
    expect(
      (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
    ).toMatch(/^sent:v2:/);
    expect(mockSend.mock.calls[0]?.[2]?.dedupeKey).toMatch(/^series:/);
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

  it("the sync sweep reclaims an expired series lease with its event id", async () => {
    const match = await setupDecidedMatch();
    const key = `resultAnnounced:${match.id}`;
    const eventId = "77777777-7777-4777-8777-777777777777";
    const ownerId = "88888888-8888-4888-8888-888888888888";
    await prisma.setting.create({
      data: {
        key,
        value: `claim:v2:${Date.now() - 1}:${eventId}:${ownerId}`,
      },
    });

    await runResultSync();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]?.[2]).toMatchObject({
      dedupeKey: expect.stringMatching(new RegExp(`${eventId}$`)),
      marker: { key, eventId },
    });
    expect(
      (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
    ).toMatch(new RegExp(`^sent:v2:${eventId}:`));
  });

  it("recovers a post-migration completion whose post-commit effect crashed", async () => {
    const match = await setupDecidedMatch();

    await runResultSync();

    expect(mockSend.mock.calls.map((call) => String(call[0]))).toContainEqual(
      expect.stringMatching(/^⚔️/),
    );
    expect(
      await prisma.setting.findUnique({
        where: { key: `resultAnnounced:${match.id}` },
      }),
    ).toMatchObject({ value: expect.stringMatching(/^sent:v2:/) });
  });

  it("never replays a historical completedAt-null result", async () => {
    const match = await setupDecidedMatch();
    await prisma.match.update({
      where: { id: match.id },
      data: { completedAt: null },
    });

    await runResultSync();

    expect(mockSend).not.toHaveBeenCalled();
    expect(
      await prisma.setting.findUnique({
        where: { key: `resultAnnounced:${match.id}` },
      }),
    ).toBeNull();
  });

  it("suppresses silent-mode results so configuring Discord cannot replay them", async () => {
    const match = await setupDecidedMatch();
    mockHook.mockResolvedValue(null);
    expect(await announceSeriesResultOnce(match)).toBe(false);
    expect(
      await prisma.setting.findUnique({
        where: { key: `resultAnnounced:${match.id}` },
      }),
    ).toMatchObject({
      value: expect.stringMatching(/^suppressed:no-webhook:/),
    });
    expect(mockSend).not.toHaveBeenCalled();

    // Webhook wired up later: this old result remains intentionally quiet.
    mockHook.mockResolvedValue("https://discord.test/hook");
    expect(await announceSeriesResultOnce(match)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("a silent-mode announcer cannot resurrect a result reopened after its webhook read", async () => {
    const match = await setupDecidedMatch();
    const key = `resultAnnounced:${match.id}`;
    mockHook.mockResolvedValue(null);

    let reopened = false;
    setRaceHook(
      onceAt(
        "match-import.announceSeriesResultOnce.beforeSilentModeClaim",
        async () => {
          await prisma.$transaction(async (tx) => {
            await tx.match.update({
              where: { id: match.id },
              data: {
                status: MATCH_STATUS.SCHEDULED,
                homeScore: 0,
                awayScore: 0,
                winnerTeamId: null,
                completedAt: null,
                forfeit: false,
              },
            });
            await tx.setting.deleteMany({ where: { key } });
          });
          reopened = true;
        },
      ),
    );

    expect(await announceSeriesResultOnce(match)).toBe(false);
    expect(reopened).toBe(true);
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: match.id } }),
    ).toMatchObject({
      status: MATCH_STATUS.SCHEDULED,
      homeScore: 0,
      awayScore: 0,
      winnerTeamId: null,
      completedAt: null,
    });
    expect(await prisma.setting.findUnique({ where: { key } })).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", "failed:v2:99999999-9999-4999-8999-999999999999:1"],
    [
      "expired lease",
      "claim:v2:1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ],
  ])(
    "retires a recoverable %s marker when Discord is disabled",
    async (_label, value) => {
      const match = await setupDecidedMatch();
      const key = `resultAnnounced:${match.id}`;
      await prisma.setting.create({ data: { key, value } });
      mockHook.mockResolvedValue(null);

      expect(await announceSeriesResultOnce(match)).toBe(false);

      expect(
        (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
      ).toMatch(/^suppressed:no-webhook:/);
      expect(mockSend).not.toHaveBeenCalled();
    },
  );

  it.skipIf(!ON_POSTGRES)(
    "silent-mode retirement never overwrites a rival finalized marker",
    async () => {
      const match = await setupDecidedMatch();
      const key = `resultAnnounced:${match.id}`;
      const eventId = "56565656-5656-4656-8656-565656565656";
      const oldOwner = "78787878-7878-4878-8878-787878787878";
      await prisma.setting.create({
        data: {
          key,
          value: `claim:v2:1:${eventId}:${oldOwner}`,
        },
      });
      mockHook.mockResolvedValue(null);

      let rivalFinalized = false;
      setRaceHook(
        onceAt(
          "match-import.announceSeriesResultOnce.beforeSilentMarkerRetire",
          async () => {
            const rival = await claimAnnouncementMarker(key);
            if (!rival) throw new Error("Rival marker reclaim did not win");
            expect(rival.eventId).toBe(eventId);
            rivalFinalized = await markAnnouncementSent(rival, 5678);
          },
        ),
      );

      expect(await announceSeriesResultOnce(match)).toBe(false);
      expect(rivalFinalized).toBe(true);
      expect(
        (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
      ).toBe(`sent:v2:${eventId}:5678`);
      expect(mockSend).not.toHaveBeenCalled();
    },
  );

  it("the worker suppresses a crash-gap result while Discord is disabled", async () => {
    const match = await setupDecidedMatch();
    mockHook.mockResolvedValue(null);

    await runResultSync();

    expect(
      await prisma.setting.findUnique({
        where: { key: `resultAnnounced:${match.id}` },
      }),
    ).toMatchObject({
      value: expect.stringMatching(/^suppressed:no-webhook:/),
    });
    mockHook.mockResolvedValue("https://discord.test/hook");
    await prisma.setting.deleteMany({ where: { key: "announceRetryAt" } });
    await runResultSync();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("formats the authoritative row when a delayed caller holds an old score", async () => {
    const stale = await setupDecidedMatch();
    await prisma.match.update({
      where: { id: stale.id },
      data: { homeScore: 2, awayScore: 1, completedAt: new Date() },
    });

    expect(await announceSeriesResultOnce(stale)).toBe(true);

    expect(mockSend.mock.calls[0]?.[0]).toContain("2–1");
    expect(mockSend.mock.calls[0]?.[0]).not.toContain("2–0");
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
        completedAt: new Date(),
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

    // No webhook → quiet and final. Enabling it later cannot replay old awards.
    await prisma.setting.deleteMany({
      where: { key: `honorsAnnounced:${season.id}:1` },
    });
    mockHook.mockResolvedValue(null);
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(
      await prisma.setting.findUnique({
        where: { key: `honorsAnnounced:${season.id}:1` },
      }),
    ).toMatchObject({
      value: expect.stringMatching(/^suppressed:honors:initial:no-webhook:/),
    });
    mockHook.mockResolvedValue("https://discord.test/hook");
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("a result correction survives an in-flight silent-mode suppression", async () => {
    const { season } = await setupCompletedWeek();
    const key = `honorsAnnounced:${season.id}:1`;
    mockHook.mockResolvedValue(null);

    let markedStale = false;
    setRaceHook(
      onceAt("honors.maybeAnnounceWeekHonors.afterClaim", async () => {
        await prisma.$transaction((tx) =>
          markWeekHonorsStale(tx, season.id, 1),
        );
        markedStale = true;
      }),
    );

    await maybeAnnounceWeekHonors(season.id, 1);
    expect(markedStale).toBe(true);
    expect(
      (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
    ).toMatch(/^stale:/);
    expect(mockSend).not.toHaveBeenCalled();

    mockHook.mockResolvedValue("https://discord.test/hook");
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatch(
      /Correction: Week 1 honors have been updated/i,
    );
  });

  it("an all-forfeit correction survives initial no-performance suppression", async () => {
    const { season, match } = await setupCompletedWeek();
    const key = `honorsAnnounced:${season.id}:1`;
    await prisma.$transaction(async (tx) => {
      await tx.game.deleteMany({ where: { matchId: match.id } });
      await tx.match.update({
        where: { id: match.id },
        data: { forfeit: true },
      });
    });

    let markedStale = false;
    setRaceHook(
      onceAt("honors.maybeAnnounceWeekHonors.afterClaim", async () => {
        await prisma.$transaction((tx) =>
          markWeekHonorsStale(tx, season.id, 1),
        );
        markedStale = true;
      }),
    );

    await maybeAnnounceWeekHonors(season.id, 1);
    expect(markedStale).toBe(true);
    expect(
      (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
    ).toMatch(/^stale:/);
    expect(mockSend).not.toHaveBeenCalled();

    await maybeAnnounceWeekHonors(season.id, 1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatch(
      /Correction: Week 1 honors have been updated/i,
    );
    expect(mockSend.mock.calls[0][0]).toMatch(
      /previous honors are withdrawn; no eligible box-score award remains/i,
    );
  });

  it("discovers one ready post-migration week after a lost post-commit effect", async () => {
    const { season } = await setupCompletedWeek();

    await runResultSync();

    expect(
      mockSend.mock.calls.some((call) =>
        String(call[0]).includes("Week 1 honors are in"),
      ),
    ).toBe(true);
    expect(
      await prisma.setting.findUnique({
        where: { key: `honorsAnnounced:${season.id}:1` },
      }),
    ).toMatchObject({ value: expect.stringMatching(/^sent:honors:v2:/) });
  });

  it("does not discover honors from an untouched historical completion", async () => {
    const { season, match } = await setupCompletedWeek();
    await prisma.match.update({
      where: { id: match.id },
      data: { completedAt: null },
    });

    await runResultSync();

    expect(
      mockSend.mock.calls.some((call) => String(call[0]).includes("honors")),
    ).toBe(false);
    expect(
      await prisma.setting.findUnique({
        where: { key: `honorsAnnounced:${season.id}:1` },
      }),
    ).toBeNull();
  });

  it("finds an older ready week behind more than twelve newer partial weeks", async () => {
    const { season, match } = await setupCompletedWeek();
    const base = Date.now();
    for (let week = 2; week <= 14; week += 1) {
      await prisma.match.createMany({
        data: [
          {
            seasonId: season.id,
            week,
            phase: MATCH_PHASE.REGULAR,
            homeTeamId: match.homeTeamId,
            awayTeamId: match.awayTeamId,
            homeScore: 1,
            awayScore: 0,
            status: MATCH_STATUS.COMPLETED,
            winnerTeamId: match.homeTeamId,
            forfeit: true,
            completedAt: new Date(base + week),
          },
          {
            seasonId: season.id,
            week,
            phase: MATCH_PHASE.REGULAR,
            homeTeamId: match.homeTeamId,
            awayTeamId: match.awayTeamId,
            status: MATCH_STATUS.SCHEDULED,
          },
        ],
      });
    }

    await runResultSync();

    expect(
      mockSend.mock.calls.some((call) =>
        String(call[0]).includes("Week 1 honors are in"),
      ),
    ).toBe(true);
    expect(
      await prisma.setting.findUnique({
        where: { key: `honorsAnnounced:${season.id}:1` },
      }),
    ).not.toBeNull();
  });

  it("skips more than four not-ready markers before a ready failed week", async () => {
    const { season, match } = await setupCompletedWeek();
    await prisma.match.update({ where: { id: match.id }, data: { week: 6 } });
    for (let week = 1; week <= 5; week += 1) {
      await prisma.match.create({
        data: {
          seasonId: season.id,
          week,
          phase: MATCH_PHASE.REGULAR,
          homeTeamId: match.homeTeamId,
          awayTeamId: match.awayTeamId,
          status: MATCH_STATUS.SCHEDULED,
        },
      });
      await prisma.setting.create({
        data: {
          key: `honorsAnnounced:${season.id}:${week}`,
          value: `stale:blocker-${week}`,
        },
      });
    }
    const eventId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await prisma.setting.create({
      data: {
        key: `honorsAnnounced:${season.id}:6`,
        value: `failed:honors:initial:v2:${eventId}:${Date.now()}`,
      },
    });

    await runResultSync();

    expect(
      mockSend.mock.calls.some((call) =>
        String(call[0]).includes("Week 6 honors are in"),
      ),
    ).toBe(true);
    expect(
      (
        await prisma.setting.findUniqueOrThrow({
          where: { key: `honorsAnnounced:${season.id}:1` },
        })
      ).value,
    ).toBe("stale:blocker-1");
  });

  it("waits for an active honors lease and recovers its expired event id", async () => {
    const { season } = await setupCompletedWeek();
    const marker = `honorsAnnounced:${season.id}:1`;
    const eventId = "55555555-5555-4555-8555-555555555555";
    const ownerId = "66666666-6666-4666-8666-666666666666";
    await prisma.setting.create({
      data: {
        key: marker,
        value: `claim:honors:v2:${Date.now() + 60_000}:${eventId}:${ownerId}:initial`,
      },
    });

    await maybeAnnounceWeekHonors(season.id, 1);
    expect(mockSend).not.toHaveBeenCalled();

    await prisma.setting.update({
      where: { key: marker },
      data: {
        value: `claim:honors:v2:${Date.now() - 1}:${eventId}:${ownerId}:initial`,
      },
    });
    await maybeAnnounceWeekHonors(season.id, 1);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]?.[2]?.dedupeKey).toMatch(
      new RegExp(`${eventId}$`),
    );
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
      const findSpy = vi
        .spyOn(prisma.setting, "findUnique")
        .mockImplementation((async (
          args: Parameters<typeof originalFind>[0],
        ) => {
          const row = await originalFind(args);
          if (args.where.key === marker && reads < 2) {
            reads += 1;
            if (reads === 2) release();
            await bothRead;
          }
          return row;
        }) as never);

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
    expect(
      mockSend.mock.calls.filter((call) => String(call[0]).includes("honors")),
    ).toHaveLength(3); // initial + failed + one retry (series recovery is separate)
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
  ])("preserves a repair marker across an in-flight %s", async (accepted) => {
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
    await prisma.$transaction((tx) => markWeekHonorsStale(tx, season.id, 1));
    release(accepted);
    await announcing;

    expect(
      (await prisma.setting.findUniqueOrThrow({ where: { key: marker } }))
        .value,
    ).toMatch(/^stale:/);

    // The next heartbeat owns a correction regardless of whether Discord
    // accepted or rejected the obsolete in-flight publication.
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1][0]).toMatch(/Correction: Week 1 honors/i);
  });
});

describe("week-reminder announcement retry", () => {
  it("preserves one reminder generation across a failed durable acceptance", async () => {
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
    const marker = await prisma.setting.findFirstOrThrow({
      where: { key: { startsWith: `weekReminder:${season.id}:1` } },
    });
    const eventId = /^failed:v2:([^:]+):/.exec(marker.value)?.[1];
    expect(eventId).toBeTruthy();
    const firstDedupeKey = mockSend.mock.calls[0]?.[2]?.dedupeKey;
    expect(firstDedupeKey).toMatch(new RegExp(`${eventId}$`));

    mockSend.mockResolvedValue(true);
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    expect(await markerCount(`weekReminder:${season.id}:1`)).toBe(1);
    expect(mockSend.mock.calls[1]?.[2]?.dedupeKey).toBe(firstDedupeKey);
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(false); // once-only
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe("stale series source snapshots", () => {
  it("does not retain a claim created by a caller after its match disappeared", async () => {
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
    expect(
      await prisma.setting.findUnique({
        where: { key: "resultAnnounced:ghost-match-1" },
      }),
    ).toBeNull();
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
    const firstDedupeKey = mockSend.mock.calls[0]?.[2]?.dedupeKey;
    expect(firstDedupeKey).toMatch(/^champion:/);

    // Discord comes back; the sitewide sweep re-claims exactly this marker.
    mockSend.mockReset();
    mockSend.mockResolvedValue(true);
    await runResultSync();

    const sent = mockSend.mock.calls.map((c) => String(c[0]));
    expect(sent.some((m) => m.includes("champions"))).toBe(true);
    expect(mockSend.mock.calls[0]?.[2]?.dedupeKey).toBe(firstDedupeKey);
    const after = await prisma.setting.findUniqueOrThrow({
      where: { key: championAnnouncedKey(season.id) },
    });
    expect(after.value).not.toMatch(/^failed:/);
  });

  it("the sync sweep reclaims an expired champion lease with its event id", async () => {
    const { season } = await crownedSeason();
    const key = championAnnouncedKey(season.id);
    const eventId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const ownerId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await prisma.setting.create({
      data: {
        key,
        value: `claim:v2:${Date.now() - 1}:${eventId}:${ownerId}`,
      },
    });

    await runResultSync();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]?.[2]).toMatchObject({
      dedupeKey: expect.stringMatching(new RegExp(`${eventId}$`)),
      marker: { key, eventId },
    });
    expect(
      (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
    ).toMatch(new RegExp(`^sent:v2:${eventId}:`));
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
    const { season, champ } = await crownedSeason();
    const runnerUp = await makeTeam(season.id, "Runners up", 1);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 3,
        phase: MATCH_PHASE.FINAL,
        bracketSlot: "R0M0",
        status: MATCH_STATUS.COMPLETED,
        homeTeamId: champ.id,
        awayTeamId: runnerUp.id,
        homeScore: 3,
        awayScore: 1,
        winnerTeamId: champ.id,
        bestOf: 5,
        completedAt: new Date(),
      },
    });
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

  it("does not replay an active legacy crown whose final predates recovery", async () => {
    const { season, champ } = await crownedSeason();
    const runnerUp = await makeTeam(season.id, "Legacy runners up", 1);
    const final = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 3,
        phase: MATCH_PHASE.FINAL,
        bracketSlot: "R0M0",
        status: MATCH_STATUS.COMPLETED,
        homeTeamId: champ.id,
        awayTeamId: runnerUp.id,
        homeScore: 3,
        awayScore: 1,
        winnerTeamId: champ.id,
        bestOf: 5,
        completedAt: new Date(),
      },
    });
    // The migration deliberately leaves existing completed rows null.
    await prisma.match.update({
      where: { id: final.id },
      data: { completedAt: null },
    });

    await runResultSync();

    expect(
      mockSend.mock.calls.some((call) => String(call[0]).includes("champions")),
    ).toBe(false);
    expect(
      await prisma.setting.findUnique({
        where: { key: championAnnouncedKey(season.id) },
      }),
    ).toBeNull();
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
