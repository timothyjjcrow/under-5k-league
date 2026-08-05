/**
 * Vercel previews may use production Discord credentials for acceptance
 * testing, but they must never change the live guild or post through a live
 * webhook. Identity/profile reads remain available so the integration can be
 * verified against an isolated preview database.
 *
 * Keep this fail-closed for every Vercel preview. Production and local test
 * environments retain their existing behavior.
 */
export function discordMutationsAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.VERCEL_ENV !== "preview";
}
