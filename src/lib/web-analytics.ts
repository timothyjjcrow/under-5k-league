import type { LeagueRegion } from "./league-config";

/**
 * The Vercel project each league deploys as. The US and Europe leagues are
 * separate projects, so one hard-coded analytics link sent the Europe admin to
 * the US numbers. Mirrors `scripts/league-targets.mjs`; a test pins the two.
 */
const VERCEL_SCOPE = "timothyjjcrows-projects";
const VERCEL_PROJECT: Record<LeagueRegion, string> = {
  us: "under-4.5k-league",
  eu: "ggd2l-europe",
};

/** This deployment's Vercel Web Analytics dashboard. */
export function webAnalyticsUrl(region: LeagueRegion): string {
  return `https://vercel.com/${VERCEL_SCOPE}/${VERCEL_PROJECT[region]}/analytics`;
}
