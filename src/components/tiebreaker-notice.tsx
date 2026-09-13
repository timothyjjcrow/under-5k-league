import Link from "next/link";
import type { PlayoffFieldProjection } from "@/lib/playoff-field";
import type { ScenarioReport } from "@/lib/scenarios";

/** The playoff order is provisional until every required extra series is final. */
export function TiebreakerNotice({
  projection,
  teams,
  regularComplete,
  hasTiebreakers,
  report,
  scheduleLink = true,
}: {
  projection: PlayoffFieldProjection;
  teams: { id: string; name: string }[];
  regularComplete: boolean;
  hasTiebreakers: boolean;
  report?: ScenarioReport | null;
  scheduleLink?: boolean;
}) {
  if (!regularComplete && !hasTiebreakers) return null;
  const finalTeams = report?.forecast?.basis === "final" ? report.teams : null;
  const unresolved = projection.seedingDeadHeatTeamIds.filter((id) => {
    const outlook = finalTeams?.get(id)?.outlook;
    return !outlook || outlook.qualificationTiebreaker > 0 || outlook.seedingTiebreaker > 0;
  });
  if (
    unresolved.length === 0 &&
    !hasTiebreakers &&
    !projection.tiebreakers.error
  )
    return null;
  const names = new Map(teams.map((team) => [team.id, team.name]));
  const qualificationIds = unresolved.filter((id) => {
    const outlook = finalTeams?.get(id)?.outlook;
    if (outlook) return outlook.qualificationTiebreaker > 0;
    const group = projection.eligibleStandings.find((row) => row.teamId === id)?.idTieGroup;
    return projection.eligibleStandings.some((row, index) =>
      row.idTieGroup === group && index >= projection.bracketSize,
    );
  });
  const seedingIds = unresolved.filter((id) => !qualificationIds.includes(id));
  const tieSummary = [
    qualificationIds.length > 0
      ? `${qualificationIds.map((id) => names.get(id) ?? id).join(", ")} need a qualification tiebreaker.`
      : "",
    seedingIds.length > 0
      ? `${seedingIds.map((id) => names.get(id) ?? id).join(", ")} have qualified; their seeding tiebreaker decides playoff order.`
      : "",
  ].filter(Boolean).join(" ");
  const hasThreeTeamBracket = projection.tiebreakers.groups.some(
    (group) => group.format === "BO1_DOUBLE_ELIMINATION",
  );
  const byes = [...new Set(projection.tiebreakers.groups.flatMap(
    (group) => group.byeTeamId ? [group.byeTeamId] : [],
  ))];
  return (
    <aside
      className="space-y-1 rounded-lg border border-accent/40 bg-accent/10 px-4 py-3 text-sm"
      aria-label="Playoff tiebreaker status"
    >
      <p className="font-semibold">
        {unresolved.length > 0 || projection.tiebreakers.error
          ? "Playoff tiebreaker week"
          : "Playoff tiebreakers complete"}
      </p>
      {hasThreeTeamBracket && unresolved.length > 0 && !projection.tiebreakers.error ? (
        <p className="text-xs text-fg">
          Three teams · 4–5 best-of-one games · One tiebreaker week.
          {byes.length > 0 ? ` ${byes.map((id) => names.get(id) ?? id).join(", ")} starts in Game 2 with an opening bye.` : " The opening matchup and bye will be drawn when scheduled."}
        </p>
      ) : null}
      <p className="text-muted">
        {projection.tiebreakers.error
          ? "The tiebreaker fixtures need an administrator's review before the playoff bracket can start."
          : unresolved.length > 0
            ? tieSummary
            : "Qualification and seeds are settled. Ready for playoffs."}
      </p>
      {unresolved.length > 0 && !projection.tiebreakers.error ? (
        <details className="text-xs text-muted">
          <summary className="w-fit cursor-pointer py-1 text-info hover:underline">Format &amp; next steps</summary>
          <div className="mt-1 space-y-2">
            <p>{projection.tiebreakers.pending ? "Finish the scheduled tiebreakers before playoffs begin." : "An administrator must schedule the remaining tiebreakers."} Regular-season points stay the same.</p>
            <p className="text-muted">
              {hasThreeTeamBracket
                ? "Three tied teams play a best-of-one double-elimination bracket: four games, or five if the final needs a reset, all in the same tiebreaker week. Two losses eliminate a team; the bracket determines every seed."
                : "Two tied teams play one best-of-three series. Larger round-robin groups play best-of-three series, ranked by wins then game differential."}
              {hasThreeTeamBracket ? " Two-team ties use one best-of-three series." : ""}
              {byes.length > 0
                ? ` Opening bye drawn: ${byes.map((id) => names.get(id) ?? id).join(", ")}.`
                : hasThreeTeamBracket
                  ? " The opening matchup and bye are drawn when the week is scheduled."
                  : ""}
            </p>
          </div>
        </details>
      ) : null}
      {scheduleLink ? (
        <Link
          href="/schedule#tiebreakers"
          className="inline-block py-1 text-info hover:underline"
        >
          View tiebreaker bracket →
        </Link>
      ) : null}
    </aside>
  );
}
