import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { claimThrottle, getSetting } from "@/lib/settings";
import { ON_POSTGRES, raceN } from "./factories";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const INTERVAL_SECONDS = 60;

describe("durable throttle claims", () => {
  it("creates one claim and leaves fresh claims untouched through the exact expiry boundary", async () => {
    await expect(claimThrottle("timer", INTERVAL_SECONDS, NOW)).resolves.toBe(true);
    const original = new Date(NOW).toISOString();

    for (const offset of [0, 1, 59_999, 60_000]) {
      await expect(
        claimThrottle("timer", INTERVAL_SECONDS, NOW + offset),
      ).resolves.toBe(false);
      expect(await getSetting("timer")).toBe(original);
    }

    await expect(
      claimThrottle("timer", INTERVAL_SECONDS, NOW + 60_001),
    ).resolves.toBe(true);
    expect(await getSetting("timer")).toBe(new Date(NOW + 60_001).toISOString());
  });

  it.each(["missing", "stale"] as const)(
    "elects exactly one winner when contenders observe a %s claim",
    async (initial) => {
      if (initial === "stale") {
        await prisma.setting.create({
          data: { key: "race", value: new Date(NOW - 60_001).toISOString() },
        });
      }

      const results = await raceN(12, () =>
        claimThrottle("race", INTERVAL_SECONDS, NOW),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await prisma.setting.count({ where: { key: "race" } })).toBe(1);
      expect(await getSetting("race")).toBe(new Date(NOW).toISOString());
    },
  );

  it("does not shorten a future claim when the request clock moves backwards", async () => {
    const future = new Date(NOW + 60_000).toISOString();
    await prisma.setting.create({ data: { key: "future", value: future } });

    await expect(claimThrottle("future", INTERVAL_SECONDS, NOW)).resolves.toBe(false);
    expect(await getSetting("future")).toBe(future);
  });

  it.skipIf(!ON_POSTGRES)("rechecks expiry after a competing writer wins between the snapshot and conflict", async () => {
    const key = "blocked-throttle";
    await prisma.setting.create({
      data: { key, value: new Date(NOW - 60_001).toISOString() },
    });
    let contender: Promise<boolean> | undefined;
    try {
      await prisma.$transaction(async (tx) => {
        // The contender sees the previously committed stale timestamp, passes
        // NOT EXISTS, and waits on this writer inside ON CONFLICT. Once this
        // transaction commits, the final WHERE must reject the new fresh row.
        await tx.setting.update({
          where: { key },
          data: { value: new Date(NOW).toISOString() },
        });
        contender = claimThrottle(key, INTERVAL_SECONDS, NOW);
        const deadline = Date.now() + 5_000;
        let waiting = false;
        while (Date.now() < deadline) {
          const rows = await tx.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock'
                AND query LIKE '%INSERT INTO "Setting"%'
            ) AS waiting
          `;
          if (rows[0]?.waiting) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
      }, { timeout: 10_000 });
      await expect(contender).resolves.toBe(false);
      expect(await getSetting(key)).toBe(new Date(NOW).toISOString());
    } finally {
      // Release/consume a pending contender even if the lock observation fails.
      await contender;
    }
  });

  it.each([
    ["", true],
    ["0", true],
    ["not-a-timestamp", false],
  ])("preserves the previous lexical comparison for legacy value %j", async (value, claimed) => {
    await prisma.setting.create({ data: { key: "legacy", value } });

    await expect(claimThrottle("legacy", INTERVAL_SECONDS, NOW)).resolves.toBe(claimed);
    expect(await getSetting("legacy")).toBe(claimed ? new Date(NOW).toISOString() : value);
  });

  it("keeps keys independent and treats SQL-shaped keys as data", async () => {
    const key = "timer'); DELETE FROM \"Setting\"; --";
    await prisma.setting.create({ data: { key: "unrelated", value: "preserved" } });

    await expect(claimThrottle(key, INTERVAL_SECONDS, NOW)).resolves.toBe(true);
    await expect(claimThrottle(key, INTERVAL_SECONDS, NOW)).resolves.toBe(false);
    await expect(claimThrottle("another", INTERVAL_SECONDS, NOW)).resolves.toBe(true);
    expect(await getSetting("unrelated")).toBe("preserved");
    expect(await prisma.setting.count()).toBe(3);
  });
});
