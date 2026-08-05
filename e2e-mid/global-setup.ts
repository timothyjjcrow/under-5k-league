import { execFileSync, execSync } from "node:child_process";
import { MID_DB_URL } from "../playwright.midseason.config";

// Reset the dedicated mid-season fixture DB (prisma/e2e-fixture.db) before
// the run: schema, the regular-season fixture seed, then the staged extras
// (a LIVE match for the chip specs). dev.db is never touched — the explicit
// DATABASE_URL wins over .env for both Prisma and Next.
export default async function globalSetup() {
  const env = {
    ...process.env,
    DATABASE_URL: MID_DB_URL,
    FIXTURE_MODE: "regular",
  };
  // Run the ESM-only safety helper as a CLI so Playwright's CommonJS global-
  // setup loader never rewrites the module after a production Next build.
  execFileSync(
    process.execPath,
    ["scripts/prepare-sqlite-test-db.mjs", "midseasonE2e"],
    { stdio: "inherit", env },
  );
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env,
  });
  execSync("npx tsx scripts/seed-fixture.ts", { stdio: "inherit", env });
  execSync("npx tsx e2e-mid/stage.ts", { stdio: "inherit", env });
  const cache = await fetch("http://localhost:3212/api/test/cache", {
    method: "POST",
  });
  if (!cache.ok) {
    throw new Error(
      `Couldn't expire the reused midseason fixture cache (${cache.status})`,
    );
  }
}
