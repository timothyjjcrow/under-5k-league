import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { runResultSync } from "@/lib/result-sync-service";
import { makeSeason, ON_POSTGRES } from "./factories";

describe("active-season read integrity", () => {
  it.skipIf(ON_POSTGRES)(
    "fails closed instead of silently choosing one of two active seasons",
    async () => {
      await makeSeason({ name: "First" });
      await makeSeason({ name: "Second" });

      await expect(getActiveSeason()).rejects.toThrow(/more than one season/i);
    },
  );

  it.skipIf(ON_POSTGRES)(
    "reports bounded failures instead of mutating the newest active season",
    async () => {
      const first = await makeSeason({ name: "First" });
      const second = await makeSeason({ name: "Second" });

      await expect(runResultSync()).resolves.toMatchObject({
        imported: 0,
        inhouse: false,
        draft: false,
        playoff: false,
        watch: false,
        issues: expect.arrayContaining([
          "LEAGUE_SYNC_FAILED",
          "DRAFT_SYNC_FAILED",
          "PLAYOFF_SYNC_FAILED",
          "REMINDER_FAILED",
          "NOTIFICATION_RETRY_FAILED",
        ]),
      });
      expect(
        await prisma.season.findMany({
          where: { id: { in: [first.id, second.id] } },
          orderBy: { name: "asc" },
          select: { name: true, status: true, isActive: true },
        }),
      ).toEqual([
        { name: "First", status: first.status, isActive: true },
        { name: "Second", status: second.status, isActive: true },
      ]);
    },
  );

  it.runIf(ON_POSTGRES)(
    "prevents the corrupt two-active-season state at the database boundary",
    async () => {
      const first = await makeSeason({ name: "First" });

      await expect(makeSeason({ name: "Second" })).rejects.toMatchObject({
        code: "P2002",
      });
      await expect(getActiveSeason()).resolves.toMatchObject({ id: first.id });
      expect(await prisma.season.count({ where: { isActive: true } })).toBe(1);
    },
  );
});
