import { execSync } from "node:child_process";
import { E2E_DB_URL } from "../playwright.config";
import { prepareSqliteTestDatabase } from "../scripts/prepare-sqlite-test-db.mjs";

// Reset the DEDICATED e2e database (prisma/e2e.db) to a known seeded state
// before the run: create/sync the schema, then seed. dev.db is never touched
// — the explicit DATABASE_URL wins over .env for both Prisma and Next.
export default async function globalSetup() {
  prepareSqliteTestDatabase("signupE2e", E2E_DB_URL);
  const env = { ...process.env, DATABASE_URL: E2E_DB_URL };
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env,
  });
  execSync("npm run db:seed", { stdio: "inherit", env });
  const cache = await fetch("http://localhost:3210/api/test/cache", {
    method: "POST",
  });
  if (!cache.ok) {
    throw new Error(
      `Couldn't expire the reused signup fixture cache (${cache.status})`,
    );
  }
}
