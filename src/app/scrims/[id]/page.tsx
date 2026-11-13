import Link from "@/components/app-link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import {
  MATCH_STATUS,
  REGISTRATION_STATUS,
  SCRIM_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { heroById } from "@/lib/heroes";
import { parseGamePlayers } from "@/lib/player-stats";
import {
  isScrimNotPlayed,
  scrimJoinCheck,
  scrimManageView,
} from "@/lib/scrim-view";
import { scrimNextStep, scrimRecordingLine } from "@/lib/scrim-lobby";
import { scrimLobbyPassword } from "@/lib/scrim-lobby-password";
import {
  describeScrimConflict,
  findConfirmedScrimConflict,
  scrimCollisionRange,
} from "@/lib/scrim-schedule-conflict";
import { canViewLeagueContact } from "@/lib/visibility";
import { LocalTime } from "@/components/local-time";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { DiscordTag } from "@/components/discord-tag";
import { ScrimCancelButton } from "@/components/scrims/scrim-controls";
import { ScrimLobbyCard } from "@/components/scrims/scrim-lobby-card";
import {
  ScrimEndSeriesForm,
  ScrimLineups,
  ScrimResultTools,
} from "@/components/scrims/scrim-manage";
import { joinScrim, removeScrimGame } from "@/app/actions/scrims";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  HeroIcon,
  KDA,
  PageTitle,
  PlayerLink,
  TAP_SAFE,
  TeamCrest,
  textLink,
} from "@/components/ui";
import { cn } from "@/lib/utils";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const scrim = await prisma.scrim.findUnique({
    where: { id },
    select: {
      hostTeam: { select: { name: true } },
      opponentTeam: { select: { name: true } },
    },
  });
  if (!scrim) return { title: "Scrim not found" };
  return {
    title: scrim.opponentTeam
      ? `${scrim.hostTeam.name} vs ${scrim.opponentTeam.name} scrim`
      : `${scrim.hostTeam.name} scrim availability`,
  };
}

const captainSelect = {
  select: { id: true, name: true, discordName: true, discordId: true },
} as const;

type ScrimCaptain = {
  id: string;
  name: string;
  discordName: string;
  discordId: string | null;
};

/**
 * One side of the matchup: team, its role in the scrim, its captain, and —
 * for league members only (the DiscordTag rule) — the captain's copyable
 * Discord handle, so the two captains can find each other without a trip
 * through the team pages. The right-hand side mirrors from sm up.
 */
function ScrimSide({
  team,
  label,
  captain,
  showContact,
  mirrored = false,
}: {
  team: { id: string; name: string; logoUrl: string | null };
  label: string;
  captain: ScrimCaptain;
  showContact: boolean;
  mirrored?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-3",
        mirrored && "sm:flex-row-reverse sm:text-right",
      )}
    >
      <TeamCrest
        seed={team.id}
        name={team.name}
        logoUrl={team.logoUrl}
        size={48}
      />
      <div className="min-w-0">
        <Link
          href={`/teams/${team.id}`}
          className={cn(
            "block truncate font-display text-lg font-semibold text-fg hover:text-info",
            TAP_SAFE,
          )}
        >
          {team.name}
        </Link>
        <p className="text-xs text-muted">{label}</p>
        <p
          className={cn(
            "mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 text-sm",
            mirrored && "sm:justify-end",
          )}
        >
          <span className="text-muted">Captain</span>
          <PlayerLink userId={captain.id} className="min-w-6 max-w-full truncate">
            {captain.name}
          </PlayerLink>
          {showContact ? (
            captain.discordName ? (
              <DiscordTag
                name={captain.discordName}
                verified={!!captain.discordId}
                className="min-w-0"
              />
            ) : (
              <span className="text-xs text-muted">no Discord</span>
            )
          ) : null}
        </p>
      </div>
    </div>
  );
}

function statusBadge(status: string, notPlayed: boolean) {
  if (notPlayed) return <Badge>Not played</Badge>;
  if (status === SCRIM_STATUS.OPEN) return <Badge tone="info">Open</Badge>;
  if (status === SCRIM_STATUS.SCHEDULED)
    return <Badge tone="success">Booked</Badge>;
  if (status === SCRIM_STATUS.LIVE) return <Badge tone="accent">Live</Badge>;
  if (status === SCRIM_STATUS.COMPLETED)
    return <Badge tone="success">Final</Badge>;
  return <Badge>Cancelled</Badge>;
}

/**
 * The Join button's verdict for an OPEN time: the viewer's own team (when
 * they captain one) and anything it already has within four hours, so the
 * page gives the same answer the service would instead of a button that
 * errors or no control at all.
 */
async function openScrimJoinCheck(
  scrim: {
    id: string;
    seasonId: string;
    status: string;
    scheduledAt: Date;
    hostTeamId: string;
    hostTeam: { withdrawn: boolean };
  },
  viewerId: string | null,
  seasonOpen: boolean,
  nowMs: number,
) {
  const viewerTeam = viewerId
    ? await prisma.team.findUnique({
        where: {
          seasonId_captainId: { seasonId: scrim.seasonId, captainId: viewerId },
        },
        select: { id: true, name: true, withdrawn: true },
      })
    : null;
  let viewerTeamClash: string | null = null;
  if (
    seasonOpen &&
    viewerTeam &&
    viewerTeam.id !== scrim.hostTeamId &&
    !viewerTeam.withdrawn
  ) {
    const [leagueMatch, scrimClash] = await Promise.all([
      prisma.match.findFirst({
        where: {
          seasonId: scrim.seasonId,
          scheduledAt: scrimCollisionRange(scrim.scheduledAt),
          status: { not: MATCH_STATUS.COMPLETED },
          OR: [{ homeTeamId: viewerTeam.id }, { awayTeamId: viewerTeam.id }],
        },
        select: { id: true },
      }),
      findConfirmedScrimConflict(prisma, {
        seasonId: scrim.seasonId,
        teamIds: [viewerTeam.id],
        scheduledAt: scrim.scheduledAt,
        exceptScrimId: scrim.id,
      }),
    ]);
    viewerTeamClash = leagueMatch
      ? "a league match"
      : scrimClash
        ? describeScrimConflict(scrimClash)
        : null;
  }
  return scrimJoinCheck({
    status: scrim.status,
    seasonOpen,
    signedIn: !!viewerId,
    viewerTeam,
    hostTeamId: scrim.hostTeamId,
    hostWithdrawn: scrim.hostTeam.withdrawn,
    scheduledAtMs: scrim.scheduledAt.getTime(),
    nowMs,
    viewerTeamClash,
  });
}

export default async function ScrimDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [scrim, viewer] = await Promise.all([
    prisma.scrim.findUnique({
      where: { id },
      include: {
        season: {
          select: {
            id: true,
            name: true,
            isActive: true,
            status: true,
            dotaLeagueId: true,
          },
        },
        hostTeam: { include: { staff: true, captain: captainSelect } },
        opponentTeam: { include: { staff: true, captain: captainSelect } },
        winnerTeam: true,
        participants: {
          orderBy: [{ teamId: "asc" }, { guest: "asc" }, { createdAt: "asc" }],
          include: { user: true, team: true },
        },
        games: { orderBy: [{ startTime: "asc" }, { fetchedAt: "asc" }] },
      },
    }),
    getSessionUser(),
  ]);
  if (!scrim) notFound();
  const sideTeamIds = [scrim.hostTeamId, scrim.opponentTeamId].filter(
    (teamId): teamId is string => teamId != null,
  );
  // A rostered player on either side: they play it, so they get the
  // lobby's password and their own next step. Read beside the registration.
  const membershipRead = viewer
    ? prisma.teamMember.findFirst({
        where: { userId: viewer.id, teamId: { in: sideTeamIds } },
        select: { teamId: true },
      })
    : Promise.resolve(null);
  const viewerRegistration =
    viewer && scrim.season.isActive
      ? await prisma.registration.findUnique({
          where: {
            seasonId_userId: { seasonId: scrim.seasonId, userId: viewer.id },
          },
          select: { status: true },
        })
      : null;
  const viewerMembership = await membershipRead;

  const seasonOpen =
    scrim.season.isActive && scrim.season.status !== SEASON_STATUS.COMPLETE;
  // One server snapshot for the join verdict and the "Not played" label.
  // eslint-disable-next-line react-hooks/purity -- async server component
  const nowMs = Date.now();
  const joinCheck =
    scrim.status === SCRIM_STATUS.OPEN
      ? await openScrimJoinCheck(scrim, viewer?.id ?? null, seasonOpen, nowMs)
      : null;
  const notPlayed = isScrimNotPlayed(
    scrim.status,
    scrim.scheduledAt.getTime(),
    nowMs,
  );
  const kickoffPassed = scrim.scheduledAt.getTime() <= nowMs;
  const hasTicket = !!scrim.season.dotaLeagueId;

  const coaches = (team: typeof scrim.hostTeam | null) =>
    !!viewer && !!team && team.staff.some((staff) => staff.userId === viewer.id);
  const isAdmin = viewer?.role === "ADMIN";
  // Which controls this viewer gets: the rule the Captains page reads too.
  const manage = scrimManageView({
    status: scrim.status,
    hasOpponent: !!scrim.opponentTeam,
    seasonOpen,
    notPlayed,
    hasTicket,
    kickoffPassed,
    viewer: viewer
      ? {
          isAdmin,
          captainsHost: scrim.hostTeam.captainId === viewer.id,
          captainsAway: scrim.opponentTeam?.captainId === viewer.id,
          coachesHost: coaches(scrim.hostTeam),
          coachesAway: coaches(scrim.opponentTeam),
          rostered: !!viewerMembership,
        }
      : null,
  });
  const { role, managesHost, managesAway, booked, mutable } = manage;
  const { showCancel, canEndSeries, showResultTools, foldTools } = manage;
  // Captains and coaches of either side always get the other captain's
  // handle: arranging the lobby is the whole point of this page for them.
  const contactFor = (userId: string) =>
    canViewLeagueContact(
      viewer,
      userId,
      viewerRegistration?.status === REGISTRATION_STATUS.ACTIVE ||
        managesHost ||
        managesAway,
    );
  const participantByAccount = new Map(
    scrim.participants.map((participant) => [
      participant.dotaAccountId,
      participant,
    ]),
  );
  const gamesRecorded = scrim.games.length;
  const nextStep = scrimNextStep({
    role,
    status: scrim.status,
    notPlayed,
    hasTicket,
    hostCaptainName: scrim.hostTeam.captain.name,
    gamesRecorded,
  });
  // Both teams, their coaches and admins get the lobby's password.
  const password =
    manage.seesPassword
      ? ((value: string | null) =>
          value ? { value } : ("host-chooses" as const))(
          scrimLobbyPassword(scrim.id),
        )
      : ("members-only" as const);
  const resultsSubtitle =
    scrim.status === SCRIM_STATUS.COMPLETED
      ? "Practice only: these games count for scrim history and the scrim leaders board, never league standings."
      : notPlayed
        ? "No games were recorded within 36 hours of the start, so this booking is listed as not played."
        : scrimRecordingLine({
            hasTicket,
            status: scrim.status,
            gamesRecorded,
            kickoffPassed,
          });

  return (
    <div className="space-y-6">
      <PageTitle
        title={
          scrim.opponentTeam
            ? `${scrim.hostTeam.name} vs ${scrim.opponentTeam.name}`
            : `${scrim.hostTeam.name} scrim time`
        }
        subtitle={`${scrim.season.name} scrim · Best of ${scrim.bestOf} · practice only, outside league standings`}
        action={
          <Link
            href={`/scrims?season=${encodeURIComponent(scrim.season.id)}`}
            className={textLink("text-sm")}
          >
            ← All scrims
          </Link>
        }
      />

      <Card tone="feature" className="overflow-hidden">
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-start">
          <ScrimSide
            team={scrim.hostTeam}
            label={scrim.opponentTeam ? "Posted the time · hosts" : "Posted the time"}
            captain={scrim.hostTeam.captain}
            showContact={contactFor(scrim.hostTeam.captainId)}
          />
          <div className="order-first flex flex-wrap items-center gap-x-3 gap-y-1 sm:order-none sm:flex-col sm:items-center sm:text-center">
            {statusBadge(scrim.status, notPlayed)}
            <p className="text-sm text-muted">
              <LocalTime
                ts={scrim.scheduledAt.getTime()}
                variant="full"
                initial={formatLeagueMatchTime(scrim.scheduledAt, "full")}
              />
            </p>
            {scrim.status === SCRIM_STATUS.LIVE ||
            scrim.status === SCRIM_STATUS.COMPLETED ? (
              <p
                className="font-display text-3xl font-bold tabular-nums"
                aria-label={`Score ${scrim.hostScore} to ${scrim.awayScore}`}
              >
                {scrim.hostScore}–{scrim.awayScore}
              </p>
            ) : null}
          </div>
          {scrim.opponentTeam ? (
            <ScrimSide
              team={scrim.opponentTeam}
              label="Claimed the time"
              captain={scrim.opponentTeam.captain}
              showContact={contactFor(scrim.opponentTeam.captainId)}
              mirrored
            />
          ) : (
            <div className="min-w-0 space-y-2 text-sm sm:text-right">
              <p className="font-medium text-fg">Waiting for an opponent</p>
              {joinCheck?.canJoin ? (
                <ActionForm
                  action={joinScrim}
                  hidden={{ scrimId: scrim.id }}
                  className="space-y-1"
                >
                  <SubmitButton size="sm">Join scrim</SubmitButton>
                  <p className="text-xs text-muted">
                    Books this time for {joinCheck.teamName}.
                  </p>
                </ActionForm>
              ) : joinCheck ? (
                <p className="text-muted">
                  {joinCheck.signIn ? (
                    <>
                      <Link
                        href={`/login?next=${encodeURIComponent(`/scrims/${scrim.id}`)}`}
                        className={textLink()}
                      >
                        Sign in
                      </Link>{" "}
                      as a team captain to claim this time.
                    </>
                  ) : (
                    joinCheck.reason
                  )}
                </p>
              ) : null}
            </div>
          )}
        </div>
        {nextStep ? (
          <p
            data-testid="scrim-next-step"
            className="border-t border-line bg-accent/10 px-4 py-3 text-sm text-fg [overflow-wrap:anywhere]"
          >
            <b className="font-semibold">Your next step:</b> {nextStep}
          </p>
        ) : null}
        {notPlayed ? (
          <p className="border-t border-line-soft px-4 py-3 text-sm text-muted">
            No games were recorded within 36 hours of the start, so this
            booking is listed as not played.
            {showResultTools ? (
              <>
                {" "}If you did play it,{" "}
                <Link href="#results" className={textLink()}>
                  add the game by its match ID
                </Link>
                .
              </>
            ) : null}
          </p>
        ) : null}
        {booked && !viewer ? (
          <p className="border-t border-line-soft px-4 py-3 text-xs text-muted">
            <Link
              href={`/login?next=${encodeURIComponent(`/scrims/${scrim.id}`)}`}
              className={textLink()}
            >
              Sign in
            </Link>
            {/* Name who the handles are for: contactFor opens them only to
                this season's signed-up players (active seasons only) and
                both teams' captains and coaches. */}
            {scrim.season.isActive
              ? " to see the captains' Discord handles if you're signed up this season or captain or coach one of these teams."
              : " to see the captains' Discord handles if you captain or coach one of these teams."}
          </p>
        ) : null}
        {canEndSeries || showCancel ? (
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-line-soft px-4 py-3">
            {canEndSeries && scrim.opponentTeam ? (
              <>
                <p className="mr-auto text-xs text-muted">
                  Can&apos;t play the rest? Either captain can end the series
                  at the current score.
                </p>
                <ScrimEndSeriesForm
                  scrimId={scrim.id}
                  hostTeamName={scrim.hostTeam.name}
                  awayTeamName={scrim.opponentTeam.name}
                  hostScore={scrim.hostScore}
                  awayScore={scrim.awayScore}
                />
              </>
            ) : null}
            {showCancel ? (
              <ScrimCancelButton
                scrimId={scrim.id}
                booked={!!scrim.opponentTeam}
                label="Cancel scrim"
              />
            ) : null}
          </div>
        ) : null}
      </Card>

      {booked && scrim.opponentTeam ? (
        <ScrimLobbyCard
          scrimId={scrim.id}
          hostTeamName={scrim.hostTeam.name}
          hostCaptainName={scrim.hostTeam.captain.name}
          awayCaptainName={scrim.opponentTeam.captain.name}
          bestOf={scrim.bestOf}
          leagueId={scrim.season.dotaLeagueId}
          password={password}
        />
      ) : scrim.status === SCRIM_STATUS.OPEN && seasonOpen ? (
        <Card tone="quiet">
          <CardBody className="text-sm text-muted">
            <b className="font-medium text-fg">Once it&apos;s claimed:</b>{" "}
            {scrim.hostTeam.name} hosts, and this page shows both teams the
            lobby&apos;s name, password and settings.{" "}
            {hasTicket
              ? "With this season's league ticket set in the lobby, every game records here by itself."
              : "This season has no league ticket yet, so its scrim games can't record themselves."}
          </CardBody>
        </Card>
      ) : null}

      {scrim.opponentTeam && scrim.status !== SCRIM_STATUS.CANCELLED ? (
        <Card id="results" className="scroll-mt-24">
          <CardHeader
            title="Results"
            subtitle={resultsSubtitle}
            headingLevel={2}
          />
          <CardBody className="space-y-6">
            {gamesRecorded === 0 ? (
              <EmptyState inline title="No games recorded yet" />
            ) : (
              scrim.games.map((game, gameIndex) => {
                const lines = parseGamePlayers(game.players);
                const radiantName =
                  game.radiantTeamId === scrim.hostTeamId
                    ? scrim.hostTeam.name
                    : scrim.opponentTeam?.name ?? "Radiant";
                const direName =
                  game.direTeamId === scrim.hostTeamId
                    ? scrim.hostTeam.name
                    : scrim.opponentTeam?.name ?? "Dire";
                const duration = `${Math.floor(game.durationSecs / 60)}:${String(
                  game.durationSecs % 60,
                ).padStart(2, "0")}`;
                return (
                  <section
                    key={game.id}
                    className="overflow-hidden rounded-lg border border-line"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface-2/40 px-4 py-3">
                      <div className="min-w-0">
                        <h3 className="font-display font-semibold [overflow-wrap:anywhere]">
                          Game {gameIndex + 1} · {radiantName} {game.radiantScore}–{game.direScore}{" "}
                          {direName}
                        </h3>
                        <p className="text-xs text-muted">{duration}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <a
                          href={`https://www.opendota.com/matches/${game.dotaMatchId}`}
                          target="_blank"
                          rel="noreferrer"
                          className={textLink("text-sm")}
                        >
                          OpenDota ↗
                        </a>
                        {isAdmin ? (
                          <ActionForm
                            action={removeScrimGame}
                            hidden={{
                              scrimId: scrim.id,
                              scrimGameId: game.id,
                            }}
                          >
                            <SubmitButton
                              size="sm"
                              variant="ghost"
                              confirm="Remove this scrim game and recalculate the practice score?"
                            >
                              Remove game
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[620px] text-sm">
                        <caption className="sr-only">
                          Scrim game {gameIndex + 1} player box score
                        </caption>
                        <thead>
                          <tr className="border-b border-line/70 text-left text-xs uppercase text-muted">
                            <th className="px-4 py-2 font-medium">Side</th>
                            <th className="px-2 py-2 font-medium">Player</th>
                            <th className="px-2 py-2 font-medium">Hero</th>
                            <th className="px-2 py-2 font-medium">K/D/A</th>
                            <th className="px-2 py-2 text-right font-medium">GPM</th>
                            <th className="px-4 py-2 text-right font-medium">Net worth</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lines.map((line, index) => {
                            const participant =
                              line.accountId == null
                                ? null
                                : participantByAccount.get(line.accountId);
                            const name =
                              participant?.displayName ??
                              line.personaname ??
                              "Unknown stand-in";
                            const hero = heroById(line.heroId);
                            return (
                              <tr
                                key={`${line.accountId ?? "unknown"}-${line.heroId}-${index}`}
                                className="border-b border-line/40 last:border-0"
                              >
                                <td className="px-4 py-2 text-xs text-muted">
                                  {line.isRadiant ? radiantName : direName}
                                </td>
                                <td className="max-w-48 truncate px-2 py-2">
                                  {participant?.userId ? (
                                    <PlayerLink userId={participant.userId}>
                                      {name}
                                    </PlayerLink>
                                  ) : (
                                    name
                                  )}
                                </td>
                                <td className="px-2 py-2">
                                  <span className="flex items-center gap-2">
                                    {hero ? <HeroIcon hero={hero} size={24} /> : null}
                                    <span className="truncate text-xs text-muted">
                                      {hero?.name ?? `Hero ${line.heroId}`}
                                    </span>
                                  </span>
                                </td>
                                <td className="px-2 py-2">
                                  <KDA
                                    kills={line.kills}
                                    deaths={line.deaths}
                                    assists={line.assists}
                                  />
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums">
                                  {line.gpm ?? "—"}
                                </td>
                                <td className="px-4 py-2 text-right tabular-nums">
                                  {line.netWorth?.toLocaleString("en-US") ?? "—"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                );
              })
            )}
            {showResultTools ? (
              foldTools ? (
                <details className="rounded-lg border border-line-soft px-4">
                  <summary className="cursor-pointer py-3 text-sm font-medium text-fg">
                    Game missing?
                  </summary>
                  <ScrimResultTools scrimId={scrim.id} />
                </details>
              ) : (
                <ScrimResultTools scrimId={scrim.id} />
              )
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <Card id="lineups">
        <CardHeader
          title="Scrim lineups"
          subtitle="Games are matched to these Dota accounts: at least 3 a side must play. Rosters are copied in when the scrim is booked; captains and coaches can add a guest who plays for their side, without touching the league roster."
          headingLevel={2}
        />
        <CardBody>
          <ScrimLineups
            scrimId={scrim.id}
            mutable={mutable}
            sides={[scrim.hostTeam, scrim.opponentTeam].flatMap((team) =>
              team
                ? [
                    {
                      team,
                      manages:
                        team.id === scrim.hostTeamId ? managesHost : managesAway,
                      participants: scrim.participants.filter(
                        (participant) => participant.teamId === team.id,
                      ),
                    },
                  ]
                : [],
            )}
          />
        </CardBody>
      </Card>
    </div>
  );
}
