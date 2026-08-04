import { describe, expect, it } from "vitest";
import { getActiveSeason } from "@/lib/season";
import { runResultSync } from "@/lib/result-sync-service";
import { makeSeason } from "./factories";

describe("active-season read integrity", () => {
  it("fails closed instead of silently choosing one of two active seasons", async () => {
    await makeSeason({ name: "First" });
    await makeSeason({ name: "Second" });

    await expect(getActiveSeason()).rejects.toThrow(/more than one season/i);
  });

  it("stops background lifecycle work instead of mutating the newest active season", async () => {
    await makeSeason({ name: "First" });
    await makeSeason({ name: "Second" });

    await expect(runResultSync()).rejects.toThrow(/more than one season/i);
  });
});
