import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  INHOUSE,
  INHOUSE_PLAYING_STATUSES,
  INHOUSE_STATUS,
} from "@/lib/constants";
import { effectiveDotaAccountId } from "@/lib/dota-account";
import { maybeAutoDetectResult } from "@/lib/inhouse-service";
import { makeUser } from "./factories";

vi.mock("@/lib/dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota")>();
  return {
    ...actual,
    fetchRecentMatchIds: vi.fn(async () => [] as number[]),
    fetchOpenDotaMatch: vi.fn(async () => null),
  };
});
import { fetchRecentMatchIds } from "@/lib/dota";

const NOW = Date.UTC(2026, 8, 4, 18);
const dueStartedAt = () =>
  new Date(NOW - (INHOUSE.DETECT_MIN_MINUTES + 1) * 60_000);

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fetchRecentMatchIds).mockClear();
});

async function game(
  startedAt = dueStartedAt(),
  detectedAt: Date | null = null,
  createdAt = new Date(NOW - 30 * 60_000),
) {
  return prisma.inhouseLobby.create({
    data: {
      status: INHOUSE_STATUS.IN_PROGRESS,
      createdAt,
      startedAt,
      detectedAt,
    },
  });
}

describe("automatic inhouse detection read budget", () => {
  it("does not load a roster or claim a scan before a game is old enough", async () => {
    // Started the moment teams locked, so neither clock has opened yet.
    await game(new Date(NOW), null, new Date(NOW - 5 * 60_000));
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const probe = vi.spyOn(prisma.inhouseLobby, "findMany");
    const roster = vi.spyOn(prisma.inhouseLobbyPlayer, "findMany");
    const claim = vi.spyOn(prisma.inhouseLobby, "updateMany");

    expect(await maybeAutoDetectResult()).toBe(false);
    expect(probe).toHaveBeenCalledOnce();
    // This hot probe (every game being played, at most MAX_LIVE_GAMES) must
    // not hydrate result JSON or joined user profiles.
    expect(probe.mock.calls[0]?.[0]).toEqual({
      where: { status: { in: INHOUSE_PLAYING_STATUSES } },
      select: {
        id: true,
        slot: true,
        status: true,
        createdAt: true,
        startedAt: true,
        detectedAt: true,
        radiantTeam: true,
      },
    });
    expect(roster).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(fetchRecentMatchIds).not.toHaveBeenCalled();
  });

  it("waits the longer READY floor from formation before scanning a game nobody started", async () => {
    // Formed just inside the READY floor: the draft has barely finished and
    // the group is still hosting, so no scan, claim or roster load yet.
    await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.READY,
        createdAt: new Date(
          NOW - (INHOUSE.DETECT_READY_MIN_MINUTES - 1) * 60_000,
        ),
      },
    });
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const roster = vi.spyOn(prisma.inhouseLobbyPlayer, "findMany");
    const claim = vi.spyOn(prisma.inhouseLobby, "updateMany");

    expect(await maybeAutoDetectResult()).toBe(false);
    expect(roster).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(fetchRecentMatchIds).not.toHaveBeenCalled();
  });

  it("keeps scanning a game whose Start was pressed long after teams locked", async () => {
    // Formed an hour ago; the formation window opened long before someone
    // pressed the optional Start just now. The press must not buy the game
    // another DETECT_MIN_MINUTES of silence.
    const lobby = await game(new Date(NOW), null, new Date(NOW - 60 * 60_000));
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const claim = vi.spyOn(prisma.inhouseLobby, "updateMany");

    expect(await maybeAutoDetectResult()).toBe(false);
    expect(claim).toHaveBeenCalledOnce();
    const after = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
      select: { detectedAt: true },
    });
    expect(after.detectedAt).toEqual(new Date(NOW));
  });

  it("uses only the clock probe while the shared scan cooldown is current", async () => {
    await game(dueStartedAt(), new Date(NOW - 1_000));
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const roster = vi.spyOn(prisma.inhouseLobbyPlayer, "findMany");
    const claim = vi.spyOn(prisma.inhouseLobby, "updateMany");

    expect(await maybeAutoDetectResult()).toBe(false);
    expect(roster).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(fetchRecentMatchIds).not.toHaveBeenCalled();
  });

  it("does not load a roster after losing the guarded scan claim", async () => {
    await game();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const roster = vi.spyOn(prisma.inhouseLobbyPlayer, "findMany");
    vi.spyOn(prisma.inhouseLobby, "updateMany").mockResolvedValueOnce({ count: 0 });

    expect(await maybeAutoDetectResult()).toBe(false);
    expect(roster).not.toHaveBeenCalled();
    expect(fetchRecentMatchIds).not.toHaveBeenCalled();
  });

  it.each(["current override", "legacy override", "Steam fallback"] as const)(
    "loads only the winning scan's identities and preserves the %s",
    async (identity) => {
      const lobby = await game();
      const user = await makeUser(`Detection ${identity}`);
      const linked = await prisma.user.update({
        where: { id: user.id },
        data: {
          dotaAccountIdV2: identity === "current override" ? 123_456_789 : null,
          legacyDotaAccountId: identity !== "Steam fallback" ? 987_654_321 : null,
        },
      });
      await prisma.inhouseLobbyPlayer.create({
        data: { lobbyId: lobby.id, userId: user.id, team: 1 },
      });
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const roster = vi.spyOn(prisma.inhouseLobbyPlayer, "findMany");

      expect(await maybeAutoDetectResult()).toBe(false);
      expect(roster).toHaveBeenCalledOnce();
      expect(roster.mock.calls[0]?.[0]).toMatchObject({
        where: {
          lobbyId: lobby.id,
          lobby: {
            status: { in: INHOUSE_PLAYING_STATUSES },
            detectedAt: new Date(NOW),
          },
        },
        select: {
          userId: true,
          team: true,
          user: {
            select: {
              name: true,
              dotaAccountIdV2: true,
              legacyDotaAccountId: true,
              steamId: true,
            },
          },
        },
      });
      expect(fetchRecentMatchIds).toHaveBeenCalledExactlyOnceWith(
        effectiveDotaAccountId(linked),
        10,
        {},
      );
      const after = await prisma.inhouseLobby.findUniqueOrThrow({
        where: { id: lobby.id },
        select: { detectedAt: true },
      });
      expect(after.detectedAt).toEqual(new Date(NOW));
    },
  );
});
