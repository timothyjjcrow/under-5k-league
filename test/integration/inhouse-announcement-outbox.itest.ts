import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  deliverInhouseAnnouncements,
  INHOUSE_ANNOUNCEMENT_KIND,
  INHOUSE_ANNOUNCEMENT_STATUS,
} from "@/lib/inhouse-announcement-outbox";
import { INHOUSE_STATUS } from "@/lib/constants";

afterEach(() => vi.unstubAllEnvs());

describe("inhouse announcements — preview isolation", () => {
  it.each([
    INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
    INHOUSE_ANNOUNCEMENT_STATUS.SENDING,
  ])("preserves a copied %s event and resumes it after the block clears", async (status) => {
    const now = new Date();
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.COMPLETED,
        completedAt: now,
        winnerTeam: 1,
        dotaMatchId: "7000000901",
      },
    });
    const before = await prisma.inhouseAnnouncement.create({
      data: {
        lobbyId: lobby.id,
        kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
        sequence: 1,
        content: "durable result",
        resultMatchId: lobby.dotaMatchId,
        status,
        attempts: status === INHOUSE_ANNOUNCEMENT_STATUS.SENDING ? 2 : 0,
        availableAt: new Date(now.getTime() - 60_000),
        claimedAt:
          status === INHOUSE_ANNOUNCEMENT_STATUS.SENDING
            ? new Date(now.getTime() - 60_000)
            : null,
        claimToken: status === INHOUSE_ANNOUNCEMENT_STATUS.SENDING ? "old-lease" : null,
      },
    });
    const send = vi.fn(async () => true);
    vi.stubEnv("VERCEL_ENV", "preview");

    await expect(
      deliverInhouseAnnouncements({ lobbyId: lobby.id, now, send }),
    ).resolves.toEqual({ attempted: 0, delivered: 0, pending: true });
    expect(send).not.toHaveBeenCalled();
    expect(
      await prisma.inhouseAnnouncement.findUniqueOrThrow({ where: { id: before.id } }),
    ).toEqual(before);

    // The block leaves the retry/lease eligible rather than burning an attempt
    // or postponing delivery after a real production worker resumes.
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(
      deliverInhouseAnnouncements({ lobbyId: lobby.id, now, send }),
    ).resolves.toEqual({ attempted: 1, delivered: 1, pending: false });
    expect(send).toHaveBeenCalledExactlyOnceWith("durable result");
    expect(
      await prisma.inhouseAnnouncement.findUniqueOrThrow({ where: { id: before.id } }),
    ).toMatchObject({
      status: INHOUSE_ANNOUNCEMENT_STATUS.SENT,
      attempts: before.attempts + 1,
    });
  });

  it("reports no pending work for an empty preview without invoking the sender", async () => {
    const send = vi.fn(async () => true);
    vi.stubEnv("VERCEL_ENV", "preview");
    await expect(deliverInhouseAnnouncements({ send })).resolves.toEqual({
      attempted: 0,
      delivered: 0,
      pending: false,
    });
    expect(send).not.toHaveBeenCalled();
  });
});
