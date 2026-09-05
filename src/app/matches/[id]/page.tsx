import { LEAGUE_CONFIG } from "@/lib/league-config";
import { Suspense } from "react";
import { fetchAllGamesForScouting } from "@/lib/cached-queries";
import {
  decodeGamePlayers,
  parseGamePlayers,
  trustedGamePlayers,
} from "@/lib/player-stats";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { shareMetadata } from "@/lib/share-metadata";
import { AUTO_SYNC } from "@/lib/constants";
import { formatNetWorth, cn } from "@/lib/utils";
import { heroById } from "@/lib/heroes";
import { seatValue } from "@/lib/standin";
import { roleShort } from "@/lib/roles";
import { recentForm, headToHead } from "@/lib/team-matches";
import { gameMvp } from "@/lib/achievements";
import { CheckinBanner } from "@/components/checkin-banner";
import { ContextBackLink } from "@/components/context-back-link";
import { SectionNav } from "@/components/section-nav";
import { LocalTime } from "@/components/local-time";
import { formatMatchTime } from "@/lib/match-time";
import { matchNightRoster } from "@/lib/availability";
import { canViewNamedMatchAvailability } from "@/lib/visibility";
import {
  matchCheckinOpen,
  matchLogisticsOpen,
  matchResultsOpen,
  standinAssignmentOpen,
} from "@/lib/league-lifecycle";
import {
  groupPlayoffRounds,
  matchPhaseLabel,
  roundName,
  slotRound,
} from "@/lib/schedule";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  cancelReschedule,
  proposeReschedule,
  respondReschedule,
} from "@/app/actions/reschedule";
import {
  captainAutoDetect,
  captainImportGame,
} from "@/app/actions/match-report";
import {
  captainAssignStandin,
  captainRemoveStandin,
} from "@/app/actions/standins";
import { MatchImportControls } from "@/components/match-import-controls";
import { LeagueLobbyChecklist } from "@/components/league-lobby-checklist";
import { DotaLobbyControls } from "@/components/dota-lobby-controls";
import { lobbyBotKindEnabled } from "@/lib/dota-lobby-service";
import type { PlayerStat } from "@/lib/match-import";
import {
  cardAverage,
  gameReportCard,
  gradeFor,
  gradeTone,
  percentLabel,
  type Grade,
} from "@/lib/benchmarks";
import {
  dossierEmpty,
  paceProfile,
  playerHeroPool,
  threatBoard,
  type HeroPoolRow,
  type PaceProfile,
  type ScoutGame,
  type ThreatBoard,
} from "@/lib/scouting";
import { roleCoverage, type RoleCount } from "@/lib/pool-stats";
import { seasonScenarioReport, type StakesMatchRow } from "@/lib/stakes";
import { projectPlayoffField } from "@/lib/playoff-field";
import { matchStakes, stakesHeadline } from "@/lib/scenarios";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  EmptyState,
  FormStrip,
  HeroIcon,
  KDA,
  PageTitle,
  PlayerLink,
  RankBadge,
  RoleBadges,
  TeamCrest,
  buttonClasses,
  teamHue,
  textLink,
} from "@/components/ui";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const match = await prisma.match.findUnique({
    where: { id },
    select: {
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
  });
  // notFound() in metadata runs before the shell streams → real 404 status.
  if (!match) notFound();
  const title = `${match.homeTeam.name} vs ${match.awayTeam.name}`;
  return shareMetadata(title, `${title} — box score and results in ${LEAGUE_CONFIG.name}.`);
}

export default async function MatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const match = await prisma.match.findUnique({
    where: { id },
    include: {
      homeTeam: true,
      awayTeam: true,
      games: { orderBy: { startTime: "asc" } },
      standins: { include: { standin: true, replaced: true } },
      season: {
        select: {
          isActive: true,
          status: true,
          name: true,
          championTeamId: true,
          dotaLeagueId: true,
        },
      },
    },
  });
  if (!match) notFound();

  // Hero names are only rendered by the box-score branch — don't make the
  // preview/empty-state paths wait on an OpenDota round trip they never use.
  const games = match.games.map((g) => ({
    ...g,
    parsed: parseGamePlayers(g.players),
  }));

  const userIds = [
    ...new Set(
      games.flatMap((g) => g.parsed.map((p) => p.userId).filter(Boolean)),
    ),
  ] as string[];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } } })
    : [];
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const userAvatar = new Map(users.map((u) => [u.id, u.avatar]));
  const teamName = new Map([
    [match.homeTeamId, match.homeTeam.name],
    [match.awayTeamId, match.awayTeam.name],
  ]);
  // Async server component: capture request time once for the overdue-result
  // explanation; this is not client render state.
  // eslint-disable-next-line react-hooks/purity
  const renderedAt = Date.now();
  const postseason =
    match.phase === "REGULAR"
      ? []
      : await prisma.match.findMany({
          where: { seasonId: match.seasonId, phase: { not: "REGULAR" } },
          select: {
            id: true,
            phase: true,
            bracketSlot: true,
            status: true,
            winnerTeamId: true,
            homeTeamId: true,
            awayTeamId: true,
          },
        });
  const championPresentation = resolveChampionPresentation(
    match.season,
    postseason,
  );
  const postseasonLabel =
    match.phase === "PLAYOFF"
      ? roundName(
          slotRound(match.bracketSlot),
          groupPlayoffRounds(postseason).totalRounds,
        )
      : matchPhaseLabel(match.phase, match.week);
  const viewer = await getSessionUser();
  const isCaptain =
    !!viewer &&
    (match.homeTeam.captainId === viewer.id ||
      match.awayTeam.captainId === viewer.id);
  const showCaptainTools = isCaptain && match.season.isActive;
  const hasSeriesScore =
    match.status === "COMPLETED" ||
    match.status === "LIVE" ||
    games.length > 0 ||
    match.homeScore + match.awayScore > 0;
  const hasPreview = games.length === 0 && match.status !== "COMPLETED";
  const resultPending =
    match.status !== "COMPLETED" &&
    match.scheduledAt != null &&
    match.scheduledAt.getTime() < renderedAt;
  const sectionItems = [
    ...(hasPreview
      ? [
          { id: "match-games", label: "Match night" },
          { id: "match-matchup", label: "Lineups" },
          { id: "match-scouting", label: "Scouting" },
        ]
      : [{ id: "match-games", label: "Games" }]),
    ...(showCaptainTools
      ? [{ id: "match-tools", label: "Captain tools" }]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageTitle
        title="Match center"
        subtitle={`${match.season.name} · ${postseasonLabel}`}
        action={
          <ContextBackLink
            href={
              match.season.isActive
                ? match.phase === "REGULAR"
                  ? "/schedule#fixtures"
                  : "/schedule#playoff-bracket"
                : `/seasons/${match.seasonId}`
            }
            className={buttonClasses("secondary", "sm")}
          >
            {match.season.isActive
              ? match.phase === "REGULAR"
                ? "← Schedule"
                : "← Playoff bracket"
              : "← Season archive"}
          </ContextBackLink>
        }
      />

      <Card className="relative overflow-hidden">
        <div
          aria-hidden
          className="hero-grid pointer-events-none absolute inset-0 opacity-40"
        />
        {/* Each side glows with its team's own color identity (home left, away right). */}
        <div
          aria-hidden
          className="animate-hero-glow pointer-events-none absolute -left-10 top-0 h-40 w-40 -translate-y-1/3 rounded-full blur-3xl"
          style={{
            backgroundColor: `hsl(${teamHue(match.homeTeamId)} 70% 50% / 0.24)`,
          }}
        />
        <div
          aria-hidden
          className="animate-hero-glow-alt pointer-events-none absolute -right-10 bottom-0 h-40 w-40 translate-y-1/3 rounded-full blur-3xl"
          style={{
            backgroundColor: `hsl(${teamHue(match.awayTeamId)} 70% 50% / 0.24)`,
          }}
        />
        <CardBody className="relative space-y-6 px-3 py-6 sm:px-6 sm:py-8">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Badge>Bo{match.bestOf}</Badge>
            {match.status === "COMPLETED" ? (
              <>
                <Badge tone="success">Series complete</Badge>
                {match.phase === "FINAL" &&
                match.id === championPresentation.authoritativeFinalId &&
                match.winnerTeamId === championPresentation.championTeamId ? (
                  <Badge tone="accent">🏆 League champion crowned</Badge>
                ) : null}
                {!match.winnerTeamId ? <Badge tone="accent">Draw</Badge> : null}
                {match.forfeit ? (
                  <Badge
                    tone="accent"
                    title="This score includes an admin ruling (forfeit / default); its recorded score counts in the standings and game-diff tiebreak."
                  >
                    forfeit
                  </Badge>
                ) : null}
              </>
            ) : match.status === "LIVE" || games.length > 0 ? (
              <Badge tone="danger">LIVE</Badge>
            ) : resultPending ? (
              <Badge tone="accent">Awaiting result</Badge>
            ) : (
              <Badge tone="info">
                {match.scheduledAt ? "Upcoming" : "Time TBD"}
              </Badge>
            )}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-8">
            <TeamSide
              name={match.homeTeam.name}
              teamId={match.homeTeamId}
              logoUrl={match.homeTeam.logoUrl}
              win={match.winnerTeamId === match.homeTeamId}
            />
            <div className="text-center">
              <div
                role="img"
                aria-label={
                  hasSeriesScore
                    ? `${match.homeTeam.name} ${match.homeScore}, ${match.awayTeam.name} ${match.awayScore}`
                    : "Series score not recorded"
                }
                className="flex items-center justify-center gap-2 font-display text-4xl font-bold tabular-nums tracking-tight sm:gap-4 sm:text-7xl"
              >
                {hasSeriesScore ? (
                  <>
                    <span
                      className={
                        match.winnerTeamId === match.homeTeamId
                          ? "text-accent"
                          : "text-fg"
                      }
                    >
                      {match.homeScore}
                    </span>
                    <span
                      aria-hidden
                      className="text-xl font-normal text-muted/50 sm:text-3xl"
                    >
                      –
                    </span>
                    <span
                      className={
                        match.winnerTeamId === match.awayTeamId
                          ? "text-accent"
                          : "text-fg"
                      }
                    >
                      {match.awayScore}
                    </span>
                  </>
                ) : (
                  <span className="text-2xl font-medium text-muted sm:text-4xl">
                    VS
                  </span>
                )}
              </div>
              <span className="mt-2 block text-[10px] font-medium uppercase tracking-[0.2em] text-muted">
                series
              </span>
            </div>
            <TeamSide
              name={match.awayTeam.name}
              teamId={match.awayTeamId}
              logoUrl={match.awayTeam.logoUrl}
              win={match.winnerTeamId === match.awayTeamId}
            />
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3 border-t border-line/60 pt-4 text-center text-sm text-muted">
            {match.scheduledAt ? (
              <LocalTime
                ts={match.scheduledAt.getTime()}
                variant="full"
                initial={formatMatchTime(match.scheduledAt, "full")}
              />
            ) : (
              <span>Kickoff time TBD</span>
            )}
            {showCaptainTools ? (
              <a href="#match-tools" className={buttonClasses("primary", "sm")}>
                {match.status === "COMPLETED"
                  ? "Result correction ↓"
                  : !matchResultsOpen(match.season.status, match.phase)
                    ? "Captain tools ↓"
                    : match.status === "LIVE" || games.length > 0
                      ? "Record next game ↓"
                      : "Set up & report ↓"}
              </a>
            ) : null}
          </div>
        </CardBody>
        {games.length > 0 ? (
          <div className="relative flex flex-wrap justify-center gap-2 border-t border-line bg-bg/30 px-3 py-3">
            {games.map((game, index) => {
              const winner =
                game.winnerTeamId === match.homeTeamId
                  ? match.homeTeam
                  : game.winnerTeamId === match.awayTeamId
                    ? match.awayTeam
                    : null;
              return (
                <a
                  key={game.id}
                  href={`#game-${game.id}`}
                  className="flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-line bg-surface/80 px-3 py-2 text-xs transition-colors hover:border-muted hover:bg-surface-2"
                >
                  <span className="shrink-0 font-semibold">
                    Game {index + 1}
                  </span>
                  {winner ? (
                    <>
                      <TeamCrest
                        name={winner.name}
                        seed={winner.id}
                        logoUrl={winner.logoUrl}
                        size={20}
                      />
                      <span className="min-w-0 text-muted [overflow-wrap:anywhere]">
                        {winner.name} won
                      </span>
                    </>
                  ) : (
                    <span className="text-muted">Box score →</span>
                  )}
                </a>
              );
            })}
          </div>
        ) : null}
      </Card>

      <SectionNav items={sectionItems} label="Match sections" sticky />

      {!match.season.isActive ? (
        <div className="rounded-[var(--radius)] border border-line bg-surface-2/40 px-4 py-3 text-sm text-muted">
          <strong className="text-fg">Archived result.</strong> This match is
          part of {match.season.name}; its schedule, reporting, and logistics
          are read-only.
        </div>
      ) : match.status !== "COMPLETED" &&
        match.scheduledAt &&
        match.scheduledAt.getTime() < renderedAt ? (
        <div className="rounded-[var(--radius)] border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-muted">
          <strong className="text-fg">Result pending.</strong> The scheduled
          kickoff has passed, but this series is not final yet. A captain can
          report the Dota game while the fixture&apos;s league phase is open.
        </div>
      ) : null}

      {/* Pending time changes stay visible to spectators. Captain controls
          live together below the match, with a primary jump in the scoreboard. */}
      {!showCaptainTools && match.status !== "COMPLETED" ? (
        <RescheduleSection match={match} />
      ) : null}

      <section
        id="match-games"
        className="scroll-mt-40 space-y-6"
        aria-label={hasPreview ? "Match preview" : "Match games"}
      >
        {games.length === 0 && match.status !== "COMPLETED" ? (
          <Suspense fallback={<CardSkeleton rows={5} />}>
            {/* Rosters, scouting (scans all seasons' box scores) and the stakes
              banner stream in so the header + check-in paint immediately. */}
            <MatchPreview match={match} />
          </Suspense>
        ) : games.length === 0 ? (
          <EmptyState
            title={
              match.forfeit
                ? "Series awarded by forfeit"
                : "Final score entered manually"
            }
            description={
              match.forfeit
                ? "This is an administrative ruling; no Dota game was recorded for this series."
                : "The final result is official, but detailed OpenDota box-score data is unavailable."
            }
          />
        ) : (
          games.map((g, i) => {
            const radiant = g.parsed.filter((p) => p.isRadiant);
            const dire = g.parsed.filter((p) => !p.isRadiant);
            const winnerName = g.winnerTeamId
              ? teamName.get(g.winnerTeamId)
              : null;
            const radiantName = g.radiantTeamId
              ? (teamName.get(g.radiantTeamId) ?? "Radiant")
              : "Radiant";
            const direName = g.direTeamId
              ? (teamName.get(g.direTeamId) ?? "Dire")
              : "Dire";
            const maxNet = Math.max(1, ...g.parsed.map((p) => p.netWorth ?? 0));
            const mvpId = gameMvp(g.parsed, g.radiantWin);
            const radiantNet = radiant.reduce(
              (s, p) => s + (p.netWorth ?? 0),
              0,
            );
            const direNet = dire.reduce((s, p) => s + (p.netWorth ?? 0), 0);
            return (
              <Card
                key={g.id}
                id={`game-${g.id}`}
                className="scroll-mt-40 overflow-hidden"
              >
                <CardHeader
                  title={`Game ${i + 1}`}
                  // 0s / 0-0 means the header stats never got reported — showing
                  // "0m 0s · 0-0 kills" reads as a real (absurd) game.
                  subtitle={
                    [
                      g.durationSecs > 0
                        ? `${Math.floor(g.durationSecs / 60)}m ${g.durationSecs % 60}s`
                        : null,
                      g.radiantScore + g.direScore > 0
                        ? `${g.radiantScore}-${g.direScore} kills`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || undefined
                  }
                  action={
                    <div className="flex items-center gap-2">
                      {winnerName ? (
                        <Badge tone="success">{winnerName} won</Badge>
                      ) : null}
                      <a
                        href={`https://www.opendota.com/matches/${g.dotaMatchId}`}
                        target="_blank"
                        rel="noreferrer"
                        className={textLink("text-xs")}
                      >
                        OpenDota ↗
                      </a>
                    </div>
                  }
                />
                <CardBody className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
                  <NetWorthAdvantage
                    radiantName={radiantName}
                    direName={direName}
                    radiantNet={radiantNet}
                    direNet={direNet}
                  />
                  <SidePlayers
                    label={radiantName}
                    win={g.radiantWin}
                    mvpId={mvpId}
                    players={radiant}
                    userName={userName}
                    userAvatar={userAvatar}
                    maxNet={maxNet}
                  />
                  <SidePlayers
                    label={direName}
                    win={!g.radiantWin}
                    mvpId={mvpId}
                    players={dire}
                    userName={userName}
                    userAvatar={userAvatar}
                    maxNet={maxNet}
                  />
                </CardBody>
              </Card>
            );
          })
        )}
      </section>

      {showCaptainTools ? (
        <section
          id="match-tools"
          className="scroll-mt-40 space-y-4"
          aria-labelledby="match-tools-title"
        >
          <div className="flex items-center gap-3 border-t border-line pt-6">
            <span
              aria-hidden
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent/10 text-accent"
            >
              ◇
            </span>
            <h2
              id="match-tools-title"
              className="font-display text-2xl font-semibold"
            >
              Captain tools
            </h2>
            <Badge className="ml-auto">Your match</Badge>
          </div>
          {/* These components keep their own write-time capability gates,
              including read-only correction and stranded-proposal cleanup. */}
          <ReportResultSection match={match} renderedAt={renderedAt} />
          {match.status !== "COMPLETED" ? (
            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
              <div className="min-w-0">
                <RescheduleSection match={match} />
              </div>
              <div className="min-w-0">
                <StandinSection match={match} />
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

// Pre-match scouting: rosters, recent form, prior meetings, and who's
// confirmed for match night — shown until the first game is recorded.
async function MatchPreview({
  match,
}: {
  match: {
    id: string;
    seasonId: string;
    week: number;
    phase: string;
    status: string;
    scheduledAt: Date | null;
    homeTeamId: string;
    awayTeamId: string;
    homeTeam: { name: string; logoUrl: string | null; captainId: string };
    awayTeam: { name: string; logoUrl: string | null; captainId: string };
    standins: {
      id: string;
      teamId: string;
      standin: { id: string; name: string };
      replaced: { id: string; name: string } | null;
    }[];
  };
}) {
  const viewer = await getSessionUser();
  const canSeeNamedAvailability = canViewNamedMatchAvailability(
    viewer,
    match.homeTeam.captainId,
    match.awayTeam.captainId,
  );
  const [members, seasonMatches, rsvps] = await Promise.all([
    prisma.teamMember.findMany({
      where: {
        seasonId: match.seasonId,
        teamId: { in: [match.homeTeamId, match.awayTeamId] },
      },
      include: { user: true },
      orderBy: { price: "desc" },
    }),
    prisma.match.findMany({
      where: { seasonId: match.seasonId },
      orderBy: [{ week: "asc" }, { createdAt: "asc" }],
    }),
    viewer
      ? prisma.matchAvailability.findMany({
          where: {
            matchId: match.id,
            ...(canSeeNamedAvailability ? {} : { userId: viewer.id }),
          },
          select: { userId: true, status: true },
        })
      : Promise.resolve([]),
  ]);
  const regs = await prisma.registration.findMany({
    where: {
      seasonId: match.seasonId,
      userId: { in: members.map((m) => m.userId) },
    },
    select: { userId: true, roles: true, mmr: true },
  });
  const regByUser = new Map(regs.map((r) => [r.userId, r]));
  const rsvpByUser = new Map(rsvps.map((r) => [r.userId, r.status]));

  // Mirror setAvailability's decisive capability gate: an RSVP is about one
  // published, upcoming match night, not an archived/locked/untimed/LIVE row.
  const [previewSeason, previewDraft] = await Promise.all([
    prisma.season.findUnique({
      where: { id: match.seasonId },
      select: { isActive: true, status: true },
    }),
    prisma.draft.findUnique({
      where: { seasonId: match.seasonId },
      select: { status: true },
    }),
  ]);
  const activeNightRoster = new Set(
    [match.homeTeamId, match.awayTeamId].flatMap((teamId) =>
      matchNightRoster(
        members.filter((m) => m.teamId === teamId).map((m) => m.userId),
        match.standins
          .filter((s) => s.teamId === teamId)
          .map((s) => ({
            standinUserId: s.standin.id,
            replacingUserId: s.replaced?.id ?? null,
          })),
      ),
    ),
  );
  // Async server component: this captures request time once for the stale-
  // fixture guard; it is not client render state.
  // eslint-disable-next-line react-hooks/purity
  const previewNow = Date.now();
  const isParticipant =
    !!viewer &&
    !!previewSeason?.isActive &&
    matchCheckinOpen(
      previewSeason.status,
      previewDraft?.status,
      match.status,
      match.scheduledAt,
      previewNow,
    ) &&
    activeNightRoster.has(viewer.id);
  const myRsvp = viewer ? (rsvpByUser.get(viewer.id) ?? null) : null;

  const h2hRow = headToHead(match.homeTeamId, seasonMatches).find(
    (h) => h.opponentId === match.awayTeamId,
  );

  const side = (teamId: string, name: string, logoUrl: string | null) => {
    const roster = members.filter((m) => m.teamId === teamId);
    const subs = match.standins.filter((s) => s.teamId === teamId);
    const replacedIds = new Set(
      subs.map((s) => s.replaced?.id).filter(Boolean),
    );
    const form = recentForm(
      teamId,
      seasonMatches.filter(
        (m) => m.homeTeamId === teamId || m.awayTeamId === teamId,
      ),
    );
    return { teamId, name, logoUrl, roster, subs, replacedIds, form };
  };
  const sides = [
    side(match.homeTeamId, match.homeTeam.name, match.homeTeam.logoUrl),
    side(match.awayTeamId, match.awayTeam.name, match.awayTeam.logoUrl),
  ];

  return (
    <div className="space-y-6">
      {isParticipant ? (
        <CheckinBanner
          matchId={match.id}
          heading="You're playing in this match"
          when={
            match.scheduledAt
              ? formatMatchTime(match.scheduledAt, "full")
              : undefined
          }
          whenTs={match.scheduledAt?.getTime()}
          myRsvp={myRsvp}
        />
      ) : null}

      <StakesBanner match={match} seasonMatches={seasonMatches} />

      <Card id="match-matchup" className="scroll-mt-40 overflow-hidden">
        <CardHeader
          title="Matchup"
          headingLevel={2}
          subtitle={
            h2hRow && h2hRow.wins + h2hRow.losses + h2hRow.draws > 0
              ? `Prior meetings: ${
                  h2hRow.wins > h2hRow.losses
                    ? `${match.homeTeam.name} lead ${h2hRow.wins}–${h2hRow.losses}`
                    : h2hRow.losses > h2hRow.wins
                      ? `${match.awayTeam.name} lead ${h2hRow.losses}–${h2hRow.wins}`
                      : `tied ${h2hRow.wins}–${h2hRow.losses}`
                }${h2hRow.draws ? ` (${h2hRow.draws} drawn)` : ""}`
              : "First meeting this season"
          }
        />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {sides.map((s) => (
            <div key={s.teamId} className="rounded-lg border border-line p-3">
              <div className="mb-2.5 flex items-center justify-between gap-2">
                <Link
                  href={`/teams/${s.teamId}`}
                  className="flex min-w-0 items-center gap-2 font-display text-base font-semibold hover:text-info"
                >
                  <TeamCrest
                    name={s.name}
                    seed={s.teamId}
                    logoUrl={s.logoUrl}
                    size={24}
                    className="rounded-md"
                  />
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {s.name}
                  </span>
                </Link>
                {s.form.length > 0 ? <FormStrip form={s.form} /> : null}
              </div>
              <ul className="space-y-1">
                {s.roster.map((m) => {
                  const reg = regByUser.get(m.userId);
                  const rsvp = rsvpByUser.get(m.userId);
                  const replaced = s.replacedIds.has(m.userId);
                  return (
                    <li
                      key={m.id}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm",
                        replaced && "opacity-50",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Avatar
                          name={m.user.name}
                          src={m.user.avatar}
                          size={22}
                        />
                        <PlayerLink userId={m.userId} className="truncate">
                          {m.user.name}
                        </PlayerLink>
                        {m.isCaptain ? <Badge tone="accent">C</Badge> : null}
                        <RankBadge rankTier={m.user.rankTier} />
                        <RoleBadges roles={reg?.roles ?? ""} />
                      </span>
                      {replaced || canSeeNamedAvailability ? (
                        <span className="shrink-0 text-xs">
                          {replaced ? (
                            <span className="text-muted">standin covers</span>
                          ) : rsvp === "IN" ? (
                            <span className="text-success">✓ in</span>
                          ) : rsvp === "OUT" ? (
                            <span className="text-danger">✗ out</span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
                {s.subs.map((sub) => {
                  // Standins RSVP like everyone else — captains need to see
                  // whether the cover actually confirmed for match night.
                  const subRsvp = rsvpByUser.get(sub.standin.id);
                  return (
                    <li
                      key={sub.id}
                      className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="text-xs">🔁</span>
                        <PlayerLink
                          userId={sub.standin.id}
                          className="truncate"
                        >
                          {sub.standin.name}
                        </PlayerLink>
                        <span className="truncate text-xs text-muted">
                          {sub.replaced
                            ? `in for ${sub.replaced.name}`
                            : "filling an open seat"}
                        </span>
                      </span>
                      {canSeeNamedAvailability ? (
                        <span className="shrink-0 text-xs">
                          {subRsvp === "IN" ? (
                            <span className="text-success">✓ in</span>
                          ) : subRsvp === "OUT" ? (
                            <span className="text-danger">✗ out</span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </CardBody>
      </Card>

      <ScoutingReport
        sides={sides.map((s) => ({
          teamId: s.teamId,
          name: s.name,
          logoUrl: s.logoUrl,
          roster: s.roster.map((m) => ({
            userId: m.userId,
            name: m.user.name,
            roles: regByUser.get(m.userId)?.roles ?? "",
          })),
        }))}
      />
    </div>
  );
}

/**
 * "Tonight's stakes": what this match means for the playoff race, from the
 * exact scenario engine. Renders only when the night actually decides
 * something (win-and-in / lose-and-out / magic number 1) or a side's fate is
 * already sealed — early-season "everyone's in the hunt" stays silent.
 */
async function StakesBanner({
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
  };
  // Passed down from MatchPreview, which already loaded the season's matches.
  seasonMatches: (StakesMatchRow & {
    homeScore: number;
    awayScore: number;
    winnerTeamId: string | null;
  })[];
}) {
  if (match.phase !== "REGULAR") return null;
  const season = await prisma.season.findUnique({
    where: { id: match.seasonId },
    select: { status: true },
  });
  if (season?.status !== "REGULAR_SEASON") return null;

  const teams = await prisma.team.findMany({
    where: { seasonId: match.seasonId },
    select: { id: true, withdrawn: true },
  });
  const playoffField = projectPlayoffField(teams, seasonMatches);
  const report = seasonScenarioReport(
    playoffField.eligibleStandings,
    seasonMatches,
    playoffField.eligibleTeamIds.length,
  );
  if (!report) return null;

  const stakes = matchStakes(
    match.id,
    match.homeTeamId,
    match.awayTeamId,
    report,
  );
  const headline = stakesHeadline(stakes);
  const decided = stakes.some(
    (s) => report.teams.get(s.teamId)?.status != null,
  );
  if (!headline && !decided) return null;

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
        subtitle={headline ?? "The playoff picture is taking shape"}
      />
      <CardBody className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {stakes.map((s) => {
          const status = report.teams.get(s.teamId)?.status ?? null;
          return (
            <div
              key={s.teamId}
              className={cn(
                "flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-sm",
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
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {nameOf.get(s.teamId) ?? "?"}
                </span>
                <span className="block text-xs text-muted">{s.label}</span>
              </span>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}

/**
 * The pre-match dossier: each roster's comfort heroes, the heroes to ban
 * (best win rate at a meaningful sample), and how fast their games run —
 * computed from every box score the league has ever stored, both teams
 * visible to everyone (it's all public data).
 */
async function ScoutingReport({
  sides,
}: {
  sides: {
    teamId: string;
    name: string;
    logoUrl: string | null;
    roster: { userId: string; name: string; roles: string }[];
  }[];
}) {
  // Uncached on purpose — see fetchAllGamesForScouting in cached-queries.ts:
  // the unstable_cache wrapper hangs inside this nested Suspense boundary.
  const allGames = await fetchAllGamesForScouting();
  const scoutGames: ScoutGame[] = allGames.map((g) => ({
    radiantWin: g.radiantWin,
    durationSecs: g.durationSecs,
    startTime: g.startTime,
    lines: trustedGamePlayers(decodeGamePlayers(g.players)).map((p) => ({
      userId: p.userId,
      heroId: p.heroId,
      isRadiant: p.isRadiant,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
    })),
  }));

  const dossiers = sides.map((side) => {
    const ids = side.roster.map((r) => r.userId);
    const board = threatBoard(ids, scoutGames);
    const pools = side.roster.map((r) => ({
      ...r,
      pool: playerHeroPool(r.userId, scoutGames),
    }));
    return {
      ...side,
      board,
      pools,
      pace: paceProfile(ids, scoutGames),
      coverage: roleCoverage(side.roster),
      empty: dossierEmpty(
        pools.map((p) => p.pool),
        board,
      ),
    };
  });

  return (
    <Card id="match-scouting" className="scroll-mt-40 overflow-hidden">
      <CardHeader
        title="Scouting report"
        headingLevel={2}
        subtitle="All recorded league games"
      />
      <CardBody className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {dossiers.map((d) => (
          <div
            key={d.teamId}
            className="min-w-0 rounded-lg border border-line p-3"
          >
            <div className="mb-2.5 flex min-w-0 items-center gap-2">
              <TeamCrest
                name={d.name}
                seed={d.teamId}
                logoUrl={d.logoUrl}
                size={22}
                className="rounded-md"
              />
              <span className="min-w-0 font-display text-base font-semibold [overflow-wrap:anywhere]">
                {d.name}
              </span>
            </div>
            {d.empty ? (
              <p className="py-4 text-center text-sm text-muted">
                No league history yet — they&apos;re a mystery.
              </p>
            ) : (
              <div className="space-y-3">
                <ThreatList board={d.board} />
                <ComfortPicks pools={d.pools} />
                <PaceLine pace={d.pace} coverage={d.coverage} />
              </div>
            )}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

function ThreatList({ board }: { board: ThreatBoard }) {
  // Only heroes they actually WIN on earn "ban board" framing — a 0-2 hero is
  // not a threat. Without any winning hero at the floor, fall back to plain
  // most-picked framing.
  const threats = board.rows.filter((r) => r.winRate >= 50);
  const ranked = threats.length > 0;
  const rows = (ranked ? threats : board.contested).slice(0, 5);
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">
        {ranked ? `Ban board (${board.minPicks}+ picks)` : "Most picked"}
      </div>
      <ul className="space-y-1">
        {rows.map((r) => {
          const hero = heroById(r.heroId);
          return (
            <li key={r.heroId} className="flex items-center gap-2 text-sm">
              {hero ? (
                <HeroIcon hero={hero} size={22} />
              ) : (
                <span className="h-[22px] w-[22px] shrink-0 rounded border border-line/70 bg-surface-2" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {hero?.name ?? `Hero ${r.heroId}`}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted">
                {r.wins}–{r.picks - r.wins}
                <span
                  className={cn(
                    "ml-2 font-medium",
                    r.winRate >= 60
                      ? "text-success"
                      : r.winRate < 40
                        ? "text-danger"
                        : "text-fg/80",
                  )}
                >
                  {r.winRate}%
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ComfortPicks({
  pools,
}: {
  pools: { userId: string; name: string; pool: HeroPoolRow[] }[];
}) {
  const withPool = pools.filter((p) => p.pool.length > 0);
  if (withPool.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">
        Comfort picks
      </div>
      <ul className="space-y-1">
        {withPool.map((p) => (
          <li key={p.userId} className="flex items-center gap-2 text-sm">
            <PlayerLink
              userId={p.userId}
              className="w-28 shrink-0 truncate text-xs"
            >
              {p.name}
            </PlayerLink>
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {p.pool.slice(0, 3).map((h) => {
                const hero = heroById(h.heroId);
                const name = hero?.name ?? `Hero ${h.heroId}`;
                return (
                  <span
                    key={h.heroId}
                    role="img"
                    aria-label={`${name}: ${h.games} games, ${h.winRate}% wins`}
                    title={`${name} — ${h.wins}–${h.games - h.wins} (${h.winRate}%)`}
                    className="inline-flex items-center gap-1 rounded border border-line bg-surface-2/50 px-1 py-px text-[11px]"
                  >
                    {hero ? <HeroIcon hero={hero} size={16} /> : null}
                    <span aria-hidden className="tabular-nums text-muted">
                      ×{h.games}
                    </span>
                  </span>
                );
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PaceLine({
  pace,
  coverage,
}: {
  pace: PaceProfile;
  coverage: RoleCount[];
}) {
  const gaps = coverage.filter((c) => c.count === 0);
  const bits: string[] = [];
  if (pace.winAvgMins != null) bits.push(`wins avg ${pace.winAvgMins}m`);
  if (pace.lossAvgMins != null) bits.push(`losses avg ${pace.lossAvgMins}m`);
  if (bits.length === 0 && gaps.length === 0) return null;
  return (
    <div className="space-y-1 border-t border-line/70 pt-2 text-xs text-muted">
      {bits.length > 0 ? (
        <p>
          Pace over {pace.games} game{pace.games === 1 ? "" : "s"}:{" "}
          {bits.join(" · ")}
        </p>
      ) : null}
      {gaps.length > 0 && gaps.length < 5 ? (
        <p>
          No declared{" "}
          {gaps.map((g) => `${g.label.toLowerCase()} (${g.key})`).join(", ")} —
          somebody&apos;s flexing.
        </p>
      ) : null}
    </div>
  );
}

function TeamSide({
  name,
  teamId,
  logoUrl,
  win,
}: {
  name: string;
  teamId: string;
  logoUrl: string | null;
  win: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-3 self-stretch text-center">
      <div
        className={cn(
          "rounded-2xl border p-2 shadow-lg shadow-black/15",
          win ? "border-accent/40 bg-accent/5" : "border-line/60 bg-surface/60",
        )}
      >
        <TeamCrest
          name={name}
          seed={teamId}
          logoUrl={logoUrl}
          size={64}
          imageFit="cover"
          className="rounded-xl"
        />
      </div>
      <Link
        href={`/teams/${teamId}`}
        className="min-h-11 max-w-full content-center font-display text-base font-semibold leading-tight text-fg [overflow-wrap:anywhere] hover:text-info sm:text-2xl"
      >
        {name}
      </Link>
    </div>
  );
}

// The recorded team net-worth split from this game's box score, with an
// explicit gold lead. These totals are not a live net-worth timeline.
function NetWorthAdvantage({
  radiantName,
  direName,
  radiantNet,
  direNet,
}: {
  radiantName: string;
  direName: string;
  radiantNet: number;
  direNet: number;
}) {
  const total = radiantNet + direNet;
  if (total <= 0) return null;
  const radPct = Math.round((radiantNet / total) * 100);
  const lead = radiantNet - direNet;
  const leaderName = lead > 0 ? radiantName : direName;
  return (
    <div className="min-w-0 rounded-xl border border-line bg-bg/35 p-4 md:col-span-2">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-muted">Recorded net worth</span>
        <span className="min-w-0 text-fg [overflow-wrap:anywhere]">
          {lead === 0 ? (
            "Even"
          ) : (
            <>
              {leaderName}{" "}
              <strong className="font-mono text-accent">
                +{formatNetWorth(Math.abs(lead))}
              </strong>
            </>
          )}
        </span>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-4">
        <div className="flex min-w-0 flex-col">
          <p className="text-xs text-emerald-300 [overflow-wrap:anywhere]">
            {radiantName}
          </p>
          <p className="mt-auto pt-1 font-display text-2xl font-semibold tabular-nums">
            {formatNetWorth(radiantNet)}
          </p>
        </div>
        <div className="flex min-w-0 flex-col text-right">
          <p className="text-xs text-rose-300 [overflow-wrap:anywhere]">
            {direName}
          </p>
          <p className="mt-auto pt-1 font-display text-2xl font-semibold tabular-nums">
            {formatNetWorth(direNet)}
          </p>
        </div>
      </div>
      <div
        role="img"
        aria-label={`${radiantName}: ${radiantNet.toLocaleString()} gold. ${direName}: ${direNet.toLocaleString()} gold.`}
        className="relative flex h-3 w-full overflow-hidden rounded-full bg-surface-2"
      >
        <div className="bg-emerald-400/80" style={{ width: `${radPct}%` }} />
        <div className="flex-1 bg-rose-400/80" />
        <span
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-px bg-bg/70"
        />
      </div>
      <div className="mt-2 flex justify-between text-[10px] uppercase tracking-wider text-muted">
        <span>Radiant</span>
        <span>Dire</span>
      </div>
    </div>
  );
}

function SidePlayers({
  label,
  win,
  players,
  userName,
  userAvatar,
  maxNet,
  mvpId,
}: {
  label: string;
  win: boolean;
  players: PlayerStat[];
  userName: Map<string, string>;
  userAvatar: Map<string, string | null>;
  maxNet: number;
  mvpId?: string | null;
}) {
  const totalNet = players.reduce((s, p) => s + (p.netWorth ?? 0), 0);
  const hasNet = players.some((p) => p.netWorth != null);
  const hasGpm = players.some((p) => p.gpm != null);
  const hasLh = players.some((p) => p.lastHits != null);
  // Order by farm so the net-worth bars descend, like Dota's post-game screen.
  const ordered = [...players].sort(
    (a, b) => (b.netWorth ?? 0) - (a.netWorth ?? 0) || b.kills - a.kills,
  );
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border p-3",
        win ? "border-success/40 bg-success/5" : "border-line",
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 font-display text-base font-semibold [overflow-wrap:anywhere]">
            {label}
          </span>
          {win ? (
            <Badge tone="success" className="shrink-0">
              Win
            </Badge>
          ) : (
            <Badge className="shrink-0">Loss</Badge>
          )}
        </span>
        {hasNet ? (
          <span className="shrink-0 text-xs text-muted">
            Net worth{" "}
            <span className="font-mono text-accent">
              {formatNetWorth(totalNet)}
            </span>
          </span>
        ) : null}
      </div>
      <ul className="space-y-0.5">
        {ordered.map((p, idx) => {
          const displayName = p.userId
            ? (userName.get(p.userId) ?? p.personaname ?? "Unknown")
            : (p.personaname ?? "Unknown");
          const hero = heroById(p.heroId);
          const heroName = hero?.name ?? `Hero ${p.heroId}`;
          const nwPct =
            p.netWorth != null ? Math.round((p.netWorth / maxNet) * 100) : 0;
          return (
            <li
              key={idx}
              className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-2/50"
            >
              <div className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2">
                {hero ? (
                  <HeroIcon hero={hero} size={30} />
                ) : (
                  <span className="text-xs text-muted">#{p.heroId}</span>
                )}
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                    {p.userId ? (
                      <span className="hidden sm:inline-flex">
                        <Avatar
                          name={displayName}
                          src={userAvatar.get(p.userId) ?? null}
                          size={18}
                        />
                      </span>
                    ) : null}
                    {p.userId ? (
                      <PlayerLink
                        userId={p.userId}
                        className="min-w-0 text-sm [overflow-wrap:anywhere]"
                      >
                        {displayName}
                      </PlayerLink>
                    ) : (
                      <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                        {displayName}
                      </span>
                    )}
                    {p.userId && p.userId === mvpId ? (
                      <Badge tone="accent" title="Best line of the game">
                        MVP
                      </Badge>
                    ) : null}
                  </div>
                  <div className="text-[11px] text-muted [overflow-wrap:anywhere]">
                    {heroName}
                  </div>
                </div>
                <KDA
                  kills={p.kills}
                  deaths={p.deaths}
                  assists={p.assists}
                  className="shrink-0 text-right text-xs"
                />
              </div>
              {hasNet || hasGpm || hasLh ? (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-10 text-[11px] tabular-nums text-muted">
                  {hasGpm ? (
                    <span title="Gold per minute">{p.gpm ?? "—"} gpm</span>
                  ) : null}
                  {hasLh ? (
                    <span title="Last hits">{p.lastHits ?? "—"} lh</span>
                  ) : null}
                  {hasNet ? (
                    <span
                      className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2"
                      title="Net worth at game end"
                    >
                      <span
                        aria-hidden
                        className="h-1.5 w-full max-w-24 overflow-hidden rounded-full bg-surface-2"
                      >
                        <span
                          className="block h-full rounded-full bg-accent/80"
                          style={{ width: `${nwPct}%` }}
                        />
                      </span>
                      <span className="shrink-0 font-mono text-accent">
                        {formatNetWorth(p.netWorth)}
                      </span>
                    </span>
                  ) : null}
                </div>
              ) : null}
              <ReportCardStrip line={p} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const GRADE_CHIP: Record<ReturnType<typeof gradeTone>, string> = {
  success: "border-success/40 text-success",
  accent: "border-accent/40 text-accent",
  default: "border-line text-fg/80",
  muted: "border-line text-muted",
};

/**
 * The hero report card: per-metric worldwide percentile grades (from
 * OpenDota's benchmarks) as a compact chip strip under a player's line.
 * Absent entirely for games imported before benchmarks were stored.
 */
function ReportCardStrip({ line }: { line: PlayerStat }) {
  const rows = gameReportCard(line);
  if (rows.length === 0) return null;
  const avg = cardAverage(rows);
  const overall: Grade | null = avg == null ? null : gradeFor(avg);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-[42px]">
      {overall ? (
        <span
          role="img"
          aria-label={`Overall report-card grade ${overall} — ${percentLabel(avg!)} vs the world on this hero`}
          title={`vs the world on this hero: ${percentLabel(avg!)}`}
          className={cn(
            "inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide",
            GRADE_CHIP[gradeTone(overall)],
          )}
        >
          <span aria-hidden>Report {overall}</span>
        </span>
      ) : null}
      {rows.map((r) => (
        <span
          key={r.key}
          role="img"
          aria-label={`${r.label}: grade ${r.grade}, ${percentLabel(r.pct)}`}
          title={`${r.label} — ${percentLabel(r.pct)}`}
          className={cn(
            "inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] tabular-nums",
            GRADE_CHIP[gradeTone(r.grade)],
          )}
        >
          <span aria-hidden>
            {r.short} <b>{r.grade}</b>
          </span>
        </span>
      ))}
    </div>
  );
}

// Captain-to-captain rescheduling: propose a time, the other captain accepts
// (retimes the match) or declines. Only the two captains ever see this card.
/**
 * Captain-only wrapper so the reschedule card renders on every unplayed OR
 * live match — not just the pre-import preview (a proposal made before game 1
 * must stay answerable after the game is imported).
 */
// The two captains can pull their finished game straight from OpenDota —
// results (and standings, bracket, fantasy, pick'em, honors downstream) stop
// bottlenecking on an admin. Guards live in match-report-service.ts.
async function ReportResultSection({
  match,
  renderedAt,
}: {
  match: {
    id: string;
    seasonId: string;
    phase: string;
    status: string;
    bestOf: number;
    scheduledAt: Date | null;
    homeScore: number;
    awayScore: number;
    season: {
      isActive: boolean;
      status: string;
      dotaLeagueId: string | null;
    };
    homeTeam: { name: string; captainId: string };
    awayTeam: { name: string; captainId: string };
  };
  renderedAt: number;
}) {
  const viewer = await getSessionUser();
  const isCaptain =
    !!viewer &&
    (match.homeTeam.captainId === viewer.id ||
      match.awayTeam.captainId === viewer.id);
  if (!isCaptain) {
    if (
      !lobbyBotKindEnabled("season") ||
      !viewer ||
      !match.season.isActive ||
      match.status === "COMPLETED" ||
      !matchResultsOpen(match.season.status, match.phase)
    ) return null;
    const participant = viewer.role === "ADMIN" || await prisma.match.count({
      where: {
        id: match.id,
        OR: [
          { homeTeam: { members: { some: { userId: viewer.id } } } },
          { awayTeam: { members: { some: { userId: viewer.id } } } },
          { standins: { some: { standinUserId: viewer.id } } },
        ],
      },
    });
    return participant ? (
      <DotaLobbyControls
        key={`${match.id}:${match.homeScore}:${match.awayScore}`}
        kind="season"
        id={match.id}
      />
    ) : null;
  }
  if (!match.season.isActive) return null;
  if (match.status === "COMPLETED") {
    return (
      <Card>
        <CardHeader
          title="Need a result correction?"
          subtitle="Captains cannot rewrite a final series. Send an admin this match page and the incorrect Dota match ID; they can remove or re-import the game without hiding the audit trail."
        />
      </Card>
    );
  }
  if (!matchResultsOpen(match.season.status, match.phase)) {
    return (
      <Card>
        <CardHeader
          title="Result reporting locked"
          subtitle={
            match.phase === "REGULAR"
              ? "Regular-season games can be reported only while the league is in the Regular season phase. Ask an admin to correct the phase or fixture."
              : "Playoff games can be reported only while the league is in the Playoffs phase. Ask an admin to reopen the postseason before reporting."
          }
        />
      </Card>
    );
  }
  const afterScheduledTime =
    match.scheduledAt != null && match.scheduledAt.getTime() <= renderedAt;
  const gamesRecorded = match.homeScore + match.awayScore;
  const leagueCheckMinutes = Math.round(AUTO_SYNC.LEAGUE_INTERVAL_SECONDS / 60);
  const leagueTitle =
    match.status === "LIVE"
      ? `Game ${gamesRecorded} recorded — series ${match.homeScore}–${match.awayScore}`
      : afterScheduledTime
        ? "Waiting for league result"
        : "Result recording";
  const leagueSubtitle =
    match.status === "LIVE"
      ? `The series stays open for the next lobby. The league feed keeps checking about every ${leagueCheckMinutes} minutes, and player-account recovery is already available if the next lobby uses the wrong ticket.`
      : afterScheduledTime
        ? `League-feed checks begin ${AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF} minutes after the scheduled match time and repeat about every ${leagueCheckMinutes} minutes. If the whole series is still missing ${Math.round(AUTO_SYNC.LEAGUE_FALLBACK_MINUTES_AFTER_KICKOFF / 60)} hours after the scheduled match time, player-account recovery starts automatically.`
        : `League-feed checks begin ${AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF} minutes after the scheduled match time and repeat about every ${leagueCheckMinutes} minutes. Player-account recovery protects the result if an old or incorrect ticket is used.`;
  return (
    <div className="space-y-6">
      {lobbyBotKindEnabled("season") ? (
        <DotaLobbyControls
          key={`${match.id}:${match.homeScore}:${match.awayScore}`}
          kind="season"
          id={match.id}
        />
      ) : null}
      {match.season.dotaLeagueId ? (
        <LeagueLobbyChecklist
          leagueId={match.season.dotaLeagueId}
          bestOf={match.bestOf}
          homeTeamName={match.homeTeam.name}
        />
      ) : null}
      <Card>
        <CardHeader
          title={match.season.dotaLeagueId ? leagueTitle : "Report your result"}
          subtitle={
            match.season.dotaLeagueId
              ? leagueSubtitle
              : "Played it? Pull the finished game from OpenDota — no admin needed. Auto-fetch scans both rosters; a pasted ID must fall near this fixture's scheduled match time so an old scrim or rematch cannot claim the result."
          }
        />
        <CardBody className="space-y-3">
          {match.season.dotaLeagueId ? (
            <p className="text-xs text-muted">
              Need recovery now? Auto-fetch checks the linked player accounts,
              or add either lobby&apos;s Dota match id directly.
            </p>
          ) : null}
          <MatchImportControls
            matchId={match.id}
            importAction={captainImportGame}
            detectAction={captainAutoDetect}
          />
        </CardBody>
      </Card>
    </div>
  );
}

// Captain-facing standin management (guards in standin-service): current
// cover for both sides, remove for your own team, and an assign form scoped
// to your roster + the season's unrostered ACTIVE signups.
async function StandinSection({
  match,
}: {
  match: {
    id: string;
    seasonId: string;
    status: string;
    homeTeamId: string;
    awayTeamId: string;
    homeTeam: { name: string; captainId: string };
    awayTeam: { name: string; captainId: string };
  };
}) {
  const viewer = await getSessionUser();
  if (!viewer) return null;
  const isAdmin = viewer.role === "ADMIN";
  const myTeamId =
    match.homeTeam.captainId === viewer.id
      ? match.homeTeamId
      : match.awayTeam.captainId === viewer.id
        ? match.awayTeamId
        : null;
  if (!myTeamId && !isAdmin) return null;
  // Admin passing by uses their panel; this card is the captain's tool. An
  // admin who IS a captain still gets their own team's view.
  if (!myTeamId) return null;

  // The service refuses archived-season matches (its guards key on the
  // active season) — don't render a form that can only error.
  const season = await prisma.season.findUnique({
    where: { id: match.seasonId },
    select: { isActive: true, teamSize: true, status: true },
  });
  if (!season?.isActive) return null;
  // Mirror the service's PHASE GATE (render/guard pairing, the roster-moves
  // rule): assignment is open in REGULAR_SEASON/PLAYOFFS, and in DRAFT only
  // once the auction is COMPLETE (pool-dry short rosters arranging week-1
  // cover). Existing assignments still render — removal is legal cleanup in
  // every phase — but a form that can only error never should.
  const draftRow =
    season.status === "DRAFT"
      ? await prisma.draft.findUnique({
          where: { seasonId: match.seasonId },
          select: { status: true },
        })
      : null;
  const assignOpen = standinAssignmentOpen(
    season.status,
    draftRow?.status,
    match.status,
  );

  const [assignments, roster, registrations, rostered, outRows] =
    await Promise.all([
      prisma.standinAssignment.findMany({
        where: { matchId: match.id },
        include: {
          standin: { select: { id: true, name: true } },
          replaced: { select: { id: true, name: true } },
        },
      }),
      prisma.teamMember.findMany({
        where: { seasonId: match.seasonId, teamId: myTeamId },
        include: { user: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.registration.findMany({
        where: { seasonId: match.seasonId, status: "ACTIVE" },
        // roles + Discord fields feed the picker's option text: a captain
        // choosing cover at 9pm needs "who fits the seat AND will answer a
        // ping" without opening five profiles. Contact-adjacent, but this
        // card only renders for the two captains (and admins), so the
        // signed-in gate contact info requires is already satisfied.
        include: {
          user: {
            select: {
              id: true,
              name: true,
              discordId: true,
              discordName: true,
            },
          },
        },
        orderBy: { mmr: "desc" },
      }),
      prisma.teamMember.findMany({
        where: { seasonId: match.seasonId },
        select: { userId: true },
      }),
      // OUT RSVPs on this match — the captain-facing uncovered-OUT alert.
      // The admin panel has always had this list; the captain, who owns the
      // fix (the assign form right below), had to notice a small ✗ in the
      // preview grid instead.
      prisma.matchAvailability.findMany({
        where: { matchId: match.id, status: "OUT" },
        select: { userId: true },
      }),
    ]);
  const rosteredIds = new Set(rostered.map((m) => m.userId));
  const pool = registrations.filter((r) => !rosteredIds.has(r.userId));
  // One seat, one standin — players already covered leave the Covers list.
  const coveredIds = new Set(
    assignments.map((a) => a.replaced?.id).filter(Boolean),
  );
  const coverable = roster.filter((m) => !coveredIds.has(m.userId));
  // OPEN SEATS on this captain's own roster. A team that lost a player
  // mid-season is short, and a standin filling that seat replaces nobody — the
  // case that previously had no UI anywhere, so a 4-of-5 side could not be
  // covered at all. Already-filled open seats are subtracted.
  const openSeatsFilled = assignments.filter(
    (a) => a.teamId === myTeamId && a.replaced == null,
  ).length;
  const openSeats = Math.max(
    0,
    season.teamSize - roster.length - openSeatsFilled,
  );
  const teamNameOf = (teamId: string) =>
    teamId === match.homeTeamId ? match.homeTeam.name : match.awayTeam.name;
  // OUT-and-uncovered on MY roster: the admin card has always alerted on
  // this; the captain — who owns the assign form below — saw only the small
  // ✗ in the preview grid.
  const outIds = new Set(outRows.map((r) => r.userId));
  const uncoveredOut = roster.filter(
    (m) => outIds.has(m.userId) && !coveredIds.has(m.userId),
  );

  // A phase where assignment is closed and nothing is booked has nothing to
  // say — don't render an empty card with a disabled story.
  if (!assignOpen && assignments.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Standins"
        subtitle="Someone can't make it? Line up cover from the standin pool yourself — the assignment announces to Discord."
      />
      <CardBody className="space-y-3">
        {uncoveredOut.length > 0 ? (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            ✗ Out and uncovered:{" "}
            <strong>{uncoveredOut.map((m) => m.user.name).join(", ")}</strong>
            {assignOpen ? " — line up cover below." : "."}
          </p>
        ) : null}
        {assignments.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {assignments.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-surface-2/40 px-3 py-1.5"
              >
                <span className="min-w-0">
                  <strong>{a.standin.name}</strong>{" "}
                  {/* A null `replaced` is an EMPTY-SEAT cover on a short
                      roster, not missing data — it rendered as "in for ?". */}
                  {a.replaced ? (
                    <>
                      <span className="text-muted">in for</span>{" "}
                      {a.replaced.name}{" "}
                    </>
                  ) : (
                    <span className="text-muted">filling an open seat </span>
                  )}
                  <span className="text-muted">· {teamNameOf(a.teamId)}</span>
                </span>
                {a.teamId === myTeamId ? (
                  <ActionForm
                    action={captainRemoveStandin}
                    hidden={{ assignmentId: a.id }}
                    className="ml-auto"
                  >
                    <SubmitButton
                      variant="ghost"
                      size="sm"
                      className="text-danger"
                      confirm={`Remove ${a.standin.name} as standin? Discord is told to stand down.`}
                    >
                      Remove
                    </SubmitButton>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No standins assigned yet.</p>
        )}
        {!assignOpen ? (
          <p className="text-sm text-muted">
            {season.status === "COMPLETE"
              ? "The season is over — standins no longer apply."
              : "Standins can be assigned once the draft has run and rosters are settled."}
          </p>
        ) : pool.length === 0 ? (
          <p className="text-sm text-muted">
            Nobody is in the standin pool right now — ask around the Discord;
            late joiners can still sign up as standins.
          </p>
        ) : (
          <ActionForm
            action={captainAssignStandin}
            hidden={{ matchId: match.id }}
            className="flex flex-wrap items-end gap-2"
          >
            <select
              name="standinUserId"
              required
              aria-label="Standin to bring in"
              className="h-10 min-w-0 max-w-full rounded-lg border border-line bg-surface-2/50 px-2 text-sm"
              defaultValue=""
            >
              <option value="" disabled>
                Standin…
              </option>
              {/* Option text carries what the 9pm decision needs: seat fit
                  (roles) and whether a ping can reach them at all. "no
                  Discord" = neither a verified link nor a typed handle. */}
              {pool.map((r) => {
                const roles = roleShort(r.roles).join("/");
                const unreachable = !r.user.discordId && !r.user.discordName;
                return (
                  <option key={r.userId} value={r.userId}>
                    {r.user.name} ({r.mmr} MMR
                    {roles ? ` · ${roles}` : ""}
                    {unreachable ? " · no Discord" : ""})
                  </option>
                );
              })}
            </select>
            <select
              name="replacingUserId"
              required
              aria-label="Player they cover"
              className="h-10 min-w-0 max-w-full rounded-lg border border-line bg-surface-2/50 px-2 text-sm"
              defaultValue=""
            >
              <option value="" disabled>
                Covers…
              </option>
              {openSeats > 0 ? (
                <option value={seatValue(myTeamId)}>
                  an empty roster seat ({openSeats} unfilled)
                </option>
              ) : null}
              {coverable.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.user.name}
                </option>
              ))}
            </select>
            <SubmitButton variant="secondary" size="sm">
              Assign standin
            </SubmitButton>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

async function RescheduleSection({
  match,
}: {
  match: {
    id: string;
    seasonId: string;
    status: string;
    scheduledAt: Date | null;
    homeTeam: { name: string; captainId: string };
    awayTeam: { name: string; captainId: string };
  };
}) {
  const [viewer, season, draft, pending] = await Promise.all([
    getSessionUser(),
    prisma.season.findUnique({
      where: { id: match.seasonId },
      select: { isActive: true, status: true },
    }),
    prisma.draft.findUnique({
      where: { seasonId: match.seasonId },
      select: { status: true },
    }),
    prisma.rescheduleRequest.findFirst({
      where: { matchId: match.id, status: "PENDING" },
      include: { proposedBy: { select: { name: true } } },
    }),
  ]);
  const isCaptain =
    !!viewer &&
    (match.homeTeam.captainId === viewer.id ||
      match.awayTeam.captainId === viewer.id);
  const canRetime =
    !!season?.isActive &&
    matchLogisticsOpen(season.status, draft?.status, match.status);

  if (isCaptain && canRetime) {
    return (
      <RescheduleCard match={match} viewerId={viewer!.id} pending={pending} />
    );
  }
  if (isCaptain && pending) {
    const mine = pending.proposedById === viewer!.id;
    return (
      <Card>
        <CardHeader
          title="Reschedule locked"
          subtitle="This match can no longer be moved. You can close the stranded proposal so it does not look actionable."
        />
        <CardBody className="flex flex-wrap items-center gap-3 text-sm">
          <span className="min-w-[14rem] flex-1 text-muted">
            {mine ? "You" : <strong>{pending.proposedBy.name}</strong>} proposed{" "}
            <strong className="text-fg">
              <LocalTime
                ts={pending.proposedTime.getTime()}
                variant="full"
                initial={formatMatchTime(pending.proposedTime, "full")}
              />
            </strong>
            .
          </span>
          <ActionForm
            action={mine ? cancelReschedule : respondReschedule}
            hidden={
              mine
                ? { requestId: pending.id }
                : { requestId: pending.id, response: "decline" }
            }
          >
            <SubmitButton variant="secondary" size="sm">
              {mine ? "Withdraw proposal" : "Decline proposal"}
            </SubmitButton>
          </ActionForm>
        </CardBody>
      </Card>
    );
  }
  // Everyone else gets a read-only heads-up that a time change is pending, so
  // spectators/scouts aren't blindsided by a moved match.
  if (!pending) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm text-muted">
      <span aria-hidden>⏳</span>
      <span>
        Reschedule proposed —{" "}
        <strong className="text-fg">
          <LocalTime
            ts={pending.proposedTime.getTime()}
            variant="full"
            initial={formatMatchTime(pending.proposedTime, "full")}
          />
        </strong>{" "}
        pending the captains&apos; agreement.
      </span>
    </div>
  );
}

async function RescheduleCard({
  match,
  viewerId,
  pending,
}: {
  match: {
    id: string;
    status: string;
    scheduledAt: Date | null;
    homeTeam: { name: string; captainId: string };
    awayTeam: { name: string; captainId: string };
  };
  viewerId: string;
  pending: {
    id: string;
    proposedById: string;
    proposedTime: Date;
    proposedBy: { name: string };
  } | null;
}) {
  if (match.status === "COMPLETED") return null;
  const checkinCount = pending
    ? await prisma.matchAvailability.count({ where: { matchId: match.id } })
    : 0;
  const fmt = (d: Date) =>
    d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const mine = pending?.proposedById === viewerId;

  return (
    <Card>
      <CardHeader
        title="Reschedule"
        subtitle={
          match.scheduledAt
            ? "Agree a new time with the other captain. A real time change resets every player's check-in."
            : "No time set yet — propose one to the other captain."
        }
      />
      <CardBody className="space-y-3 text-sm">
        {pending ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-[14rem] flex-1">
              {mine ? "You" : <strong>{pending.proposedBy.name}</strong>}{" "}
              proposed{" "}
              <strong>
                <LocalTime
                  ts={pending.proposedTime.getTime()}
                  variant="full"
                  initial={fmt(pending.proposedTime)}
                />
              </strong>
              {mine ? " — waiting on the other captain." : "."}
              {!mine && checkinCount > 0 ? (
                <span className="mt-1 block text-xs text-accent">
                  Accepting will clear {checkinCount} check-in
                  {checkinCount === 1 ? "" : "s"}; every player must answer
                  again for the new night.
                </span>
              ) : null}
            </span>
            {mine ? (
              <ActionForm
                action={cancelReschedule}
                hidden={{ requestId: pending.id }}
              >
                <SubmitButton variant="secondary" size="sm">
                  Withdraw
                </SubmitButton>
              </ActionForm>
            ) : (
              <div className="flex shrink-0 gap-2">
                <ActionForm
                  action={respondReschedule}
                  hidden={{ requestId: pending.id, response: "accept" }}
                >
                  <SubmitButton
                    variant="primary"
                    size="sm"
                    confirm={`Accept this new kickoff? ${checkinCount} check-in${checkinCount === 1 ? "" : "s"} will be cleared and every player must answer again.`}
                  >
                    ✓ Accept time
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={respondReschedule}
                  hidden={{ requestId: pending.id, response: "decline" }}
                >
                  <SubmitButton variant="secondary" size="sm">
                    ✗ Decline
                  </SubmitButton>
                </ActionForm>
              </div>
            )}
          </div>
        ) : (
          <ActionForm
            action={proposeReschedule}
            hidden={{ matchId: match.id }}
            className="flex flex-wrap items-center gap-2"
          >
            <label htmlFor={`proposed-time-${match.id}`} className="sr-only">
              Proposed new kickoff
            </label>
            <span>
              <LocalDatetimeField
                id={`proposed-time-${match.id}`}
                name="proposedTime"
                tsName="proposedTs"
                required
                className="h-9 rounded-md border border-line bg-surface-2/50 px-2 text-sm text-fg"
              />
            </span>
            <SubmitButton variant="secondary" size="sm">
              Propose new time
            </SubmitButton>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
