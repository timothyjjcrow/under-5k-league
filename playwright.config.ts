import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// E2E runs against its OWN database and port — never dev.db / :3000 — so the
// suite can reseed freely without clobbering local dev state (the same
// isolation integration tests get from test.db). Global setup pushes the
// schema + seeds prisma/e2e.db; the web server below is pinned to it too.
export const E2E_DB_URL = `file:${path.resolve(process.cwd(), "prisma/e2e.db")}`;
const E2E_PORT = 3210;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Playwright polls the URL before globalSetup runs, so the command must
    // make the DB servable itself (schema + seed) before booting the server;
    // globalSetup then re-seeds for the reuse-an-existing-server path (the
    // seed script resets first, so running it twice is harmless).
    command: `npx prisma db push --skip-generate --accept-data-loss && npm run db:seed && npm run dev -- -p ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}`,
    // Anything already on this port is a previous e2e server (same DB) —
    // a dev server on :3000 is never reused, so dev.db stays untouched.
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      DATABASE_URL: E2E_DB_URL,
      ALLOW_DEV_LOGIN: "true",
    },
  },
  globalSetup: "./e2e/global-setup.ts",
});
