import { shareMetadata } from "@/lib/share-metadata";
import { Suspense } from "react";
import { listPage } from "@/lib/list-page";
import Link from "next/link";
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
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { LocalTime } from "@/components/local-time";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  addTeamCoach,
  cancelScrim,
  createScrim,
  joinScrim,
  removeTeamCoach,
} from "@/app/actions/scrims";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  KDA,
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

const inputClass =
  "h-10 rounded-lg border border-line bg-surface-2/50 px-3 text-sm text-fg outline-none focus:border-accent/60";

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
  const [teams, scrims] = await Promise.all([
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
  ]);

  const myCaptainTeam = viewer
    ? teams.find((team) => team.captainId === viewer.id) ?? null
    : null;
  const myStaffTeams = viewer
    ? teams.filter((team) => team.staff.some((staff) => staff.userId === viewer.id))
    : [];
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
        subtitle={`${season.name} · Captains post a time, another team claims it, and the result stays entirely outside league standings and records.`}
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
      {myCaptainTeam && seasonOpen ? (
        <Card tone="feature">
          <CardHeader
            title="Post team availability"
            subtitle={`${myCaptainTeam.name} is available to practice. A captain from another active team can claim the slot.`}
          />
          <CardBody>
            <ActionForm
              action={createScrim}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              {/* A datetime needs about 18rem; stretched across the card it
                  pushed Format and Post to the far edge. A flex column, not
                  space-y: the field's hidden twin is the last child, so
                  space-y put a margin under the visible box and lifted it
                  6px above Format and Post. */}
              <label className="flex min-w-0 flex-col gap-1.5 text-sm sm:w-72">
                <span className="block text-xs font-medium text-muted">
                  Available date and time
                </span>
                <LocalDatetimeField
                  name="scheduledAt"
                  tsName="scheduledAtTs"
                  required
                  className={`${inputClass} w-full`}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="block text-xs font-medium text-muted">
                  Format
                </span>
                <select name="bestOf" defaultValue="1" className={inputClass}>
                  <option value="1">Best of 1</option>
                  <option value="2">Best of 2</option>
                  <option value="3">Best of 3</option>
                  <option value="5">Best of 5</option>
                </select>
              </label>
              <SubmitButton>Post availability</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      ) : viewer && seasonOpen ? (
        <Card tone="quiet">
          <CardBody className="text-sm text-muted">
            You can browse scrims now. Only a current team captain can post or
            claim availability.
            {myStaffTeams.length > 0
              ? " As a team coach, you can manage casual guests and fetch results after a scrim is booked."
              : ""}
          </CardBody>
        </Card>
      ) : !viewer && seasonOpen ? (
        <Card tone="quiet">
          <CardBody className="text-sm text-muted">
            <Link href="/login?next=/scrims" className={textLink()}>
              Sign in
            </Link>{" "}
            to post, claim, or manage a scrim.
          </CardBody>
        </Card>
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
                      {canJoin ? (
                        <ActionForm action={joinScrim} hidden={{ scrimId: scrim.id }}>
                          <SubmitButton size="sm">Join scrim</SubmitButton>
                        </ActionForm>
                      ) : null}
                      {canCancel ? (
                        <ActionForm
                          action={cancelScrim}
                          hidden={{ scrimId: scrim.id }}
                        >
                          <SubmitButton
                            size="sm"
                            variant="ghost"
                            confirm="Cancel this open scrim time?"
                          >
                            Cancel
                          </SubmitButton>
                        </ActionForm>
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
                <Link
                  key={scrim.id}
                  href={`/scrims/${scrim.id}`}
                  className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2/30 p-4 transition-colors hover:border-muted/60 hover:no-underline sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <TeamMark team={scrim.hostTeam} />
                    <span className="text-xs font-medium uppercase text-muted">
                      vs
                    </span>
                    {scrim.opponentTeam ? (
                      <TeamMark team={scrim.opponentTeam} />
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted">
                    {scrim.status === SCRIM_STATUS.LIVE ? (
                      <Badge tone="accent">Live · {scrim.hostScore}–{scrim.awayScore}</Badge>
                    ) : (
                      <Badge tone="info">Booked</Badge>
                    )}
                    <ScrimTime date={scrim.scheduledAt} />
                  </div>
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
        <Card id="coaches" tone="quiet">
          <CardHeader
            title={`${myCaptainTeam.name} coaches`}
            subtitle="Coaches must have signed into the site once. They can manage your side’s casual guest IDs and fetch scrim results, but cannot post, claim, or cancel scrims."
            headingLevel={2}
          />
          <CardBody className="space-y-4">
            <ActionForm
              action={addTeamCoach}
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
            >
              <label className="min-w-0 flex-1 space-y-1.5 text-sm sm:max-w-md">
                <span className="block text-xs font-medium text-muted">
                  Coach Dota ID, SteamID64, or profile URL
                </span>
                <input
                  name="coachRef"
                  required
                  placeholder="Account ID or profile URL"
                  className={`${inputClass} w-full`}
                />
              </label>
              {/* Secondary: a set-once form must not compete with Post
                  availability, the page's one main action. */}
              <SubmitButton size="sm" variant="secondary">
                Add coach
              </SubmitButton>
            </ActionForm>
            {myCaptainTeam.staff.length > 0 ? (
              <ul className="divide-y divide-line/60 rounded-lg border border-line/70">
                {myCaptainTeam.staff.map((staff) => (
                  <li
                    key={staff.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <PlayerLink userId={staff.userId}>
                      {staff.user.name}
                    </PlayerLink>
                    <ActionForm
                      action={removeTeamCoach}
                      hidden={{ staffId: staff.id }}
                    >
                      <SubmitButton
                        variant="ghost"
                        size="sm"
                        confirm={`Remove ${staff.user.name}'s coach access?`}
                      >
                        Remove
                      </SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No coaches assigned.</p>
            )}
          </CardBody>
        </Card>
      ) : null}
      </>
      )}
    </div>
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
