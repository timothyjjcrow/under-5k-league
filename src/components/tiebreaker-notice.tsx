import Link from "next/link";
import type { PlayoffFieldProjection } from "@/lib/playoff-field";

/** The playoff order is provisional until every required extra series is final. */
export function TiebreakerNotice({
  projection,
  teams,
  regularComplete,
  hasTiebreakers,
  scheduleLink = true,
}: {
  projection: PlayoffFieldProjection;
  teams: { id: string; name: string }[];
  regularComplete: boolean;
  hasTiebreakers: boolean;
  scheduleLink?: boolean;
}) {
  if (!regularComplete && !hasTiebreakers) return null;
  const unresolved = projection.seedingDeadHeatTeamIds;
  if (
    unresolved.length === 0 &&
    !hasTiebreakers &&
    !projection.tiebreakers.error
  )
    return null;
  const names = new Map(teams.map((team) => [team.id, team.name]));
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
      <p className="text-muted">
        {projection.tiebreakers.error
          ? "The tiebreaker fixtures need an administrator's review before the playoff bracket can start."
          : unresolved.length > 0
            ? `${unresolved.map((id) => names.get(id) ?? id).join(", ")} are tied for playoff qualification or seeding. ${projection.tiebreakers.pending ? "The scheduled tiebreaker matches must finish before playoffs begin." : "The remaining tiebreaker matches must be scheduled before playoffs begin."}`
            : "The extra results have settled playoff qualification and seeding. The playoff bracket can now be started by an administrator."}{" "}
        Regular-season points stay the same.
      </p>
      {unresolved.length > 0 && !projection.tiebreakers.error ? (
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
      ) : null}
      {scheduleLink ? (
        <Link
          href="/schedule#tiebreakers"
          className="inline-block py-1 text-info hover:underline"
        >
          Tiebreaker schedule →
        </Link>
      ) : null}
    </aside>
  );
}
