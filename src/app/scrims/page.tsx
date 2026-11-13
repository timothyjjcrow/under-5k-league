import { shareMetadata } from "@/lib/share-metadata";
import { Suspense } from "react";
import { listPage } from "@/lib/list-page";
import Link from "@/components/app-link";
import { notFound } from "next/navigation";
import { singleSearchParam } from "@/lib/search-params";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { singleActiveSeason } from "@/lib/season";
import { SCRIM_STATUS, SEASON_STATUS } from "@/lib/constants";
import { formatLeagueMatchTime } from "@/lib/match-time";
import {
  isScrimNotPlayed,
  scrimJoinCheck,
  scrimNotPlayedCutoff,
} from "@/lib/scrim-view";
import { parseGamePlayers } from "@/lib/player-stats";
import { LocalTime } from "@/components/local-time";
import {
  ScrimCancelButton,
  ScrimJoinButton,
  ScrimPostForm,
  TeamCoachesCard,
} from "@/components/scrims/scrim-controls";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  KDA,
  LinkArrow,
  PageTitle,
  PlayerLink,
  TeamCrest,
  textLink,
} from "@/components/ui";

export const metadata = shareMetadata(
  "Scrims",
  "Post team availability, book casual league scrims, and review scrim-only results and statistics.",
  "/scrims",
);

function ScrimTime({ date }: { date: Date }) {
  return (
    <LocalTime
      ts={date.getTime()}
      variant="full"
      initial={formatLeagueMatchTime(date, "full")}
    />
  );
}

function TeamMark({
  team,
}: {
  team: { id: string; name: string; logoUrl: string | null };
}) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <TeamCrest
        seed={team.id}
        name={team.name}
        logoUrl={team.logoUrl}
        size={34}
      />
      <span className="truncate font-medium text-fg">{team.name}</span>
    </span>
  );
}

export default async function ScrimsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string | string[]; historyPage?: string | string[] }>;
}) {
  const [query, viewer, seasons] = await Promise.all([
    searchParams,
    getSessionUser(),
    prisma.season.findMany({
      where: { OR: [{ isActive: true }, { scrims: { some: {} } }] },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        status: true,
        isActive: true,
        dotaLeagueId: true,
      },
    }),
  ]);
  const activeSeason = singleActiveSeason(
    seasons.filter((candidate) => candidate.isActive),
  );
  const seasonParam = singleSearchParam(query.season);
  if (seasonParam === null) notFound();
  const season = seasonParam
    ? seasons.find((candidate) => candidate.id === seasonParam)
    : activeSeason ?? seasons[0] ?? null;
  if (seasonParam && !season) notFound();

  if (!season) {
    return (
      <div className="space-y-6">
        <PageTitle
          title="Scrims"
          subtitle="Casual practice games between teams, kept separate from league competition."
        />
        <EmptyState
          title="No active league"
          description="Scrim availability opens when the next season has teams."
        />
      </div>
    );
  }

  const now = new Date();
  const [teams, scrims, viewerMembership] = await Promise.all([
    prisma.team.findMany({
      where: { seasonId: season.id },
      orderBy: { name: "asc" },
      include: {
        staff: { include: { user: true }, orderBy: { createdAt: "asc" } },
      },
    }),
    prisma.scrim.findMany({
      where: {
        seasonId: season.id,
        status: { in: [SCRIM_STATUS.OPEN, SCRIM_STATUS.SCHEDULED, SCRIM_STATUS.LIVE] },
        OR: [
          { status: SCRIM_STATUS.LIVE },
          // A booking still without games 36h after kickoff moves to the
          // history as "Not played" instead of sitting in Booked forever.
          {
            status: SCRIM_STATUS.SCHEDULED,
            scheduledAt: { gte: scrimNotPlayedCutoff(now.getTime()) },
          },
          { status: SCRIM_STATUS.OPEN, scheduledAt: { gte: now } },
        ],
      },
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
      include: {
        hostTeam: true,
        opponentTeam: true,
        winnerTeam: true,
      },
    }),
    viewer
      ? prisma.teamMember.findFirst({
          where: { seasonId: season.id, userId: viewer.id },
          select: { teamId: true },
        })
      : null,
  ]);

  const myCaptainTeam = viewer
    ? teams.find((team) => team.captainId === viewer.id) ?? null
    : null;
  const myStaffTeams = viewer
    ? teams.filter((team) => team.staff.some((staff) => staff.userId === viewer.id))
    : [];
  // The team the viewer plays for, captains or coaches: its scrims lead the
  // page, with their lobby setup one tap away.
  const myTeam =
    myCaptainTeam ??
    teams.find((team) => team.id === viewerMembership?.teamId) ??
    myStaffTeams[0] ??
    null;
  const hasTicket = !!season.dotaLeagueId;
  const seasonOpen =
    season.isActive && season.status !== SEASON_STATUS.COMPLETE;
  const open = scrims.filter((scrim) => scrim.status === SCRIM_STATUS.OPEN);
  const booked = scrims.filter(
    (scrim) =>
      scrim.status === SCRIM_STATUS.SCHEDULED ||
      scrim.status === SCRIM_STATUS.LIVE,
  );
  return (
    <div className="space-y-6">
      <PageTitle
        title="Scrims"
        subtitle={`${season.name} · Practice games between league teams, kept out of standings and records.`}
      />

      {seasons.length > 1 ? (
        <nav
          aria-label="Scrim season"
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <span className="text-muted">Season:</span>
          {seasons.map((candidate) => (
            <Link
              key={candidate.id}
              href={`/scrims?season=${encodeURIComponent(candidate.id)}`}
              aria-current={candidate.id === season.id ? "page" : undefined}
              className={
                candidate.id === season.id
                  ? "rounded-full bg-accent/15 px-3 py-1 font-medium text-accent"
                  : "rounded-full border border-line px-3 py-1 text-muted transition-colors hover:text-fg"
              }
            >
              {candidate.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {!seasonOpen ? (
        <Card tone="quiet">
          <CardBody className="flex items-center gap-2 text-sm text-muted">
            <Badge>Archive</Badge>
            This season’s scrim history and practice-only stats are read-only.
          </CardBody>
        </Card>
      ) : null}

      {/* A season still before its draft has no teams, so nobody can post
          or claim anything: one line instead of a sign-in card and six empty
          lists (and Scrims is one of the few Explore links in signups). */}
      {seasonOpen && teams.length === 0 ? (
        <EmptyState
          title="Scrims open once teams exist"
          description="Teams form at the draft. After that, captains post practice times here and another team claims them, kept apart from league standings and records."
        />
      ) : (
      <>
      {/* Someone on a team gets their team's scrims first (on a phone the
          explainer filled the first screen); everyone else the explainer. */}
      {seasonOpen && !myTeam ? (
        <ScrimSteps hasTicket={hasTicket} signedIn={!!viewer} />
      ) : null}

      {myTeam && seasonOpen ? (
        <Card tone={myCaptainTeam ? "feature" : "default"} id="your-team">
          <CardHeader
            title={`${myTeam.name} scrims`}
            subtitle={
              myCaptainTeam
                ? "Post a time your team can play. Another captain claims it, and its page gives both teams the lobby setup."
                : "Your captain posts and claims times. When one is booked, its page has the lobby's name, password and settings."
            }
            headingLevel={2}
          />
          <CardBody className="space-y-4">
            {/* Render it only where createScrim would accept. */}
            {myCaptainTeam && !myCaptainTeam.withdrawn ? <ScrimPostForm /> : null}
            <TeamScrimList
              teamId={myTeam.id}
              scrims={scrims.filter(
                (scrim) =>
                  scrim.hostTeamId === myTeam.id ||
                  scrim.opponentTeamId === myTeam.id,
              )}
              canCancel={myCaptainTeam?.id === myTeam.id}
            />
          </CardBody>
        </Card>
      ) : null}

      {seasonOpen && myTeam ? (
        <ScrimSteps hasTicket={hasTicket} signedIn={!!viewer} />
      ) : null}

      {/* Open and booked are the two lists of upcoming practice: side by
          side from lg, each as tall as the row (an empty one keeps its
          one-line note at the top). */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card id="open" className="min-w-0">
          <CardHeader
            title="Open availability"
            subtitle="One captain click books the matchup. Posting or joining confirms that your side can field a team."
            headingLevel={2}
          />
          <CardBody className="space-y-3">
            {open.length === 0 ? (
              <EmptyState
                inline
                title="No open scrim times"
                description={
                  // Only a captain has a post form above to point at.
                  myCaptainTeam && seasonOpen
                    ? "Post the first one above."
                    : seasonOpen
                      ? "Team captains post their practice times here, and none are open right now."
                      : "This season is closed, so no new times can be posted."
                }
              />
            ) : (
              open.map((scrim) => {
                // Same verdict as the scrim's own page, minus the per-row
                // clash lookup (the service names that clash if it applies).
                const canJoin =
                  scrimJoinCheck({
                    status: scrim.status,
                    seasonOpen,
                    signedIn: !!viewer,
                    viewerTeam: myCaptainTeam,
                    hostTeamId: scrim.hostTeamId,
                    hostWithdrawn: scrim.hostTeam.withdrawn,
                    scheduledAtMs: scrim.scheduledAt.getTime(),
                    nowMs: now.getTime(),
                  })?.canJoin === true;
                const canCancel =
                  seasonOpen &&
                  (viewer?.role === "ADMIN" ||
                    myCaptainTeam?.id === scrim.hostTeamId);
                return (
                  <div
                    key={scrim.id}
                    className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2/30 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1.5">
                      <TeamMark team={scrim.hostTeam} />
                      <p className="text-sm text-muted">
                        <ScrimTime date={scrim.scheduledAt} /> · Best of{" "}
                        {scrim.bestOf}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Link
                        href={`/scrims/${scrim.id}`}
                        className={textLink("self-center text-sm")}
                      >
                        Details
                      </Link>
                      {canJoin ? <ScrimJoinButton scrimId={scrim.id} /> : null}
                      {canCancel ? (
                        <ScrimCancelButton scrimId={scrim.id} booked={false} />
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </CardBody>
        </Card>

        <Card id="booked" className="min-w-0">
          <CardHeader
            title="Booked scrims"
            subtitle="Upcoming and in-progress practice series."
            headingLevel={2}
          />
          <CardBody className="space-y-3">
            {booked.length === 0 ? (
              <EmptyState
                inline
                title="Nothing booked"
                description="Claimed availability appears here."
              />
            ) : (
              booked.map((scrim) => (
                // The matchup gets its own line: beside the badge and time,
                // two team names were cut to a few letters each.
                <Link
                  key={scrim.id}
                  href={`/scrims/${scrim.id}`}
                  className="block rounded-lg border border-line bg-surface-2/30 p-4 transition-colors hover:border-muted/60 hover:no-underline"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                    <TeamMark team={scrim.hostTeam} />
                    <span className="text-xs font-medium uppercase text-muted">
                      vs
                    </span>
                    {scrim.opponentTeam ? (
                      <TeamMark team={scrim.opponentTeam} />
                    ) : null}
                  </span>
                  <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
                    {scrim.status === SCRIM_STATUS.LIVE ? (
                      <Badge tone="accent">Live · {scrim.hostScore}–{scrim.awayScore}</Badge>
                    ) : (
                      <Badge tone="info">Booked</Badge>
                    )}
                    <span>
                      <ScrimTime date={scrim.scheduledAt} /> · Best of{" "}
                      {scrim.bestOf}
                    </span>
                  </span>
                </Link>
              ))
            )}
          </CardBody>
        </Card>

      </div>

      {/* Each card is a two-row subgrid (header, list), so side by side
          the three lists start on one line whatever their subtitles wrap to. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Suspense fallback={<p role="status">Loading practice history…</p>}><ScrimHistory seasonId={season.id} page={listPage(query.historyPage)} nowMs={now.getTime()} /></Suspense>
        <Suspense fallback={<p role="status">Loading all-time practice statistics…</p>}><ScrimStatistics seasonId={season.id} teams={teams} /></Suspense>
      </div>

      {myCaptainTeam && seasonOpen ? (
        <TeamCoachesCard team={myCaptainTeam} />
      ) : null}
      </>
      )}
    </div>
  );
}

/**
 * The whole flow in four lines, above the lists: post, claim, host with the
 * ticket, and the games record themselves. The third step is the one that
 * was missing: scrims hosted without the season's ticket never reached
 * OpenDota, so none recorded.
 */
function ScrimSteps({
  hasTicket,
  signedIn,
}: {
  hasTicket: boolean;
  signedIn: boolean;
}) {
  const steps = [
    {
      title: "Post a time",
      body: "A captain posts when their team can play.",
    },
    {
      title: "Claim it",
      body: "Another team's captain claims it in one click, and the posting captain is pinged on Discord.",
    },
    {
      title: "Host with the ticket",
      // Only a booked scrim owns its games: an unbooked game under the
      // ticket between two teams that meet in the league within three days
      // can be taken for that league match (claimsGame, closest meeting).
      body: "The posting team hosts. The scrim's page gives both teams the lobby's name, password and the league ticket to set. Use the ticket only for scrims booked here.",
    },
    hasTicket
      ? {
          title: "It records itself",
          body: "Games played with the ticket show up on the scrim a few minutes after they end.",
        }
      : {
          title: "No ticket yet",
          body: "This season has no league ticket yet, so scrim games can't record themselves.",
        },
  ];
  return (
    <section
      aria-labelledby="scrim-steps-title"
      className="rounded-[var(--radius)] border border-line-soft bg-surface/50 px-4 py-3"
    >
      <h2 id="scrim-steps-title" className="text-sm font-semibold text-fg">
        How scrims work
      </h2>
      <ol className="mt-2 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((step, index) => (
          <li key={step.title} className="flex min-w-0 gap-3">
            <span
              aria-hidden
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-accent/40 bg-accent/10 text-xs font-semibold text-accent"
            >
              {index + 1}
            </span>
            <span className="min-w-0 text-sm">
              <b className="block font-medium text-fg">{step.title}</b>
              <span className="text-muted">{step.body}</span>
            </span>
          </li>
        ))}
      </ol>
      {signedIn ? null : (
        <p className="mt-3 text-xs text-muted">
          <Link href="/login?next=/scrims" className={textLink()}>
            Sign in
          </Link>{" "}
          to post, claim or manage a scrim.
        </p>
      )}
    </section>
  );
}

/**
 * The viewer's team's coming scrims: who against, when, who hosts, and the
 * lobby setup for a booked one. Captains also get Cancel (the scrim page's
 * rule: either captain, not once it is live; the action re-checks it).
 */
function TeamScrimList({
  teamId,
  scrims,
  canCancel,
}: {
  teamId: string;
  scrims: {
    id: string;
    status: string;
    bestOf: number;
    scheduledAt: Date;
    hostTeamId: string;
    hostScore: number;
    awayScore: number;
    hostTeam: { name: string };
    opponentTeam: { name: string } | null;
  }[];
  canCancel: boolean;
}) {
  if (scrims.length === 0) {
    return (
      <EmptyState
        inline
        title="No scrims coming up"
        description={
          canCancel
            ? "Post a time above, or claim one under Open availability."
            : "Your captain can post a time or claim another team's."
        }
      />
    );
  }
  return (
    <ul aria-label="Your team's scrims" className="divide-y divide-line-soft text-sm">
      {scrims.map((scrim) => {
        const hosts = scrim.hostTeamId === teamId;
        const opponent = hosts ? scrim.opponentTeam : scrim.hostTeam;
        const booked =
          scrim.status === SCRIM_STATUS.SCHEDULED ||
          scrim.status === SCRIM_STATUS.LIVE;
        const ownScore = hosts ? scrim.hostScore : scrim.awayScore;
        const otherScore = hosts ? scrim.awayScore : scrim.hostScore;
        return (
          <li
            key={scrim.id}
            className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5"
          >
            <span className="min-w-0 flex-1 basis-48">
              <Link
                href={`/scrims/${scrim.id}`}
                className={textLink("font-medium [overflow-wrap:anywhere]")}
              >
                {opponent ? `vs ${opponent.name}` : "Your open time"}
              </Link>
              <span className="block text-xs text-muted">
                <ScrimTime date={scrim.scheduledAt} /> · Best of {scrim.bestOf}
                {opponent
                  ? hosts
                    ? " · your team hosts"
                    : ` · ${scrim.hostTeam.name} hosts`
                  : ""}
              </span>
            </span>
            {scrim.status === SCRIM_STATUS.LIVE ? (
              <Badge tone="accent">
                Live · {ownScore}–{otherScore}
              </Badge>
            ) : scrim.status === SCRIM_STATUS.OPEN ? (
              <Badge>Waiting for a team</Badge>
            ) : (
              <Badge tone="info">Booked</Badge>
            )}
            {booked ? (
              <Link
                href={`/scrims/${scrim.id}#lobby`}
                className={textLink("text-sm")}
              >
                Lobby setup <LinkArrow />
              </Link>
            ) : null}
            {canCancel && scrim.status !== SCRIM_STATUS.LIVE ? (
              <ScrimCancelButton scrimId={scrim.id} booked={booked} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const SUBGRID_CARD = "row-span-2 grid min-w-0 grid-rows-subgrid gap-0";

async function ScrimHistory({
  seasonId,
  page,
  nowMs,
}: {
  seasonId: string;
  page: number;
  nowMs: number;
}) {
  const results = await prisma.scrim.findMany({
    where: {
      seasonId,
      OR: [
        { status: SCRIM_STATUS.COMPLETED },
        {
          status: SCRIM_STATUS.SCHEDULED,
          scheduledAt: { lt: scrimNotPlayedCutoff(nowMs) },
        },
      ],
    },
    orderBy: [{ scheduledAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * 20,
    take: 21,
    include: {
      hostTeam: { select: { name: true } },
      opponentTeam: { select: { name: true } },
    },
  });
  const completed = results.slice(0, 20);
  return (
    <Card id="history" className={SUBGRID_CARD}>
      <CardHeader
        title="Scrim history"
        subtitle="Practice results only — never league results. A booking with no games 36 hours after it started is listed as not played."
        headingLevel={2}
      />
      <CardBody className="space-y-2">
        {completed.length === 0 ? (
          <EmptyState inline title="No completed scrims yet" />
        ) : (
          completed.map((scrim) => (
            <Link
              key={scrim.id}
              href={`/scrims/${scrim.id}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-line/70 px-3 py-2 text-sm transition-colors hover:border-muted/60 hover:no-underline"
            >
              <span className="min-w-0 truncate">
                {scrim.hostTeam.name} vs {scrim.opponentTeam?.name}
              </span>
              {isScrimNotPlayed(
                scrim.status,
                scrim.scheduledAt.getTime(),
                nowMs,
              ) ? (
                <Badge className="shrink-0">Not played</Badge>
              ) : (
                <span className="shrink-0 font-mono tabular-nums">
                  {scrim.hostScore}–{scrim.awayScore}
                </span>
              )}
            </Link>
          ))
        )}
        {page > 1 || results.length > 20 ? (
        <nav
          aria-label="Scrim history pages"
          className="flex flex-wrap gap-3 pt-3 text-sm"
        >
          {page > 1 ? (
            <Link
              href={`/scrims?${new URLSearchParams({ season: seasonId, historyPage: String(page - 1) })}#history`}
              className={textLink()}
            >
              ← Newer results
            </Link>
          ) : null}
          {results.length > 20 ? (
            <Link
              href={`/scrims?${new URLSearchParams({ season: seasonId, historyPage: String(page + 1) })}#history`}
              className={textLink()}
            >
              Older results →
            </Link>
          ) : null}
        </nav>
        ) : null}
      </CardBody>
    </Card>
  );
}

async function ScrimStatistics({
  seasonId,
  teams,
}: {
  seasonId: string;
  teams: { id: string; name: string; logoUrl: string | null }[];
}) {
  // Statistics retain every completed result regardless of the history page.
  const [scrimGames, completed] = await Promise.all([
    prisma.scrimGame.findMany({
      where: {
        scrim: { seasonId: seasonId, status: SCRIM_STATUS.COMPLETED },
      },
      select: {
        radiantWin: true,
        players: true,
        scrim: {
          select: {
            participants: {
              select: {
                userId: true,
                dotaAccountId: true,
                displayName: true,
              },
            },
          },
        },
      },
    }),
    prisma.scrim.findMany({
      where: { seasonId, status: SCRIM_STATUS.COMPLETED },
      select: {
        hostTeamId: true,
        opponentTeamId: true,
        hostScore: true,
        awayScore: true,
      },
    }),
  ]);
  const leaders = new Map<
    string,
    {
      key: string;
      userId: string | null;
      name: string;
      games: number;
      wins: number;
      kills: number;
      deaths: number;
      assists: number;
    }
  >();
  for (const game of scrimGames) {
    const names = new Map(
      game.scrim.participants.map((participant) => [
        participant.dotaAccountId,
        participant.displayName,
      ]),
    );
    for (const player of parseGamePlayers(game.players)) {
      if (player.accountId == null && !player.userId) continue;
      const key = player.userId
        ? `user:${player.userId}`
        : `account:${player.accountId}`;
      const row = leaders.get(key) ?? {
        key,
        userId: player.userId,
        name:
          (player.accountId != null ? names.get(player.accountId) : null) ??
          player.personaname ??
          "Guest player",
        games: 0,
        wins: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
      };
      row.games += 1;
      row.wins += player.isRadiant === game.radiantWin ? 1 : 0;
      row.kills += player.kills;
      row.deaths += player.deaths;
      row.assists += player.assists;
      leaders.set(key, row);
    }
  }
  const leaderRows = [...leaders.values()]
    .sort(
      (a, b) =>
        b.kills + b.assists - (a.kills + a.assists) ||
        b.games - a.games ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 8);
  const teamRecordRows = teams
    .map((team) => {
      let seriesWins = 0;
      let seriesDraws = 0;
      let seriesLosses = 0;
      let gameWins = 0;
      let gameLosses = 0;
      for (const scrim of completed) {
        const isHost = scrim.hostTeamId === team.id;
        const isAway = scrim.opponentTeamId === team.id;
        if (!isHost && !isAway) continue;
        const ownScore = isHost ? scrim.hostScore : scrim.awayScore;
        const otherScore = isHost ? scrim.awayScore : scrim.hostScore;
        gameWins += ownScore;
        gameLosses += otherScore;
        if (ownScore > otherScore) seriesWins += 1;
        else if (ownScore < otherScore) seriesLosses += 1;
        else seriesDraws += 1;
      }
      return {
        team,
        seriesWins,
        seriesDraws,
        seriesLosses,
        gameWins,
        gameLosses,
        played: seriesWins + seriesDraws + seriesLosses,
      };
    })
    .filter((row) => row.played > 0)
    .sort(
      (a, b) =>
        b.seriesWins - a.seriesWins ||
        b.gameWins - b.gameLosses - (a.gameWins - a.gameLosses) ||
        a.team.name.localeCompare(b.team.name),
    );

  return (
    <>
      <Card id="team-stats" className={SUBGRID_CARD}>
        <CardHeader
          title="Scrim team records"
          subtitle="A practice-only table; league standings are unchanged."
          headingLevel={2}
        />
        <CardBody className="space-y-2">
          {teamRecordRows.length === 0 ? (
            <EmptyState inline title="No scrim team records yet" />
          ) : (
            teamRecordRows.map((row) => (
              <div
                key={row.team.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-line/70 px-3 py-2 text-sm"
              >
                <TeamMark team={row.team} />
                <div className="shrink-0 text-right">
                  <p className="font-mono tabular-nums">
                    {row.seriesWins}-{row.seriesDraws}-{row.seriesLosses}
                  </p>
                  <p className="text-xs text-muted">
                    games {row.gameWins}–{row.gameLosses}
                  </p>
                </div>
              </div>
            ))
          )}
        </CardBody>
      </Card>

      <Card id="stats" className={SUBGRID_CARD}>
        <CardHeader
          title="Scrim leaders"
          subtitle="Calculated only from completed scrim games, including casual guests."
          headingLevel={2}
        />
        <CardBody className="space-y-2">
          {leaderRows.length === 0 ? (
            <EmptyState inline title="No scrim stats yet" />
          ) : (
            leaderRows.map((row) => (
              <div
                key={row.key}
                className="flex items-center justify-between gap-3 rounded-lg border border-line/70 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  {row.userId ? (
                    <PlayerLink userId={row.userId}>{row.name}</PlayerLink>
                  ) : (
                    <span className="font-medium">{row.name}</span>
                  )}
                  <p className="text-xs text-muted">
                    {row.games}g · {row.wins}w
                  </p>
                </div>
                <KDA
                  kills={row.kills}
                  deaths={row.deaths}
                  assists={row.assists}
                />
              </div>
            ))
          )}
        </CardBody>
      </Card>
    </>
  );
}
