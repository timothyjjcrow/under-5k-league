import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import {
  MATCH_STATUS,
  REGISTRATION_STATUS,
  SCRIM_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import { formatMatchTime } from "@/lib/match-time";
import { heroById } from "@/lib/heroes";
import { parseGamePlayers } from "@/lib/player-stats";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import {
  isScrimNotPlayed,
  scrimEndConfirm,
  scrimHostLine,
  scrimJoinCheck,
} from "@/lib/scrim-view";
import {
  describeScrimConflict,
  findConfirmedScrimConflict,
  scrimCollisionRange,
} from "@/lib/scrim-schedule-conflict";
import { canViewLeagueContact } from "@/lib/visibility";
import { LocalTime } from "@/components/local-time";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { DiscordTag } from "@/components/discord-tag";
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
  TeamCrest,
  textLink,
} from "@/components/ui";

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
 * One side of the matchup: team, its captain, and — for league members only
 * (the DiscordTag rule) — the captain's copyable Discord handle, so the two
 * captains can find each other without a trip through the team pages.
 */
function ScrimSide({
  team,
  label,
  captain,
  showContact,
}: {
  team: { id: string; name: string; logoUrl: string | null };
  label: string;
  captain: ScrimCaptain;
  showContact: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <TeamCrest
        seed={team.id}
        name={team.name}
        logoUrl={team.logoUrl}
        size={48}
      />
      <div className="min-w-0">
        <p className="truncate font-display text-lg font-semibold">
          {team.name}
        </p>
        <p className="text-xs text-muted">{label}</p>
        <p className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 text-sm">
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
    return <Badge tone="brand">Completed</Badge>;
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
          select: { id: true, name: true, isActive: true, status: true },
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
  const viewerRegistration =
    viewer && scrim.season.isActive
      ? await prisma.registration.findUnique({
          where: {
            seasonId_userId: { seasonId: scrim.seasonId, userId: viewer.id },
          },
          select: { status: true },
        })
      : null;

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

  const teamManager = (team: typeof scrim.hostTeam | null) =>
    !!viewer &&
    !!team &&
    (team.captainId === viewer.id ||
      team.staff.some((staff) => staff.userId === viewer.id));
  const managesHost = teamManager(scrim.hostTeam);
  const managesAway = teamManager(scrim.opponentTeam);
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
  const canManageResults =
    viewer?.role === "ADMIN" || managesHost || managesAway;
  const canCancel =
    !!viewer &&
    (viewer.role === "ADMIN" ||
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
    scrim.status === SCRIM_STATUS.LIVE ||
    (scrim.season.isActive &&
      scrim.season.status !== SEASON_STATUS.COMPLETE &&
      activeStatus);
  const canRecordResults =
    scrim.status === SCRIM_STATUS.LIVE ||
    (scrim.status === SCRIM_STATUS.SCHEDULED &&
      (viewer?.role === "ADMIN" ||
        (scrim.season.isActive &&
          scrim.season.status !== SEASON_STATUS.COMPLETE)));

  const showResultTools =
    !!scrim.opponentTeam && canManageResults && canRecordResults;

  return (
    <div className="space-y-6">
      <PageTitle
        title={
          scrim.opponentTeam
            ? `${scrim.hostTeam.name} vs ${scrim.opponentTeam.name}`
            : `${scrim.hostTeam.name} availability`
        }
        subtitle={`${scrim.season.name} scrim · Best of ${scrim.bestOf}`}
        action={
          <Link
            href={`/scrims?season=${encodeURIComponent(scrim.season.id)}`}
            className={textLink("text-sm")}
          >
            ← All scrims
          </Link>
        }
      />

      <Card tone="feature">
        <CardBody className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="grid min-w-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2">
              <ScrimSide
                team={scrim.hostTeam}
                label="Posting team"
                captain={scrim.hostTeam.captain}
                showContact={contactFor(scrim.hostTeam.captainId)}
              />
              {scrim.opponentTeam ? (
                <ScrimSide
                  team={scrim.opponentTeam}
                  label="Claimed the time"
                  captain={scrim.opponentTeam.captain}
                  showContact={contactFor(scrim.opponentTeam.captainId)}
                />
              ) : (
                <div className="min-w-0 space-y-2 self-center text-sm">
                  <p className="text-muted">Waiting for an opponent</p>
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
                    <p>
                      {joinCheck.signIn ? (
                        <>
                          <Link
                            href={`/login?returnTo=${encodeURIComponent(`/scrims/${scrim.id}`)}`}
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
            <div className="space-y-1 text-left sm:text-right">
              <div>{statusBadge(scrim.status, notPlayed)}</div>
              <p className="text-sm text-muted">
                <LocalTime
                  ts={scrim.scheduledAt.getTime()}
                  variant="full"
                  initial={formatMatchTime(scrim.scheduledAt, "full")}
                />
              </p>
              {scrim.status === SCRIM_STATUS.LIVE ||
              scrim.status === SCRIM_STATUS.COMPLETED ? (
                <p className="font-display text-2xl font-bold tabular-nums">
                  {scrim.hostScore}–{scrim.awayScore}
                </p>
              ) : null}
            </div>
          </div>
          {notPlayed ? (
            <p className="border-t border-line-soft pt-3 text-sm text-muted">
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
          {booked && scrim.opponentTeam ? (
            <div className="space-y-1 border-t border-line-soft pt-3 text-sm">
              <p>
                {scrimHostLine({
                  hostTeamName: scrim.hostTeam.name,
                  hostCaptainName: scrim.hostTeam.captain.name,
                  opponentCaptainName: scrim.opponentTeam.captain.name,
                  bestOf: scrim.bestOf,
                  region: LEAGUE_CONFIG.gameServerRegion,
                })}
              </p>
              {!viewer ? (
                <p className="text-xs text-muted">
                  <Link
                    href={`/login?returnTo=${encodeURIComponent(`/scrims/${scrim.id}`)}`}
                    className={textLink()}
                  >
                    Sign in
                  </Link>{" "}
                  to see the captains&apos; Discord handles.
                </p>
              ) : null}
            </div>
          ) : null}
        </CardBody>
      </Card>

      {canEndSeries && scrim.opponentTeam ? (
        <div className="flex flex-col items-start gap-1 sm:items-end">
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
          <p className="text-xs text-muted">
            Can&apos;t play the rest? Either captain can end the series at the
            current score.
          </p>
        </div>
      ) : null}

      {canCancel &&
      mutable &&
      scrim.status !== SCRIM_STATUS.LIVE ? (
        <div className="flex justify-end">
          <ActionForm action={cancelScrim} hidden={{ scrimId: scrim.id }}>
            <SubmitButton
              variant="ghost"
              size="sm"
              confirm="Cancel this scrim? The saved lineup will remain in the cancelled record, but no result can be added."
            >
              Cancel scrim
            </SubmitButton>
          </ActionForm>
        </div>
      ) : null}

      <Card id="lineups">
        <CardHeader
          title="Scrim lineups"
          subtitle="League roster IDs are snapshotted automatically. Captains and coaches can add casual guests to this scrim without registering or changing the league roster."
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
                  <h2 className="font-display font-semibold">{team.name}</h2>
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

      {showResultTools ? (
        <Card id="results">
          <CardHeader
            title="Find scrim games"
            subtitle="Auto-fetch scans these saved player IDs and accepts a game with at least three recognized players on each side. Unknown stand-ins are fine. The league ticket is optional and safe to reuse."
            headingLevel={2}
          />
          <CardBody className="grid gap-4 md:grid-cols-2">
            <ActionForm
              action={autoDetectScrimGames}
              hidden={{ scrimId: scrim.id }}
              className="space-y-2 rounded-lg border border-line bg-surface-2/30 p-4"
            >
              <p className="text-sm font-medium">Scan player histories</p>
              <p className="text-xs text-muted">
                Best when several known players expose public match data.
              </p>
              <SubmitButton variant="secondary" size="sm">
                Auto-fetch games
              </SubmitButton>
            </ActionForm>
            <ActionForm
              action={importScrimGame}
              hidden={{ scrimId: scrim.id }}
              className="space-y-2 rounded-lg border border-line bg-surface-2/30 p-4"
            >
              <label className="block space-y-1 text-sm font-medium">
                Dota match ID or URL
                <input
                  name="dotaMatchRef"
                  required
                  placeholder="Match ID or OpenDota URL"
                  className={`${inputClass} w-full font-normal`}
                />
              </label>
              <p className="text-xs text-muted">
                Use this fallback when recent histories are private or delayed.
              </p>
              <SubmitButton variant="secondary" size="sm">
                Add game
              </SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}

      <Card id="box-scores">
        <CardHeader
          title="Scrim box scores"
          subtitle="These games feed only this scrim history and the separate Scrim leaders board."
          headingLevel={2}
        />
        <CardBody className="space-y-6">
          {scrim.games.length === 0 ? (
            <EmptyState
              compact
              title="No games recorded"
              description={
                scrim.status === SCRIM_STATUS.OPEN
                  ? "An opponent must claim the time before results can be fetched."
                  : "A captain or coach can auto-fetch after the game finishes."
              }
            />
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
                    <div>
                      <h2 className="font-display font-semibold">
                        Game {gameIndex + 1} · {radiantName} {game.radiantScore}–{game.direScore}{" "}
                        {direName}
                      </h2>
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
                      {viewer?.role === "ADMIN" ? (
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
                                {line.netWorth?.toLocaleString() ?? "—"}
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
        </CardBody>
      </Card>
    </div>
  );
}
