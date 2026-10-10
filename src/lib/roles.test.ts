import { describe, it, expect } from "vitest";
import {
  effectiveInhouseRoles,
  parseRoleKeys,
  parseRoles,
  serializeRoles,
  roleLabels,
  roleShort,
 rolesAccessibleName,
  parseRoleOrder,
  rolePreferenceLine,
  serializeRoleOrder,
} from "./roles";

describe("roles", () => {
  it("parses and orders valid position keys, dropping junk", () => {
    expect(parseRoles("3,1,x,1")).toEqual(["1", "3"]);
    expect(parseRoles("")).toEqual([]);
    expect(parseRoles(null)).toEqual([]);
  });

  it("serializes to a canonical ordered, deduped string", () => {
    expect(serializeRoles(["5", "1", "1"])).toBe("1,5");
    expect(serializeRoles(["9"])).toBe("");
  });

  it("maps to human labels", () => {
    expect(roleLabels("1,3")).toEqual(["Carry", "Offlane"]);
    expect(roleShort("2,5")).toEqual(["Pos 2", "Pos 5"]);
  });
});

// The inhouse picker's input, straight off a request body. Strict: a choice
// that is partly junk is refused whole, so the toast never says "saved" over a
// silently trimmed choice.
describe("parseRoleKeys", () => {
  it("stores a valid choice in the player's order of preference", () => {
    expect(parseRoleKeys(["3", "1"])).toBe("3,1");
    expect(parseRoleKeys(["5"])).toBe("5");
    expect(parseRoleKeys(["5", "4", "3", "2", "1"])).toBe("5,4,3,2,1");
  });

  it("stores an empty choice as \"\" (deliberately none), not as a refusal", () => {
    // "" and null mean different things downstream: "" is the player saying
    // "no positions", null is "never chose" (the signup's roles stand in).
    expect(parseRoleKeys([])).toBe("");
  });

  it("refuses anything that isn't an array", () => {
    for (const input of [
      undefined,
      null,
      "1,3",
      "1",
      1,
      true,
      {},
      { 0: "1", length: 1 }, // array-like, not an array
    ]) {
      expect(parseRoleKeys(input)).toBeNull();
    }
  });

  it("refuses the whole choice when any key is junk", () => {
    for (const input of [
      ["6"],
      ["0"],
      ["1", "9"],
      ["x"],
      [""],
      [" 1"],
      ["1 "],
      ["1,2"], // a stored string smuggled in as one key
      [1], // numbers, not position keys
      [1, "2"],
      [null],
      [undefined],
      [["1"]],
      [{}],
    ]) {
      expect(parseRoleKeys(input)).toBeNull();
    }
  });

  it("refuses duplicates instead of quietly deduping them", () => {
    expect(parseRoleKeys(["1", "1"])).toBeNull();
    expect(parseRoleKeys(["2", "3", "2"])).toBeNull();
  });

  it("refuses more than five keys", () => {
    expect(parseRoleKeys(["1", "2", "3", "4", "5", "1"])).toBeNull();
    expect(parseRoleKeys(["1", "2", "3", "4", "5", "6"])).toBeNull();
    expect(
      parseRoleKeys(Array.from({ length: 1000 }, () => "1")),
    ).toBeNull();
  });
});

describe("effectiveInhouseRoles", () => {
  it("uses the player's own inhouse choice over their signup's", () => {
    // In the player's order: Hard Support first, then Mid.
    expect(effectiveInhouseRoles("5,2", "1,3")).toEqual({
      roles: "5,2",
      source: "inhouse",
    });
  });

  it("keeps an own choice of none (\"\"), even over a signup that has roles", () => {
    // The player cleared their positions for inhouses on purpose: the signup
    // must not creep back in.
    expect(effectiveInhouseRoles("", "1,2")).toEqual({
      roles: "",
      source: "inhouse",
    });
  });

  it("falls back to the latest signup's roles when they never chose", () => {
    expect(effectiveInhouseRoles(null, "3,1")).toEqual({
      roles: "1,3",
      source: "signup",
    });
    expect(effectiveInhouseRoles(undefined, "4")).toEqual({
      roles: "4",
      source: "signup",
    });
  });

  it("says none when neither has a position", () => {
    for (const signup of [null, undefined, "", "x,9"]) {
      expect(effectiveInhouseRoles(null, signup)).toEqual({
        roles: "",
        source: "none",
      });
    }
  });

  it("keeps an own choice's order and sorts a signup's set, both deduped and junk-free", () => {
    // An own choice is a preference order (first occurrence kept); a signup's
    // roles are an unordered set, in position order.
    expect(effectiveInhouseRoles("3,1,1,x", null)).toEqual({
      roles: "3,1",
      source: "inhouse",
    });
    expect(effectiveInhouseRoles(null, " 5 ,2,2")).toEqual({
      roles: "2,5",
      source: "signup",
    });
    // An own value that is all junk is still the player's own word: none.
    expect(effectiveInhouseRoles("x", "1")).toEqual({
      roles: "",
      source: "inhouse",
    });
  });
});

describe("rolesAccessibleName", () => {
  it("speaks positions in order with their names", () => {
    expect(rolesAccessibleName("3,1")).toBe("Plays Pos 1 Carry, Pos 3 Offlane");
  });
  it("is null when none are set (or all are junk)", () => {
    expect(rolesAccessibleName("")).toBeNull();
    expect(rolesAccessibleName(null)).toBeNull();
    expect(rolesAccessibleName("9,x")).toBeNull();
  });
});

describe("parseRoleOrder / serializeRoleOrder", () => {
  it("keeps the order given, first occurrence only, junk dropped", () => {
    expect(parseRoleOrder("2, 5,2,x,1")).toEqual(["2", "5", "1"]);
    expect(parseRoleOrder("")).toEqual([]);
    expect(parseRoleOrder(null)).toEqual([]);
    expect(serializeRoleOrder(["4", "4", "1", "9"])).toBe("4,1");
  });
});

describe("rolesAccessibleName ranked", () => {
  it("says which comes first for a ranked choice", () => {
    expect(rolesAccessibleName("2,3,1", { ranked: true })).toBe(
      "Plays Pos 2 Mid first, then Pos 3 Offlane, then Pos 1 Carry",
    );
    expect(rolesAccessibleName("4", { ranked: true })).toBe(
      "Plays Pos 4 Soft Support",
    );
    // Unranked (a signup's set) stays in position order.
    expect(rolesAccessibleName("2,3,1")).toBe(
      "Plays Pos 1 Carry, Pos 2 Mid, Pos 3 Offlane",
    );
  });
});

describe("rolePreferenceLine", () => {
  it("spells a preference order out", () => {
    expect(rolePreferenceLine("2,3")).toBe("Mid first, then Offlane");
    expect(rolePreferenceLine("5")).toBe("Hard Support");
    expect(rolePreferenceLine("")).toBe("");
    expect(rolePreferenceLine("3,1,2,5,4")).toBe(
      "Any position: Offlane first, then Carry, then Mid, then Hard Support, then Soft Support",
    );
  });
});
