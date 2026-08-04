import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_DATABASE_PATHS,
  assertExpectedFixtureDatabase,
  isExpectedFixtureDatabase,
} from "./fixture-database";

const fixtureUrl = (fixture: keyof typeof FIXTURE_DATABASE_PATHS) =>
  pathToFileURL(FIXTURE_DATABASE_PATHS[fixture]).href;

describe("fixture database boundary", () => {
  it("accepts only the configured SQLite fixture files", () => {
    expect(
      isExpectedFixtureDatabase(fixtureUrl("midseason"), ["midseason"]),
    ).toBe(true);
    expect(
      isExpectedFixtureDatabase(fixtureUrl("postseason"), [
        "midseason",
        "postseason",
      ]),
    ).toBe(true);
    expect(
      isExpectedFixtureDatabase(fixtureUrl("postseason"), ["midseason"]),
    ).toBe(false);
  });

  it("rejects similarly named files and non-SQLite URLs", () => {
    expect(
      isExpectedFixtureDatabase("file:/tmp/e2e-fixture.db", ["midseason"]),
    ).toBe(false);
    expect(
      isExpectedFixtureDatabase(
        "postgresql://league.example/production_fixture",
        ["midseason", "postseason"],
      ),
    ).toBe(false);
    expect(
      isExpectedFixtureDatabase("file:/tmp/dev.db?fixture=true", [
        "midseason",
      ]),
    ).toBe(false);
  });

  it("fails closed with the rejected target visible to the operator", () => {
    expect(() =>
      assertExpectedFixtureDatabase(
        "postgresql://league.example/production_fixture",
        ["midseason"],
        "stage midseason data",
      ),
    ).toThrow(/Refusing to stage midseason data.*production_fixture/);
  });
});
