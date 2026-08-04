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
    "stops background lifecycle work instead of mutating the newest active season",
    async () => {
      await makeSeason({ name: "First" });
      await makeSeason({ name: "Second" });

      await expect(runResultSync()).rejects.toThrow(/more than one season/i);
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
