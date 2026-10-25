import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  clearTiebreakerWeek: vi.fn(),
  sendDiscordMessage: vi.fn(),
  logAdminAction: vi.fn(),
}));

vi.mock("next/cache", () => ({ updateTag: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/tiebreaker-service", () => ({
  createTiebreakerWeek: vi.fn(),
  clearTiebreakerWeek: mocks.clearTiebreakerWeek,
}));
vi.mock("@/lib/admin-log", () => ({ logAdminAction: mocks.logAdminAction }));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  sendDiscordMessage: mocks.sendDiscordMessage,
}));

import { resetTiebreakerWeek } from "./tiebreakers";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ id: "admin" });
  mocks.sendDiscordMessage.mockResolvedValue(true);
  mocks.clearTiebreakerWeek.mockResolvedValue({
    matchCount: 1,
    removedGameCount: 0,
    checkins: 0,
    standins: 2,
    standinRequests: 0,
    predictions: 0,
    reschedules: 0,
    standDowns: ["123456789012345678", "223456789012345678"].map((discordId) => ({
      standinName: "Cover",
      discordId,
      teamName: "Alpha",
      homeName: "Alpha",
      awayName: "Bravo",
      week: 6,
    })),
  });
});

const form = () => {
  const data = new FormData();
  data.set("seasonId", "season");
  data.set("expectedRevision", "revision");
  return data;
};

describe("resetTiebreakerWeek stand-downs", () => {
  it("notifies each removed standin using the tiebreaker label and exact mention", async () => {
    const result = await resetTiebreakerWeek(null, form());
    expect(result?.message).toContain("Tiebreaker week reset");
    expect(mocks.sendDiscordMessage).toHaveBeenCalledTimes(2);
    expect(mocks.sendDiscordMessage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("tiebreaker match"),
      { users: ["123456789012345678"] },
    );
    expect(mocks.sendDiscordMessage).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("stand down"),
      { users: ["223456789012345678"] },
    );
  });

  it("preserves a committed reset and continues notifying after failures", async () => {
    mocks.sendDiscordMessage.mockRejectedValueOnce(new Error("unavailable"));
    mocks.sendDiscordMessage.mockResolvedValueOnce(false);
    const result = await resetTiebreakerWeek(null, form());
    expect(result?.error).toBeUndefined();
    expect(result?.message).toContain("Tiebreaker week reset");
    expect(result?.message).toContain("2 standin stand-down notification(s) failed");
    expect(mocks.sendDiscordMessage).toHaveBeenCalledTimes(2);
    expect(mocks.logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.stringContaining("2 Discord stand-down notification(s) failed"),
    }));
  });
});

describe("resetTiebreakerWeek waiting standin requests", () => {
  it("names the cancelled requests in the toast and the log, and posts nothing for them", async () => {
    mocks.clearTiebreakerWeek.mockResolvedValueOnce({
      matchCount: 1, removedGameCount: 0, checkins: 0, standins: 0,
      standinRequests: 2, predictions: 0, reschedules: 0, standDowns: [],
    });
    const result = await resetTiebreakerWeek(null, form());
    expect(result?.message).toContain("Tiebreaker week reset. 2 standin request(s) cancelled. Review");
    expect(mocks.logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.stringContaining("; 2 standin request(s) cancelled"),
    }));
    expect(mocks.sendDiscordMessage).not.toHaveBeenCalled();
  });

  it("says nothing about requests when none were waiting", async () => {
    const result = await resetTiebreakerWeek(null, form());
    expect(result?.message).not.toMatch(/standin request/);
    expect(mocks.logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.not.stringContaining("standin request"),
    }));
  });
});
