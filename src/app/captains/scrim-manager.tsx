import Link from "@/components/app-link";
import { DiscordTag } from "@/components/discord-tag";
import { LocalTime } from "@/components/local-time";
import { ScrimLobbyCard } from "@/components/scrims/scrim-lobby-card";
import {
  ScrimEndSeriesForm,
  ScrimLineups,
  ScrimResultTools,
} from "@/components/scrims/scrim-manage";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LinkArrow,
  PlayerLink,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";
import type { SessionUser } from "@/lib/auth";
import { CAPTAINS_ANCHOR } from "@/lib/captains";
import { SCRIM_STATUS } from "@/lib/constants";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { prisma } from "@/lib/prisma";
import { scrimNextStep, scrimRecordingLine } from "@/lib/scrim-lobby";
import { scrimLobbyPassword } from "@/lib/scrim-lobby-password";
import { isScrimNotPlayed, scrimManageView } from "@/lib/scrim-view";
import { canViewLeagueContact } from "@/lib/visibility";

const sideSelect = {
  select: {
    id: true,
    name: true,
    logoUrl: true,
    captainId: true,
    captain: {
      select: { id: true, name: true, discordName: true, discordId: true },
    },
  },
} as const;

/**
 * One of the team's booked scrims with everything its captain does for it,
 * the scrim page's own controls (so the same rule, `scrimManageView`, and the
 * same server checks): what to do next, the lobby's name, password and
 * ticket, both lineups with the captain's casual guests, the games recorded
 * so far, the fallback for a game that didn't record, and ending or
 * cancelling the series. Box scores stay on the scrim's page.
 */
export async function ScrimManager({
  scrimId,
  teamId,
  viewer,
  seasonOpen,
  leagueId,
  nowMs,
}: {
  scrimId: string;
  /** The captain's own team: the scrim must be one of its bookings. */
  teamId: string;
  viewer: SessionUser;
  /** The active season isn't complete. */
  seasonOpen: boolean;
  /** The season's Valve league ticket (`Season.dotaLeagueId`), if any. */
  leagueId: string | null;
  nowMs: number;
}) {
  const scrim = await prisma.scrim.findUnique({
    where: { id: scrimId },
    select: {
      id: true,
      status: true,
      bestOf: true,
      scheduledAt: true,
      hostTeamId: true,
      hostScore: true,
      awayScore: true,
      hostTeam: sideSelect,
      opponentTeam: sideSelect,
      participants: {
        orderBy: [{ teamId: "asc" }, { guest: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          teamId: true,
          userId: true,
          displayName: true,
          dotaAccountId: true,
          guest: true,
        },
      },
      games: {
        orderBy: [{ startTime: "asc" }, { fetchedAt: "asc" }],
        select: {
          id: true,
          dotaMatchId: true,
          durationSecs: true,
          radiantScore: true,
          direScore: true,
          radiantTeamId: true,
          direTeamId: true,
        },
      },
    },
  });
  const away = scrim?.opponentTeam;
  if (!scrim || !away) return null;
  const host = scrim.hostTeam;
  if (host.id !== teamId && away.id !== teamId) return null;
  const hosting = host.id === teamId;
  const other = hosting ? away : host;
  const hasTicket = !!leagueId;
  const kickoffPassed = scrim.scheduledAt.getTime() <= nowMs;
  const view = scrimManageView({
    status: scrim.status,
    hasOpponent: true,
    seasonOpen,
    notPlayed: isScrimNotPlayed(scrim.status, scrim.scheduledAt.getTime(), nowMs),
    hasTicket,
    kickoffPassed,
    viewer: {
      isAdmin: viewer.role === "ADMIN",
      captainsHost: host.captainId === viewer.id,
      captainsAway: away.captainId === viewer.id,
      coachesHost: false,
      coachesAway: false,
      rostered: false,
    },
  });
  if (!view.booked) return null;
  const live = scrim.status === SCRIM_STATUS.LIVE;
  const gamesRecorded = scrim.games.length;
  const nextStep = scrimNextStep({
    role: view.role,
    status: scrim.status,
    notPlayed: false,
    hasTicket,
    hostCaptainName: host.captain.name,
    gamesRecorded,
  });
  const secret = view.seesPassword ? scrimLobbyPassword(scrim.id) : null;
  const nameOf = (id: string | null, fallback: string) =>
    id === host.id ? host.name : id === away.id ? away.name : fallback;

  return (
    <section
      id={CAPTAINS_ANCHOR.scrimDesk}
      data-testid="scrim-desk"
      aria-labelledby="scrim-desk-title"
      className="scroll-mt-24 space-y-4"
    >
      <Card tone="feature" className="overflow-hidden">
        <CardBody className="flex flex-wrap items-center gap-3">
          <TeamCrest
            name={other.name}
            seed={other.id}
            logoUrl={other.logoUrl}
            size={44}
          />
          <div className="min-w-0 flex-1 basis-56">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold uppercase tracking-wider text-muted">
              Scrim · Best of {scrim.bestOf}
              {live ? (
                <Badge tone="accent">
                  Live · {scrim.hostScore}–{scrim.awayScore}
                </Badge>
              ) : (
                <Badge tone="info">Booked</Badge>
              )}
            </p>
            <h2
              id="scrim-desk-title"
              className="font-semibold [overflow-wrap:anywhere]"
            >
              Your scrim vs {other.name}
            </h2>
            <p className="text-sm text-muted">
              <LocalTime
                ts={scrim.scheduledAt.getTime()}
                variant="full"
                initial={formatLeagueMatchTime(scrim.scheduledAt, "full")}
              />
              {hosting ? " · you host" : ` · ${host.name} hosts`}
            </p>
            <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              <span>Their captain:</span>
              <PlayerLink
                userId={other.captain.id}
                className="font-medium text-fg [overflow-wrap:anywhere]"
              >
                {other.captain.name}
              </PlayerLink>
              {/* Either side's captain gets the other's handle: arranging
                  the lobby is what the two of them are here to do. */}
              {canViewLeagueContact(viewer, other.captain.id, true) ? (
                other.captain.discordName ? (
                  <DiscordTag
                    name={other.captain.discordName}
                    verified={!!other.captain.discordId}
                  />
                ) : (
                  <span className="text-xs">(no Discord on file)</span>
                )
              ) : null}
            </p>
          </div>
          <Link
            href={`/scrims/${scrim.id}`}
            className={buttonClasses("secondary", "sm")}
          >
            Scrim page <LinkArrow />
          </Link>
        </CardBody>
        {nextStep ? (
          <p
            data-testid="scrim-next-step"
            className="border-t border-line bg-accent/10 px-4 py-3 text-sm text-fg [overflow-wrap:anywhere]"
          >
            <b className="font-semibold">Your next step:</b> {nextStep}
          </p>
        ) : null}
        {/* Cancel stays on the scrim's row in the list above; a live series
            can't be cancelled, only ended at its score. */}
        {view.canEndSeries ? (
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-line-soft px-4 py-3">
            <p className="mr-auto text-xs text-muted">
              Can&apos;t play the rest? Either captain can end the series at
              the current score.
            </p>
            <ScrimEndSeriesForm
              scrimId={scrim.id}
              hostTeamName={host.name}
              awayTeamName={away.name}
              hostScore={scrim.hostScore}
              awayScore={scrim.awayScore}
            />
          </div>
        ) : null}
      </Card>

      <ScrimLobbyCard
        scrimId={scrim.id}
        hostTeamName={host.name}
        hostCaptainName={host.captain.name}
        awayCaptainName={away.captain.name}
        bestOf={scrim.bestOf}
        leagueId={leagueId}
        password={
          !view.seesPassword
            ? "members-only"
            : secret
              ? { value: secret }
              : "host-chooses"
        }
      />

      <Card className="min-w-0">
          <CardHeader
            title="Scrim lineups"
            subtitle="Games are matched to these Dota accounts: at least 3 a side must play. Add a guest who plays for your side here, without touching the league roster."
          />
          <CardBody>
            <ScrimLineups
              scrimId={scrim.id}
              mutable={view.mutable}
              sides={[host, away].map((team) => ({
                team,
                manages: team.id === host.id ? view.managesHost : view.managesAway,
                participants: scrim.participants.filter(
                  (participant) => participant.teamId === team.id,
                ),
              }))}
            />
          </CardBody>
        </Card>
      <Card id="scrim-results" className="min-w-0 scroll-mt-24">
          <CardHeader
            title="Scrim results"
            subtitle={scrimRecordingLine({
              hasTicket,
              status: scrim.status,
              gamesRecorded,
              kickoffPassed,
            })}
          />
          <CardBody className="space-y-4">
            {gamesRecorded === 0 ? (
              <EmptyState inline title="No games recorded yet" />
            ) : (
              <ol aria-label="Games recorded" className="divide-y divide-line-soft text-sm">
                {scrim.games.map((game, i) => (
                  <li
                    key={game.id}
                    className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2"
                  >
                    <span className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">
                      <span className="font-medium">Game {i + 1}</span>
                      {" · "}
                      {nameOf(game.radiantTeamId, "Radiant")} {game.radiantScore}–
                      {game.direScore} {nameOf(game.direTeamId, "Dire")}
                      <span className="text-muted">
                        {" · "}
                        {Math.floor(game.durationSecs / 60)}:
                        {String(game.durationSecs % 60).padStart(2, "0")}
                      </span>
                    </span>
                    <Link
                      href={`/scrims/${scrim.id}#results`}
                      className={textLink("text-sm")}
                    >
                      Box score <LinkArrow />
                    </Link>
                  </li>
                ))}
              </ol>
            )}
            {view.showResultTools ? (
              view.foldTools ? (
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
    </section>
  );
}
