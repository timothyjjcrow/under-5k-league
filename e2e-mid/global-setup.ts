import { execSync } from "node:child_process";
import { MID_DB_URL } from "../playwright.midseason.config";

// Reset the dedicated mid-season fixture DB (prisma/e2e-fixture.db) before
// the run: schema, the regular-season fixture seed, then the staged extras
// (a LIVE match for the chip specs). dev.db is never touched — the explicit
// DATABASE_URL wins over .env for both Prisma and Next.
export default async function globalSetup() {
  if (!/e2e-fixture/i.test(MID_DB_URL)) {
    throw new Error(
      `Refusing to reset: DATABASE_URL (${MID_DB_URL}) doesn't look like the dedicated mid-season e2e DB.`,
    );
  }
  const env = {
    ...process.env,
    DATABASE_URL: MID_DB_URL,
    FIXTURE_MODE: "regular",
  };
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env,
  });
  execSync("npx tsx scripts/seed-fixture.ts", { stdio: "inherit", env });
  execSync("npx tsx e2e-mid/stage.ts", { stdio: "inherit", env });
}
