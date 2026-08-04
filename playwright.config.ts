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
  // On CI, capture evidence: a failure that leaves only log text is
  // undiagnosable without repo auth, which is how the e2e job stayed red and
  // unexplained. NOTE trace "on-first-retry" captures NOTHING while retries is 0
  // (the default) — retain-on-failure is what actually writes a trace, and we
  // keep retries at 0 so a flake can't be silently masked green. The "github"
  // reporter is the important one: it emits Actions ANNOTATIONS naming the
  // failing test, file, line and error, which show on the run summary WITHOUT
  // signing in — the only failure detail visible to someone without repo auth.
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: process.env.CI ? "retain-on-failure" : "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Playwright polls the URL before globalSetup runs, so the command must
    // make the DB servable itself (schema + seed) before booting the server;
    // globalSetup then re-seeds for the reuse-an-existing-server path (the
    // seed script resets first, so running it twice is harmless).
    command: `node scripts/prepare-sqlite-test-db.mjs signupE2e && npx prisma db push --skip-generate --accept-data-loss && npm run db:seed && npm run dev -- -p ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}`,
    // Local reruns may reuse this suite's dedicated port and database. CI must
    // always own a fresh process so a stale server cannot make a clean-checkout
    // run pass against old code.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DATABASE_URL: E2E_DB_URL,
      ALLOW_DEV_LOGIN: "true",
      PRIVACY_CONTACT_EMAIL: "privacy@ggd2l.org",
      PRIVACY_DATA_LOCATIONS: "United States, Germany",
      // Next's dev worker restarts at 80% of its V8 heap limit. The full
      // single-server browser suite intentionally compiles almost every route;
      // the default constrained heap restarted between two poll-resilience
      // tests and stranded the next page before hydration. Raising the ceiling
      // keeps the test server stable without changing production runtime limits.
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=8192`.trim(),
    },
  },
  globalSetup: "./e2e/global-setup.ts",
});
