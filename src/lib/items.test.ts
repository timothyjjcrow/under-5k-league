import { describe, expect, it } from "vitest";
import { ITEMS } from "./item-catalogue";
import { itemById, itemOrUnknown } from "./items";

describe("the bundled item catalogue", () => {
  it("has one row per id, each with a name and a CDN image stem", () => {
    const ids = ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of ITEMS) {
      expect(Number.isSafeInteger(item.id) && item.id > 0).toBe(true);
      expect(item.name.trim()).not.toBe("");
      expect(item.img).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("names the items a box score shows", () => {
    expect(itemById(1)?.name).toBe("Blink Dagger");
    expect(itemById(63)?.name).toBe("Power Treads");
    expect(itemById(44)?.kind).toBe("consumable"); // Tango
    expect(itemById(42)?.kind).toBe("consumable"); // Observer Ward
  });

  it("sorts neutral items and enchantments into their own kinds", () => {
    expect(ITEMS.some((item) => item.kind === "neutral")).toBe(true);
    expect(ITEMS.some((item) => item.kind === "enchantment")).toBe(true);
    for (const item of ITEMS.filter((row) => row.kind === "enchantment")) {
      expect(item.img.startsWith("enhancement_")).toBe(true);
    }
  });
});

describe("itemOrUnknown", () => {
  it("names an id the catalogue doesn't know yet instead of leaving a blank", () => {
    expect(itemOrUnknown(99_999)).toEqual({
      id: 99_999,
      img: "",
      name: "Item 99999",
      kind: "item",
    });
    expect(itemOrUnknown(1).name).toBe("Blink Dagger");
  });
});
