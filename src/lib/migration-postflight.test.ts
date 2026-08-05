import { describe, expect, it } from "vitest";
import {
  EXPECTED_RELEASE_NATIVE,
  postgresDatamodel,
  validatePostflightSnapshot,
  type PostflightSnapshot,
} from "../../scripts/migration-postflight.mjs";
import { MIGRATION_SHA256 } from "../../scripts/migration-safety.mjs";

function validSnapshot(): PostflightSnapshot {
  const schema = "league_data";
  return {
    schema,
    migrations: Object.entries(MIGRATION_SHA256).map(([name, checksum]) => ({
      name,
      checksum,
      finished: true,
      rolledBack: false,
    })),
    functions: Object.entries(EXPECTED_RELEASE_NATIVE.functions).map(
      ([name, definition]) => ({ name, ...definition }),
    ),
    triggers: Object.entries(EXPECTED_RELEASE_NATIVE.triggers).map(
      ([name, definition]) => ({
        name,
        ...definition,
        functionSchema: schema,
        updateColumns: [...definition.updateColumns],
      }),
    ),
    partialIndexes: Object.entries(
      EXPECTED_RELEASE_NATIVE.partialIndexes,
    ).map(([name, definition]) => ({ name, ...definition })),
    checks: Object.entries(EXPECTED_RELEASE_NATIVE.checks).map(
      ([name, definition]) => ({ name, ...definition }),
    ),
  };
}

describe("migration postflight attestation", () => {
  it("accepts only the reviewed migration and native-object snapshot", () => {
    expect(validatePostflightSnapshot(validSnapshot())).toEqual({
      schema: "league_data",
      migrationCount: 3,
      nativeObjectCount: 14,
    });
  });

  it("rejects missing, unfinished, extra, and checksum-drifted migrations", () => {
    const missing = validSnapshot();
    missing.migrations.pop();
    expect(() => validatePostflightSnapshot(missing)).toThrow(
      /completed migration inventory drift/i,
    );

    const unfinished = validSnapshot();
    unfinished.migrations[0].finished = false;
    expect(() => validatePostflightSnapshot(unfinished)).toThrow(
      /unfinished migration history/i,
    );

    const extra = validSnapshot();
    extra.migrations.push({
      name: "20990101000000_unknown",
      checksum: "x",
      finished: true,
      rolledBack: false,
    });
    expect(() => validatePostflightSnapshot(extra)).toThrow(
      /completed migration inventory drift/i,
    );

    const changed = validSnapshot();
    changed.migrations[0].checksum = "changed";
    expect(() => validatePostflightSnapshot(changed)).toThrow(
      /migration checksum drift/i,
    );
  });

  it("allows a resolved failed attempt while still requiring exact completed history", () => {
    const snapshot = validSnapshot();
    snapshot.migrations.push({
      name: "20260804010000_release_readiness",
      checksum: MIGRATION_SHA256["20260804010000_release_readiness"],
      finished: false,
      rolledBack: true,
    });

    expect(validatePostflightSnapshot(snapshot).migrationCount).toBe(3);
  });

  it("rejects a missing or unexpected native object", () => {
    const missing = validSnapshot();
    missing.functions.pop();
    expect(() => validatePostflightSnapshot(missing)).toThrow(
      /function inventory drift.*missing/i,
    );

    const unexpected = validSnapshot();
    unexpected.checks.push({
      name: "manual_check",
      table: "Season",
      definition: "CHECK (true)",
      validated: true,
      noInherit: false,
    });
    expect(() => validatePostflightSnapshot(unexpected)).toThrow(
      /CHECK constraint inventory drift.*unexpected/i,
    );
  });

  it("rejects changed function and trigger definitions", () => {
    const changedFunction = validSnapshot();
    changedFunction.functions[0].body = "BEGIN RETURN NULL; END";
    expect(() => validatePostflightSnapshot(changedFunction)).toThrow(
      /function definition drift/i,
    );

    const disabledTrigger = validSnapshot();
    disabledTrigger.triggers[0].enabled = "D";
    expect(() => validatePostflightSnapshot(disabledTrigger)).toThrow(
      /trigger definition drift/i,
    );

    const wrongUpdateColumn = validSnapshot();
    const updateTrigger = wrongUpdateColumn.triggers.find(
      (trigger) => trigger.name === "ld2l_stamp_inhouse_completion_trigger",
    );
    if (!updateTrigger) throw new Error("test fixture trigger missing");
    updateTrigger.updateColumns = ["completedAt"];
    expect(() => validatePostflightSnapshot(wrongUpdateColumn)).toThrow(
      /trigger definition drift/i,
    );
  });

  it("rejects changed partial-index and CHECK semantics", () => {
    const weakenedIndex = validSnapshot();
    weakenedIndex.partialIndexes[0].predicate = "status = 'READY'::text";
    expect(() => validatePostflightSnapshot(weakenedIndex)).toThrow(
      /partial index definition drift/i,
    );

    const weakenedCheck = validSnapshot();
    weakenedCheck.checks[0].definition =
      'CHECK ("dotaAccountIdV2" IS NULL OR "dotaAccountIdV2" > 0)';
    expect(() => validatePostflightSnapshot(weakenedCheck)).toThrow(
      /CHECK constraint definition drift/i,
    );
  });

  it("builds a temporary PostgreSQL datamodel without mutating other schema content", () => {
    const sqlite = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url = env("DATABASE_URL")
}

model User {
  id String @id
}
`;
    const converted = postgresDatamodel(sqlite);

    expect(converted).toContain('provider  = "postgresql"');
    expect(converted).toContain('directUrl = env("DIRECT_URL")');
    expect(converted).toContain("model User");
    expect(sqlite).toContain('provider = "sqlite"');
    expect(() => postgresDatamodel("model User { id String @id }")).toThrow(
      /isolate the Prisma datasource/i,
    );
  });
});
