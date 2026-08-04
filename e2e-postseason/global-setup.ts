import { execFileSync } from "node:child_process";
import { POSTSEASON_DB_URL } from "../playwright.postseason.config";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

export default async function globalSetup() {
  const env = {
    ...process.env,
    DATABASE_URL: POSTSEASON_DB_URL,
    FIXTURE_MODE: "playoffs",
  };
  // Run the ESM-only safety helper as a CLI so Playwright's CommonJS global-
  // setup loader never rewrites the module after a production Next build.
  execFileSync(
    process.execPath,
    ["scripts/prepare-sqlite-test-db.mjs", "postseasonE2e"],
    { stdio: "inherit", env },
  );
  execFileSync(
    npx,
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    { stdio: "inherit", env },
  );
  execFileSync(npx, ["tsx", "e2e-postseason/seed.ts"], {
    stdio: "inherit",
    env,
  });
  execFileSync(npx, ["tsx", "e2e-postseason/seed-side-games.ts"], {
    stdio: "inherit",
    env,
  });
  const cache = await fetch("http://localhost:3214/api/test/cache", {
    method: "POST",
  });
  if (!cache.ok) {
    throw new Error(
      `Couldn't expire the reused postseason fixture cache (${cache.status})`,
    );
  }
}
