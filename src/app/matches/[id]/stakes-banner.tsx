import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { seasonScenarioReport, type StakesMatchRow } from "@/lib/stakes";
import { projectPlayoffField } from "@/lib/playoff-field";
import { PlayoffOutlook } from "@/components/playoff-outlook";
import { Card, CardBody, CardHeader, TeamCrest } from "@/components/ui";

/**
 * "Tonight's stakes": what this match means for the playoff race, from the
 * exact scenario engine. Renders only when the night actually decides
 * something (win-and-in / lose-and-out / magic number 1) or a side's fate is
 * already sealed — early-season "everyone's in the hunt" stays silent.
 */
export async function StakesBanner({
  match,
  seasonMatches,
}: {
  match: {
    id: string;
    seasonId: string;
    phase: string;
    homeTeamId: string;
    awayTeamId: string;
    homeTeam: { name: string; logoUrl: string | null };
    awayTeam: { name: string; logoUrl: string | null };
    season: { status: string };
  };
  // Passed down from MatchPreview, which already loaded the season's matches.
  seasonMatches: (StakesMatchRow & {
    homeScore: number;
    awayScore: number;
    winnerTeamId: string | null;
  })[];
}) {
  if (match.phase !== "REGULAR") return null;
  if (match.season.status !== "REGULAR_SEASON") return null;

  const teams = await prisma.team.findMany({
    where: { seasonId: match.seasonId },
    select: { id: true, name: true, withdrawn: true },
  });
  const playoffField = projectPlayoffField(teams, seasonMatches);
  const report = seasonScenarioReport(
    playoffField.eligibleStandings,
    seasonMatches,
    playoffField.eligibleTeamIds.length,
    playoffField,
  );
  if (!report) return null;

  const sides = [match.homeTeamId, match.awayTeamId].flatMap((teamId) => {
    const scenario = report.teams.get(teamId);
    return scenario ? [{ teamId, scenario }] : [];
  });
  if (!sides.some(({ scenario }) => scenario.paths || scenario.status || scenario.outlook)) return null;
  const teamNames = new Map(teams.map((team) => [team.id, team.name]));

  const nameOf = new Map([
    [match.homeTeamId, match.homeTeam.name],
    [match.awayTeamId, match.awayTeam.name],
  ]);
  const logoOf = new Map([
    [match.homeTeamId, match.homeTeam.logoUrl],
    [match.awayTeamId, match.awayTeam.logoUrl],
  ]);
  return (
    <Card className="border-accent/30">
      <CardHeader
        title="Tonight's stakes"
        headingLevel={2}
        subtitle="How each feasible result changes playoff qualification"
      />
      <CardBody className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {sides.map((s) => {
          const status = report.teams.get(s.teamId)?.status ?? null;
          return (
            <div
              key={s.teamId}
              className={cn(
                "flex min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2 text-sm",
                status === "CLINCHED"
                  ? "border-success/30 bg-success/5"
                  : status === "ELIMINATED"
                    ? "border-line bg-surface-2/40 text-muted"
                    : "border-accent/30 bg-accent/5",
              )}
            >
              <TeamCrest
                name={nameOf.get(s.teamId) ?? "?"}
                seed={s.teamId}
                logoUrl={logoOf.get(s.teamId)}
                size={22}
                className="shrink-0 rounded-md"
              />
              <div className="min-w-0 flex-1">
                <p className="mb-2 font-medium">
                  {nameOf.get(s.teamId) ?? "?"}
                </p>
                <PlayoffOutlook scenario={s.scenario} teamNames={teamNames} matchId={match.id} />
              </div>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}
