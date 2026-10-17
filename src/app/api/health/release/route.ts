import { leagueDeployEnv } from "@/lib/deploy-env";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { resolveSiteUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";

/**
 * Public code identity only. Does not read data or expose connection details.
 * `commit` is the release SHA each deploy sets (Vercel through the release
 * script, the box per release). `site` is the origin this build was baked
 * with and `deployEnv` the self-hosted marker (null when undeclared), so a
 * release check can refuse a build with the wrong origin or a staging env
 * serving production.
 */
export function GET() {
  const commit = process.env.LEAGUE_RELEASE_SHA;
  return Response.json({
    ok: true,
    region: LEAGUE_CONFIG.region,
    commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
    site: resolveSiteUrl(),
    deployEnv: leagueDeployEnv(),
  }, { headers: { "Cache-Control": "no-store" } });
}
