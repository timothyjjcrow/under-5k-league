import type { computeStandings, ClinchStatus } from "@/lib/standings";
import type { FormResult } from "@/lib/team-matches";
import { StandingsTableClient, type StandingsRowView } from "./standings-table";

/**
 * Server-side adapter for the sortable client table: flattens the maps into
 * plain rows (Maps don't cross the client boundary) and drops clinch marks
 * when every team makes the bracket (they'd all be ✓).
 *
 * Lives beside the client half rather than in a page module — /,
 * /schedule and /seasons/[id] all render it, and importing a component
 * from "@/app/page" pulled the whole 2,700-line dashboard module into
 * those routes' graphs.
 */
export function StandingsTable({
  standings,
  teamName,
  teamLogoUrl,
  formByTeam,
  playoffCut,
  clinch,
  viewerTeamId,
  movement,
  totalTeams,
  withdrawnIds,
  playoffSeedByTeam,
  eligibleTeams,
  overview = false,
}: {
  standings: ReturnType<typeof computeStandings>;
  teamName: Map<string, string>;
  teamLogoUrl?: Map<string, string | null>;
  formByTeam?: Map<string, FormResult[]>;
  /** How many top teams make playoffs — draws a "playoff cut" line when set. */
  playoffCut?: number;
  /** Per-team clinched/eliminated verdicts (see clinchStatuses). */
  clinch?: Map<string, ClinchStatus>;
  /** The signed-in viewer's team — its row gets a subtle highlight. */
  viewerTeamId?: string | null;
  /** Weekly rank movement (see standingsMovement). */
  movement?: Map<string, number>;
  /** League size before any slicing (dashboard passes the top 8 only). */
  totalTeams?: number;
  /** Teams that withdrew mid-season (withdrawTeam) — badged, never hidden:
   *  their played results are real, they're just out of seeding contention. */
  withdrawnIds?: Set<string>;
  /** Canonical eligible seed map from projectPlayoffField. */
  playoffSeedByTeam?: Map<string, number>;
  /** Number of non-withdrawn teams competing for playoff places. */
  eligibleTeams?: number;
  /** Start with readable records; full sortable statistics remain available. */
  overview?: boolean;
}) {
  // "Everyone makes the bracket" must be judged against the whole league,
  // not the (possibly sliced) rows this table happens to show.
  const fieldSize = totalTeams ?? standings.length;
  const eligibleFieldSize =
    eligibleTeams ??
    standings.filter((row) => !withdrawnIds?.has(row.teamId)).length;
  const cutIsReal =
    playoffCut != null && playoffCut > 0 && playoffCut < eligibleFieldSize;
  const rows: StandingsRowView[] = standings.map((s, i) => ({
    teamId: s.teamId,
    name: teamName.get(s.teamId) ?? "—",
    logoUrl: teamLogoUrl?.get(s.teamId) ?? null,
    rank: i + 1,
    wins: s.wins,
    draws: s.draws,
    losses: s.losses,
    gameDiff: s.gameDiff,
    points: s.points,
    form: formByTeam ? (formByTeam.get(s.teamId) ?? []) : null,
    clinch: cutIsReal ? (clinch?.get(s.teamId) ?? null) : null,
    move: movement?.get(s.teamId) ?? 0,
    idDecided: s.idDecided ?? false,
    withdrawn: withdrawnIds?.has(s.teamId) ?? false,
    playoffSeed: playoffSeedByTeam?.get(s.teamId) ?? null,
  }));
  return (
    <StandingsTableClient
      rows={rows}
      overview={overview}
      playoffCut={playoffCut}
      viewerTeamId={viewerTeamId}
      totalTeams={fieldSize}
      eligibleTeams={eligibleFieldSize}
    />
  );
}
