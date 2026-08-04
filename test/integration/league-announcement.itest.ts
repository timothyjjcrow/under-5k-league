import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  deliverLeagueAnnouncements,
  enqueueLeagueAnnouncement,
  InvalidLeagueAnnouncementError,
  LEAGUE_ANNOUNCEMENT_STATUS,
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
