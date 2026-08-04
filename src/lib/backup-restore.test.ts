import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deployRestoredMigrations,
  parseRestoreArguments,
  postgresUrlForSchema,
  rehearseBackupRestore,
} from "../../scripts/rehearse-backup-restore.mjs";

const SCRIPT = path.resolve(
  process.cwd(),
  "scripts/rehearse-backup-restore.mjs",
);

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "ld2l-restore-test-"));
  const backup = path.join(directory, "backup-release.sql");
  const contents = "postgres dump fixture\n";
  writeFileSync(backup, contents, { mode: 0o600 });
  writeFileSync(
    `${backup}.sha256`,
    `${createHash("sha256").update(contents).digest("hex")}  ${path.basename(backup)}\n`,
    { mode: 0o600 },
  );

  const bin = path.join(directory, "bin");
  const capture = path.join(directory, "capture.ndjson");
  mkdirSync(bin);
  const client = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { basename } = require("node:path");
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.PG_RESTORE_CAPTURE, JSON.stringify({
  command,
  args,
  database: process.env.PGDATABASE,
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  leakedUrl: process.env.PG_RESTORE_TEST_URL,
}) + "\\n");
if (command === "psql" && args.includes("--tuples-only")) {
  process.stdout.write(
    args.includes("--command")
      ? (process.env.PG_DISCOVERED_SCHEMAS || "league_data\\n")
      : (process.env.PG_SMOKE_RESULT || "3|3\\n")
  );
}
`;
  for (const command of ["psql", "dropdb", "createdb"]) {
    const executable = path.join(bin, command);
    writeFileSync(executable, client, { mode: 0o700 });
    chmodSync(executable, 0o700);
  }
  return { backup, bin, capture, directory };
}

function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        ![
          "BACKUP_RECEIPT_SECRET",
          "DATABASE_URL",
          "DIRECT_URL",
          "PG_DISCOVERED_SCHEMAS",
          "PG_RESTORE_TEST_URL",
          "PG_SMOKE_RESULT",
        ].includes(key),
    ),
  ) as NodeJS.ProcessEnv;
}

describe("PostgreSQL backup restore rehearsal", () => {
  it("verifies, restores, and fully attests only the dedicated local database", async () => {
    const { backup, bin, capture } = fixture();
    const secret = "restore-password-must-not-appear-in-argv";
    const postflightUrls: string[] = [];
    const result = await rehearseBackupRestore({
      backupArgument: backup,
      restoreUrl: `postgresql://tester:${secret}@localhost:5432/ld2l_restore_test`,
      env: {
        ...cleanEnv(),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PG_RESTORE_CAPTURE: capture,
        PG_RESTORE_TEST_URL: `postgresql://tester:${secret}@localhost:5432/ld2l_restore_test`,
      },
      baselineResolver: async () => {
        throw new Error("default restore must not resolve a baseline");
      },
      migrationPreflight: () => {
        throw new Error("default restore must not run migration preflight");
      },
      migrateDeploy: async () => {
        throw new Error("default restore must not deploy migrations");
      },
      postflight: async ({ env }) => {
        postflightUrls.push(env.DIRECT_URL ?? "");
        return {
          schema: "league_data",
          migrationCount: 3,
          nativeObjectCount: 14,
        };
      },
    });
    const calls = readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<{
      command: string;
      args: string[];
      database: string;
      password: string;
      leakedUrl?: string;
    }>;

    expect(result).toMatchObject({
      applicationSchema: "league_data",
      migrationCount: 3,
      coreTableCount: 3,
      attestation: { migrationCount: 3, nativeObjectCount: 14 },
    });
    expect(postflightUrls).toHaveLength(1);
    expect(new URL(postflightUrls[0]).searchParams.get("schema")).toBe(
      "league_data",
    );
    expect(calls.map((call) => call.command)).toEqual([
      "psql",
      "dropdb",
      "createdb",
      "psql",
      "psql",
      "psql",
    ]);
    expect(calls[0].database).toBe("postgres");
    expect(calls[3].database).toBe("ld2l_restore_test");
    expect(calls[3].args).toEqual(
      expect.arrayContaining([
        "-X",
        "--set=ON_ERROR_STOP=on",
        "--single-transaction",
        `--file=${backup}`,
      ]),
    );
    expect(calls[5].args).toContain("--set=league_schema=league_data");
    expect(calls[5].args.join(" ")).not.toContain("schema=public");
    expect(calls.every((call) => call.password === secret)).toBe(true);
    expect(calls.every((call) => call.leakedUrl === undefined)).toBe(true);
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain(secret);
  });

  it("does not accept a restored database when full schema attestation fails", async () => {
    const { backup, bin, capture } = fixture();
    const env = {
      ...cleanEnv(),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PG_RESTORE_CAPTURE: capture,
      PG_RESTORE_TEST_URL:
        "postgresql://tester:do-not-print@localhost:5432/ld2l_restore_test",
    };

    await expect(
      rehearseBackupRestore({
        backupArgument: backup,
        restoreUrl: env.PG_RESTORE_TEST_URL,
        env,
        postflight: async () => {
          throw new Error("Postflight Prisma schema drift detected");
        },
      }),
    ).rejects.toThrow(/schema drift detected/i);
  });

  it("attests, records, migrates, and postflights an explicit legacy backup in order", async () => {
    const { backup, bin, capture } = fixture();
    const restoreUrl =
      "postgresql://tester:do-not-print@localhost:5432/ld2l_restore_test";
    const steps: string[] = [];
    const scopedUrls: string[] = [];
    const env = {
      ...cleanEnv(),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PG_DISCOVERED_SCHEMAS: "legacy_league\n",
      PG_RESTORE_CAPTURE: capture,
      PG_RESTORE_TEST_URL: restoreUrl,
      PG_SMOKE_RESULT: "0|3\n",
    };

    const result = await rehearseBackupRestore({
      backupArgument: backup,
      restoreUrl,
      env,
      legacyBaseline: true,
      baselineResolver: async ({ env: childEnv, confirmed }) => {
        steps.push("baseline");
        expect(confirmed).toBe(true);
        scopedUrls.push(childEnv.DIRECT_URL ?? "");
        return "baseline recorded";
      },
      migrationPreflight: (childEnv) => {
        steps.push("preflight");
        scopedUrls.push(childEnv.DIRECT_URL ?? "");
        return "preflight passed";
      },
      migrateDeploy: async ({ env: childEnv }) => {
        steps.push("deploy");
        scopedUrls.push(childEnv.DIRECT_URL ?? "");
        return "migrations applied";
      },
      postflight: async ({ env: childEnv }) => {
        steps.push("postflight");
        scopedUrls.push(childEnv.DIRECT_URL ?? "");
        return {
          schema: "legacy_league",
          migrationCount: 3,
          nativeObjectCount: 14,
        };
      },
    });

    expect(steps).toEqual(["baseline", "preflight", "deploy", "postflight"]);
    expect(scopedUrls).toHaveLength(4);
    for (const scopedUrl of scopedUrls) {
      const parsed = new URL(scopedUrl);
      expect(parsed.hostname).toBe("localhost");
      expect(parsed.pathname).toBe("/ld2l_restore_test");
      expect(parsed.searchParams.get("schema")).toBe("legacy_league");
    }
    expect(result).toMatchObject({
      applicationSchema: "legacy_league",
      migrationCount: 0,
      coreTableCount: 3,
      legacyBaseline: true,
      attestation: {
        schema: "legacy_league",
        migrationCount: 3,
        nativeObjectCount: 14,
      },
    });
  });

  it("rejects a legacy-mode dump that already has migration metadata before baseline mutation", async () => {
    const { backup, bin, capture } = fixture();
    const restoreUrl =
      "postgresql://tester:do-not-print@localhost:5432/ld2l_restore_test";
    let baselineCalled = false;

    await expect(
      rehearseBackupRestore({
        backupArgument: backup,
        restoreUrl,
        env: {
          ...cleanEnv(),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          PG_DISCOVERED_SCHEMAS: "legacy_league\n",
          PG_RESTORE_CAPTURE: capture,
          PG_RESTORE_TEST_URL: restoreUrl,
          PG_SMOKE_RESULT: "1|3\n",
        },
        legacyBaseline: true,
        baselineResolver: async () => {
          baselineCalled = true;
          return "";
        },
      }),
    ).rejects.toThrow(/must have no _prisma_migrations table/i);
    expect(baselineCalled).toBe(false);
  });

  it("rejects a partial legacy application schema before baseline mutation", async () => {
    const { backup, bin, capture } = fixture();
    const restoreUrl =
      "postgresql://tester:do-not-print@localhost:5432/ld2l_restore_test";
    let baselineCalled = false;

    await expect(
      rehearseBackupRestore({
        backupArgument: backup,
        restoreUrl,
        env: {
          ...cleanEnv(),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          PG_DISCOVERED_SCHEMAS: "partial_league\n",
          PG_RESTORE_CAPTURE: capture,
          PG_RESTORE_TEST_URL: restoreUrl,
          PG_SMOKE_RESULT: "0|2\n",
        },
        legacyBaseline: true,
        baselineResolver: async () => {
          baselineCalled = true;
          return "";
        },
      }),
    ).rejects.toThrow(/exactly three core league tables/i);
    expect(baselineCalled).toBe(false);
  });

  it("replaces any source schema selector with the discovered restore schema", () => {
    const scoped = postgresUrlForSchema(
      "postgresql://tester:secret@localhost:5432/ld2l_restore_test?schema=public&connect_timeout=5",
      "league_data",
    );
    const parsed = new URL(scoped);
    expect(parsed.searchParams.get("schema")).toBe("league_data");
    expect(parsed.searchParams.get("connect_timeout")).toBe("5");
  });

  it("rejects an ambiguous restore instead of guessing an application schema", () => {
    const { backup, bin, directory } = fixture();
    const result = spawnSync(process.execPath, [SCRIPT, backup], {
      cwd: directory,
      env: {
        ...cleanEnv(),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PG_DISCOVERED_SCHEMAS: "league_a\nleague_b\n",
        PG_RESTORE_CAPTURE: path.join(directory, "ambiguous-capture.ndjson"),
        PG_RESTORE_TEST_URL:
          "postgresql://tester:do-not-print@localhost:5432/ld2l_restore_test",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "exactly one non-system schema with _prisma_migrations; found 2",
    );
    expect(result.stderr).not.toContain("do-not-print");
  });

  it("rejects ambiguous legacy application schemas before baseline adoption", () => {
    const { backup, bin, directory } = fixture();
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--legacy-baseline", backup],
      {
        cwd: directory,
        env: {
          ...cleanEnv(),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          PG_DISCOVERED_SCHEMAS: "league_a\nleague_b\n",
          PG_RESTORE_CAPTURE: path.join(
            directory,
            "ambiguous-legacy-capture.ndjson",
          ),
          PG_RESTORE_TEST_URL:
            "postgresql://tester:do-not-print@localhost:5432/ld2l_restore_test",
          PG_SMOKE_RESULT: "0|3\n",
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "exactly one non-system schema with application tables; found 2",
    );
    expect(result.stderr).not.toContain("do-not-print");
  });

  it("rejects remote and similarly named targets before invoking a client", () => {
    const { backup, bin, capture, directory } = fixture();
    const result = spawnSync(process.execPath, [SCRIPT, backup], {
      cwd: directory,
      env: {
        ...cleanEnv(),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PG_RESTORE_CAPTURE: capture,
        PG_RESTORE_TEST_URL:
          "postgresql://tester:do-not-print@db.example/ld2l_restore_test_copy",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Refusing restore rehearsal/);
    expect(result.stderr).not.toContain("do-not-print");
    expect(() => readFileSync(capture)).toThrow();
  });

  it("parses legacy mode only as an explicit, single CLI flag", () => {
    expect(parseRestoreArguments(["--legacy-baseline", "backup.sql"])).toEqual({
      backupArgument: "backup.sql",
      legacyBaseline: true,
    });
    expect(parseRestoreArguments(["backup.sql"])).toEqual({
      backupArgument: "backup.sql",
      legacyBaseline: false,
    });
    expect(() =>
      parseRestoreArguments([
        "--legacy-baseline",
        "--legacy-baseline",
        "backup.sql",
      ]),
    ).toThrow(/only once/i);
    expect(() => parseRestoreArguments(["--force", "backup.sql"])).toThrow(
      /unknown restore rehearsal option/i,
    );
    expect(() => parseRestoreArguments(["one.sql", "two.sql"])).toThrow(
      /exactly one/i,
    );
  });

  it("builds migrate deploy in isolation and revalidates its exact scratch target", () => {
    const secret = "restore-deploy-secret";
    const scopedUrl = `postgresql://tester:${secret}@localhost:5432/ld2l_restore_test?schema=legacy_league`;
    let called = 0;
    let temporarySchema = "";
    const output = deployRestoredMigrations({
      env: {
        ...cleanEnv(),
        DATABASE_URL: scopedUrl,
        DIRECT_URL: scopedUrl,
      },
      runner: (command, args, options) => {
        called += 1;
        temporarySchema = args.at(-1) ?? "";
        expect(command).toBe(process.execPath);
        expect(args.slice(1, 4)).toEqual(["migrate", "deploy", "--schema"]);
        expect(readFileSync(temporarySchema, "utf8")).toContain(
          'provider  = "postgresql"',
        );
        expect(options.env.DATABASE_URL).toBe(scopedUrl);
        expect(options.env.DIRECT_URL).toBe(scopedUrl);
        return {
          status: 0,
          stdout: `applied via ${scopedUrl} using ${secret}`,
          stderr: "",
        };
      },
    });

    expect(called).toBe(1);
    expect(output).not.toContain(scopedUrl);
    expect(output).not.toContain(secret);
    expect(() => readFileSync(temporarySchema)).toThrow();

    let remoteRunnerCalled = false;
    expect(() =>
      deployRestoredMigrations({
        env: {
          ...cleanEnv(),
          DIRECT_URL:
            "postgresql://tester:do-not-print@db.example/ld2l_restore_test?schema=legacy_league",
        },
        runner: () => {
          remoteRunnerCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    ).toThrow(/target must be localhost/i);
    expect(remoteRunnerCalled).toBe(false);
  });
});
