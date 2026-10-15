// Static checks for the box's SQL files (design §3, §4, §6, §10 G-DATA).
// They were also run against a scratch PostgreSQL 18 with the real
// migrations; on the box the coordinator re-runs them on a scratch database
// (psql -X -v ON_ERROR_STOP=1 -f) before using them on a league.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "../../..");
const sql = (name) => readFileSync(path.join(DIR, name), "utf8");
/** The statements of a file, without -- comments. */
const code = (name) => sql(name).replace(/--.*$/gm, "");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

/** SETTING_KEYS from src/lib/settings.ts, as { NAME: "storedKey" }. */
function settingKeys() {
  const source = readFileSync(path.join(ROOT, "src/lib/settings.ts"), "utf8");
  const block = /export const SETTING_KEYS = \{([\s\S]*?)\n\} as const;/.exec(source)[1];
  return Object.fromEntries([...block.matchAll(/^\s+([A-Z_]+): "([^"]+)",/gm)].map((m) => [m[1], m[2]]));
}

test("the kit ships exactly the five SQL files the design names", () => {
  assert.deepEqual(FILES, ["db-parity.sql", "identity-eu.sql", "identity-us.sql", "runtime-grants.sql", "scrub-rehearsal.sql"]);
});

test("every file stops on its first error, whatever flags the caller passes", () => {
  for (const file of FILES) assert.match(code(file).trimStart(), /^\\set ON_ERROR_STOP on\n/, file);
});

test("db-parity is read-only and fixes the session settings G-DATA names", () => {
  // Neon is read-only during the cutover, and a parity check must not write.
  assert.doesNotMatch(code("db-parity.sql"), /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|BEGIN)\b/i);
  for (const setting of ["SET TimeZone = 'UTC';", "SET DateStyle = 'ISO, YMD';", "SET extra_float_digits = 1;"])
    assert.ok(code("db-parity.sql").includes(setting), setting);
  assert.match(code("db-parity.sql"), /ORDER BY r\.t COLLATE "C"/, "rows sort the same under any database collation");
  assert.match(code("db-parity.sql"), /FROM public\._prisma_migrations AS m/, "the full ledger rows are printed");
});

test("runtime-grants checks whatever role it is given and never names one", () => {
  const text = code("runtime-grants.sql");
  assert.match(text, /:'app'/);
  assert.doesNotMatch(text, /ggd2l_(us|eu)_/);
  assert.doesNotMatch(text, /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|BEGIN)\b/im, "it only reads");
  for (const problem of ["app-lacks-dml:", "app-can-create", "app-owns:", "app-cannot-read-ledger", "app-can-write-ledger",
    "app-member-of:", "app-has-role-attributes", "not-owned-by-database-owner:"])
    assert.ok(text.includes(`'${problem}`), problem);
});

test("the rehearsal scrub removes every webhook and both self-editing messages", () => {
  const keys = settingKeys();
  const scrubbed = [...code("scrub-rehearsal.sql").matchAll(/^\s+'([A-Za-z]+)',?$/gm)].map((m) => m[1]).sort();
  const expected = ["DISCORD_WEBHOOK_URL", "INHOUSE_WEBHOOK_URL", "INHOUSE_ALERT_WEBHOOK_URL", "LEAGUE_STATUS_WEBHOOK_URL",
    "INHOUSE_BOARD", "LEAGUE_STATUS_CARD"].map((name) => keys[name]).sort();
  assert.deepEqual(scrubbed, expected);
  // A webhook key added to settings.ts later must be added to the scrub too.
  for (const [name, stored] of Object.entries(keys))
    if (name.includes("WEBHOOK")) assert.ok(scrubbed.includes(stored), `${name} (${stored}) is scrubbed`);
  // Webhook URLs are credentials: only key names are ever printed.
  assert.match(code("scrub-rehearsal.sql"), /RETURNING "key"\n/);
  assert.doesNotMatch(code("scrub-rehearsal.sql"), /RETURNING[^\n]*"value"/);
  assert.match(code("scrub-rehearsal.sql"), /'scrub-' \|\| current_database\(\)/, "the caller must name the database");
});

test("the identity markers are exactly the ones the build attests", () => {
  const attest = readFileSync(path.join(ROOT, "scripts/instance-database.mjs"), "utf8");
  assert.match(attest, /"key" = 'deploymentRegion'/);
  assert.match(attest, /"key" = 'deploymentOrigin'/);
  const us = code("identity-us.sql");
  assert.match(us, /VALUES \('deploymentRegion', 'us'\), \('deploymentOrigin', 'https:\/\/us\.ggd2l\.com'\)\n\s*ON CONFLICT \("key"\) DO NOTHING/);
  assert.match(us, /configured_region IS DISTINCT FROM 'us' OR configured_origin IS DISTINCT FROM 'https:\/\/us\.ggd2l\.com'/);
  const eu = code("identity-eu.sql");
  assert.match(eu, /SET "value" = 'https:\/\/eu\.ggd2l\.com'\n\s*WHERE "key" = 'deploymentOrigin' AND "value" = 'https:\/\/ggd2l-europe\.vercel\.app'\n\s+AND EXISTS \(SELECT 1 FROM public\."Setting" WHERE "key" = 'deploymentRegion' AND "value" = 'eu'\)/);
  for (const file of ["identity-us.sql", "identity-eu.sql"]) {
    // The agent runs these with --single-transaction and counts the INSERT or
    // UPDATE command tag, so: exactly one write, no transaction control of
    // their own, and no CTE that would turn the tag into a SELECT.
    const writes = code(file).match(/^(INSERT|UPDATE|DELETE)\b/gm) ?? [];
    assert.equal(writes.length, 1, `${file} writes in exactly one statement`);
    assert.doesNotMatch(code(file), /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im, file);
    assert.doesNotMatch(code(file), /^WITH\b/m, file);
    assert.match(code(file), /RAISE EXCEPTION/, `${file} refuses a database that is not the league's`);
  }
});

test("every grants problem is a printable label the agent can report as is", () => {
  const labels = [...code("runtime-grants.sql").matchAll(/'([a-z-]+:?[a-z-]*:?)'/g)].map((m) => m[1]);
  assert.ok(labels.length >= 10);
  for (const label of labels) assert.match(label, /^[A-Za-z0-9_:.\-"]{1,64}$/, label);
});
