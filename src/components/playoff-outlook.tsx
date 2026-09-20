import type { ScenarioOutlook, TeamScenario } from "@/lib/scenarios";

/** Counts are feasible result combinations, never estimated probabilities. */
export function outlookSummary(outlook: ScenarioOutlook): string {
  const { total, qualified, qualificationTiebreaker, eliminated, seedingTiebreaker } = outlook;
  if (qualified === total) {
    if (seedingTiebreaker === total)
      return "Qualified for playoffs; seeding tiebreaker required.";
    if (seedingTiebreaker > 0)
      return "Qualified for playoffs; a seeding tiebreaker remains possible.";
    return "Qualified for playoffs.";
  }
  if (qualificationTiebreaker === total) return "Qualification tiebreaker required.";
  if (eliminated === total) return "Eliminated from playoffs.";
  const outcomes: string[] = [];
  if (qualified > 0) outcomes.push(`qualify in ${qualified} of ${total}`);
  if (qualificationTiebreaker > 0)
    outcomes.push(`qualification tiebreaker in ${qualificationTiebreaker} of ${total}`);
  if (eliminated > 0) outcomes.push(`eliminated in ${eliminated} of ${total}`);
  return `${outcomes.join("; ")}.`;
}

export function playoffStatusLine(scenario: TeamScenario): string {
  const outlook = scenario.outlook;
  if (outlook) {
    if (outlook.qualified === outlook.total)
      return outlook.seedingTiebreaker === outlook.total
        ? "Qualified · seeding tiebreaker"
        : "Qualified for playoffs";
    if (outlook.qualificationTiebreaker === outlook.total)
      return "Playoff spot decided by tiebreaker";
    if (outlook.eliminated === outlook.total) return "Eliminated";
  }
  if (!outlook && scenario.status === "CLINCHED") return "Qualified for playoffs";
  if (!outlook && scenario.status === "ELIMINATED") return "Eliminated";
  if (scenario.paths?.win && scenario.paths.win.qualified === scenario.paths.win.total)
    return "Win to qualify";
  if (scenario.nextMatchId === null)
    return "Waiting on remaining results";
  if (scenario.winAndIn) return "Win to qualify";
  if (scenario.loseAndOut) return "Must avoid a loss";
  return "Playoff spot still open";
}

/** The default view states possibilities, without turning counts into odds. */
export function shortOutlook(outlook: ScenarioOutlook): string {
  const { total, qualified, qualificationTiebreaker, eliminated } = outlook;
  if (qualified === total) return "Qualify";
  if (qualificationTiebreaker === total) return "Tiebreaker for a spot";
  if (eliminated === total) return "Out";
  if (qualified > 0 && qualificationTiebreaker > 0 && eliminated > 0)
    return "Qualify, tiebreaker or out";
  if (qualified > 0 && qualificationTiebreaker > 0) return "Qualify or tiebreaker";
  if (qualificationTiebreaker > 0 && eliminated > 0) return "Tiebreaker or out";
  return "Qualify or out";
}

export function playoffPathLines(scenario: TeamScenario | undefined, matchId?: string) {
  if (!scenario?.paths || (matchId && scenario.nextMatchId !== matchId)) return [];
  return (["win", "draw", "loss"] as const).flatMap((outcome) => {
    const result = scenario.paths?.[outcome];
    return result ? [{
      key: outcome,
      label: outcome === "win" ? "Win" : outcome === "draw" ? "Draw" : "Loss",
      description: shortOutlook(result),
      detail: outlookSummary(result),
    }] : [];
  });
}

export function PlayoffOutlook({
  scenario,
  teamNames,
  matchId,
  showPaths = true,
  compact = false,
}: {
  scenario: TeamScenario;
  teamNames?: Map<string, string>;
  /** Only attach conditional paths to the fixture they actually describe. */
  matchId?: string;
  showPaths?: boolean;
  compact?: boolean;
}) {
  const paths = showPaths ? playoffPathLines(scenario, matchId) : [];
  const outlook = scenario.outlook;
  const tiedGroups = outlook?.qualificationTies ?? [];
  const mayNeedQualificationTiebreaker = (outlook?.qualificationTiebreaker ?? 0) > 0 ||
    Object.values(scenario.paths ?? {}).some((path) => path && path.qualificationTiebreaker > 0);
  return (
    <div
      data-testid="playoff-outlook"
      data-team-id={scenario.teamId}
      className="min-w-0 space-y-2 text-xs leading-relaxed [overflow-wrap:anywhere]"
    >
      <p data-testid="playoff-status" className="font-medium text-fg">{playoffStatusLine(scenario)}</p>
      {paths.length > 0 ? (
        <dl data-testid="playoff-paths" className="space-y-1.5">
          {paths.map((path) => (
            <div key={path.key} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
              <dt className="font-semibold text-accent">{path.label}</dt>
              <dd className="text-muted">{path.description}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {!compact && (outlook || paths.length > 0) ? (
        <details className="group text-muted">
          <summary className="w-fit cursor-pointer py-1 text-[11px] font-medium text-info hover:underline">
            How this works
          </summary>
          <div className="mt-1 space-y-2 border-l border-line pl-3">
            {outlook ? <p>{outlookSummary(outlook)}</p> : null}
            {paths.length > 0 ? (
              <ul className="space-y-1">
                {paths.map((path) => <li key={path.key}><strong>{path.label}:</strong> {path.detail}</li>)}
              </ul>
            ) : null}
            {tiedGroups.length > 0 ? (
              <ul className="space-y-1 text-muted">
                {tiedGroups.map((group) => (
                  <li key={`${group.teamIds.join(":")}:${group.spots}`}>
                    {outlook?.qualificationTiebreaker === outlook?.total ? "Tiebreaker" : "Possible tiebreaker"}: {group.teamIds.map((id) => teamNames?.get(id) ?? id).join(", ")}{" "}
                    for {group.spots} playoff place{group.spots === 1 ? "" : "s"}.
                  </li>
                ))}
              </ul>
            ) : null}
            {outlook ? (
              <p className="text-muted">
                {outlook.bestRank === outlook.worstRank
                  ? `Playoff order: #${outlook.bestRank}.`
                  : `Possible playoff order: #${outlook.bestRank}–#${outlook.worstRank}.`}
              </p>
            ) : null}
            {mayNeedQualificationTiebreaker ? (
              <p className="text-[11px] text-muted">
                Tiebreakers use BO1 knockouts: up to three games per team in one weekend.
                Published brackets keep their original format.
              </p>
            ) : null}
            {paths.length > 0 || (outlook && outlook.total > 1) ? (
              <p className="text-[11px] text-muted">
                Counts are result combinations, not qualification odds. Assumes
                normally completed series; administrative rulings or score corrections
                can change outcomes.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
