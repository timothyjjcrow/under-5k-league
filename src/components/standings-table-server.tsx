import type { ScenarioReport } from "@/lib/scenarios";
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
  playoffScenarios,
  viewerTeamId,
  movement,
  totalTeams,
  withdrawnIds,
  playoffSeedByTeam,
  unresolvedPlayoffTeamIds = [],
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
  /** Authoritative final classification only (report.forecast.basis === "final"). */
  playoffScenarios?: ScenarioReport["teams"];
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
  /** Teams whose qualification or seed still needs an extra tiebreaker. */
  unresolvedPlayoffTeamIds?: string[];
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
  const pendingTeamIds = new Set(unresolvedPlayoffTeamIds);
  const eligibleRows = standings.filter((row) => !withdrawnIds?.has(row.teamId));
  const qualificationTieIds = new Set<string>();
  for (const row of eligibleRows) {
    if (!pendingTeamIds.has(row.teamId)) continue;
    const tied = row.idTieGroup
      ? eligibleRows.filter((other) => other.idTieGroup === row.idTieGroup)
      : [row];
    // A pending seed order must not erase an already secured playoff place.
    // A group crossing the cut still cannot inherit a stale clinch verdict.
    if (tied.some((other) => eligibleRows.indexOf(other) >= (playoffCut ?? 0)))
      tied.forEach((other) => qualificationTieIds.add(other.teamId));
  }
  const rows: StandingsRowView[] = standings.map((s, i) => {
    const outlook = playoffScenarios?.get(s.teamId)?.outlook;
    const confirmedIn = !!outlook && outlook.qualified === outlook.total;
    const confirmedOut = !!outlook && outlook.eliminated === outlook.total;
    const pending = pendingTeamIds.has(s.teamId) && !confirmedOut &&
      (!outlook || outlook.qualificationTiebreaker > 0 || outlook.seedingTiebreaker > 0);
    const seedPending = pending && (outlook
      ? confirmedIn && outlook.seedingTiebreaker > 0
      : !qualificationTieIds.has(s.teamId));
    return ({
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
    clinch: cutIsReal || pending
      ? confirmedIn ? "CLINCHED" : confirmedOut ? "ELIMINATED"
        : pending && !seedPending ? null : (clinch?.get(s.teamId) ?? null)
      : null,
    move: movement?.get(s.teamId) ?? 0,
    idDecided: !confirmedOut && (s.idDecided ?? false),
    tiebreakerResolved: s.tiebreakerResolved ?? false,
    tiebreakerPending: pending && !withdrawnIds?.has(s.teamId),
    seedingTiebreakerPending: seedPending,
    withdrawn: withdrawnIds?.has(s.teamId) ?? false,
    playoffSeed: pending || confirmedOut
      ? null
      : playoffSeedByTeam?.get(s.teamId) ?? null,
  });
  });
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
