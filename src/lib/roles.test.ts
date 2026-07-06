import { describe, it, expect } from "vitest";
import { parseRoles, serializeRoles, roleLabels, roleShort } from "./roles";

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
