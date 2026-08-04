import { execFileSync } from "node:child_process";
import { POSTSEASON_DB_URL } from "../playwright.postseason.config";
import { prepareSqliteTestDatabase } from "../scripts/prepare-sqlite-test-db.mjs";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

export default async function globalSetup() {
  prepareSqliteTestDatabase("postseasonE2e", POSTSEASON_DB_URL);
  const env = {
    ...process.env,
    DATABASE_URL: POSTSEASON_DB_URL,
    FIXTURE_MODE: "playoffs",
  };
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
