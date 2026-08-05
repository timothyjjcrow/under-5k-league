import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Public postseason coverage owns a database and port distinct from the signup
// and regular-season suites. Tests reseed this one database between lifecycle
// states while the same Next server stays up; workers must therefore remain 1.
export const POSTSEASON_DB_URL = `file:${path.resolve(
  process.cwd(),
  "prisma/postseason-e2e-fixture.db",
)}`;
const POSTSEASON_PORT = 3214;

const seedChain = [
  "node scripts/prepare-sqlite-test-db.mjs postseasonE2e",
  "npx prisma db push --skip-generate --accept-data-loss",
  "npx tsx e2e-postseason/seed.ts",
  "npx tsx e2e-postseason/seed-side-games.ts",
].join(" && ");

export default defineConfig({
  testDir: "./e2e-postseason",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL: `http://localhost:${POSTSEASON_PORT}`,
    trace: process.env.CI ? "retain-on-failure" : "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "postseason-chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    // Playwright polls before globalSetup, so make the dedicated DB servable in
    // the command too. globalSetup repeats the deterministic seed when an old
    // server is intentionally reused during local development.
    command: `${seedChain} && npm run dev -- -p ${POSTSEASON_PORT}`,
    url: `http://localhost:${POSTSEASON_PORT}`,
    // CI must prove this checkout can boot its own server. Local reruns may
    // reuse the suite-owned port and isolated fixture database.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DATABASE_URL: POSTSEASON_DB_URL,
      FIXTURE_MODE: "playoffs",
      ALLOW_DEV_LOGIN: "true",
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=8192`.trim(),
    },
  },
  globalSetup: "./e2e-postseason/global-setup.ts",
});
