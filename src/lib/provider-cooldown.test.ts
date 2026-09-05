import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("./prisma", () => ({
  prisma: {
    setting: { updateMany: mocks.updateMany },
    $executeRaw: mocks.executeRaw,
  },
}));

import {
  claimProviderCooldown,
  providerCooldownKey,
} from "./settings";

beforeEach(() => {
  mocks.updateMany.mockReset();
  mocks.executeRaw.mockReset();
});

describe("provider cooldown safety", () => {
  it("builds an unambiguous per-resource/per-user key", () => {
    expect(
      providerCooldownKey("open-dota-match-scan", "user:1", "match:2"),
    ).toBe(
      "providerCooldown:open-dota-match-scan:match%3A2:user%3A1",
    );
    expect(
      providerCooldownKey(
        "open-dota-match-import",
        "user:1",
        "fixture:match:2",
      ),
    ).toBe(
      "providerCooldown:open-dota-match-import:fixture%3Amatch%3A2:user%3A1",
    );
  });

  it("fails closed without logging a secret-bearing database exception", async () => {
    mocks.executeRaw.mockRejectedValue(
      new Error("postgresql://user:super-secret@internal-db/league"),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      claimProviderCooldown(
        "open-dota-profile",
        "user-1",
        123456,
        1_700_000_000_000,
      ),
    ).resolves.toBe("unavailable");

    expect(log).toHaveBeenCalledWith(
      "[provider-cooldown] claim unavailable (open-dota-profile)",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("super-secret");
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it.each([
    [1, "claimed"],
    [0, "cooldown"],
  ] as const)("resolves a %i-row claim with one database call", async (count, result) => {
    mocks.executeRaw.mockResolvedValue(count);

    await expect(
      claimProviderCooldown("open-dota-profile", "user-1", 123456, 1_700_000_000_000),
    ).resolves.toBe(result);

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
