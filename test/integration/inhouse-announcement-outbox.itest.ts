import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  deliverInhouseAnnouncements,
  INHOUSE_ANNOUNCEMENT_KIND,
  INHOUSE_ANNOUNCEMENT_STATUS,
} from "@/lib/inhouse-announcement-outbox";
import { INHOUSE_STATUS } from "@/lib/constants";
import { inhouseResultVoidedMessage } from "@/lib/discord";

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

describe("inhouse announcements — rows written before Cred was retired", () => {
  const resultLine =
    "🏁 **Inhouse result: Radiant win 30–20** in 40:00. MVP: **Ash** (Axe). Box score + ladder: <https://ggd2l.test/inhouse> · <https://www.opendota.com/matches/7000000950>";

  async function unsentEvent(opts: {
    kind: string;
    lobbyStatus: string;
    matchId: string;
    content: string;
  }) {
    const completed = opts.lobbyStatus === INHOUSE_STATUS.COMPLETED;
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status: opts.lobbyStatus,
        completedAt: completed ? new Date() : null,
        winnerTeam: completed ? 1 : null,
        dotaMatchId: completed ? opts.matchId : null,
      },
    });
    await prisma.inhouseAnnouncement.create({
      data: {
        lobbyId: lobby.id,
        kind: opts.kind,
        sequence: opts.kind === INHOUSE_ANNOUNCEMENT_KIND.RESULT ? 1 : 2,
        content: opts.content,
        resultMatchId: opts.matchId,
      },
    });
    return lobby;
  }

  it.each([
    [
      "a pot with live stakes",
      `${resultLine}\n**Pot 200 Cred** · fully covered\nRadiant: Ash 100 → +100\nDire: Bo 100 → -100\n-# Refunded: Cy 50 (lineup changed)`,
    ],
    [
      "only refunded stakes",
      `${resultLine}\n-# Refunded: Cy 50 (placed after the game started)`,
    ],
  ])("posts a result with %s as the plain result line", async (_label, legacy) => {
    const lobby = await unsentEvent({
      kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
      lobbyStatus: INHOUSE_STATUS.COMPLETED,
      matchId: "7000000950",
      content: legacy,
    });
    const send = vi.fn(async (_content: string) => true);

    await expect(
      deliverInhouseAnnouncements({ lobbyId: lobby.id, send }),
    ).resolves.toEqual({ attempted: 1, delivered: 1, pending: false });
    expect(send).toHaveBeenCalledExactlyOnceWith(resultLine);
  });

  it("posts a void correction without the wager reversal copy", async () => {
    const lobby = await unsentEvent({
      kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT_VOIDED,
      lobbyStatus: INHOUSE_STATUS.CANCELLED,
      matchId: "7000000951",
      content:
        "↩️ **That inhouse result has been voided by an admin** — it's off the ladder, and the wagers on it reverse to their pre-game balances: 3 slips, 150 Cred back where it started. The payouts posted for that game no longer stand. <https://www.opendota.com/matches/7000000951>",
    });
    const send = vi.fn(async (_content: string) => true);

    await expect(
      deliverInhouseAnnouncements({ lobbyId: lobby.id, send }),
    ).resolves.toEqual({ attempted: 1, delivered: 1, pending: false });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      inhouseResultVoidedMessage({ dotaMatchId: "7000000951" }),
    );
    expect(send.mock.calls[0][0]).not.toMatch(/Cred|wager|payout/i);
  });
});
