import { adminHref } from "@/lib/admin-tabs";
import { adminMatchRowId } from "@/lib/match-anchors";
import Link from "@/components/app-link";
import { MATCH_STATUS } from "@/lib/constants";
import { autoCheckStatus } from "@/lib/result-sync";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import { matchRoundLabel, playoffTotalRounds } from "@/lib/schedule";
import { matchNightSide, nightSideLabel } from "@/lib/admin-match-night";
import { AutoCheckLine } from "@/components/admin-match-tools";
import { Badge, Card, CardBody, CardHeader, textLink } from "@/components/ui";
import { AdminAnchor } from "@/components/admin/admin-section";
import type { AdminData, Season } from "@/components/admin/season-admin-data";

/**
 * Match night on Overview: each of tonight's fixtures with its state,
 * check-ins, standins and next automatic result check, and a link to its
 * full result controls on Matches ("Result controls"). The fixture
 * name opens the public match page (rosters, check-ins, games), which has no
 * admin controls of its own.
 */
export function TonightMatches({
  season,
  data,
  slate,
  nowMs,
}: {
  season: Season;
  data: AdminData;
  slate: AdminData["matches"];
  nowMs: number;
}) {
  const totalRounds = playoffTotalRounds(data.matches);
  const names = new Map(data.teams.map((team) => [team.id, team.name]));
  const rosters = new Map(
    data.teams.map((team) => [
      team.id,
      team.members.map((member) => member.userId),
    ]),
  );
  return (
    <AdminAnchor id="adm-tonight">
      <Card>
        <CardHeader
          headingLevel={2}
          title="Tonight"
          subtitle="Fixtures kicking off soon, being played, or still waiting on a result."
        />
        <CardBody>
          <ul className="space-y-2">
            {slate.map((m) => {
              const home = m.homeTeamId ? names.get(m.homeTeamId) : undefined;
              const away = m.awayTeamId ? names.get(m.awayTeamId) : undefined;
              const open = m.status !== MATCH_STATUS.COMPLETED;
              const check = autoCheckStatus(m, season, nowMs);
              const sides =
                open && m.homeTeamId && m.awayTeamId
                  ? ([
                      [home, m.homeTeamId],
                      [away, m.awayTeamId],
                    ] as const).map(([name, teamId]) => ({
                      name: name ?? "?",
                      label: nightSideLabel(
                        matchNightSide(
                          rosters.get(teamId) ?? [],
                          teamId,
                          m.standins,
                          m.availability,
                          season.teamSize,
                        ),
                        m.status === MATCH_STATUS.LIVE,
                      ),
                    }))
                  : [];
              return (
                <li
                  key={m.id}
                  data-testid="admin-tonight-match"
                  className="space-y-1 rounded-lg border border-line p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-xs text-muted">
                      {matchRoundLabel(m, totalRounds, { bestOf: true })}
                    </span>
                    <Link
                      href={`/matches/${m.id}`}
                      className={textLink(
                        "min-w-0 flex-1 basis-48 font-medium [overflow-wrap:anywhere]",
                      )}
                    >
                      {home ?? "TBD"} vs {away ?? "TBD"}
                    </Link>
                    {m.status === MATCH_STATUS.LIVE ? (
                      <Badge tone="accent">
                        Live · {m.homeScore}–{m.awayScore}
                      </Badge>
                    ) : m.status === MATCH_STATUS.COMPLETED ? (
                      <Badge tone="success">
                        Final · {m.homeScore}–{m.awayScore}
                        {m.forfeit ? " · forfeit" : ""}
                      </Badge>
                    ) : null}
                  </div>
                  {m.scheduledAt ? (
                    <p className="text-xs text-muted">
                      Kickoff{" "}
                      <LocalTime
                        ts={m.scheduledAt.getTime()}
                        variant="short"
                        initial={formatLeagueMatchTime(m.scheduledAt, "short")}
                      />
                    </p>
                  ) : null}
                  {sides.map((side, index) => (
                    <p
                      key={index}
                      className="text-xs text-muted [overflow-wrap:anywhere]"
                    >
                      {side.name}: {side.label}
                    </p>
                  ))}
                  {check ? <AutoCheckLine check={check} /> : null}
                  {open ? (
                    <a
                      href={adminHref(adminMatchRowId(m.id))}
                      className={textLink("inline-block text-xs")}
                    >
                      Result controls →
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>
    </AdminAnchor>
  );
}
