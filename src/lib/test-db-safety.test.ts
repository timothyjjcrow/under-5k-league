import { describe, expect, it } from "vitest";
import {
  assertLocalManagedPostgresUrl,
  assertLocalRestorePostgresUrl,
  assertPostgresTestUrl,
} from "../../scripts/test-db-safety.mjs";

describe("destructive Postgres test URL safety", () => {
  it.each(["ld2l_test", "ld2l_pgtest"])(
    "accepts the explicit disposable database %s",
    (database) => {
      expect(
        assertPostgresTestUrl(
          `postgresql://tester:secret@db.example/${database}?sslmode=require`,
        ).pathname,
      ).toBe(`/${database}`);
    },
  );

  it.each([
    undefined,
    "file:./test.db",
    "postgresql://db.example/production",
    "postgresql://db.example/production?application_name=ld2l_test",
    "postgresql://db.example/ld2l_test_archive",
    "postgresql://db.example/ld2l%2Ftest",
  ])("rejects a non-disposable target without echoing credentials", (url) => {
    expect(() => assertPostgresTestUrl(url)).toThrow(/refus|must|invalid/i);
  });

  it("limits database create/drop helpers to localhost", () => {
    expect(() =>
      assertLocalManagedPostgresUrl(
        "postgresql://tester:do-not-print@db.example/ld2l_pgtest",
      ),
    ).toThrow(/localhost/i);
    expect(
      assertLocalManagedPostgresUrl(
        "postgresql://tester@localhost:5432/ld2l_pgtest",
      ).hostname,
    ).toBe("localhost");
  });

  it("reserves one exact localhost database for destructive restore rehearsals", () => {
    expect(
      assertLocalRestorePostgresUrl(
        "postgresql://tester:secret@localhost:5432/ld2l_restore_test",
      ).pathname,
    ).toBe("/ld2l_restore_test");
    for (const unsafe of [
      "postgresql://tester@localhost/ld2l_test",
      "postgresql://tester@localhost/ld2l_restore_test_copy",
      "postgresql://tester@db.example/ld2l_restore_test",
      "file:./ld2l_restore_test.db",
    ]) {
      expect(() => assertLocalRestorePostgresUrl(unsafe)).toThrow(
        /refus|must|local/i,
      );
    }
  });
});
