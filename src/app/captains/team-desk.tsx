import type { Match } from "@prisma/client";
import Link from "@/components/app-link";
import { editTeamIdentity } from "@/app/actions/teams";
import { DiscordTag } from "@/components/discord-tag";
import { playoffStatusLine } from "@/components/playoff-outlook";
import { TeamCoachesCard } from "@/components/scrims/scrim-controls";
import { TeamIdentityForm } from "@/components/team-identity-form";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  LinkArrow,
  PlayerLink,
  RankBadge,
  textLink,
} from "@/components/ui";
import type { SessionUser } from "@/lib/auth";
import { CAPTAINS_ANCHOR } from "@/lib/captains";
import { MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { standingSummary, tablePlace } from "@/lib/home-slate";
import { projectPlayoffField } from "@/lib/playoff-field";
import { prisma } from "@/lib/prisma";
import type { SeasonSnapshot } from "@/lib/queries";
import { playoffOutlookShown, seasonScenarioReport } from "@/lib/stakes";
import { canEditTeamIdentity } from "@/lib/team-identity";
import { getTeamJersey } from "@/lib/team-jerseys";
import {
  canViewLeagueContact,
  hasActiveLeagueParticipation,
} from "@/lib/visibility";
import { cn } from "@/lib/utils";

/**
 * The team itself: its name and logo (the team page's own form and rule,
 * `canEditTeamIdentity`), where it stands, the roster with each player's
 * Discord handle, and the coaches. Roster moves stay with the admins.
 */
export async function TeamDesk({
  snapshot,
  matches,
  team,
  viewer,
  seasonOpen,
}: {
  snapshot: SeasonSnapshot;
  matches: Match[];
  team: { id: string; name: string; logoUrl: string | null; captainId: string };
  viewer: SessionUser;
  seasonOpen: boolean;
}) {
  const { season } = snapshot;
  const [roster, staff] = await Promise.all([
    prisma.teamMember.findMany({
      where: { seasonId: season.id, teamId: team.id },
      orderBy: { createdAt: "asc" },
      select: {
        userId: true,
        isCaptain: true,
        user: {
          select: {
            name: true,
            rankTier: true,
            discordName: true,
            discordId: true,
          },
        },
      },
    }),
    prisma.teamStaff.findMany({
      where: { teamId: team.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, userId: true, user: { select: { name: true } } },
    }),
  ]);
  const canEdit = canEditTeamIdentity({
    viewer,
    captainId: team.captainId,
    seasonIsActive: season.isActive,
    seasonStatus: season.status,
  });
  const jersey = getTeamJersey({
    id: team.id,
    roster: roster.map((m) => m.user),
  });
  // A sitting captain is a current team role, so league contact is theirs
  // whatever their registration row says (visibility.ts).
  const contact = hasActiveLeagueParticipation(
    snapshot.myReg?.status === "ACTIVE",
    true,
  );
  return (
    <div
      id={CAPTAINS_ANCHOR.team}
      className={cn(
        "grid scroll-mt-24 grid-cols-1 items-start gap-5",
        seasonOpen && "xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]",
      )}
    >
      <Card className="min-w-0">
        <CardHeader
          headingLevel={2}
          title="Your team"
          action={
            <Link href={`/teams/${team.id}`} className={textLink("text-sm")}>
              Team page <LinkArrow />
            </Link>
          }
        />
        <CardBody
          className={cn(
            "grid grid-cols-1 items-start gap-x-8 gap-y-5",
            canEdit && "lg:grid-cols-2",
          )}
        >
          {canEdit ? (
            <div className="min-w-0 space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Name and logo
              </h3>
              <p className="text-xs text-muted">
                Changes save right away and are posted in the league Discord.
                For a logo, upload the image to Imgur and paste its direct
                link (https://i.imgur.com/…).
              </p>
              <TeamIdentityForm
                // Remount on a saved change so the fields start from it.
                key={`${team.name}|${team.logoUrl ?? ""}`}
                action={editTeamIdentity}
                teamId={team.id}
                name={team.name}
                logoUrl={team.logoUrl}
                note={
                  jersey
                    ? "This team's Fourthwall jerseys stay linked when it is renamed."
                    : undefined
                }
              />
            </div>
          ) : null}
          <div className="min-w-0 space-y-5">
            {season.status === SEASON_STATUS.REGULAR_SEASON ? (
              <Standing snapshot={snapshot} matches={matches} teamId={team.id} />
            ) : season.status === SEASON_STATUS.PLAYOFFS ? (
              <Playoffs matches={matches} teamId={team.id} />
            ) : null}
            <div>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                Roster
              </h3>
              <ul aria-label="Your roster" className="divide-y divide-line-soft text-sm">
                {roster.map((m) => (
                  <li
                    key={m.userId}
                    className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-2"
                  >
                    <PlayerLink
                      userId={m.userId}
                      className="min-w-6 font-medium [overflow-wrap:anywhere]"
                    >
                      {m.user.name}
                    </PlayerLink>
                    {m.isCaptain ? <Badge tone="accent">Captain</Badge> : null}
                    <RankBadge rankTier={m.user.rankTier} />
                    {canViewLeagueContact(viewer, m.userId, contact) &&
                    m.user.discordName ? (
                      <DiscordTag
                        name={m.user.discordName}
                        verified={!!m.user.discordId}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                Signing or releasing a player goes through an admin.
              </p>
            </div>
          </div>
        </CardBody>
      </Card>
      {seasonOpen ? (
        <div className="min-w-0">
          <TeamCoachesCard team={{ name: team.name, staff }} id="team-coaches" />
        </div>
      ) : null}
    </div>
  );
}

/** The team's place and playoff status, as Home's "Where you stand" says it. */
function Standing({
  snapshot,
  matches,
  teamId,
}: {
  snapshot: SeasonSnapshot;
  matches: Match[];
  teamId: string;
}) {
  const field = projectPlayoffField(snapshot.teams, matches, snapshot.season);
  const group = field.groups?.find((g) =>
    g.standings.some((row) => row.teamId === teamId),
  );
  const table = group?.standings ?? field.standings;
  const place = tablePlace(table, teamId);
  const report = playoffOutlookShown(matches)
    ? seasonScenarioReport(
        field.eligibleStandings,
        matches,
        field.eligibleTeamIds.length,
        field,
      )
    : null;
  const scenario = report?.teams.get(teamId) ?? null;
  return (
    <div className="space-y-1 text-sm">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Where you stand
      </h3>
      <p>
        {place
          ? standingSummary({
              ...place,
              groupKey: group?.key ?? null,
              tableSize: table.length,
            })
          : "Not in the table"}
      </p>
      {scenario ? (
        <p className="font-medium">{playoffStatusLine(scenario)}</p>
      ) : null}
      <Link href="/schedule#standings" className={textLink()}>
        Full standings <LinkArrow />
      </Link>
    </div>
  );
}

function Playoffs({ matches, teamId }: { matches: Match[]; teamId: string }) {
  const playoff = matches.filter(
    (m) =>
      (m.phase === "PLAYOFF" || m.phase === "FINAL") &&
      (m.homeTeamId === teamId || m.awayTeamId === teamId),
  );
  const lost = playoff.some(
    (m) =>
      m.status === MATCH_STATUS.COMPLETED &&
      m.winnerTeamId !== null &&
      m.winnerTeamId !== teamId,
  );
  return (
    <div className="space-y-1 text-sm">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Playoffs
      </h3>
      <p>
        {playoff.length === 0
          ? "Your team isn't in the bracket."
          : lost
            ? "Your team is out of the playoffs."
            : "Your team is still in the bracket."}
      </p>
      <Link href="/schedule#playoff-bracket" className={textLink()}>
        The bracket <LinkArrow />
      </Link>
    </div>
  );
}
