import type { ScenarioOutlook, TeamScenario } from "@/lib/scenarios";
import { cn } from "@/lib/utils";

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
  const pathLine = pathsStatusLine(scenario.paths);
  if (pathLine) return pathLine;
  if (scenario.nextMatchId === null)
    return "Waiting on remaining results";
  if (scenario.winAndIn) return "Win to qualify";
  if (scenario.loseAndOut)
    return every(scenario.paths?.draw, "eliminated") ? "Must win" : "Must avoid a loss";
  return "Playoff spot still open";
}

/** Every counted combination for this result ends the same way. */
function every(path: ScenarioOutlook | null | undefined, verdict: "qualified" | "eliminated") {
  return !!path && path.total > 0 && path[verdict] === path.total;
}

/**
 * The headline read off the same Win/Draw/Loss paths the table under it
 * prints, so the two can never disagree: a draw that also qualifies isn't
 * "Win to qualify", and a draw that eliminates isn't "avoid a loss". A null
 * path is a result that can't happen (a BO3 can't be drawn; a BO2 at 1-0
 * can't be lost), never a result that knocks them out.
 */
function pathsStatusLine(paths: TeamScenario["paths"]): string | null {
  if (!paths) return null;
  const { win, draw, loss } = paths;
  if (every(win, "qualified"))
    return every(draw, "qualified") ? "Avoid a loss to qualify" : "Win to qualify";
  const alive = (path: ScenarioOutlook | null) => !!path && !every(path, "eliminated");
  if (alive(win) && (draw || loss) && !alive(draw) && !alive(loss))
    return win!.qualificationTiebreaker === win!.total
      ? "Must win to reach a tiebreaker"
      : "Needs a win and help";
  if (every(loss, "eliminated") && alive(draw)) return "Must avoid a loss";
  return null;
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

export type PlayoffPathLine = {
  /** "any" when every possible result leads to the same place. */
  key: "win" | "draw" | "loss" | "any";
  label: string;
  description: string;
  detail: string;
};

/**
 * What a result leads to, compared exactly. A settled verdict is the same
 * whatever the other games do; anything mixed compares its counts, because
 * the short label lumps "qualify in 8 of 9" and "qualify in 1 of 9" together
 * as "Qualify or out".
 */
function verdictKey(outlook: ScenarioOutlook): string {
  const { total, qualified, qualificationTiebreaker, eliminated } = outlook;
  if (qualified === total) return "qualified";
  if (eliminated === total) return "eliminated";
  if (qualificationTiebreaker === total) return "tiebreaker";
  return `${qualified}/${qualificationTiebreaker}/${eliminated} of ${total}`;
}

export function playoffPathLines(
  scenario: TeamScenario | undefined,
  matchId?: string,
): PlayoffPathLine[] {
  if (!scenario?.paths || (matchId && scenario.nextMatchId !== matchId)) return [];
  const results = (["win", "draw", "loss"] as const).flatMap((outcome) => {
    const result = scenario.paths?.[outcome];
    return result ? [{ outcome, result }] : [];
  });
  const lines = results.map(({ outcome, result }) => ({
    key: outcome,
    label: outcome === "win" ? "Win" : outcome === "draw" ? "Draw" : "Loss",
    description: shortOutlook(result),
    detail: outlookSummary(result),
  }));
  // "Win Qualify · Draw Qualify · Loss Qualify" is three lines that say the
  // next result changes nothing: fold them into one. Only when every result
  // really leads to the same place, not merely the same short label.
  const firstKey = results[0] ? verdictKey(results[0].result) : null;
  if (lines.length > 1 && results.every(({ result }) => verdictKey(result) === firstKey)) {
    return [{
      key: "any",
      label: "Any result",
      description: lines[0].description,
      detail: scenario.outlook ? outlookSummary(scenario.outlook) : lines[0].detail,
    }];
  }
  return lines;
}

/** "Playoff order: #2." or "Possible playoff order: #1–#3." */
function playoffOrderLine(outlook: ScenarioOutlook): string {
  return outlook.bestRank === outlook.worstRank
    ? `Playoff order: #${outlook.bestRank}.`
    : `Possible playoff order: #${outlook.bestRank}–#${outlook.worstRank}.`;
}

function mayNeedQualificationTiebreaker(scenario: TeamScenario): boolean {
  return (scenario.outlook?.qualificationTiebreaker ?? 0) > 0 ||
    Object.values(scenario.paths ?? {}).some((path) => path && path.qualificationTiebreaker > 0);
}

const TIEBREAKER_FORMAT_NOTE =
  "Tiebreakers use BO1 knockouts: up to three games per team in one weekend. Published brackets keep their original format.";

const COUNTS_NOTE =
  "Counts are result combinations, not qualification odds. Assumes normally completed series; administrative rulings or score corrections can change outcomes.";

/** Every counted result gives the same qualification verdict. */
function settled(outlook: ScenarioOutlook | undefined) {
  return !!outlook && (outlook.qualified === outlook.total ||
    outlook.eliminated === outlook.total ||
    outlook.qualificationTiebreaker === outlook.total);
}

/**
 * The team's playoff status as a chip once nothing left can change it
 * (qualified, out, or a tiebreaker for the spot), else null. The team page
 * shows it beside the name and keeps its outlook card only while results
 * still matter.
 */
export function settledPlayoffStatus(
  scenario: TeamScenario,
): { text: string; tone: "success" | "accent" | "neutral" } | null {
  const outlook = scenario.outlook;
  const isSettled = outlook
    ? settled(outlook)
    : scenario.status === "CLINCHED" || scenario.status === "ELIMINATED";
  if (!isSettled) return null;
  const text = playoffStatusLine(scenario);
  const qualified = outlook
    ? outlook.qualified === outlook.total
    : scenario.status === "CLINCHED";
  const out = outlook
    ? outlook.eliminated === outlook.total
    : scenario.status === "ELIMINATED";
  return { text, tone: qualified ? "success" : out ? "neutral" : "accent" };
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
  const outlook = scenario.outlook;
  const lines = showPaths ? playoffPathLines(scenario, matchId) : [];
  // A folded "Any result: Qualify" under "Qualified for playoffs" repeats the
  // status line, so a settled team shows the status alone.
  const folded = lines.length === 1 && lines[0].key === "any";
  const paths = folded && settled(outlook) ? [] : lines;
  const tiedGroups = outlook?.qualificationTies ?? [];
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
            <div
              key={path.key}
              className={cn(
                "grid gap-2",
                // The folded "Any result" label is wider than Win/Draw/Loss.
                path.key === "any"
                  ? "grid-cols-[auto_minmax(0,1fr)]"
                  : "grid-cols-[3rem_minmax(0,1fr)]",
              )}
            >
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
            {paths.length > 0 && !folded ? (
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
              <p className="text-muted">{playoffOrderLine(outlook)}</p>
            ) : null}
            {mayNeedQualificationTiebreaker(scenario) ? (
              <p className="text-[11px] text-muted">{TIEBREAKER_FORMAT_NOTE}</p>
            ) : null}
            {paths.length > 0 || (outlook && outlook.total > 1) ? (
              <p className="text-[11px] text-muted">{COUNTS_NOTE}</p>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * One "How this works" for a list of compact outlooks (the Schedule playoff
 * tracker), instead of the same disclosure repeated on every team's card:
 * each team's counts and playoff order in one list, then the rules once.
 */
export function PlayoffOutlookFootnote({
  scenarios,
  teamNames,
}: {
  scenarios: readonly TeamScenario[];
  teamNames?: Map<string, string>;
}) {
  const withOutlook = scenarios.filter((scenario) => scenario.outlook);
  const tiedGroups = [
    ...new Map(
      withOutlook
        .flatMap((scenario) => scenario.outlook?.qualificationTies ?? [])
        .map((group) => [`${[...group.teamIds].sort().join(":")}:${group.spots}`, group]),
    ).entries(),
  ];
  const anyTiebreaker = scenarios.some(mayNeedQualificationTiebreaker);
  const anyCounts = scenarios.some(
    (scenario) =>
      Object.values(scenario.paths ?? {}).some(Boolean) ||
      (scenario.outlook?.total ?? 0) > 1,
  );
  if (withOutlook.length === 0 && !anyCounts) return null;
  const name = (id: string) => teamNames?.get(id) ?? id;
  // Certain once any team in the group has a tiebreaker in every case.
  const certainTie = (teamIds: readonly string[]) =>
    withOutlook.some(
      (scenario) =>
        teamIds.includes(scenario.teamId) &&
        scenario.outlook!.qualificationTiebreaker === scenario.outlook!.total,
    );
  return (
    <details
      data-testid="playoff-outlook-footnote"
      className="group text-xs leading-relaxed text-muted [overflow-wrap:anywhere]"
    >
      <summary className="w-fit cursor-pointer py-1 text-[11px] font-medium text-info hover:underline">
        How this works
      </summary>
      <div className="mt-1 space-y-2 border-l border-line pl-3">
        {withOutlook.length > 0 ? (
          <ul className="space-y-1">
            {withOutlook.map((scenario) => (
              <li key={scenario.teamId}>
                <strong className="text-fg">{name(scenario.teamId)}:</strong>{" "}
                {outlookSummary(scenario.outlook!)} {playoffOrderLine(scenario.outlook!)}
              </li>
            ))}
          </ul>
        ) : null}
        {tiedGroups.length > 0 ? (
          <ul className="space-y-1">
            {tiedGroups.map(([key, group]) => (
              <li key={key}>
                {certainTie(group.teamIds) ? "Tiebreaker" : "Possible tiebreaker"}:{" "}
                {group.teamIds.map(name).join(", ")}{" "}
                for {group.spots} playoff place{group.spots === 1 ? "" : "s"}.
              </li>
            ))}
          </ul>
        ) : null}
        {anyTiebreaker ? <p className="text-[11px]">{TIEBREAKER_FORMAT_NOTE}</p> : null}
        {anyCounts ? <p className="text-[11px]">{COUNTS_NOTE}</p> : null}
      </div>
    </details>
  );
}
