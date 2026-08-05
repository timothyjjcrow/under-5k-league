import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Mid-season browser coverage: the pages players actually live on once the
// draft is done — sortable standings, schedule, box scores, leaders, meta,
// fantasy, pick'em — previously had ZERO e2e coverage (the main suite stops
// at the draft), so a client-render crash on any of them shipped silently.
// Runs against its OWN database (prisma/e2e-fixture.db — the name satisfies
// both this config's e2e guard and seed-fixture's "must contain fixture"
// guard) seeded to FIXTURE_MODE=regular (6 teams, last week open, box scores
// with report cards) plus a staged LIVE match, on its own port. Run with
// `npm run test:e2e:mid`; can't run SIMULTANEOUSLY with the main e2e (Next's
// project-dir lock allows one dev server per repo) — run them sequentially.
export const MID_DB_URL = `file:${path.resolve(
  process.cwd(),
  "prisma/e2e-fixture.db",
)}`;
const MID_PORT = 3212;

const seedChain = [
  "node scripts/prepare-sqlite-test-db.mjs midseasonE2e",
  "npx prisma db push --skip-generate --accept-data-loss",
  "npx tsx scripts/seed-fixture.ts",
  "npx tsx e2e-mid/stage.ts",
].join(" && ");

export default defineConfig({
  testDir: "./e2e-mid",
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
    baseURL: `http://localhost:${MID_PORT}`,
    trace: process.env.CI ? "retain-on-failure" : "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Playwright polls the URL before globalSetup runs, so the command must
    // make the DB servable itself; globalSetup re-seeds for the local reuse
    // path (seeding resets first — running twice is harmless).
    command: `${seedChain} && npm run dev -- -p ${MID_PORT}`,
    url: `http://localhost:${MID_PORT}`,
    // CI must prove this checkout can boot its own server. Local reruns may
    // reuse the suite-owned port and isolated fixture database.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DATABASE_URL: MID_DB_URL,
      FIXTURE_MODE: "regular",
      ALLOW_DEV_LOGIN: "true",
      // This suite compiles most post-draft routes in one dev-server process.
      // Give Next's dev worker the same test-only heap ceiling as the primary
      // e2e suite so it does not restart between late-suite navigations.
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=8192`.trim(),
    },
  },
  globalSetup: "./e2e-mid/global-setup.ts",
});
