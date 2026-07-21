import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { SEASON_STATUS } from "@/lib/constants";
import { getActiveSeason, reactivateSeason } from "@/lib/season";
import { makeSeason } from "./factories";

// The undo for the one irreversible admin fat-finger: a mis-clicked
// "Create season" archives the live season with (previously) no way back.

describe("reactivateSeason (integration)", () => {
  it("swaps the active flag back atomically — the fat-finger undo", async () => {
    const real = await makeSeason({
      name: "Season 9",
      status: SEASON_STATUS.PLAYOFFS,
      isActive: false, // archived by the accidental create
    });
    const accident = await makeSeason({
      name: "Season 10 (oops)",
      status: SEASON_STATUS.SIGNUPS,
      isActive: true,
    });

    const res = await reactivateSeason(real.id);
    expect(res).toEqual({ ok: true, name: "Season 9" });

    const active = await getActiveSeason();
    expect(active?.id).toBe(real.id);
    expect(active?.status).toBe(SEASON_STATUS.PLAYOFFS); // phase untouched
    const oops = await prisma.season.findUniqueOrThrow({
      where: { id: accident.id },
    });
    expect(oops.isActive).toBe(false); // now archived → deletable

    // Exactly one active season, always.
    expect(await prisma.season.count({ where: { isActive: true } })).toBe(1);
  });

  it("refuses unknown and already-active seasons", async () => {
    const current = await makeSeason({ isActive: true });
    expect(await reactivateSeason("nope")).toEqual({
      ok: false,
      error: "Unknown season",
    });
    const already = await reactivateSeason(current.id);
    expect(already.ok).toBe(false);
    // Nothing changed.
    expect((await getActiveSeason())?.id).toBe(current.id);
  });

  it("works even when no season is currently active", async () => {
    const old = await makeSeason({ isActive: false });
    const res = await reactivateSeason(old.id);
    expect(res.ok).toBe(true);
    expect((await getActiveSeason())?.id).toBe(old.id);
  });
});
