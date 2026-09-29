import path from "node:path";
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

  it("gives every fixture its own file under prisma/, never dev.db", () => {
    const paths = Object.values(FIXTURE_DATABASE_PATHS);
    expect(new Set(paths).size).toBe(paths.length);
    for (const file of paths) {
      expect(path.basename(path.dirname(file))).toBe("prisma");
      expect(path.basename(file)).toMatch(/-fixture\.db$/);
    }
    expect(
      isExpectedFixtureDatabase(
        pathToFileURL(path.join(path.dirname(paths[0]), "dev.db")).href,
        Object.keys(FIXTURE_DATABASE_PATHS) as (keyof typeof FIXTURE_DATABASE_PATHS)[],
      ),
    ).toBe(false);
  });

  it("keeps the demo servers' files apart from the browser suites'", () => {
    expect(
      isExpectedFixtureDatabase(fixtureUrl("demoRegular"), ["demoRegular"]),
    ).toBe(true);
    expect(
      isExpectedFixtureDatabase(fixtureUrl("demoRegular"), [
        "midseason",
        "postseason",
      ]),
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
