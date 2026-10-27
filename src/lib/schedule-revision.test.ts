import { describe, expect, it } from "vitest";
import { regularScheduleRevision } from "./schedule-revision";

describe("regularScheduleRevision", () => {
  it("is none before a schedule exists", () => {
    expect(regularScheduleRevision([])).toBe("none");
  });

  it("names the fixture set, whatever order the ids arrive in", () => {
    const revision = regularScheduleRevision(["m1", "m2", "m3"]);
    expect(revision).toMatch(/^[0-9a-f]{32}$/);
    expect(regularScheduleRevision(["m3", "m1", "m2"])).toBe(revision);
  });

  it("changes when any fixture is replaced", () => {
    expect(regularScheduleRevision(["m1", "m2", "m4"])).not.toBe(
      regularScheduleRevision(["m1", "m2", "m3"]),
    );
    expect(regularScheduleRevision(["m1", "m2"])).not.toBe(
      regularScheduleRevision(["m1", "m2", "m3"]),
    );
  });
});
