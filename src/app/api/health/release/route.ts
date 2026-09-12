import { LEAGUE_CONFIG } from "@/lib/league-config";

export const dynamic = "force-dynamic";

/** Public code identity only. Does not read data or expose connection details. */
export function GET() {
  const commit = process.env.LEAGUE_RELEASE_SHA;
  return Response.json({
    ok: true,
    region: LEAGUE_CONFIG.region,
    commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
  }, { headers: { "Cache-Control": "no-store" } });
}
