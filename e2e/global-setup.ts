import { execSync } from "node:child_process";
import { E2E_DB_URL } from "../playwright.config";

// Reset the DEDICATED e2e database (prisma/e2e.db) to a known seeded state
// before the run: create/sync the schema, then seed. dev.db is never touched
// — the explicit DATABASE_URL wins over .env for both Prisma and Next.
export default async function globalSetup() {
  if (!/e2e/i.test(E2E_DB_URL)) {
    throw new Error(
      `Refusing to reset: DATABASE_URL (${E2E_DB_URL}) doesn't look like the dedicated e2e DB.`,
    );
  }
  const env = { ...process.env, DATABASE_URL: E2E_DB_URL };
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env,
  });
  execSync("npm run db:seed", { stdio: "inherit", env });
}
