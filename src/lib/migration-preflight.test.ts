import { describe, expect, it } from "vitest";
import { PREFLIGHT_SQL } from "../../scripts/migration-preflight.mjs";

describe("migration capability preflight", () => {
  it("requires CREATE on the resolved migration schema", () => {
    expect(PREFLIGHT_SQL).toContain("migration_schema text := current_schema()");
    expect(PREFLIGHT_SQL).toContain(
      "has_schema_privilege(current_user, migration_schema, 'CREATE')",
    );
    expect(PREFLIGHT_SQL).toContain(
      "Migration preflight requires CREATE on the current schema for the configured migration role",
    );
  });

  it("requires immediately usable ownership of application relations and functions", () => {
    expect(PREFLIGHT_SQL).toContain(
      "cls.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')",
    );
    expect(PREFLIGHT_SQL).toContain(
      "pg_has_role(current_user, cls.relowner, 'USAGE')",
    );
    expect(PREFLIGHT_SQL).toContain("proc.prokind = 'f'");
    expect(PREFLIGHT_SQL).toContain(
      "pg_has_role(current_user, proc.proowner, 'USAGE')",
    );
    expect(PREFLIGHT_SQL).toContain(
      "pg_get_function_identity_arguments(proc.oid)",
    );
  });

  it("excludes extension-managed objects from the application ownership inventory", () => {
    expect(PREFLIGHT_SQL).toContain(
      "dependency.classid = 'pg_class'::regclass",
    );
    expect(PREFLIGHT_SQL).toContain(
      "dependency.classid = 'pg_proc'::regclass",
    );
    expect(PREFLIGHT_SQL.match(/dependency\.deptype = 'e'/g)).toHaveLength(2);
  });

  it("checks migration capabilities before both fresh-install and legacy data paths", () => {
    const createCapabilityCheck = PREFLIGHT_SQL.indexOf(
      "has_schema_privilege(current_user, migration_schema, 'CREATE')",
    );
    const ownershipCapabilityCheck = PREFLIGHT_SQL.indexOf(
      "INTO ownership_gaps",
    );
    const freshInstallCheck = PREFLIGHT_SQL.indexOf(
      "A genuinely empty database is the fresh-install path",
    );
    const firstDataCheck = PREFLIGHT_SQL.indexOf(
      'WHERE "dotaAccountId" IS NOT NULL',
    );
    const migrationHistoryCheck = PREFLIGHT_SQL.indexOf(
      "Migration preflight requires exactly one finished baseline migration record",
    );

    expect(createCapabilityCheck).toBeGreaterThanOrEqual(0);
    expect(ownershipCapabilityCheck).toBeGreaterThan(createCapabilityCheck);
    expect(freshInstallCheck).toBeGreaterThan(ownershipCapabilityCheck);
    expect(firstDataCheck).toBeGreaterThan(freshInstallCheck);
    expect(migrationHistoryCheck).toBeGreaterThan(firstDataCheck);
  });

  it("reports only schema capabilities and object identities", () => {
    expect(PREFLIGHT_SQL).toContain(
      "Migration preflight requires ownership rights for every existing application relation/function in the current schema; inaccessible objects: %",
    );
    expect(PREFLIGHT_SQL).not.toMatch(/DATABASE_URL|DIRECT_URL|password/i);
  });
});
