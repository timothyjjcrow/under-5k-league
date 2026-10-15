/**
 * Which kind of self-hosted deployment this process is, read from
 * `LEAGUE_DEPLOY_ENV`. The league box sets it on every unit (its env contract
 * refuses to start one without it); Vercel, local development and the test
 * suites leave it unset.
 *
 * - `null`: undeclared. Every caller keeps its pre-self-hosting behaviour.
 * - `"production"`: the live league on the box.
 * - `"staging"`: a rehearsal or on-demand copy. It must never post to Discord.
 * - `"invalid"`: declared, but not exactly one of the two values. Callers
 *   treat it as "not production" so a typo fails closed.
 */
export type LeagueDeployEnv = "production" | "staging" | "invalid";

export function leagueDeployEnv(
  env: Record<string, string | undefined> = process.env,
): LeagueDeployEnv | null {
  const value = env.LEAGUE_DEPLOY_ENV;
  if (value === undefined) return null;
  if (value === "production" || value === "staging") return value;
  return "invalid";
}
