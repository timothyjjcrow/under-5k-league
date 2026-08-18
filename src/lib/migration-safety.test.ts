import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASELINE_MIGRATION,
  MIGRATION_SHA256,
  splitSqlStatements,
  validateMigrationSql,
  validateMigrations,
} from "../../scripts/migration-safety.mjs";

describe("migration SQL safety gate", () => {
  function migrationFixture(mutatedMigration: string) {
    const root = mkdtempSync(path.join(tmpdir(), "ld2l-migration-safety-"));
    writeFileSync(
      path.join(root, "migration_lock.toml"),
      'provider = "postgresql"\n',
    );
    for (const name of Object.keys(MIGRATION_SHA256)) {
      const directory = path.join(root, name);
      mkdirSync(directory);
      const originalDirectory = path.join(
        process.cwd(),
        "prisma",
        "migrations",
        name,
      );
      const sql = readFileSync(path.join(originalDirectory, "migration.sql"));
      writeFileSync(
        path.join(directory, "migration.sql"),
        name === mutatedMigration ? Buffer.concat([sql, Buffer.from("\n-- changed\n")]) : sql,
      );
      if (name === BASELINE_MIGRATION) {
        writeFileSync(
          path.join(directory, "baseline.schema.prisma"),
          readFileSync(path.join(originalDirectory, "baseline.schema.prisma")),
        );
      }
    }
    return new URL(`file://${root}/`);
  }

  it("parses a PostgreSQL DO block as one statement", () => {
    const statements = splitSqlStatements(`
      BEGIN;
      DO $$
      BEGIN
        IF EXISTS (SELECT 1) THEN
          RAISE EXCEPTION 'stop; preserve data';
        END IF;
      END
      $$;
      COMMIT;
    `);

    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain("RAISE EXCEPTION");
  });

  it.each([
    'DROP TABLE "User"',
    'TRUNCATE TABLE "User"',
    'DELETE FROM "User"',
    'ALTER TABLE "User" RENAME COLUMN "name" TO "displayName"',
    'ALTER TABLE "User" ALTER COLUMN "name" TYPE VARCHAR(100)',
  ])("rejects destructive post-baseline SQL: %s", (statement) => {
    expect(() =>
      validateMigrationSql("20260804020000_bad", `BEGIN; ${statement}; COMMIT;`),
    ).toThrow(/forbidden destructive operation/);
  });

  it("rejects an unreviewed statement even when it is not on the denylist", () => {
    expect(() =>
      validateMigrationSql(
        "20260804020000_bad",
        'BEGIN; GRANT ALL ON TABLE "User" TO public; COMMIT;',
      ),
    ).toThrow(/not in the additive SQL allowlist/);
    expect(() =>
      validateMigrationSql(
        "20260804020000_bad",
        `BEGIN;
         CREATE FUNCTION "unreviewed_trigger"() RETURNS trigger LANGUAGE plpgsql
         AS $$ BEGIN RETURN NEW; END $$;
         COMMIT;`,
      ),
    ).toThrow(/not in the additive SQL allowlist/);
  });

  it("allows only the reviewed rollback-window trigger names", () => {
    expect(() =>
      validateMigrationSql(
        "20260804020000_trigger",
        `BEGIN;
         CREATE FUNCTION "ld2l_stamp_inhouse_completion"()
         RETURNS trigger LANGUAGE plpgsql
         AS $$ BEGIN RETURN NEW; END $$;
         CREATE TRIGGER "ld2l_stamp_inhouse_completion_trigger"
         BEFORE UPDATE ON "InhouseLobby" FOR EACH ROW
         EXECUTE FUNCTION "ld2l_stamp_inhouse_completion"();
         COMMIT;`,
      ),
    ).not.toThrow();
  });

  it("requires a single explicit transaction", () => {
    expect(() =>
      validateMigrationSql(
        "20260804020000_bad",
        'ALTER TABLE "User" ADD COLUMN "safe" TEXT;',
      ),
    ).toThrow(/BEGIN and COMMIT/);
    expect(() =>
      validateMigrationSql(
        "20260804020000_bad",
        'BEGIN; COMMIT; BEGIN; COMMIT;',
      ),
    ).toThrow(/exactly one transaction/);
  });

  it("accepts the committed migration set and checks the baseline hash", () => {
    expect(validateMigrations()).toEqual([
      BASELINE_MIGRATION,
      "20260804010000_release_readiness",
      "20260804020000_automation_run_state",
      "20260814000000_team_logo",
      "20260817000000_scrims",
    ]);
  });

  it("fails closed when the immutable baseline changes", () => {
    expect(() => validateMigrations(migrationFixture(BASELINE_MIGRATION))).toThrow(
      /immutable migration checksum mismatch/,
    );
  });

  it("fails closed when a post-baseline migration changes", () => {
    expect(() =>
      validateMigrations(migrationFixture("20260804010000_release_readiness")),
    ).toThrow(
      /immutable migration checksum mismatch/,
    );
  });

  it("fails closed when the automation-state migration changes", () => {
    expect(() =>
      validateMigrations(migrationFixture("20260804020000_automation_run_state")),
    ).toThrow(/immutable migration checksum mismatch/);
  });

  it("fails closed when the team-logo migration changes", () => {
    expect(() =>
      validateMigrations(migrationFixture("20260814000000_team_logo")),
    ).toThrow(/immutable migration checksum mismatch/);
  });

  it("fails closed when the scrims migration changes", () => {
    expect(() =>
      validateMigrations(migrationFixture("20260817000000_scrims")),
    ).toThrow(/immutable migration checksum mismatch/);
  });
});
