import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  deliverLeagueAnnouncements,
  discardWaitingLeagueAnnouncements,
  enqueueLeagueAnnouncement,
  expireLeagueAnnouncementGroup,
  InvalidLeagueAnnouncementError,
  LEAGUE_ANNOUNCEMENT_STATUS,
  loadLeagueDeliveryHealth,
  resumeLeagueAnnouncements,
} from "@/lib/league-announcement-outbox";
import {
  deliverInhouseAnnouncements,
  INHOUSE_ANNOUNCEMENT_KIND,
  INHOUSE_ANNOUNCEMENT_STATUS,
} from "@/lib/inhouse-announcement-outbox";
import { INHOUSE_STATUS } from "@/lib/constants";
import { raceN } from "./factories";

describe("league announcement outbox", () => {
  it("deduplicates a stable domain event while distinct actions remain distinct", async () => {
    const first = await enqueueLeagueAnnouncement({
      dedupeKey: "result:match-1:2-0",
      content: "result",
    });
    const duplicate = await enqueueLeagueAnnouncement({
      dedupeKey: "result:match-1:2-0",
      content: "replacement text must not rewrite queued history",
    });
    await enqueueLeagueAnnouncement({ content: "one-off" });
    await enqueueLeagueAnnouncement({ content: "one-off" });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.content).toBe("result");
    expect(await prisma.leagueAnnouncement.count()).toBe(3);
  });

  it("leases, retries with backoff, and preserves the safe mention allowlist", async () => {
    await enqueueLeagueAnnouncement({
      content: "captain action",
      mentions: {
        users: [
          "123456789012345678",
          "bad",
          "123456789012345678",
        ],
        roles: ["223456789012345678"],
      },
    });
    const now = new Date(Date.now() + 1_000);
    const rejected = vi.fn(async () => false);

    expect(await deliverLeagueAnnouncements({ now, send: rejected })).toEqual({
      attempted: 1,
      delivered: 0,
      pending: true,
    });
    expect(rejected).toHaveBeenCalledWith("captain action", {
      users: ["123456789012345678"],
      roles: ["223456789012345678"],
    });
    const pending = await prisma.leagueAnnouncement.findFirstOrThrow();
    expect(pending).toMatchObject({
      status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
      attempts: 1,
      lastErrorCode: "TRANSPORT_REJECTED",
      claimToken: null,
    });

    const accepted = vi.fn(async () => true);
    expect(
      await deliverLeagueAnnouncements({
        now: new Date(now.getTime() + 29_999),
        send: accepted,
      }),
    ).toEqual({ attempted: 0, delivered: 0, pending: true });
    expect(
      await deliverLeagueAnnouncements({
        now: new Date(now.getTime() + 30_000),
        send: accepted,
      }),
    ).toEqual({ attempted: 1, delivered: 1, pending: false });
  });

  it("rejects poison payloads before insertion, including mention expansion", async () => {
    const tooLongAfterMention = "x".repeat(1_980);
    for (const input of [
      { content: "" },
      { content: "   " },
      { content: "x".repeat(2_001) },
      {
        content: tooLongAfterMention,
        mentions: { users: ["123456789012345678"] },
      },
      { content: "valid", dedupeKey: "k".repeat(191) },
      {
        content: "valid",
        dedupeKey: "marker-without-valid-event",
        marker: { key: "resultAnnounced:1", eventId: "not-a-uuid" },
      },
      {
        content: "valid",
        marker: {
          key: "resultAnnounced:1",
          eventId: "11111111-1111-4111-8111-111111111111",
        },
      },
    ]) {
      await expect(enqueueLeagueAnnouncement(input)).rejects.toBeInstanceOf(
        InvalidLeagueAnnouncementError,
      );
    }
    expect(await prisma.leagueAnnouncement.count()).toBe(0);
  });

  it.each([
    ["deleted", null],
    ["superseded", "sent:v2:33333333-3333-4333-8333-333333333333:1"],
    ["invalidated", "stale:2026-08-04T00:00:00.000Z"],
  ])("cancels %s marker-backed work before webhook I/O", async (_label, value) => {
    const eventId = "11111111-1111-4111-8111-111111111111";
    const key = "resultAnnounced:match-1";
    if (value) await prisma.setting.create({ data: { key, value } });
    await enqueueLeagueAnnouncement({
      content: "stale result",
      dedupeKey: `stale-${_label}`,
      marker: { key, eventId },
    });
    const send = vi.fn(async () => true);

    await expect(
      deliverLeagueAnnouncements({ send, limit: 1 }),
    ).resolves.toEqual({ attempted: 1, delivered: 0, pending: false });
    expect(send).not.toHaveBeenCalled();
    expect(await prisma.leagueAnnouncement.findFirstOrThrow()).toMatchObject({
      status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
      lastErrorCode: "STALE_SOURCE",
      attempts: 1,
    });
  });

  it("delivers after the same marker event is re-leased to a new owner", async () => {
    const eventId = "11111111-1111-4111-8111-111111111111";
    const firstOwner = "22222222-2222-4222-8222-222222222222";
    const secondOwner = "33333333-3333-4333-8333-333333333333";
    const key = "resultAnnounced:match-1";
    await prisma.setting.create({
      data: { key, value: `claim:v2:1:${eventId}:${firstOwner}` },
    });
    await enqueueLeagueAnnouncement({
      content: "owned result",
      dedupeKey: "owned-event",
      marker: { key, eventId },
    });
    await prisma.setting.update({
      where: { key },
      data: { value: `claim:v2:${Date.now() + 90_000}:${eventId}:${secondOwner}` },
    });
    const send = vi.fn(async () => true);

    await expect(deliverLeagueAnnouncements({ send, limit: 1 })).resolves.toEqual(
      { attempted: 1, delivered: 1, pending: false },
    );
    expect(send).toHaveBeenCalledWith("owned result", undefined);
  });

  it("requeues safely when source ownership cannot be checked", async () => {
    const eventId = "11111111-1111-4111-8111-111111111111";
    const owner = "22222222-2222-4222-8222-222222222222";
    const key = "resultAnnounced:match-1";
    await prisma.setting.create({
      data: { key, value: `claim:v2:${Date.now() + 90_000}:${eventId}:${owner}` },
    });
    await enqueueLeagueAnnouncement({
      content: "wait for database",
      dedupeKey: "source-read-failure",
      marker: { key, eventId },
    });
    const lookup = vi
      .spyOn(prisma.setting, "findUnique")
      .mockRejectedValueOnce(new Error("database unavailable"));
    const send = vi.fn(async () => true);

    await expect(deliverLeagueAnnouncements({ send, limit: 1 })).resolves.toEqual(
      { attempted: 1, delivered: 0, pending: true },
    );
    lookup.mockRestore();
    expect(send).not.toHaveBeenCalled();
    expect(await prisma.leagueAnnouncement.findFirstOrThrow()).toMatchObject({
      status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
      lastErrorCode: "SOURCE_CHECK_FAILED",
      attempts: 1,
    });
  });

  it("keeps ordinary unmarked announcements deliverable", async () => {
    await enqueueLeagueAnnouncement({ content: "ordinary action" });
    const send = vi.fn(async () => true);

    await expect(deliverLeagueAnnouncements({ send, limit: 1 })).resolves.toEqual(
      { attempted: 1, delivered: 1, pending: false },
    );
    expect(send).toHaveBeenCalledWith("ordinary action", undefined);
  });

  it("cancels a legacy invalid head row and still delivers the next event", async () => {
    const poison = await prisma.leagueAnnouncement.create({
      data: { content: "" },
    });
    await enqueueLeagueAnnouncement({ content: "healthy" });
    const send = vi.fn(async () => true);

    await expect(
      deliverLeagueAnnouncements({ send, limit: 1 }),
    ).resolves.toEqual({ attempted: 1, delivered: 1, pending: false });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("healthy", undefined);
    expect(
      await prisma.leagueAnnouncement.findUnique({ where: { id: poison.id } }),
    ).toMatchObject({
      status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
      attempts: 0,
      lastErrorCode: "INVALID_PAYLOAD",
    });
  });

  it("elects only one sender under concurrent drains", async () => {
    await enqueueLeagueAnnouncement({ content: "once" });
    const send = vi.fn(async () => true);

    await raceN(6, () => deliverLeagueAnnouncements({ send, limit: 1 }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(await prisma.leagueAnnouncement.findFirst()).toMatchObject({
      status: LEAGUE_ANNOUNCEMENT_STATUS.SENT,
      attempts: 1,
    });
  });

  it("uses the database clock when the application host is behind", async () => {
    await enqueueLeagueAnnouncement({ content: "clock-safe" });
    const send = vi.fn(async () => true);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
    try {
      await raceN(6, () => deliverLeagueAnnouncements({ send, limit: 1 }));
    } finally {
      vi.useRealTimers();
    }

    expect(send).toHaveBeenCalledTimes(1);
    expect(await prisma.leagueAnnouncement.findFirst()).toMatchObject({
      status: LEAGUE_ANNOUNCEMENT_STATUS.SENT,
      attempts: 1,
    });
  });

  it("uses the database clock for an immediate concurrent inhouse drain", async () => {
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.COMPLETED,
        winnerTeam: 1,
        dotaMatchId: "7000000998",
        completedAt: new Date(),
      },
    });
    await prisma.inhouseAnnouncement.create({
      data: {
        lobbyId: lobby.id,
        kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
        sequence: 1,
        content: "database-clock inhouse event",
        resultMatchId: "7000000998",
      },
    });
    const send = vi.fn(async () => true);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
    try {
      await raceN(6, () =>
        deliverInhouseAnnouncements({ lobbyId: lobby.id, send, limit: 1 }),
      );
    } finally {
      vi.useRealTimers();
    }

    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await prisma.inhouseAnnouncement.findFirstOrThrow(),
    ).toMatchObject({
      status: INHOUSE_ANNOUNCEMENT_STATUS.SENT,
      attempts: 1,
    });
  });

  it("does not let a later event overtake an earlier live lease", async () => {
    await enqueueLeagueAnnouncement({ content: "first" });
    await enqueueLeagueAnnouncement({ content: "second" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sends: string[] = [];
    const firstDrain = deliverLeagueAnnouncements({
      limit: 1,
      send: async (content) => {
        sends.push(content);
        entered();
        await gate;
        return true;
      },
    });
    await started;

    expect(
      await deliverLeagueAnnouncements({
        limit: 1,
        send: async (content) => {
          sends.push(content);
          return true;
        },
      }),
    ).toEqual({ attempted: 0, delivered: 0, pending: true });
    release();
    await firstDrain;
    await deliverLeagueAnnouncements({
      limit: 1,
      send: async (content) => {
        sends.push(content);
        return true;
      },
    });
    expect(sends).toEqual(["first", "second"]);
  });

  it("recovers an expired send lease and fences the old completion", async () => {
    await enqueueLeagueAnnouncement({ content: "recover me" });
    const start = new Date(Date.now() + 1_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const old = deliverLeagueAnnouncements({
      now: start,
      limit: 1,
      send: async () => {
        entered();
        await gate;
        return true;
      },
    });
    await started;

    const recovered = await deliverLeagueAnnouncements({
      now: new Date(start.getTime() + 30_001),
      limit: 1,
      send: async () => true,
    });
    expect(recovered.delivered).toBe(1);
    release();
    expect((await old).delivered).toBe(0);
    expect(await prisma.leagueAnnouncement.findFirst()).toMatchObject({
      status: LEAGUE_ANNOUNCEMENT_STATUS.SENT,
      attempts: 2,
    });
  });
});

describe("league announcement outbox — refusals, expiry and admin controls", () => {
  const MINUTE = 60_000;

  it("drops a post Discord refuses (400) and delivers the next one", async () => {
    await enqueueLeagueAnnouncement({ content: "refused" });
    await enqueueLeagueAnnouncement({ content: "healthy" });
    const sends: string[] = [];
    const send = vi.fn(async (content: string) => {
      sends.push(content);
      return content === "refused" ? { status: 400 } : true;
    });

    await deliverLeagueAnnouncements({ send, limit: 2 });

    expect(sends).toEqual(["refused", "healthy"]);
    const rows = await prisma.leagueAnnouncement.findMany({
      orderBy: { createdAt: "asc" },
      select: { content: true, status: true, lastErrorCode: true },
    });
    expect(rows).toEqual([
      {
        content: "refused",
        status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
        lastErrorCode: "DISCORD_400",
      },
      {
        content: "healthy",
        status: LEAGUE_ANNOUNCEMENT_STATUS.SENT,
        lastErrorCode: null,
      },
    ]);
  });

  it.each([401, 403, 404])(
    "pauses the whole queue on a refused webhook (%i) without dropping posts",
    async (status) => {
      await enqueueLeagueAnnouncement({ content: "proposed" });
      await enqueueLeagueAnnouncement({ content: "accepted" });
      const now = new Date(Date.now() + 1_000);
      const refused = vi.fn(async () => ({ status }));

      expect(
        await deliverLeagueAnnouncements({ now, send: refused, limit: 2 }),
      ).toEqual({ attempted: 1, delivered: 0, pending: true });
      const head = await prisma.leagueAnnouncement.findFirstOrThrow({
        where: { content: "proposed" },
      });
      expect(head).toMatchObject({
        status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
        lastErrorCode: `DISCORD_${status}`,
      });
      // Straight to the slowest retry: a dead webhook is not hammered.
      expect(head.availableAt.getTime()).toBe(now.getTime() + 15 * MINUTE);

      // Nothing overtakes it while paused, however often the queue drains.
      const accepted = vi.fn(async () => true);
      expect(
        await deliverLeagueAnnouncements({
          now: new Date(now.getTime() + 5 * MINUTE),
          send: accepted,
          limit: 2,
        }),
      ).toEqual({ attempted: 0, delivered: 0, pending: true });
      expect(accepted).not.toHaveBeenCalled();

      // A new webhook resumes it at once, still oldest first.
      expect(await resumeLeagueAnnouncements()).toBe(2);
      const sends: string[] = [];
      await deliverLeagueAnnouncements({
        limit: 2,
        send: async (content) => {
          sends.push(content);
          return true;
        },
      });
      expect(sends).toEqual(["proposed", "accepted"]);
    },
  );

  it("retries a Discord outage with backoff and keeps the status code", async () => {
    await enqueueLeagueAnnouncement({ content: "outage" });
    const now = new Date(Date.now() + 1_000);
    await deliverLeagueAnnouncements({
      now,
      send: async () => ({ status: 503 }),
    });
    const row = await prisma.leagueAnnouncement.findFirstOrThrow();
    expect(row).toMatchObject({
      status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
      lastErrorCode: "DISCORD_503",
      attempts: 1,
    });
    expect(row.availableAt.getTime()).toBe(now.getTime() + 30_000);
  });

  it("drops an out-of-date post instead of sending it late", async () => {
    const start = Date.now();
    await enqueueLeagueAnnouncement({
      content: "reminder for tonight",
      expiresAt: new Date(start + 10 * MINUTE),
    });
    await enqueueLeagueAnnouncement({ content: "result" });
    const sends: string[] = [];

    await deliverLeagueAnnouncements({
      now: new Date(start + 11 * MINUTE),
      limit: 2,
      send: async (content) => {
        sends.push(content);
        return true;
      },
    });

    expect(sends).toEqual(["result"]);
    expect(
      await prisma.leagueAnnouncement.findFirstOrThrow({
        where: { content: "reminder for tonight" },
      }),
    ).toMatchObject({
      status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
      lastErrorCode: "EXPIRED",
      attempts: 0,
    });
  });

  it("drops an expired head even while it waits out a paused retry", async () => {
    const start = Date.now();
    await enqueueLeagueAnnouncement({
      content: "draft is live",
      expiresAt: new Date(start + 5 * MINUTE),
    });
    await enqueueLeagueAnnouncement({ content: "teams" });
    await deliverLeagueAnnouncements({
      now: new Date(start + 1_000),
      send: async () => ({ status: 404 }),
    });

    // Past its expiry but well before its 15-minute retry.
    const sends: string[] = [];
    await deliverLeagueAnnouncements({
      now: new Date(start + 6 * MINUTE),
      send: async (content) => {
        sends.push(content);
        return true;
      },
    });
    expect(sends).toEqual(["teams"]);
  });

  it("leaves a post that expires mid-send to the sender that holds it", async () => {
    const start = new Date(Date.now() + 1_000);
    await enqueueLeagueAnnouncement({
      content: "in flight",
      expiresAt: new Date(start.getTime() + 5_000),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = deliverLeagueAnnouncements({
      now: start,
      limit: 1,
      send: async () => {
        entered();
        await gate;
        return true;
      },
    });
    await started;

    // Another drain after the expiry, inside the first sender's live lease.
    const other = vi.fn(async () => true);
    await deliverLeagueAnnouncements({
      now: new Date(start.getTime() + 10_000),
      limit: 1,
      send: other,
    });
    release();
    expect((await first).delivered).toBe(1);
    expect(other).not.toHaveBeenCalled();
    expect(await prisma.leagueAnnouncement.findFirstOrThrow()).toMatchObject({
      status: LEAGUE_ANNOUNCEMENT_STATUS.SENT,
    });
  });

  it("expires one group's waiting posts and nothing else", async () => {
    await prisma.leagueAnnouncement.createMany({
      data: [
        { content: "live post", dedupeKey: "draft-live:s1:a" },
        {
          content: "already out",
          dedupeKey: "draft-live:s1:b",
          status: LEAGUE_ANNOUNCEMENT_STATUS.SENT,
          sentAt: new Date(),
        },
        { content: "other season", dedupeKey: "draft-live:s10:c" },
        { content: "result" },
      ],
    });

    expect(await expireLeagueAnnouncementGroup("draft-live:s1:")).toBe(1);
    // A malformed group matches nothing rather than everything.
    expect(await expireLeagueAnnouncementGroup("")).toBe(0);

    const byContent = Object.fromEntries(
      (await prisma.leagueAnnouncement.findMany()).map((row) => [
        row.content,
        row.status,
      ]),
    );
    expect(byContent).toEqual({
      "live post": LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
      "already out": LEAGUE_ANNOUNCEMENT_STATUS.SENT,
      "other season": LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
      result: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
    });
  });

  it("discards only the waiting posts the admin was shown", async () => {
    const t = Date.now() - 60 * MINUTE;
    const at = (minutes: number) => new Date(t + minutes * MINUTE);
    await prisma.leagueAnnouncement.createMany({
      data: [
        { content: "stale", createdAt: at(0) },
        {
          content: "delivered",
          createdAt: at(1),
          status: LEAGUE_ANNOUNCEMENT_STATUS.SENT,
          sentAt: at(1),
        },
        {
          content: "dead worker",
          createdAt: at(2),
          status: LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
          claimedAt: at(2),
          claimToken: "11111111-1111-4111-8111-111111111111",
        },
        {
          content: "mid-send",
          createdAt: at(3),
          status: LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
          claimedAt: new Date(),
          claimToken: "22222222-2222-4222-8222-222222222222",
        },
        { content: "queued after the page loaded", createdAt: at(10) },
      ],
    });

    expect(await discardWaitingLeagueAnnouncements(at(5))).toBe(2);

    const byContent = Object.fromEntries(
      (await prisma.leagueAnnouncement.findMany()).map((row) => [
        row.content,
        [row.status, row.lastErrorCode],
      ]),
    );
    expect(byContent).toEqual({
      stale: [LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED, "DISCARDED"],
      delivered: [LEAGUE_ANNOUNCEMENT_STATUS.SENT, null],
      "dead worker": [LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED, "DISCARDED"],
      "mid-send": [LEAGUE_ANNOUNCEMENT_STATUS.SENDING, null],
      "queued after the page loaded": [
        LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
        null,
      ],
    });
  });

  it("reports delivery health from the queue alone", async () => {
    const now = new Date();
    const at = (minutes: number) => new Date(now.getTime() + minutes * MINUTE);
    await prisma.leagueAnnouncement.createMany({
      data: [
        {
          content: "delivered",
          createdAt: at(-120),
          status: LEAGUE_ANNOUNCEMENT_STATUS.SENT,
          sentAt: at(-90),
        },
        {
          content: "refused\nsecond line",
          createdAt: at(-80),
          status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
          lastErrorCode: "DISCORD_400",
        },
        {
          content: "too late",
          createdAt: at(-70),
          status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
          lastErrorCode: "EXPIRED",
        },
        {
          content: "head",
          createdAt: at(-40),
          availableAt: at(10),
          lastErrorCode: "DISCORD_404",
          attempts: 3,
        },
        { content: "behind", createdAt: at(-5) },
      ],
    });

    expect(await loadLeagueDeliveryHealth(now)).toEqual({
      checkedAt: now,
      waiting: 2,
      oldestWaitingAt: at(-40),
      newestWaitingAt: at(-5),
      headErrorCode: "DISCORD_404",
      headRetryAt: at(10),
      lastDeliveredAt: at(-90),
      refusedRecently: 1,
      lastRefusedCode: "DISCORD_400",
      lastRefusedPreview: "refused",
      expiredRecently: 1,
    });
  });
});
