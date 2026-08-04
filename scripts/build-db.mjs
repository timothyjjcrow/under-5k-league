// Final Vercel build step for the database layer. The build command generates
// the Prisma client and completes `next build` before invoking this script, so
// a compilation failure cannot occur after the production schema is changed.
// `prisma db push` mutates whatever DATABASE_URL points at, and Vercel env vars
// are often scoped to all environments — so only production deploys may push.
// Preview, development, and local builds are an intentional no-op here.
//
//   node scripts/build-db.mjs  # decide from VERCEL_ENV and run
//
// BUILD_DB_DRY_RUN=1 is a unit-test seam only. It must be paired with
// NODE_ENV=test; any other value or environment fails closed so a stray deploy
// setting cannot silently suppress the production schema command.
import { execSync } from "node:child_process";

// Prisma should stop a deploy when it detects destructive schema work. An
// operator may acknowledge one reviewed deployment, but the phrase must be
// suffixed with that deployment's immutable Git commit SHA. A persistent
// project-level value therefore cannot silently approve later deployments.
export const ACCEPT_DATA_LOSS_ACK =
  "I_UNDERSTAND_THIS_MAY_DELETE_PRODUCTION_DATA";

/** Exported for tests: the command selected for a deployment environment. */
export function commandFor(vercelEnv, acknowledgement, commitSha) {
  if (vercelEnv !== "production") return null;
  const deployAcknowledgement =
    typeof commitSha === "string" && /^[a-f0-9]{40}$/i.test(commitSha)
      ? `${ACCEPT_DATA_LOSS_ACK}:${commitSha}`
      : null;
  return deployAcknowledgement && acknowledgement === deployAcknowledgement
    ? "prisma db push --skip-generate --accept-data-loss"
    : "prisma db push --skip-generate";
}

const cmd = commandFor(
  process.env.VERCEL_ENV,
  process.env.PRISMA_ACCEPT_DATA_LOSS,
  process.env.VERCEL_GIT_COMMIT_SHA,
);

const dryRunConfigured = process.env.BUILD_DB_DRY_RUN !== undefined;
const testDryRun =
  process.env.NODE_ENV === "test" && process.env.BUILD_DB_DRY_RUN === "1";

if (dryRunConfigured && !testDryRun) {
  console.error(
    "build-db: BUILD_DB_DRY_RUN is allowed only as exact value 1 when NODE_ENV=test",
  );
  process.exitCode = 1;
} else {
  console.log(
    `build-db: VERCEL_ENV=${process.env.VERCEL_ENV ?? "(unset)"} → ${cmd ?? "skip schema push"}${testDryRun ? " (test dry run)" : ""}`,
  );
  if (cmd && !testDryRun) {
    execSync(`npx ${cmd}`, { stdio: "inherit" });
  }
}
