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
  scrimEndConfirm,
  scrimJoinCheck,
} from "@/lib/scrim-view";
import {
  scrimNextStep,
  scrimRecordingLine,
  type ScrimViewerRole,
} from "@/lib/scrim-lobby";
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
import { ScrimLobbyCard } from "@/components/scrims/scrim-lobby-card";
import {
  addScrimGuest,
  autoDetectScrimGames,
  cancelScrim,
  endScrimSeries,
  importScrimGame,
  joinScrim,
  removeScrimGuest,
  removeScrimGame,
} from "@/app/actions/scrims";
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

const inputClass =
  "h-10 min-w-0 rounded-lg border border-line bg-surface-2/50 px-3 text-sm text-fg outline-none focus:border-accent/60";

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
  const teamManager = (team: typeof scrim.hostTeam | null) =>
    !!viewer && !!team && (team.captainId === viewer.id || coaches(team));
  const managesHost = teamManager(scrim.hostTeam);
  const managesAway = teamManager(scrim.opponentTeam);
  const isAdmin = viewer?.role === "ADMIN";
  const role: ScrimViewerRole = !viewer
    ? "other"
    : scrim.hostTeam.captainId === viewer.id
      ? "host-captain"
      : scrim.opponentTeam?.captainId === viewer.id
        ? "away-captain"
        : viewerMembership ||
            coaches(scrim.hostTeam) ||
            coaches(scrim.opponentTeam)
          ? "member"
          : "other";
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
  const booked =
    !!scrim.opponentTeam &&
    !notPlayed &&
    (scrim.status === SCRIM_STATUS.SCHEDULED ||
      scrim.status === SCRIM_STATUS.LIVE);
  const canManageResults = isAdmin || managesHost || managesAway;
  const canCancel =
    !!viewer &&
    (isAdmin ||
      scrim.hostTeam.captainId === viewer.id ||
      scrim.opponentTeam?.captainId === viewer.id);
  // Same people as Cancel: a series that can't be finished is called at its
  // current score rather than left LIVE forever (a live scrim can't cancel).
  const canEndSeries =
    canCancel && scrim.status === SCRIM_STATUS.LIVE && !!scrim.opponentTeam;
  const participantByAccount = new Map(
    scrim.participants.map((participant) => [
      participant.dotaAccountId,
      participant,
    ]),
  );
  const activeStatus =
    scrim.status === SCRIM_STATUS.OPEN ||
    scrim.status === SCRIM_STATUS.SCHEDULED ||
    scrim.status === SCRIM_STATUS.LIVE;
  const mutable =
    scrim.status === SCRIM_STATUS.LIVE || (seasonOpen && activeStatus);
  const showCancel = canCancel && mutable && scrim.status !== SCRIM_STATUS.LIVE;
  const canRecordResults =
    scrim.status === SCRIM_STATUS.LIVE ||
    (scrim.status === SCRIM_STATUS.SCHEDULED && (isAdmin || seasonOpen));
  const showResultTools =
    !!scrim.opponentTeam && canManageResults && canRecordResults;
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
    role !== "other" || isAdmin
      ? ((value: string | null) =>
          value ? { value } : ("host-chooses" as const))(
          scrimLobbyPassword(scrim.id),
        )
      : ("members-only" as const);
  // Tools first when a game should be in by now and isn't, or when nothing
  // records by itself; otherwise one tap away under "Game missing?".
  const foldTools =
    hasTicket &&
    !notPlayed &&
    (!kickoffPassed || scrim.status === SCRIM_STATUS.LIVE);
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
                <ActionForm action={endScrimSeries} hidden={{ scrimId: scrim.id }}>
                  <SubmitButton
                    variant="secondary"
                    size="sm"
                    confirm={scrimEndConfirm({
                      hostTeamName: scrim.hostTeam.name,
                      awayTeamName: scrim.opponentTeam.name,
                      hostScore: scrim.hostScore,
                      awayScore: scrim.awayScore,
                    })}
                  >
                    End series at {scrim.hostScore}–{scrim.awayScore}
                  </SubmitButton>
                </ActionForm>
              </>
            ) : null}
            {showCancel ? (
              <ActionForm action={cancelScrim} hidden={{ scrimId: scrim.id }}>
                <SubmitButton
                  variant="ghost"
                  size="sm"
                  confirm={
                    scrim.opponentTeam
                      ? "Cancel this scrim? The other captain is told, and no result can be added."
                      : "Cancel this open scrim time?"
                  }
                >
                  Cancel scrim
                </SubmitButton>
              </ActionForm>
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
                  <ResultTools scrimId={scrim.id} />
                </details>
              ) : (
                <ResultTools scrimId={scrim.id} />
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
        <CardBody className="grid gap-5 md:grid-cols-2">
          {[scrim.hostTeam, scrim.opponentTeam].map((team) => {
            if (!team) return null;
            const manages =
              team.id === scrim.hostTeamId ? managesHost : managesAway;
            const participants = scrim.participants.filter(
              (participant) => participant.teamId === team.id,
            );
            return (
              <section key={team.id} className="min-w-0 space-y-3">
                <div className="flex items-center gap-2">
                  <TeamCrest
                    seed={team.id}
                    name={team.name}
                    logoUrl={team.logoUrl}
                    size={30}
                  />
                  <h3 className="min-w-0 truncate font-display font-semibold">
                    {team.name}
                  </h3>
                  <Badge>
                    {participants.length}{" "}
                    {participants.length === 1 ? "player" : "players"}
                  </Badge>
                </div>
                <ul className="divide-y divide-line/60 rounded-lg border border-line/70">
                  {participants.map((participant) => (
                    <li
                      key={participant.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        {participant.userId ? (
                          <PlayerLink
                            userId={participant.userId}
                            className="max-w-full truncate"
                          >
                            {participant.displayName}
                          </PlayerLink>
                        ) : (
                          <span className="block truncate font-medium">
                            {participant.displayName}
                          </span>
                        )}
                        {/* A guest has no profile, so the account they were
                            added with is the only way to tell who they are. */}
                        {participant.guest ? (
                          <p className="font-mono text-[11px] text-muted">
                            Dota {participant.dotaAccountId}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {participant.userId === team.captainId ? (
                          <Badge tone="accent">Captain</Badge>
                        ) : null}
                        {participant.guest ? <Badge tone="info">Guest</Badge> : null}
                        {participant.guest && manages && mutable ? (
                          <ActionForm
                            action={removeScrimGuest}
                            hidden={{
                              scrimId: scrim.id,
                              participantId: participant.id,
                            }}
                          >
                            <SubmitButton
                              size="sm"
                              variant="ghost"
                              confirm={`Remove ${participant.displayName} from this scrim lineup?`}
                            >
                              Remove
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
                {manages && mutable ? (
                  <ActionForm
                    action={addScrimGuest}
                    hidden={{ scrimId: scrim.id }}
                    className="grid gap-2 rounded-lg border border-dashed border-line p-3 sm:grid-cols-2"
                  >
                    <label className="space-y-1 text-xs text-muted">
                      Guest name
                      <input
                        name="displayName"
                        required
                        maxLength={60}
                        placeholder="Display name"
                        className={`${inputClass} w-full`}
                      />
                    </label>
                    <label className="space-y-1 text-xs text-muted">
                      Dota or Steam ID
                      <input
                        name="accountRef"
                        required
                        placeholder="ID or profile URL"
                        className={`${inputClass} w-full`}
                      />
                    </label>
                    <SubmitButton size="sm" className="sm:col-span-2">
                      Add casual guest
                    </SubmitButton>
                  </ActionForm>
                ) : null}
              </section>
            );
          })}
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * The fallback when a game didn't record by itself: by its match ID (a game
 * hosted under another league's ticket is on OpenDota too), or a search of
 * the players' recent public matches. Captains, coaches and admins only.
 */
function ResultTools({ scrimId }: { scrimId: string }) {
  return (
    <div className="grid gap-4 pb-4 md:grid-cols-2">
      <ActionForm
        action={importScrimGame}
        hidden={{ scrimId }}
        className="space-y-2 rounded-lg border border-line bg-surface-2/30 p-4"
      >
        <label className="block space-y-1 text-sm font-medium">
          Add a game by its Dota match ID
          <input
            name="dotaMatchRef"
            required
            placeholder="Match ID or OpenDota URL"
            className={`${inputClass} w-full font-normal`}
          />
        </label>
        <p className="text-xs text-muted">
          For a game OpenDota has that didn&apos;t record by itself, such as
          one hosted under another league&apos;s ticket. A lobby with no
          ticket at all never reaches OpenDota.
        </p>
        <SubmitButton variant="secondary" size="sm">
          Add game
        </SubmitButton>
      </ActionForm>
      <ActionForm
        action={autoDetectScrimGames}
        hidden={{ scrimId }}
        className="space-y-2 rounded-lg border border-line bg-surface-2/30 p-4"
      >
        <p className="text-sm font-medium">Search the players&apos; matches</p>
        <p className="text-xs text-muted">
          Looks through both lineups&apos; recent public matches for a game
          with at least 3 of each side in it.
        </p>
        <SubmitButton variant="secondary" size="sm">
          Search for games
        </SubmitButton>
      </ActionForm>
    </div>
  );
}
