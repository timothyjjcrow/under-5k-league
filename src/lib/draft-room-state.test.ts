import { beforeEach, describe, expect, it, vi } from "vitest";

// pollDraftRoomState's claim path with its database faked: what a tick does
// around the 2s settle claim. The real thing, through the route and a
// database, is test/integration/draft-room-longpoll.itest.ts.

const mocks = vi.hoisted(() => ({
  loadDraftRoomRows: vi.fn(),
  resolveExpiredNomination: vi.fn(),
  resolveStalledNomination: vi.fn(),
  claimThrottle: vi.fn(),
  recordCaptainPresence: vi.fn(),
  publishDraftRoomChange: vi.fn(),
  readDraftRoomVersion: vi.fn(),
  invalidateAutomationGateBestEffort: vi.fn(),
}));

vi.mock("./draft-service", () => ({
  loadDraftRoomRows: mocks.loadDraftRoomRows,
  resolveExpiredNomination: mocks.resolveExpiredNomination,
  resolveStalledNomination: mocks.resolveStalledNomination,
  buildDraftState: (viewer: { id: string } | null) => ({ built: true, viewer: viewer?.id ?? null }),
}));
vi.mock("./settings", () => ({
  claimThrottle: mocks.claimThrottle,
  SETTING_KEYS: { DRAFT_ROOM_MAINTENANCE_AT: "draftRoomMaintenanceAt" },
}));
vi.mock("./draft-presence-service", () => ({
  recordCaptainPresence: mocks.recordCaptainPresence,
}));
vi.mock("./draft-room-version", () => ({
  draftRoomLocalGeneration: () => 0,
  publishDraftRoomChange: mocks.publishDraftRoomChange,
  readDraftRoomVersion: mocks.readDraftRoomVersion,
  readDraftRoomVersionToken: async () => "v1",
}));
vi.mock("./automation-gate-invalidation", () => ({
  invalidateAutomationGateBestEffort: mocks.invalidateAutomationGateBestEffort,
}));

import { pollDraftRoomState, resetDraftRoomCacheForTests } from "./draft-room-state";

const viewer = { id: "pool-1", steamId: "1", name: "Pool", avatar: null, role: "USER" };

/** A live auction whose lot's bid clock ran out a second ago. */
function dueRows() {
  return {
    season: { id: "s1", isActive: true, status: "DRAFT" },
    draft: {
      status: "IN_PROGRESS",
      nominatedUserId: "player-1",
      currentBidTeamId: "team-1",
      nominatorTeamId: "team-1",
      bidEndsAt: new Date(Date.now() - 1_000),
      nominationEndsAt: null,
    },
    teams: [{ id: "team-1", captainId: "captain-1", members: [] }],
    captainLastSeen: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftRoomCacheForTests();
  mocks.readDraftRoomVersion.mockResolvedValue("v1");
  mocks.loadDraftRoomRows.mockResolvedValue(dueRows());
});

describe("pollDraftRoomState's settle claim", () => {
  it("a signed-in tick that finds the clock run out settles it under the claim", async () => {
    mocks.claimThrottle.mockResolvedValue(true);
    // The settle publishes: the copy read after it is labelled with the
    // new version, so this client's next tick holds instead of asking again.
    mocks.resolveExpiredNomination.mockImplementation(async () => {
      mocks.readDraftRoomVersion.mockResolvedValue("v2");
      return true;
    });
    const result = await pollDraftRoomState(viewer, "s1", "v1");
    expect(mocks.claimThrottle).toHaveBeenCalledWith("draftRoomMaintenanceAt", 2, expect.any(Number));
    expect(mocks.resolveExpiredNomination).toHaveBeenCalledWith("s1");
    expect(mocks.resolveStalledNomination).toHaveBeenCalledWith("s1");
    expect(mocks.loadDraftRoomRows).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      state: { built: true, viewer: "pool-1" },
      version: "v2",
      invalidateGate: true,
    });
  });

  it("a tick that loses the claim reads the copy and changes nothing", async () => {
    mocks.claimThrottle.mockResolvedValue(false);
    const result = await pollDraftRoomState(viewer, "s1", "v1");
    expect(mocks.resolveExpiredNomination).not.toHaveBeenCalled();
    expect(result).toEqual({
      state: { built: true, viewer: "pool-1" },
      version: "v1",
      invalidateGate: false,
    });
  });

  it("a signed-out tick never claims", async () => {
    const result = await pollDraftRoomState(null, "s1", "v1");
    expect(mocks.claimThrottle).not.toHaveBeenCalled();
    expect(result.invalidateGate).toBe(false);
  });

  it("nothing due, nothing claimed", async () => {
    mocks.loadDraftRoomRows.mockResolvedValue({
      ...dueRows(),
      draft: { ...dueRows().draft, bidEndsAt: new Date(Date.now() + 30_000) },
    });
    await pollDraftRoomState(viewer, "s1", "v1");
    expect(mocks.claimThrottle).not.toHaveBeenCalled();
  });

  it("expires the automation gate when the settle throws, then rethrows", async () => {
    // A resolver may have committed before the failure; the route never sees
    // a result to read the flag from.
    mocks.claimThrottle.mockResolvedValue(true);
    mocks.resolveExpiredNomination.mockResolvedValue(true);
    mocks.resolveStalledNomination.mockRejectedValue(new Error("settle failed"));
    await expect(pollDraftRoomState(viewer, "s1", "v1")).rejects.toThrow("settle failed");
    expect(mocks.invalidateAutomationGateBestEffort).toHaveBeenCalledOnce();
  });

  it("a signed-out tick's reply is labelled with the version it was given", async () => {
    expect((await pollDraftRoomState(null, "s1", "v1")).version).toBe("v1");
    // No version row yet: an uncached read, labelled null ("none" to the client).
    resetDraftRoomCacheForTests();
    expect((await pollDraftRoomState(null, "s1", null)).version).toBeNull();
  });
});
