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
      : "2|3\\n"
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
          "PG_RESTORE_TEST_URL",
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
      postflight: async ({ env }) => {
        postflightUrls.push(env.DIRECT_URL ?? "");
        return {
          schema: "league_data",
          migrationCount: 2,
          nativeObjectCount: 12,
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
      migrationCount: 2,
      coreTableCount: 3,
      attestation: { migrationCount: 2, nativeObjectCount: 12 },
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
});
