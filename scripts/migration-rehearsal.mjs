import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBaselineDatabase } from "./migration-baseline-resolve.mjs";
import { inspectPostflightDatabase } from "./migration-postflight.mjs";
import { runMigrationPreflight } from "./migration-preflight.mjs";
import { assertLocalManagedPostgresUrl } from "./test-db-safety.mjs";

const ROOT = new URL("../", import.meta.url);
const SCHEMA = new URL("prisma/schema.prisma", ROOT);
const BASELINE_SQL = new URL(
  "prisma/migrations/20260804000000_baseline/migration.sql",
  ROOT,
);
const PRISMA_CLI = new URL("node_modules/prisma/build/index.js", ROOT);
const BASELINE_MIGRATION = "20260804000000_baseline";
const RELEASE_MIGRATION = "20260804010000_release_readiness";
const AUTOMATION_MIGRATION = "20260804020000_automation_run_state";
const ROOT_PATH = fileURLToPath(ROOT);
const SCHEMA_PATH = fileURLToPath(SCHEMA);
const BASELINE_SQL_PATH = fileURLToPath(BASELINE_SQL);
const PRISMA_CLI_PATH = fileURLToPath(PRISMA_CLI);

function rehearsalUrl(env = process.env) {
  const raw = env.PG_TEST_URL ?? env.DIRECT_URL ?? env.DATABASE_URL;
  const parsed = assertLocalManagedPostgresUrl(raw);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (database !== "ld2l_pgtest") {
    throw new Error(
      "Migration rehearsal only resets the disposable ld2l_pgtest database",
    );
  }
  const schema = parsed.searchParams.get("schema");
  if (schema && schema !== "public") {
    throw new Error("Migration rehearsal requires the public PostgreSQL schema");
  }
  return raw;
}

function prisma(args, { url, input, expectFailure = false } = {}) {
  const result = spawnSync(
    process.execPath,
    [PRISMA_CLI_PATH, ...args],
    {
      cwd: ROOT_PATH,
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      encoding: "utf8",
      input,
    },
  );
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (expectFailure) {
    if (result.status === 0) {
      throw new Error(`Expected Prisma command to fail: prisma ${args.join(" ")}`);
    }
    return combined;
  }
  if (result.status !== 0) {
    throw new Error(
      `Prisma command failed (${result.status}): prisma ${args.join(" ")}\n${combined}`,
    );
  }
  if (combined.trim()) console.log(combined.trim());
  return combined;
}

function executeSql(url, sql) {
  prisma(["db", "execute", "--stdin", "--schema", SCHEMA_PATH], {
    url,
    input: sql,
  });
}

function resetPublicSchema(url) {
  executeSql(
    url,
    `DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
GRANT ALL ON SCHEMA public TO public;
`,
  );
}

function applyBaselineDirectly(url) {
  prisma(
    ["db", "execute", "--file", BASELINE_SQL_PATH, "--schema", SCHEMA_PATH],
    { url },
  );
}

function resolveBaseline(url) {
  prisma(
    ["migrate", "resolve", "--applied", BASELINE_MIGRATION, "--schema", SCHEMA_PATH],
    { url },
  );
}

function deploy(url, { expectFailure = false } = {}) {
  return prisma(["migrate", "deploy", "--schema", SCHEMA_PATH], {
    url,
    expectFailure,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`Migration rehearsal assertion failed: ${message}`);
}

async function withClient(url, work) {
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    return await work(client);
  } finally {
    await client.$disconnect();
  }
}

async function migrationNames(client) {
  const rows = await client.$queryRawUnsafe(
    `SELECT migration_name
     FROM "_prisma_migrations"
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
     ORDER BY migration_name`,
  );
  return rows.map((row) => row.migration_name);
}

async function rehearseFreshDatabase(url) {
  console.log("\n[rehearsal] fresh empty PostgreSQL database");
  resetPublicSchema(url);
  runMigrationPreflight({ DATABASE_URL: url, DIRECT_URL: url });
  deploy(url);
  await withClient(url, async (client) => {
    assert(
      JSON.stringify(await migrationNames(client)) ===
        JSON.stringify([
          BASELINE_MIGRATION,
          RELEASE_MIGRATION,
          AUTOMATION_MIGRATION,
        ]),
      "fresh deploy must finish every reviewed migration in order",
    );
    const [{ count }] = await client.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN (
           'User', 'Season', 'Setting', 'InhouseAnnouncement',
           'AutomationRunState', 'LeagueAnnouncement'
         )`,
    );
    assert(
      count === 6,
      "fresh deploy must create core, outbox, and operational-state tables",
    );
  });

  await inspectPostflightDatabase({
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });

  // Prove the postflight is more than a migration-row check. Prisma's
  // semantic layer must notice supported drift on a non-core index, while the
  // catalog layer must notice native drift that Prisma cannot model.
  executeSql(url, `DROP INDEX "NewsPost_pinned_createdAt_id_idx";`);
  await expectPostflightFailure(url, /Prisma schema drift detected/i);
  executeSql(
    url,
    `CREATE INDEX "NewsPost_pinned_createdAt_id_idx"
       ON "NewsPost"("pinned", "createdAt", "id");`,
  );
  await inspectPostflightDatabase({
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });

  executeSql(
    url,
    `DROP TRIGGER "ld2l_stamp_inhouse_completion_trigger"
       ON "InhouseLobby";`,
  );
  await expectPostflightFailure(url, /trigger inventory drift.*missing/i);
}

async function expectPostflightFailure(url, expected) {
  let message = "";
  try {
    await inspectPostflightDatabase({
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(
    expected.test(message),
    `postflight must report ${expected}; received ${message}`,
  );
}

async function rehearsePreflightRollback(url) {
  console.log("\n[rehearsal] invalid legacy state stops atomically");
  resetPublicSchema(url);
  applyBaselineDirectly(url);
  executeSql(
    url,
    `INSERT INTO "User" (
       "id", "steamId", "name", "dotaAccountId", "updatedAt"
     ) VALUES (
       'invalid-dota-user', '76561197961465777', 'Invalid Dota', -1,
       CURRENT_TIMESTAMP
     );
`,
  );
  expectPreflightFailure(url, /non-positive legacy dotaAccountId/);
  executeSql(url, `DELETE FROM "User" WHERE "id" = 'invalid-dota-user';`);

  executeSql(
    url,
    `INSERT INTO "User" (
       "id", "steamId", "name", "dotaAccountId", "updatedAt"
     ) VALUES
       ('cross-claim-holder', '76561197960266000', 'Cross Claim Holder', 123, CURRENT_TIMESTAMP),
       ('canonical-owner', '76561197960265851', 'Canonical Owner', NULL, CURRENT_TIMESTAMP);
`,
  );
  expectPreflightFailure(url, /collide with another user's canonical Steam identity/);
  executeSql(
    url,
    `DELETE FROM "User" WHERE "id" IN ('cross-claim-holder', 'canonical-owner');`,
  );

  executeSql(
    url,
    `INSERT INTO "Season" ("id", "name", "isActive", "updatedAt")
VALUES
  ('season-conflict-a', 'Conflict A', true, CURRENT_TIMESTAMP),
  ('season-conflict-b', 'Conflict B', true, CURRENT_TIMESTAMP);
`,
  );
  expectPreflightFailure(url, /2 active seasons exist/);
  executeSql(
    url,
    `UPDATE "Season" SET "isActive" = false WHERE "id" = 'season-conflict-b';`,
  );
  executeSql(
    url,
    `INSERT INTO "InhouseLobby" ("id", "status", "updatedAt")
VALUES
  ('lobby-conflict-a', 'READY_CHECK', CURRENT_TIMESTAMP),
  ('lobby-conflict-b', 'DRAFTING', CURRENT_TIMESTAMP);
`,
  );
  expectPreflightFailure(url, /2 active inhouse lobbies exist/);
  resolveBaseline(url);
  deploy(url, { expectFailure: true });
  await withClient(url, async (client) => {
    const [{ exists }] = await client.$queryRawUnsafe(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'User'
           AND column_name = 'dotaAccountIdV2'
       ) AS exists`,
    );
    assert(exists === false, "failed release migration must roll back every DDL change");
  });
}

function expectPreflightFailure(url, expected) {
  let message = "";
  try {
    runMigrationPreflight({ DATABASE_URL: url, DIRECT_URL: url });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(expected.test(message), `preflight must report ${expected}; received ${message}`);
}

const LEGACY_FIXTURE_SQL = `
INSERT INTO "User" (
  "id", "steamId", "name", "dotaAccountId", "updatedAt"
) VALUES
  ('legacy-user-a', '76561197961465728', 'Legacy A', 1234567890, '2024-08-03T00:00:00Z'),
  ('legacy-user-b', '76561197961465729', 'Legacy B', NULL, '2024-08-03T00:00:00Z');

INSERT INTO "Season" ("id", "name", "isActive", "updatedAt")
VALUES ('legacy-season', 'Legacy Season', true, '2024-08-03T00:00:00Z');

INSERT INTO "Team" ("id", "seasonId", "name", "captainId", "draftOrder")
VALUES
  ('legacy-team-a', 'legacy-season', 'Radiant', 'legacy-user-a', 0),
  ('legacy-team-b', 'legacy-season', 'Dire', 'legacy-user-b', 1);

UPDATE "Season"
SET "status" = 'COMPLETE', "championTeamId" = 'legacy-team-a'
WHERE "id" = 'legacy-season';

INSERT INTO "Match" (
  "id", "seasonId", "week", "homeTeamId", "awayTeamId", "status",
  "homeScore", "awayScore", "winnerTeamId"
) VALUES (
  'legacy-match', 'legacy-season', 1, 'legacy-team-a', 'legacy-team-b',
  'COMPLETED', 1, 0, 'legacy-team-a'
);

INSERT INTO "Game" (
  "id", "matchId", "dotaMatchId", "radiantWin", "startTime", "fetchedAt"
) VALUES (
  'legacy-game', 'legacy-match', '9000000001', true, 1722470400,
  '2024-08-02T12:00:00Z'
);

INSERT INTO "InhouseLobby" (
  "id", "status", "updatedAt"
) VALUES (
  'legacy-lobby', 'COMPLETED', '2024-08-03T04:05:06Z'
);

INSERT INTO "InhouseLobbyPlayer" (
  "id", "lobbyId", "userId", "createdAt"
) VALUES (
  'legacy-lobby-player', 'legacy-lobby', 'legacy-user-a',
  '2024-08-01T03:02:01Z'
);
`;

async function runBaselineCheck(url) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("migration-baseline-check.mjs", import.meta.url))],
    {
      cwd: ROOT_PATH,
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Immutable baseline check failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  console.log(result.stdout.trim());
}

async function expectSqlState(work, sqlState, message) {
  let rejected = false;
  try {
    await work();
  } catch (error) {
    rejected =
      (sqlState === "23505" && error?.code === "P2002") ||
      error?.meta?.code === sqlState;
  }
  assert(rejected, message);
}

async function expectUniqueViolation(work, message) {
  return expectSqlState(work, "23505", message);
}

async function rehearseExistingLegacyDatabase(url) {
  console.log("\n[rehearsal] populated pre-migration PostgreSQL database");
  resetPublicSchema(url);
  applyBaselineDirectly(url);
  executeSql(url, LEGACY_FIXTURE_SQL);
  await runBaselineCheck(url);
  const resolveOutput = await resolveBaselineDatabase({
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    confirmed: true,
  });
  if (resolveOutput.trim()) console.log(resolveOutput.trim());
  runMigrationPreflight({ DATABASE_URL: url, DIRECT_URL: url });
  deploy(url);

  await withClient(url, async (client) => {
    assert(
      JSON.stringify(await migrationNames(client)) ===
        JSON.stringify([
          BASELINE_MIGRATION,
          RELEASE_MIGRATION,
          AUTOMATION_MIGRATION,
        ]),
      "legacy path must resolve baseline and finish every release migration",
    );

    const [user] = await client.$queryRawUnsafe(
      `SELECT "dotaAccountId", "dotaAccountIdV2"
       FROM "User" WHERE "id" = 'legacy-user-a'`,
    );
    assert(user.dotaAccountId === 1234567890, "legacy Dota column must be retained");
    assert(
      user.dotaAccountIdV2 === 1234567890,
      "valid legacy Dota ids must copy into the v2 column",
    );
    await client.$executeRawUnsafe(
      `UPDATE "User" SET "dotaAccountIdV2" = 4294967295
       WHERE "id" = 'legacy-user-b'`,
    );
    const [fullUint32] = await client.$queryRawUnsafe(
      `SELECT "dotaAccountIdV2" FROM "User" WHERE "id" = 'legacy-user-b'`,
    );
    assert(
      fullUint32.dotaAccountIdV2 === 4294967295,
      "v2 Dota column must represent the full uint32 range exactly",
    );
    await expectSqlState(
      () =>
        client.$executeRawUnsafe(
          `UPDATE "User" SET "dotaAccountIdV2" = 1.5
           WHERE "id" = 'legacy-user-b'`,
        ),
      "23514",
      "v2 Dota check must reject fractional identifiers",
    );
    await expectSqlState(
      () =>
        client.$executeRawUnsafe(
          `UPDATE "User" SET "dotaAccountIdV2" = 'NaN'::double precision
           WHERE "id" = 'legacy-user-b'`,
        ),
      "23514",
      "v2 Dota check must reject non-finite identifiers",
    );
    await expectSqlState(
      () =>
        client.$executeRawUnsafe(
          `UPDATE "User" SET "dotaAccountId" = -1
           WHERE "id" = 'legacy-user-a'`,
        ),
      "23514",
      "legacy Dota check must reject negative identifiers",
    );

    // A v2-only write is authoritative. Clearing a now-shadowed legacy claim
    // must not wipe it, while old-binary writes still mirror when both columns
    // represented the same legacy value at the start of the update.
    await client.$executeRawUnsafe(
      `UPDATE "User" SET "dotaAccountIdV2" = 1234567891
       WHERE "id" = 'legacy-user-a'`,
    );
    await client.$executeRawUnsafe(
      `UPDATE "User" SET "dotaAccountId" = NULL
       WHERE "id" = 'legacy-user-a'`,
    );
    const [shadowCleanup] = await client.$queryRawUnsafe(
      `SELECT "dotaAccountId", "dotaAccountIdV2"
       FROM "User" WHERE "id" = 'legacy-user-a'`,
    );
    assert(
      shadowCleanup.dotaAccountId === null &&
        shadowCleanup.dotaAccountIdV2 === 1234567891,
      "shadowed legacy cleanup must preserve authoritative v2 state",
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "User" (
         "id", "steamId", "name", "dotaAccountId", "updatedAt"
       ) VALUES (
         'old-binary-user', '76561197961465730', 'Old Binary', 100,
         CURRENT_TIMESTAMP
       )`,
    );
    await client.$executeRawUnsafe(
      `UPDATE "User" SET "dotaAccountId" = 101
       WHERE "id" = 'old-binary-user'`,
    );
    const [oldBinaryUpdate] = await client.$queryRawUnsafe(
      `SELECT "dotaAccountId", "dotaAccountIdV2"
       FROM "User" WHERE "id" = 'old-binary-user'`,
    );
    assert(
      oldBinaryUpdate.dotaAccountId === 101 &&
        oldBinaryUpdate.dotaAccountIdV2 === 101,
      "old-binary legacy writes must mirror into v2 during rollout",
    );
    await client.$executeRawUnsafe(
      `UPDATE "User" SET "dotaAccountId" = NULL
       WHERE "id" = 'old-binary-user'`,
    );
    const [oldBinaryClear] = await client.$queryRawUnsafe(
      `SELECT "dotaAccountId", "dotaAccountIdV2"
       FROM "User" WHERE "id" = 'old-binary-user'`,
    );
    assert(
      oldBinaryClear.dotaAccountId === null &&
        oldBinaryClear.dotaAccountIdV2 === null,
      "old-binary legacy clears must mirror into v2 when unshadowed",
    );
    await client.$executeRawUnsafe(
      `UPDATE "User"
       SET "dotaAccountId" = 102, "dotaAccountIdV2" = 103
       WHERE "id" = 'old-binary-user'`,
    );
    const [newApplicationDualWrite] = await client.$queryRawUnsafe(
      `SELECT "dotaAccountId", "dotaAccountIdV2"
       FROM "User" WHERE "id" = 'old-binary-user'`,
    );
    assert(
      newApplicationDualWrite.dotaAccountId === 102 &&
        newApplicationDualWrite.dotaAccountIdV2 === 103,
      "explicit new-application dual writes must not be overwritten by the legacy trigger",
    );

    const [backfills] = await client.$queryRawUnsafe(
      `SELECT
         season."fantasyLockedAt",
         lobby."completedAt",
         player."queuedAt",
         player."createdAt"
       FROM "Season" AS season
       CROSS JOIN "InhouseLobby" AS lobby
       CROSS JOIN "InhouseLobbyPlayer" AS player
       WHERE season."id" = 'legacy-season'
         AND lobby."id" = 'legacy-lobby'
         AND player."id" = 'legacy-lobby-player'`,
    );
    assert(
      backfills.fantasyLockedAt.toISOString() === "2024-08-01T00:00:00.000Z",
      "fantasy lock must use the first imported game in UTC",
    );
    assert(
      backfills.completedAt.toISOString() === "2024-08-03T04:05:06.000Z",
      "completed lobby history must receive a stable best-effort timestamp",
    );
    assert(
      backfills.queuedAt.getTime() === backfills.createdAt.getTime(),
      "historical lobby queue order must backfill from createdAt",
    );
    const championMarkers = await client.$queryRawUnsafe(
      `SELECT "key" FROM "Setting"
       WHERE "key" = 'championAnnounced:legacy-season'`,
    );
    assert(
      championMarkers.length === 0,
      "the migration must not race a live old-binary crown by manufacturing a champion marker",
    );
    const [historicalMatch] = await client.$queryRawUnsafe(
      `SELECT "completedAt" FROM "Match" WHERE "id" = 'legacy-match'`,
    );
    assert(
      historicalMatch.completedAt === null,
      "historical completed matches must remain unstamped to prevent announcement replay",
    );
    await client.$executeRawUnsafe(
      `UPDATE "Match" SET "status" = 'COMPLETED'
       WHERE "id" = 'legacy-match'`,
    );
    const [untouchedHistoricalMatch] = await client.$queryRawUnsafe(
      `SELECT "completedAt" FROM "Match" WHERE "id" = 'legacy-match'`,
    );
    assert(
      untouchedHistoricalMatch.completedAt === null,
      "a no-op write must not make an untouched historical result recoverable",
    );
    await client.$executeRawUnsafe(
      `UPDATE "Match"
       SET "homeScore" = 0, "awayScore" = 1,
           "winnerTeamId" = 'legacy-team-b'
       WHERE "id" = 'legacy-match'`,
    );
    const [correctedHistoricalMatch] = await client.$queryRawUnsafe(
      `SELECT "completedAt" FROM "Match" WHERE "id" = 'legacy-match'`,
    );
    assert(
      correctedHistoricalMatch.completedAt instanceof Date,
      "a post-migration correction to a historical result must receive a recovery receipt",
    );

    await client.$executeRawUnsafe(
      `INSERT INTO "InhouseQueueEntry" (
         "id", "userId", "joinedAt", "lastSeenAt"
       ) VALUES (
         'queue-entry', 'legacy-user-b', '2024-08-04T01:02:03Z',
         CURRENT_TIMESTAMP
       )`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "InhouseLobby" ("id", "status", "updatedAt")
       VALUES ('queue-lobby', 'CANCELLED', CURRENT_TIMESTAMP)`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "InhouseLobbyPlayer" (
         "id", "lobbyId", "userId"
       ) VALUES ('queue-player', 'queue-lobby', 'legacy-user-b')`,
    );
    const [queuedPlayer] = await client.$queryRawUnsafe(
      `SELECT "queuedAt" FROM "InhouseLobbyPlayer" WHERE "id" = 'queue-player'`,
    );
    assert(
      queuedPlayer.queuedAt.toISOString() === "2024-08-04T01:02:03.000Z",
      "old-binary lobby inserts must preserve InhouseQueueEntry.joinedAt",
    );

    await client.$executeRawUnsafe(
      `INSERT INTO "InhouseLobby" ("id", "status", "updatedAt")
       VALUES ('completion-lobby', 'READY_CHECK', CURRENT_TIMESTAMP)`,
    );
    await client.$executeRawUnsafe(
      `UPDATE "InhouseLobby" SET "status" = 'COMPLETED', "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = 'completion-lobby'`,
    );
    const [completedLobby] = await client.$queryRawUnsafe(
      `SELECT "completedAt" FROM "InhouseLobby" WHERE "id" = 'completion-lobby'`,
    );
    assert(
      completedLobby.completedAt instanceof Date,
      "old-binary completion updates must stamp completedAt",
    );

    await client.$executeRawUnsafe(
      `INSERT INTO "Season" (
         "id", "name", "isActive", "updatedAt"
       ) VALUES (
         'trigger-season', 'Trigger Season', false, CURRENT_TIMESTAMP
       )`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Team" (
         "id", "seasonId", "name", "captainId", "draftOrder"
       ) VALUES
         ('trigger-team-a', 'trigger-season', 'Trigger A', 'legacy-user-a', 0),
         ('trigger-team-b', 'trigger-season', 'Trigger B', 'legacy-user-b', 1)`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Match" (
         "id", "seasonId", "week", "homeTeamId", "awayTeamId"
       ) VALUES (
         'trigger-match', 'trigger-season', 1, 'trigger-team-a', 'trigger-team-b'
       )`,
    );
    await client.$executeRawUnsafe(
      `UPDATE "Match"
       SET "status" = 'COMPLETED', "homeScore" = 1, "awayScore" = 0,
           "winnerTeamId" = 'trigger-team-a'
       WHERE "id" = 'trigger-match'`,
    );
    const [completedMatch] = await client.$queryRawUnsafe(
      `SELECT "completedAt" FROM "Match" WHERE "id" = 'trigger-match'`,
    );
    assert(
      completedMatch.completedAt instanceof Date,
      "new completion transitions must stamp Match.completedAt",
    );
    await client.$executeRawUnsafe(
      `UPDATE "Match"
       SET "status" = 'SCHEDULED', "homeScore" = 0, "awayScore" = 0,
           "winnerTeamId" = NULL
       WHERE "id" = 'trigger-match'`,
    );
    const [reopenedMatch] = await client.$queryRawUnsafe(
      `SELECT "completedAt" FROM "Match" WHERE "id" = 'trigger-match'`,
    );
    assert(
      reopenedMatch.completedAt === null,
      "reopening a result must clear Match.completedAt",
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Game" (
         "id", "matchId", "dotaMatchId", "radiantWin", "startTime"
       ) VALUES (
         'trigger-game', 'trigger-match', '9000000002', true, 1722556800
       )`,
    );
    const [triggerSeason] = await client.$queryRawUnsafe(
      `SELECT "fantasyLockedAt" FROM "Season" WHERE "id" = 'trigger-season'`,
    );
    assert(
      triggerSeason.fantasyLockedAt.toISOString() === "2024-08-02T00:00:00.000Z",
      "old-binary game inserts must lock Fantasy in UTC",
    );

    await client.$executeRawUnsafe(
      `INSERT INTO "InhouseAnnouncement" (
         "id", "lobbyId", "kind", "sequence", "content", "updatedAt"
       ) VALUES (
         'legacy-announcement', 'legacy-lobby', 'RESULT', 1, 'Result', CURRENT_TIMESTAMP
       )`,
    );
    const [{ count: announcementCount }] = await client.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count FROM "InhouseAnnouncement"`,
    );
    assert(announcementCount === 1, "outbox table and lobby foreign key must work");

    await expectUniqueViolation(
      () =>
        client.$executeRawUnsafe(
          `INSERT INTO "Season" ("id", "name", "isActive", "updatedAt")
           VALUES ('second-active-season', 'Second', true, CURRENT_TIMESTAMP)`,
        ),
      "database must reject a second active season",
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "InhouseLobby" ("id", "status", "updatedAt")
       VALUES ('active-lobby-a', 'READY_CHECK', CURRENT_TIMESTAMP)`,
    );
    await expectUniqueViolation(
      () =>
        client.$executeRawUnsafe(
          `INSERT INTO "InhouseLobby" ("id", "status", "updatedAt")
           VALUES ('active-lobby-b', 'DRAFTING', CURRENT_TIMESTAMP)`,
        ),
      "database must reject a second active inhouse lobby",
    );
  });
  await inspectPostflightDatabase({
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}

export async function rehearseMigrations(env = process.env) {
  const url = rehearsalUrl(env);
  const schema = readFileSync(SCHEMA, "utf8");
  if (!/provider\s*=\s*"postgresql"/.test(schema)) {
    throw new Error(
      "Switch prisma/schema.prisma to postgresql before migration rehearsal",
    );
  }
  prisma(["validate", "--schema", SCHEMA_PATH], { url });
  prisma(["generate", "--schema", SCHEMA_PATH], { url });
  await rehearseFreshDatabase(url);
  await rehearsePreflightRollback(url);
  await rehearseExistingLegacyDatabase(url);
  console.log(
    "\nMigration rehearsal passed: fresh, fail-closed preflight, and populated legacy paths are safe.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  rehearseMigrations().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
