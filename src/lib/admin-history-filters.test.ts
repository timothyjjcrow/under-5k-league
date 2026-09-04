import { describe, expect, it } from "vitest";
import { adminHistoryWhere } from "./admin-history-filters";
import { listPage } from "./list-page";

describe("admin activity filters", () => {
  it("keeps the empty filter unrestricted", () =>
    expect(adminHistoryWhere({})).toEqual({}));
  it("retains historical actor names and global scope", () =>
    expect(
      adminHistoryWhere({
        season: "global",
        actor: " Old captain ",
        action: " reset ",
      }),
    ).toEqual({
      seasonId: null,
      actorName: { contains: "Old captain" },
      action: { contains: "reset" },
    }));
  it("makes the end date inclusive without including the next day", () =>
    expect(adminHistoryWhere({ from: "2026-09-01", to: "2026-09-04" })).toEqual(
      {
        createdAt: {
          gte: new Date("2026-09-01T00:00:00Z"),
          lt: new Date("2026-09-05T00:00:00Z"),
        },
      },
    ));
  it("rejects invalid and rollover dates", () =>
    expect(adminHistoryWhere({ from: "2026-02-30", to: "not a date" })).toEqual(
      {},
    ));
});

describe("bounded pagination", () => {
  it.each([undefined, "0", "-1", "1.2", "9999999", ["2", "3"], "oops"])(
    "defaults invalid input %s",
    (input) => expect(listPage(input)).toBe(1),
  );
  it("accepts a valid page", () => expect(listPage("42")).toBe(42));
});
