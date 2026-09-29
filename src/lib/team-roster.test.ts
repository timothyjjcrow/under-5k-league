import { describe, expect, it } from "vitest";
import { rosterOrder } from "./team-roster";

const member = (name: string, price: number, isCaptain = false) => ({
  name,
  price,
  isCaptain,
});

describe("rosterOrder", () => {
  it("lists the $0 captain first, then the rest by price", () => {
    const roster = [
      member("One", 1),
      member("Twelve", 12),
      member("Captain", 0, true),
      member("Five", 5),
    ];
    expect(rosterOrder(roster).map((m) => m.name)).toEqual([
      "Captain",
      "Twelve",
      "Five",
      "One",
    ]);
  });

  it("keeps a priced captain first after a captaincy transfer", () => {
    const roster = [member("Old captain", 0), member("New captain", 20, true)];
    expect(rosterOrder(roster)[0].name).toBe("New captain");
  });

  it("keeps the given order for equal prices and leaves the input alone", () => {
    const roster = [member("A", 3), member("B", 3), member("C", 3)];
    const ordered = rosterOrder(roster);
    expect(ordered.map((m) => m.name)).toEqual(["A", "B", "C"]);
    expect(ordered).not.toBe(roster);
  });
});
