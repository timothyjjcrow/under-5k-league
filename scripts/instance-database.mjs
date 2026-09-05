import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRISMA = fileURLToPath(new URL("../node_modules/prisma/build/index.js", import.meta.url));

export function sqlLiteral(value) {
  // SQL is sent on stdin. E strings escape both quotes and backslashes, without
  // depending on the database's standard_conforming_strings setting.
  return `E'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

export function instanceIdentitySql(env) {
  const region = env.NEXT_PUBLIC_LEAGUE_REGION ?? "us";
  if (!["us", "eu"].includes(region)) throw new Error("Invalid league region");
  return `DO $identity$
DECLARE configured_region text; configured_origin text;
BEGIN
  SELECT "value" INTO configured_region FROM "Setting" WHERE "key" = 'deploymentRegion';
  SELECT "value" INTO configured_origin FROM "Setting" WHERE "key" = 'deploymentOrigin';
  IF ${sqlLiteral(region)} = 'eu' AND configured_region IS DISTINCT FROM 'eu' THEN
    RAISE EXCEPTION 'Europe database identity is missing or incorrect; run the empty-instance bootstrap on the dedicated Europe database';
  END IF;
  IF configured_region IS NOT NULL AND configured_region <> ${sqlLiteral(region)} THEN
    RAISE EXCEPTION 'Database belongs to a different league region';
  END IF;
  IF configured_region IS NOT NULL AND configured_origin IS DISTINCT FROM ${sqlLiteral(env.APP_URL ?? "")} THEN
    RAISE EXCEPTION 'Database belongs to a different site origin';
  END IF;
END $identity$;`;
}

/** Execute SQL with a temporary datasource; never regenerate the shared client. */
export function executeInstanceSql(sql, { env = process.env, execute = spawnSync } = {}) {
  const target = env.DIRECT_URL;
  try {
    if (!["postgres:", "postgresql:"].includes(new URL(target).protocol)) throw new Error();
  } catch {
    throw new Error("Instance database work requires a direct PostgreSQL DIRECT_URL");
  }
  const temporary = mkdtempSync(path.join(tmpdir(), "ggd2l-instance-"));
  try {
    const schema = path.join(temporary, "schema.prisma");
    writeFileSync(schema, `datasource db {
  provider = "postgresql"
  url = env("DIRECT_URL")
}
`);
    const result = execute(process.execPath, [PRISMA, "db", "execute", "--stdin", "--schema", schema], {
      cwd: temporary,
      env,
      input: sql,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) {
      // Prisma errors may contain credentials or user data. Expose only our
      // fixed diagnostic, keeping captured subprocess output private.
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      for (const message of [
        "Bootstrap requires every application table to be empty",
        "Europe database identity is missing or incorrect",
        "Database belongs to a different league region",
        "Database belongs to a different site origin",
      ]) {
        if (output.includes(message)) throw new Error(message);
      }
      throw new Error("Instance database command failed; check connectivity, migrations and database permissions");
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
