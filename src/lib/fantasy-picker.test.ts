import { describe, expect, it } from "vitest";
import {
  DEFAULT_FANTASY_PICKER_ORDER,
  FANTASY_PICKER_ORDERS,
  fantasyPickerStatus,
  formatFantasyMmr,
  isFantasyPickerOrder,
  orderFantasyCandidates,
} from "./fantasy-picker";

const pool = [
  { userId: "u3", name: "Cleo", mmr: 3000 },
  { userId: "u1", name: "Ana", mmr: 4200 },
  { userId: "u4", name: "Bram", mmr: 3000 },
  { userId: "u2", name: "Ana", mmr: 3000 },
  { userId: "u5", name: "Dee", mmr: 1800 },
];
const ids = (list: { userId: string }[]) => list.map((c) => c.userId);

describe("orderFantasyCandidates", () => {
  it("opens most expensive first, and the default says so", () => {
    expect(DEFAULT_FANTASY_PICKER_ORDER).toBe("priceHigh");
    expect(FANTASY_PICKER_ORDERS[0]).toEqual({
      key: "priceHigh",
      label: "Price, highest first",
    });
    expect(ids(orderFantasyCandidates(pool, DEFAULT_FANTASY_PICKER_ORDER))).toEqual(
      ["u1", "u2", "u4", "u3", "u5"],
    );
  });

  it("sorts cheapest first, breaking price ties by name then id", () => {
    expect(ids(orderFantasyCandidates(pool, "priceLow"))).toEqual([
      "u5",
      "u2",
      "u4",
      "u3",
      "u1",
    ]);
  });

  it("sorts by name, with the id deciding between equal names", () => {
    expect(ids(orderFantasyCandidates(pool, "name"))).toEqual([
      "u1",
      "u2",
      "u4",
      "u3",
      "u5",
    ]);
  });

  it("returns a copy and leaves the input alone", () => {
    const before = ids(pool);
    orderFantasyCandidates(pool, "priceLow");
    expect(ids(pool)).toEqual(before);
  });

  it("accepts only the orders it offers", () => {
    for (const order of FANTASY_PICKER_ORDERS) {
      expect(isFantasyPickerOrder(order.key)).toBe(true);
    }
    expect(isFantasyPickerOrder("mmr")).toBe(false);
  });
});

describe("fantasyPickerStatus", () => {
  const base = { slots: 5, cap: 12450, hasReleased: false };

  it("shows the salary and what is left while the five is short", () => {
    expect(fantasyPickerStatus({ ...base, picked: 3, spent: 7200 })).toEqual({
      canSave: false,
      overCap: false,
      salary: "7,200 of 12,450 MMR",
      hint: "Pick 2 more · 5,250 MMR left",
    });
    expect(
      fantasyPickerStatus({ ...base, picked: 4, spent: 9000 }).hint,
    ).toBe("Pick 1 more · 3,450 MMR left");
  });

  it("is ready to save with five under or at the cap", () => {
    for (const spent of [12000, 12450]) {
      const status = fantasyPickerStatus({ ...base, picked: 5, spent });
      expect(status.canSave).toBe(true);
      expect(status.hint).toBe("Your five is ready to save.");
    }
  });

  it("names the overage and blocks the save over the cap", () => {
    const status = fantasyPickerStatus({ ...base, picked: 5, spent: 12800 });
    expect(status).toMatchObject({ canSave: false, overCap: true });
    expect(status.hint).toBe("Over the cap by 350 MMR. Swap in someone cheaper.");
    // Going over is reported before the missing picks.
    expect(
      fantasyPickerStatus({ ...base, picked: 3, spent: 13000 }).hint,
    ).toMatch(/^Over the cap by 550 MMR/);
  });

  it("asks for released players to be removed first", () => {
    const status = fantasyPickerStatus({
      ...base,
      picked: 5,
      spent: 9000,
      hasReleased: true,
    });
    expect(status.canSave).toBe(false);
    expect(status.hint).toBe("Remove released players to save.");
  });

  it("drops the MMR from an uncapped season", () => {
    const status = fantasyPickerStatus({
      ...base,
      cap: 0,
      picked: 2,
      spent: 0,
    });
    expect(status.salary).toBe("No salary cap");
    expect(status.hint).toBe("Pick 3 more");
    expect(
      fantasyPickerStatus({ ...base, cap: 0, picked: 5, spent: 0 }).canSave,
    ).toBe(true);
  });
});

describe("formatFantasyMmr", () => {
  it("groups thousands the same way on the server and in every browser", () => {
    expect(formatFantasyMmr(12450)).toBe("12,450");
    expect(formatFantasyMmr(950)).toBe("950");
  });
});
