import { describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));

import { revokeAllSessions } from "@/app/actions/admin";
import { getSessionEpoch, bumpSessionEpoch } from "@/lib/session-epoch";
import { prisma } from "@/lib/prisma";

// Read the persisted epoch directly (bypasses the in-process cache in
// session-epoch.ts so assertions see the DB truth).
async function storedEpoch(): Promise<number> {
  const row = await prisma.setting.findUnique({
    where: { key: "sessionEpoch" },
  });
  return row ? Number(row.value) : 0;
}

describe("session revocation (break-glass epoch)", () => {
  it("revokeAllSessions advances the stored epoch", async () => {
    expect(await storedEpoch()).toBe(0);

    const res = await revokeAllSessions({}, new FormData());

    expect(res?.message).toMatch(/Signed out all users/);
    expect(await storedEpoch()).toBe(1);
  });

  it("bumpSessionEpoch is monotonic from 0", async () => {
    // beforeEach resets the DB, so the epoch starts unset (0).
    expect(await bumpSessionEpoch()).toBe(1);
    expect(await bumpSessionEpoch()).toBe(2);
    expect(await storedEpoch()).toBe(2);
  });

  it("getSessionEpoch reads the stored value (cache-busted by a later timestamp)", async () => {
    expect(await getSessionEpoch(0)).toBe(0);
    await bumpSessionEpoch(); // clears the cache
    // well past the 30s cache TTL so we read fresh regardless of prior caching
    expect(await getSessionEpoch(10_000_000)).toBe(1);
  });
});
