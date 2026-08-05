import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(process.cwd(), "scripts/pg-test-env.mjs");

describe("PostgreSQL test environment helper", () => {
  it("uses the supplied TCP credentials for database create and drop commands", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ld2l-pg-env-test-"));
    const bin = path.join(directory, "bin");
    const capture = path.join(directory, "capture.ndjson");
    mkdirSync(bin);

    const client = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { basename } = require("node:path");
appendFileSync(process.env.PG_TEST_CAPTURE, JSON.stringify({
  command: basename(process.argv[1]),
  args: process.argv.slice(2),
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  leakedTestUrl: process.env.PG_TEST_URL,
  leakedDatabaseUrl: process.env.DATABASE_URL,
  leakedDirectUrl: process.env.DIRECT_URL,
}) + "\\n");
`;
    for (const command of ["createdb", "dropdb", "node", "npm", "npx"]) {
      const executable = path.join(bin, command);
      writeFileSync(executable, client, { mode: 0o700 });
      chmodSync(executable, 0o700);
    }

    const result = spawnSync(process.execPath, [SCRIPT, "up"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://must-not-reach-database-tools/production",
        DIRECT_URL: "postgresql://must-not-reach-database-tools/production",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PG_TEST_CAPTURE: capture,
        PG_TEST_URL:
          "postgresql://ci%2Duser:p%40ss@localhost:6543/ld2l_pgtest",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<{
      command: string;
      args: string[];
      host?: string;
      port?: string;
      database?: string;
      user?: string;
      password?: string;
      leakedTestUrl?: string;
      leakedDatabaseUrl?: string;
      leakedDirectUrl?: string;
    }>;
    const databaseCalls = calls.filter(({ command }) =>
      ["createdb", "dropdb"].includes(command),
    );

    expect(databaseCalls.map(({ command }) => command)).toEqual([
      "dropdb",
      "createdb",
    ]);
    for (const call of databaseCalls) {
      expect(call.args).toContain("--maintenance-db=postgres");
      expect(call.host).toBe("localhost");
      expect(call.port).toBe("6543");
      expect(call.database).toBe("postgres");
      expect(call.user).toBe("ci-user");
      expect(call.password).toBe("p@ss");
      expect(call.leakedTestUrl).toBeUndefined();
      expect(call.leakedDatabaseUrl).toBeUndefined();
      expect(call.leakedDirectUrl).toBeUndefined();
      expect(call.args.join(" ")).not.toContain("p@ss");
    }
  });
});
