// Operator-only build job. Production secrets remain inside the hosting
// provider; temporary DDL URLs are scoped to the guarded migration subprocess.
// This emits a static receipt, never an application candidate to promote.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RELEASE_REPOSITORY } from "./league-targets.mjs";
import { authorizeMigrationRelease } from "./release-migrations.mjs";

export function hostedReleaseInputs(env) {
  const sha = env.HOSTED_MIGRATION_RELEASE_SHA;
  authorizeMigrationRelease({ argv: ["--apply", sha], env, headSha: sha, status: "" });
  for (const key of ["HOSTED_MIGRATION_DATABASE_URL", "HOSTED_MIGRATION_DIRECT_URL"])
    if (!env[key]?.startsWith("postgresql://")) throw new Error(`Missing temporary ${key}`);
  return { sha, databaseUrl: env.HOSTED_MIGRATION_DATABASE_URL, directUrl: env.HOSTED_MIGRATION_DIRECT_URL };
}

export function runHostedMigrationRelease() {
  const { sha, databaseUrl, directUrl } = hostedReleaseInputs(process.env);
  const temporary = mkdtempSync(path.join(tmpdir(), "ggd2l-reviewed-migration-"));
  const checkout = path.join(temporary, "checkout");
  try {
    execFileSync("git", ["clone", "--no-checkout", `https://github.com/${RELEASE_REPOSITORY}.git`, checkout], { stdio: "pipe" });
    execFileSync("git", ["checkout", "--detach", sha], { cwd: checkout, stdio: "pipe" });
    symlinkSync(path.resolve("node_modules"), path.join(checkout, "node_modules"), "dir");
    // The existing wrapper verifies the real clean Git checkout, exact SHA,
    // actual production environment, DDL ownership, migrations and postflight.
    execFileSync(process.execPath, ["scripts/release-migrations.mjs", "--apply", sha], {
      cwd: checkout,
      env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: directUrl },
      stdio: "inherit",
    });
    const output = path.resolve("release-result");
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "index.html"), "Guarded migration job completed. This is not an application deployment.\n");
    writeFileSync(path.join(output, "result.json"), JSON.stringify({ ok: true, commit: sha, kind: "migration-only" }) + "\n");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  runHostedMigrationRelease();
