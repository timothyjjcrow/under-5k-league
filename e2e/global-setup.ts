import { execFileSync, execSync } from "node:child_process";
import { E2E_DB_URL } from "../playwright.config";

// Reset the DEDICATED e2e database (prisma/e2e.db) to a known seeded state
// before the run: create/sync the schema, then seed. dev.db is never touched
// — the explicit DATABASE_URL wins over .env for both Prisma and Next.
export default async function globalSetup() {
  const env = { ...process.env, DATABASE_URL: E2E_DB_URL };
  // Keep the ESM-only safety helper behind its CLI boundary. Playwright loads
  // TypeScript global setup as CommonJS after a production Next build, which
  // otherwise attempts to transform the imported .mjs file and rejects its
  // import.meta usage before any browser test can start.
  execFileSync(
    process.execPath,
    ["scripts/prepare-sqlite-test-db.mjs", "signupE2e"],
    { stdio: "inherit", env },
  );
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
