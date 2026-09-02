import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { SCRIM_STATUS, SEASON_STATUS } from "@/lib/constants";
import { formatMatchTime } from "@/lib/match-time";
import { heroById } from "@/lib/heroes";
import { parseGamePlayers } from "@/lib/player-stats";
import { LocalTime } from "@/components/local-time";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  addScrimGuest,
  autoDetectScrimGames,
  cancelScrim,
  importScrimGame,
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

function statusBadge(status: string) {
  if (status === SCRIM_STATUS.OPEN) return <Badge tone="info">Open</Badge>;
  if (status === SCRIM_STATUS.SCHEDULED)
    return <Badge tone="success">Booked</Badge>;
  if (status === SCRIM_STATUS.LIVE) return <Badge tone="accent">Live</Badge>;
  if (status === SCRIM_STATUS.COMPLETED)
    return <Badge tone="brand">Completed</Badge>;
  return <Badge>Cancelled</Badge>;
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
        hostTeam: { include: { staff: true } },
        opponentTeam: { include: { staff: true } },
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

  const teamManager = (team: typeof scrim.hostTeam | null) =>
    !!viewer &&
    !!team &&
    (team.captainId === viewer.id ||
      team.staff.some((staff) => staff.userId === viewer.id));
  const managesHost = teamManager(scrim.hostTeam);
  const managesAway = teamManager(scrim.opponentTeam);
  const canManageResults =
    viewer?.role === "ADMIN" || managesHost || managesAway;
  const canCancel =
    !!viewer &&
    (viewer.role === "ADMIN" ||
      scrim.hostTeam.captainId === viewer.id ||
      scrim.opponentTeam?.captainId === viewer.id);
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
        <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <TeamCrest
              seed={scrim.hostTeam.id}
              name={scrim.hostTeam.name}
              logoUrl={scrim.hostTeam.logoUrl}
              size={48}
            />
            <div className="min-w-0">
              <p className="truncate font-display text-lg font-semibold">
                {scrim.hostTeam.name}
              </p>
              <p className="text-xs text-muted">Posting team</p>
            </div>
            <span className="text-sm font-medium uppercase text-muted">vs</span>
            {scrim.opponentTeam ? (
              <>
                <TeamCrest
                  seed={scrim.opponentTeam.id}
                  name={scrim.opponentTeam.name}
                  logoUrl={scrim.opponentTeam.logoUrl}
                  size={48}
                />
                <p className="min-w-0 truncate font-display text-lg font-semibold">
                  {scrim.opponentTeam.name}
                </p>
              </>
            ) : (
              <span className="text-muted">Waiting for an opponent</span>
            )}
          </div>
          <div className="space-y-1 text-left sm:text-right">
            <div>{statusBadge(scrim.status)}</div>
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
        </CardBody>
      </Card>

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
                  <Badge>{participants.length} known IDs</Badge>
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
                        <p className="font-mono text-[11px] text-muted">
                          Dota {participant.dotaAccountId}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
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

      {scrim.opponentTeam && canManageResults && canRecordResults ? (
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
