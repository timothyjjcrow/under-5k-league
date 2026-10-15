import { test } from "node:test";
import assert from "node:assert/strict";
import { compareFingerprints, libpqEnv } from "./neon-parity.mjs";

const A = "table\tGame\t29\taaa\ntable\tUser\t80\tbbb\nmigration\t(1,x)\nmigration\t(2,y)\n";

test("identical fingerprints pass, any table or migration difference fails", () => {
  assert.equal(compareFingerprints(A, A).identical, true);
  const changedRow = compareFingerprints(A, A.replace("bbb", "ccc"));
  assert.equal(changedRow.identical, false);
  assert.deepEqual(changedRow.differingTables, ["User"]);
  const missingTable = compareFingerprints(A, A.replace("table\tGame\t29\taaa\n", ""));
  assert.deepEqual(missingTable.differingTables, ["Game"]);
  const migration = compareFingerprints(A, A.replace("(2,y)", "(2,z)"));
  assert.equal(migration.identical, false);
  assert.equal(migration.migrationsMatch, false);
  assert.equal(compareFingerprints(A, A.replace("migration\t(2,y)\n", "")).migrationsMatch, false);
});

test("the report names tables, never row data", () => {
  const result = compareFingerprints(A, A.replace("bbb", "secret-row-hash"));
  assert.ok(!JSON.stringify(result).includes("secret-row-hash"));
});

test("psql gets libpq fields, and only allowlisted parent variables", () => {
  const env = libpqEnv("postgresql://neondb_owner:p%40ss@ep-x.neon.tech/neondb?sslmode=require", {
    HOME: "/h", PATH: "/bin", DATABASE_URL: "postgresql://other", PGPASSWORD: "stale",
  });
  assert.equal(env.PGUSER, "neondb_owner");
  assert.equal(env.PGPASSWORD, "p@ss");
  assert.equal(env.PGDATABASE, "neondb");
  assert.equal(env.PGSSLMODE, "require");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.HOME, "/h");
});
