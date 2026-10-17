import { leagueDeployEnv } from "./deploy-env";

/**
 * Whether this deployment may change Discord: post, edit or delete through a
 * webhook, change roles, join a member to the guild, or enqueue outbox work.
 * Identity/profile reads remain available everywhere so the integration can be
 * verified against an isolated database.
 *
 * - Vercel previews may use production Discord credentials for acceptance
 *   testing, but they must never change the live guild or post through a live
 *   webhook. Keep this fail-closed for every preview, whatever else is set.
 * - A self-hosted deployment declares `LEAGUE_DEPLOY_ENV` (deploy-env.ts).
 *   Once declared, only exactly `production` may write: a rehearsal or
 *   on-demand copy (`staging`) and any typo (`invalid`) fail closed.
 * - Undeclared (Vercel production, local development and the test suites)
 *   retains its existing behavior.
 */
export function discordMutationsAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.VERCEL_ENV === "preview") return false;
  const declared = leagueDeployEnv(env);
  if (declared !== null) return declared === "production";
  return true;
}
