import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { getPublicReadSignals } from "@/lib/public-read-signals";
import { SETTING_KEYS, stampResultChange } from "@/lib/settings";
import { makeSeason, makeTeam } from "./factories";

afterEach(() => vi.useRealTimers());

describe("public read revision", () => {
  it("reads an uninitialized database without writing a revision", async () => {
    expect(await getPublicReadSignals()).toEqual({ resultChangedAt: null, publicGameRevision: "legacy" });
    expect(await prisma.setting.count()).toBe(0);
  });

  it("changes UUIDs for writes in the same millisecond while preserving ISO timestamps", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T20:00:00.000Z"));
    await stampResultChange();
    const first = await getPublicReadSignals();
    await stampResultChange();
    const second = await getPublicReadSignals();
    expect(first.resultChangedAt).toBe("2026-09-24T20:00:00.000Z");
    expect(second.resultChangedAt).toBe(first.resultChangedAt);
    expect(first.publicGameRevision).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.publicGameRevision).not.toBe(first.publicGameRevision);
  });

  it("rolls back the data and both signals when a mutation fails", async () => {
    const season = await makeSeason();
    const team = await makeTeam(season.id, "Before", 0);
    await stampResultChange();
    const before = await getPublicReadSignals();
    await expect(prisma.$transaction(async (tx) => {
      await tx.team.update({ where: { id: team.id }, data: { name: "After" } });
      await stampResultChange(tx);
      throw new Error("abort mutation");
    })).rejects.toThrow("abort mutation");
    expect((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).name).toBe("Before");
    expect(await getPublicReadSignals()).toEqual(before);
    expect(await prisma.setting.count({ where: { key: { in: [SETTING_KEYS.RESULT_CHANGED_AT, SETTING_KEYS.PUBLIC_GAME_REVISION] } } })).toBe(2);
  });
});
