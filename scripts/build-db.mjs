// Vercel build step for the database layer. `prisma db push` mutates whatever
// database DATABASE_URL points at, and Vercel env vars are often scoped to all
// environments — so an unconditional push meant a PREVIEW deploy of a WIP
// branch could push its half-finished schema into the live production DB
// (db push has no migration history, so there is no rollback). Only production
// deploys may push; every other environment just generates the Prisma client
// (which the Next build still needs).
//
//   node scripts/build-db.mjs            # decide from VERCEL_ENV and run
//   BUILD_DB_DRY_RUN=1 node scripts/...  # print the decision, run nothing
import { execSync } from "node:child_process";

/** Exported for tests via dry-run output: the command for an environment. */
export function commandFor(vercelEnv) {
  // --accept-data-loss: db push IS this project's migration mechanism (no
  // migrate history), and without the flag the build fails on ANY warning —
  // even a purely additive one (a new nullable unique column blocked the
  // 2026-07 Discord-linking deploy). The safety net for genuinely destructive
  // changes is `npm run db:backup` before shipping schema changes (README),
  // plus the production-only gate below.
  return vercelEnv === "production"
    ? "prisma db push --accept-data-loss"
    : "prisma generate";
}

const cmd = commandFor(process.env.VERCEL_ENV);
console.log(
  `build-db: VERCEL_ENV=${process.env.VERCEL_ENV ?? "(unset)"} → ${cmd}`,
);
if (!process.env.BUILD_DB_DRY_RUN) {
  execSync(`npx ${cmd}`, { stdio: "inherit" });
}
