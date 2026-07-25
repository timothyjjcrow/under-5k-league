import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The last line of defence in front of the league's only copy of its history.
// `npm run db:seed` deletes every row and `npm run db:reset` drops the schema
// first; both used to run wherever DATABASE_URL happened to point, silently and
// with a zero exit code — while the README teaches the operator to put the
// production url on a command line for backups. Drive the real guard so the
// rule that protects the live database is pinned by a test.
const SCRIPT = path.resolve(process.cwd(), "scripts/assert-local-db.mjs");

type Result = { code: number; stderr: string };

/**
 * Run the guard in a THROWAWAY cwd. The .env fallback must be tested against a
 * .env this test controls: the repo's own is gitignored, so asserting against it
 * passes locally and fails in CI (which is exactly what happened).
 */
function runIn(
  cwd: string,
  databaseUrl: string | undefined,
  override?: string,
): Result {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) =>
          k !== "DATABASE_URL" && k !== "I_UNDERSTAND_THIS_WIPES_THE_DATABASE",
      ),
    ),
    NODE_ENV: "test",
  };
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
  if (override !== undefined) env.I_UNDERSTAND_THIS_WIPES_THE_DATABASE = override;
  try {
    execFileSync("node", [SCRIPT, "Seeding"], {
      env,
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { code: err.status ?? 1, stderr: err.stderr ?? "" };
  }
}

/** A temp dir, optionally holding a .env with the given DATABASE_URL line. */
function dirWithEnv(envUrl?: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ld2l-guard-"));
  if (envUrl !== undefined)
    writeFileSync(path.join(dir, ".env"), `DATABASE_URL="${envUrl}"\n`);
  return dir;
}

function run(databaseUrl: string | undefined, override?: string): Result {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) =>
          k !== "DATABASE_URL" && k !== "I_UNDERSTAND_THIS_WIPES_THE_DATABASE",
      ),
    ),
    NODE_ENV: "test",
  };
  void env;
  return runIn(dirWithEnv(), databaseUrl, override);
}

describe("assert-local-db destructive-command guard", () => {
  it("allows a local SQLite file", () => {
    expect(run("file:./dev.db").code).toBe(0);
    expect(run("file:/tmp/anything.db").code).toBe(0);
  });

  it("REFUSES a Postgres url — the production-wipe accident", () => {
    const r = run("postgresql://user:pw@ep-prod.neon.tech/league");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Refusing to continue");
  });

  it("refuses every non-file protocol, not just postgres", () => {
    for (const url of [
      "postgres://u:p@host/db",
      "mysql://u:p@host/db",
      "prisma://aws-us-east-1.prisma-data.com/?api_key=x",
      "libsql://db.turso.io",
    ]) {
      expect(run(url).code, url).toBe(1);
    }
  });

  it("names the action and the escape hatch so the operator knows what to do", () => {
    const r = run("postgresql://u:p@host/db");
    expect(r.stderr).toContain("Seeding");
    expect(r.stderr).toContain("I_UNDERSTAND_THIS_WIPES_THE_DATABASE=1");
  });

  it("does not leak the url only — it prints it so the mistake is visible", () => {
    expect(run("postgresql://u:p@ep-prod.neon.tech/league").stderr).toContain(
      "ep-prod.neon.tech",
    );
  });

  it("honours the explicit override", () => {
    expect(run("postgresql://u:p@host/db", "1").code).toBe(0);
  });

  it("only the exact override value waives the guard", () => {
    for (const v of ["true", "yes", "0", ""]) {
      expect(run("postgresql://u:p@host/db", v).code, v).toBe(1);
    }
  });

  it("falls back to .env like Prisma does, so a bare `npm run db:seed` works", () => {
    // DATABASE_URL unset → read .env from the cwd. Uses a .env this test writes:
    // the repo's is gitignored, so asserting against it passes locally and fails
    // in CI.
    expect(runIn(dirWithEnv("file:./dev.db"), undefined).code).toBe(0);
  });

  it("refuses via the .env fallback too when that url isn't local", () => {
    expect(runIn(dirWithEnv("postgresql://u:p@ep-prod.neon.tech/league"), undefined).code).toBe(1);
  });

  it("FAILS CLOSED with no DATABASE_URL and no .env — it can't know where it would write", () => {
    // CI's situation, and the right answer: refuse rather than guess.
    const res = runIn(dirWithEnv(), undefined);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("(unset)");
  });
});
