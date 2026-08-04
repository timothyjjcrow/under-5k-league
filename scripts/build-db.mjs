// Production migration step for the canonical Vercel build. It runs after
// environment + committed-migration validation, but BEFORE Prisma generation
// and `next build`: the old deployment can continue serving while an additive,
// backward-compatible migration lands, and a later compile failure never
// promotes incompatible code. `prisma migrate deploy` applies only reviewed,
// committed SQL and has no accept-data-loss escape hatch.
//
// Preview, development, and local builds are an intentional no-op here. Their
// databases must be provisioned independently; a preview must never mutate the
// production target merely because credentials were scoped too broadly.
//
//   node scripts/build-db.mjs  # decide from VERCEL_ENV and run
//
// BUILD_DB_DRY_RUN=1 is a unit-test seam only. It must be paired with
// NODE_ENV=test; any other value or environment fails closed so a stray deploy
// setting cannot silently suppress the production schema command.
import { execFileSync } from "node:child_process";

/** Exported for tests: the command selected for a deployment environment. */
export function commandFor(vercelEnv) {
  return vercelEnv === "production" ? "prisma migrate deploy" : null;
}

const cmd = commandFor(process.env.VERCEL_ENV);

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
    `build-db: VERCEL_ENV=${process.env.VERCEL_ENV ?? "(unset)"} → ${cmd ?? "skip migration deploy"}${testDryRun ? " (test dry run)" : ""}`,
  );
  if (cmd && !testDryRun) {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      stdio: "inherit",
    });
  }
}
