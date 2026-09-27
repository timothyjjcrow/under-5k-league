import { AddToCalendar } from "@/components/add-to-calendar";
import { resolveSiteUrl } from "@/lib/site-url";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { PlayoffOutlook } from "@/components/playoff-outlook";
import Link from "next/link";
import { ContextBackLink } from "@/components/context-back-link";
import { SectionNav } from "@/components/section-nav";
import { ProfileMatchSpotlight } from "@/components/profile-match-spotlight";
import { profileMatch, profileMatchState } from "@/lib/profile-match";
import { formatMatchTime } from "@/lib/match-time";
import { getSeasonGameScores } from "@/lib/cached-queries";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { DiscordTag } from "@/components/discord-tag";
import { shareMetadata } from "@/lib/share-metadata";
import { LocalTime } from "@/components/local-time";
import { Countdown } from "@/components/countdown";
import { DRAFT_PASSED_LABEL } from "@/lib/season-copy";
import { seasonScenarioReport } from "@/lib/stakes";
import { projectPlayoffField } from "@/lib/playoff-field";
import type { TeamScenario } from "@/lib/scenarios";
import {
  headToHead,
  recentForm,
  rematches,
  teamFixtureOrder,
} from "@/lib/team-matches";
import {
  matchRoundLabel,
  playoffTotalRounds,
  teamByeWeek,
} from "@/lib/schedule";
import { ByeWeekNote } from "@/components/bye-week-note";
import { roleCoverage } from "@/lib/pool-stats";
import {
  summarizePlayerGames,
  type PlayerGameLine,
  decodeGamePlayers,
  trustedGamePlayers,
} from "@/lib/player-stats";
import { heroById, heroPortrait, parseHeroList } from "@/lib/heroes";
import { cn } from "@/lib/utils";
import { draftBudgetsForDisplay } from "@/lib/draft-budgets";
import { draftSetupOpen } from "@/lib/draft-setup";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import { getTeamJersey } from "@/lib/team-jerseys";
import { TeamJerseyPreview } from "@/components/team-jersey-preview";
import { TeamIdentityForm } from "@/components/team-identity-form";
import { editTeamIdentity } from "@/app/actions/teams";
import { canEditTeamIdentity } from "@/lib/team-identity";
import { canViewLeagueContact } from "@/lib/visibility";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "@/lib/constants";
import { playoffStatuses } from "@/lib/playoff-status";
import { seedsFromFirstRound } from "@/lib/bracket-view";
import { PlayoffStatusLine } from "@/components/playoff-status-line";
import { SeriesRecord } from "@/components/series-record";
import { rosterOrder } from "@/lib/team-roster";
import { teamHueVar } from "@/lib/team-hues";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  FormStrip,
  HeroPool,
  PlayerLink,
  RankBadge,
  RoleBadges,
  Stat,
  TeamCrest,
  textLink,
} from "@/components/ui";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const team = await prisma.team.findUnique({
    where: { id },
    select: { name: true },
  });
  // Metadata resolves BEFORE the body streams — a notFound() here is the
  // only way an unknown id yields a real 404 status (the root loading.tsx
  // otherwise commits a 200 shell before the page's own notFound throws).
  if (!team) notFound();
  return shareMetadata(
    team.name,
    `${team.name} — roster, results, and stats in ${LEAGUE_CONFIG.name}.`,
  );
}

export default async function TeamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const team = await prisma.team.findUnique({
    where: { id },
    include: {
      season: {
        include: { draft: { select: { status: true } } },
      },
      captain: true,
      members: { include: { user: true }, orderBy: { price: "desc" } },
    },
  });
  if (!team) notFound();
  const jersey = team.season.isActive
    ? getTeamJersey(team.members.map((member) => member.user))
    : null;
  const viewer = await getSessionUser();
  // The captain (or an admin) edits the team's name and logo right here, all
  // season until it is complete; the service enforces the same rule on save.
  const canEditTeam = canEditTeamIdentity({
    viewer,
    captainId: team.captainId,
    seasonIsActive: team.season.isActive,
    seasonStatus: team.season.status,
  });

  const memberIds = team.members.map((m) => m.userId);
  const shouldProjectBudget =
    team.season.isActive &&
    draftSetupOpen(team.season.status, team.season.draft?.status);
  const [
    allTeams,
    allMatches,
    rosterRegs,
    seasonGames,
    captainRegs,
    viewerRegistration,
  ] = await Promise.all([
    prisma.team.findMany({ where: { seasonId: team.seasonId } }),
    prisma.match.findMany({ where: { seasonId: team.seasonId } }),
    memberIds.length
      ? prisma.registration.findMany({
          where: { seasonId: team.seasonId, userId: { in: memberIds } },
          select: {
            userId: true,
            roles: true,
            favoriteHeroes: true,
            mmr: true,
          },
        })
      : Promise.resolve([]),
    memberIds.length ? getSeasonGameScores(team.seasonId) : Promise.resolve([]),
    shouldProjectBudget
      ? prisma.registration.findMany({
          where: {
            seasonId: team.seasonId,
            status: REGISTRATION_STATUS.ACTIVE,
            type: REGISTRATION_TYPE.PLAYER,
          },
          select: { userId: true, mmr: true },
        })
      : Promise.resolve([]),
    viewer
      ? prisma.registration.findUnique({
          where: {
            seasonId_userId: { seasonId: team.seasonId, userId: viewer.id },
          },
          select: { status: true },
        })
      : null,
  ]);
  // This team's fixtures are a filter of the season's, so derive them here
  // rather than paying a second query. Same order the old query asked for:
  // week, then creation time (Array.prototype.sort is stable).
  const myMatches = allMatches
    .filter((m) => m.homeTeamId === id || m.awayTeamId === id)
    .sort(
      (a, b) =>
        a.week - b.week || a.createdAt.getTime() - b.createdAt.getTime(),
    );
  const viewerHasActiveRegistration =
    team.season.isActive &&
    viewerRegistration?.status === REGISTRATION_STATUS.ACTIVE;

  const displayBudgets = draftBudgetsForDisplay({
    seasonIsActive: team.season.isActive,
    seasonStatus: team.season.status,
    draftStatus: team.season.draft?.status,
    baseBudget: team.season.draftBudget,
    budgetMmrWeight: team.season.budgetMmrWeight,
    teamSize: team.season.teamSize,
    teams: allTeams,
    captainMmrs: captainRegs,
  });
  const displayBudget = displayBudgets.byTeam.get(team.id) ?? team.budget;
  const championPresentation = resolveChampionPresentation(
    team.season,
    allMatches,
  );

  // Aggregate every rostered player's game lines into the team's hero pool.
  const memberIdSet = new Set(memberIds);
  const teamLines: PlayerGameLine[] = [];
  for (const g of seasonGames) {
    for (const pl of trustedGamePlayers(decodeGamePlayers(g.players))) {
      if (pl.userId && memberIdSet.has(pl.userId)) {
        teamLines.push({
          isRadiant: pl.isRadiant,
          radiantWin: g.radiantWin,
          kills: pl.kills,
          deaths: pl.deaths,
          assists: pl.assists,
          heroId: pl.heroId,
          netWorth: pl.netWorth,
          gpm: pl.gpm,
        });
      }
    }
  }
  const teamHeroes = summarizePlayerGames(teamLines).topHeroes;

  const playoffField = projectPlayoffField(allTeams, allMatches);
  const playoffRounds = playoffTotalRounds(allMatches);
  const standings = playoffField.standings;
  const rank = standings.findIndex((s) => s.teamId === id) + 1;
  const row = standings.find((s) => s.teamId === id);
  const teamName = new Map(allTeams.map((t) => [t.id, t.name]));
  const teamLogoUrl = new Map(allTeams.map((t) => [t.id, t.logoUrl]));
  // "What we need": this team's playoff scenario, from the exact engine.
  const stakesReport =
    team.season.status === "REGULAR_SEASON"
      ? seasonScenarioReport(
          playoffField.eligibleStandings,
          allMatches,
          playoffField.eligibleTeamIds.length,
          playoffField,
        )
      : null;
  const myScenario = team.withdrawn
    ? null
    : (stakesReport?.teams.get(id) ?? null);

  const form = recentForm(id, myMatches);
  // Only opponents met more than once: a single meeting is already on the
  // Matches list, so the card would repeat it.
  const h2h = rematches(headToHead(id, myMatches)).sort(
    (a, b) => b.wins - a.wins || a.losses - b.losses,
  );
  const spent = team.members.reduce((sum, m) => sum + m.price, 0);
  const draftStatus = team.season.draft?.status;
  const auctionStarted =
    draftStatus != null && draftStatus !== DRAFT_STATUS.NOT_STARTED;
  // Signups, or a draft phase whose auction hasn't finished: fixtures come
  // after the draft.
  const draftAhead =
    team.season.isActive &&
    (team.season.status === SEASON_STATUS.SIGNUPS ||
      (team.season.status === SEASON_STATUS.DRAFT &&
        draftStatus !== DRAFT_STATUS.COMPLETE));
  // Before any result exists, record/points/rank are noise (and the "rank"
  // is just draft order) — show draft-shaped tiles instead.
  const played = allMatches.some((m) => m.status === "COMPLETED");
  const knownMmrs = rosterRegs.map((r) => r.mmr).filter((v) => v > 0);
  const avgMmr = knownMmrs.length
    ? Math.round(knownMmrs.reduce((s, v) => s + v, 0) / knownMmrs.length)
    : null;
  // Role coverage helps a captain decide whom to buy, so it shows only in
  // the draft phase before the auction completes. In signups it is all gaps
  // (only the captain is rostered); after the draft the team can't act on
  // it, and each player's roles stay on their roster row.
  const coverage = roleCoverage(rosterRegs);
  const showCoverage =
    team.season.isActive &&
    team.season.status === SEASON_STATUS.DRAFT &&
    draftStatus !== DRAFT_STATUS.COMPLETE &&
    coverage.some((r) => r.count > 0);
  // Which player prefers which roles → per-row badges in the roster card.
  const rolesByUser = new Map(rosterRegs.map((r) => [r.userId, r.roles]));
  // The season hue its crest wears (published by the root layout).
  const hue = teamHueVar(team.id);
  // The roster's most-commonly listed hero → a faint banner backdrop. Kept
  // subtle so the team's color identity (crest + glow) stays dominant.
  const heroCounts = new Map<number, number>();
  for (const r of rosterRegs) {
    for (const h of parseHeroList(r.favoriteHeroes).matched) {
      heroCounts.set(h.id, (heroCounts.get(h.id) ?? 0) + 1);
    }
  }
  let teamHeroId: number | null = null;
  let bestCount = 0;
  for (const [hid, count] of heroCounts) {
    if (count > bestCount) {
      bestCount = count;
      teamHeroId = hid;
    }
  }
  const teamHero = teamHeroId != null ? heroById(teamHeroId) : null;
  // One server snapshot keeps every fixture label consistent on the page.
  // eslint-disable-next-line react-hooks/purity -- async server component
  const nowMs = Date.now();
  // Playoffs (and the finished season): the bracket seed replaces the
  // regular-season rank badge, and a line says where the team stands.
  const postseason =
    team.season.status === SEASON_STATUS.PLAYOFFS ||
    team.season.status === SEASON_STATUS.COMPLETE;
  const playoffStatus = postseason
    ? (playoffStatuses(
        allTeams,
        allMatches,
        championPresentation.championTeamId,
        nowMs,
      ).get(id) ?? null)
    : null;
  const seed = postseason
    ? seedsFromFirstRound(
        allMatches.filter(
          (m) =>
            m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL,
        ),
      ).get(id)
    : undefined;
  const featuredMatch = profileMatch(
    myMatches,
    nowMs,
    team.season.isActive && team.season.status !== SEASON_STATUS.COMPLETE,
  );
  // Resting this week: say so before the spotlight shows a match a week away.
  const byeWeek =
    team.season.isActive &&
    !team.withdrawn &&
    (team.season.status === SEASON_STATUS.REGULAR_SEASON ||
      team.season.status === SEASON_STATUS.DRAFT)
      ? teamByeWeek(allMatches, id, nowMs)
      : null;
  const byeNext =
    byeWeek != null && featuredMatch && featuredMatch.status !== "COMPLETED"
      ? `${matchRoundLabel(featuredMatch, playoffRounds)} vs ${
          teamName.get(
            featuredMatch.homeTeamId === id
              ? featuredMatch.awayTeamId
              : featuredMatch.homeTeamId,
          ) ?? "?"
        }`
      : null;
  // The page leads with what's next: the live or next series (or, before
  // any result, the draft numbers), then the roster, then every fixture.
  const showOverview = !played || featuredMatch != null;
  const fixtureList = teamFixtureOrder(myMatches);
  // The same "Add to calendar" menu as Schedule, offering this team's feed
  // (or the whole league's), once the team has a kickoff time to add.
  const showCalendar =
    team.season.isActive &&
    (team.season.status === SEASON_STATUS.REGULAR_SEASON ||
      team.season.status === SEASON_STATUS.PLAYOFFS) &&
    myMatches.some((m) => m.scheduledAt);
  const sectionItems = [
    ...(showOverview ? [{ id: "team-overview", label: "Overview" }] : []),
    { id: "team-roster", label: "Roster" },
    ...(myMatches.length > 0 ? [{ id: "team-matches", label: "Matches" }] : []),
    ...(teamHeroes.length > 0 ? [{ id: "team-heroes", label: "Heroes" }] : []),
    ...(h2h.length > 0 ? [{ id: "team-rivals", label: "Head-to-head" }] : []),
    ...(myScenario && stakesReport && played
      ? [{ id: "team-outlook", label: "Playoff outlook" }]
      : []),
    ...(jersey ? [{ id: "team-jersey", label: "Jersey" }] : []),
  ];

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {/* An archived team belongs to its season's archive — /teams and
              /schedule only know the ACTIVE season. */}
          <ContextBackLink
            href={team.season.isActive ? "/teams" : `/seasons/${team.seasonId}`}
            className={textLink("text-sm")}
          >
            {team.season.isActive ? "← All teams" : "← Season archive"}
          </ContextBackLink>
          {/* The standings sit behind the rank badge beside the team's
              name, and the calendar in the Matches card. */}
          <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {team.season.isActive ? (
              <Link href="/scrims" className={textLink("text-sm")}>
                Scrims →
              </Link>
            ) : null}
            {team.season.isActive ? (
              team.season.status === SEASON_STATUS.SIGNUPS ? (
                // The week's job before the draft: scouting the pool.
                <Link href="/players" className={textLink("text-sm")}>
                  Player pool →
                </Link>
              ) : team.season.status === SEASON_STATUS.DRAFT ? (
                <Link href="/draft" className={textLink("text-sm")}>
                  Draft room →
                </Link>
              ) : null
            ) : (
              <Link
                href={`/seasons/${team.seasonId}`}
                className={textLink("text-sm")}
              >
                {team.season.status === SEASON_STATUS.COMPLETE
                  ? "Final standings →"
                  : team.season.status === SEASON_STATUS.REGULAR_SEASON ||
                      team.season.status === SEASON_STATUS.PLAYOFFS
                    ? "Standings at archive →"
                    : "Season overview →"}
              </Link>
            )}
          </span>
        </div>
        <div className="relative overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-br from-surface-2/70 via-surface/50 to-surface/30 shadow-sm">
          {/* The roster's signature hero, very faint on the right. */}
          {teamHero ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-2/3 sm:w-1/2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={heroPortrait(teamHero)}
                alt=""
                className="profile-hero-bg h-full w-full object-cover object-center opacity-20"
              />
            </div>
          ) : null}
          {/* Ambient graphics tinted with the team's own color identity. */}
          <div
            aria-hidden
            className="hero-grid pointer-events-none absolute inset-0 opacity-50"
          />
          <div
            aria-hidden
            data-team-hue={team.id}
            className="animate-hero-glow pointer-events-none absolute -left-8 top-0 h-40 w-40 -translate-y-1/3 rounded-full blur-3xl"
            style={{ backgroundColor: `hsl(${hue} 70% 50% / 0.22)` }}
          />
          <div
            aria-hidden
            className="animate-hero-glow-alt pointer-events-none absolute -right-8 bottom-0 h-40 w-40 translate-y-1/3 rounded-full bg-accent/15 blur-3xl"
          />
          <div className="relative flex items-center gap-4 p-4 sm:gap-5 sm:p-6">
            {/* A smaller crest on phones leaves the names room to breathe. */}
            <TeamCrest
              name={team.name}
              seed={team.id}
              logoUrl={team.logoUrl}
              size={64}
              imageFit="cover"
              className="self-start rounded-xl shadow-lg sm:hidden"
            />
            <TeamCrest
              name={team.name}
              seed={team.id}
              logoUrl={team.logoUrl}
              size={112}
              imageFit="cover"
              className="hidden rounded-2xl shadow-lg sm:grid"
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="font-display text-2xl font-bold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">
                  {team.name}
                </h1>
                {seed ? (
                  <StandingBadge
                    href={
                      team.season.isActive
                        ? "/schedule#playoff-bracket"
                        : undefined
                    }
                    where="in the playoff bracket"
                  >
                    Seed #{seed}
                  </StandingBadge>
                ) : played && rank > 0 ? (
                  <StandingBadge
                    href={
                      team.season.isActive ? "/schedule#standings" : undefined
                    }
                    where="in the standings"
                  >
                    #{rank} of {allTeams.length}
                  </StandingBadge>
                ) : null}
                {championPresentation.championTeamId === team.id ? (
                  <Badge tone="accent">🏆 Champion</Badge>
                ) : null}
                {team.withdrawn ? <Badge tone="danger">Withdrawn</Badge> : null}
              </div>
              <div className="mt-1 text-sm text-muted">{team.season.name}</div>
              {played && row ? (
                // Record and points in one line (the badge beside the name
                // carries the rank, or the playoff seed).
                <p className="mt-1 text-sm">
                  {seed ? (
                    <span className="text-muted">Regular season: </span>
                  ) : null}
                  <span className="font-semibold tabular-nums">
                    <SeriesRecord record={row} />
                  </span>
                  <span className="text-muted"> · </span>
                  <span className="font-semibold tabular-nums">
                    {row.points}
                  </span>{" "}
                  <span className="text-muted">
                    {row.points === 1 ? "pt" : "pts"}
                  </span>
                  {seed && rank > 0 ? (
                    <span className="text-muted">
                      {" "}
                      · #{rank} of {allTeams.length}
                    </span>
                  ) : null}
                </p>
              ) : null}
              {/* The Champion badge beside the name already says it. */}
              {playoffStatus && playoffStatus.kind !== "champion" ? (
                <PlayoffStatusLine
                  status={playoffStatus}
                  teamName={teamName}
                  className="mt-1.5 text-sm"
                />
              ) : null}
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
                <span className="flex items-center gap-1.5 text-muted">
                  Captain
                  <PlayerLink
                    userId={team.captainId}
                    className="flex items-center gap-1.5 text-fg hover:no-underline"
                  >
                    <Avatar
                      name={team.captain.name}
                      src={team.captain.avatar}
                      size={20}
                    />
                    <span className="font-medium">{team.captain.name}</span>
                  </PlayerLink>
                </span>
                {form.length > 0 ? (
                  <span className="flex items-center gap-2">
                    <span className="text-xs uppercase tracking-wide text-muted">
                      Form
                    </span>
                    <FormStrip form={form} />
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
        {canEditTeam ? (
          <details className="mt-3 rounded-[var(--radius)] border border-line bg-surface px-4">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-muted hover:text-fg">
              ✎ Edit team name and logo
            </summary>
            <div className="space-y-3 pb-4">
              <p className="text-xs text-muted">
                Changes save right away and are posted in the league Discord.
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
          </details>
        ) : null}
      </div>

      {team.withdrawn ? (
        <div className="rounded-[var(--radius)] border border-line bg-surface-2/40 px-4 py-3 text-sm">
          <div className="font-medium">Withdrawn from this season</div>
          <p className="mt-1 text-muted">
            Played results remain in the standings, and the team no longer
            occupies a playoff seed. Remaining fixtures are recorded as league
            rulings for its opponents.
          </p>
        </div>
      ) : null}

      {byeWeek != null ? (
        <ByeWeekNote week={byeWeek} who={team.name} next={byeNext} />
      ) : null}

      <SectionNav items={sectionItems} label="Team sections" sticky />

      {showOverview ? (
        <section
          id="team-overview"
          aria-label="Team overview"
          className={cn(
            "scroll-mt-40 grid grid-cols-1 gap-4",
            !played && featuredMatch && "lg:grid-cols-2",
          )}
        >
          {/* Record, points and rank sit in the header once results exist;
              before that the draft numbers are what this team is about. */}
          {!played ? (
            <div className="grid min-w-0 grid-cols-2 gap-3">
              <Stat
                label={
                  displayBudgets.isProjected ? "Projected budget" : "Budget left"
                }
                value={`$${displayBudget}`}
                hint={
                  displayBudgets.isProjected
                    ? "Finalized when the auction starts"
                    : undefined
                }
              />
              <Stat
                label="Roster"
                value={`${team.members.length}/${team.season.teamSize}`}
              />
              <Stat label="Avg MMR" value={avgMmr ?? "—"} />
              {/* Nothing is spent before the auction opens. */}
              {auctionStarted || spent > 0 ? (
                <Stat label="Spent" value={`$${spent}`} />
              ) : null}
            </div>
          ) : null}

          {featuredMatch ? (
            <ProfileMatchSpotlight
              match={featuredMatch}
              teams={allTeams}
              playoffRounds={playoffRounds}
              nowMs={nowMs}
            />
          ) : null}
        </section>
      ) : null}

      <section
        id="team-roster"
        aria-label="Team roster"
        className="scroll-mt-40 space-y-4"
      >
        <Card>
          <CardHeader
            title="Roster"
            headingLevel={2}
            subtitle={[
              `${team.members.length} of ${team.season.teamSize} players`,
              ...(spent > 0
                ? [
                    displayBudgets.isProjected
                      ? `Recorded $${spent} · projected start $${displayBudget}`
                      : `Spent $${spent} · $${displayBudget} left`,
                  ]
                : []),
            ].join(" · ")}
          />
          <CardBody className="space-y-1.5">
            {team.members.length === 0 ? (
              <p className="text-sm text-muted">No players yet.</p>
            ) : (
              rosterOrder(team.members).map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-3 rounded-lg border border-line/60 bg-surface-2/20 px-3 py-2 text-sm"
                >
                  <Avatar
                    name={m.user.name}
                    src={m.user.avatar}
                    size={36}
                    className="shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <PlayerLink
                      userId={m.userId}
                      className="my-0 inline-flex min-h-11 items-center font-medium [overflow-wrap:anywhere]"
                    >
                      {m.user.name}
                    </PlayerLink>
                    <div className="flex flex-wrap items-center gap-2">
                      {m.isCaptain ? (
                        <Badge tone="accent">Captain</Badge>
                      ) : null}
                      <RankBadge rankTier={m.user.rankTier} />
                      {canViewLeagueContact(
                        viewer,
                        m.userId,
                        viewerHasActiveRegistration,
                      ) ? (
                        // Shown on phones too: match night is when teammates
                        // look each other up. Still members-only.
                        <DiscordTag
                          name={m.user.discordName}
                          verified={!!m.user.discordId}
                        />
                      ) : null}
                      <RoleBadges roles={rolesByUser.get(m.userId)} />
                    </div>
                  </div>
                  {/* Prices matter while the draft is ahead; after it, phones
                      give the room to the name and contact chips. */}
                  <span
                    className={cn(
                      "shrink-0 font-mono text-muted",
                      !draftAhead && "hidden sm:inline",
                    )}
                  >
                    {m.isCaptain ? "—" : `$${m.price}`}
                  </span>
                </div>
              ))
            )}
          </CardBody>
        </Card>

        {showCoverage ? (
          <Card>
            <CardHeader
              title="Role coverage"
              subtitle="Positions the roster prefers to play"
            />
            <CardBody>
              <div className="grid grid-cols-5 gap-2">
                {coverage.map((r) => (
                  <div
                    key={r.key}
                    className={cn(
                      "rounded-lg border px-2 py-3 text-center",
                      r.count > 0
                        ? "border-line bg-surface-2/40"
                        : "border-dashed border-danger/40 bg-danger/5",
                    )}
                    title={r.label}
                  >
                    <div className="text-xs font-medium text-muted">
                      {r.short}
                    </div>
                    <div
                      className={cn(
                        "mt-1 text-lg font-semibold tabular-nums",
                        r.count === 0 ? "text-danger" : "text-fg",
                      )}
                    >
                      {r.count}
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-muted">
                      {r.count === 0
                        ? "gap"
                        : r.count === 1
                          ? "player"
                          : "players"}
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        ) : null}
      </section>

      {myMatches.length === 0 ? (
        // No fixtures yet: one line saying when they come, not an empty card.
        <p className="rounded-[var(--radius)] border border-line-soft bg-surface/50 px-4 py-3 text-sm text-muted">
          {draftAhead ? (
            <>
              No matches until after the draft.
              {team.season.draftAt && !auctionStarted ? (
                <>
                  {" "}
                  🗓️ Draft night:{" "}
                  <strong className="text-fg">
                    <LocalTime
                      ts={team.season.draftAt.getTime()}
                      variant="full"
                      initial={formatMatchTime(team.season.draftAt, "full")}
                    />
                  </strong>{" "}
                  <Countdown
                    targetMs={team.season.draftAt.getTime()}
                    eventLabel="Draft"
                    passedLabel={DRAFT_PASSED_LABEL}
                  />
                </>
              ) : null}
            </>
          ) : team.season.isActive ? (
            "No matches scheduled yet."
          ) : (
            "No matches were scheduled for this team."
          )}
        </p>
      ) : (
        // No overflow-hidden on the card: it would clip the calendar menu.
        // The body clips the rows' hover background to the corners instead.
        <Card id="team-matches" className="scroll-mt-40">
          <CardHeader
            title="Matches"
            headingLevel={2}
            action={
              team.season.isActive ? (
                // Full width on phones so the calendar button, and the menu
                // under it, keep to the card's right edge.
                <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 sm:w-auto">
                  <Link
                    href={`/schedule?team=${team.id}#fixtures`}
                    className={textLink("text-sm")}
                  >
                    Team schedule →
                  </Link>
                  {showCalendar ? (
                    <div className="ml-auto">
                      <AddToCalendar
                        site={resolveSiteUrl()}
                        teams={[{ id: team.id, name: team.name }]}
                        initialTeamId={team.id}
                        align="end"
                      />
                    </div>
                  ) : null}
                </div>
              ) : undefined
            }
          />
          <CardBody className="overflow-hidden rounded-b-[var(--radius)] p-0">
            <ul className="divide-y divide-line/60">
              {fixtureList.map((m) => {
                const isHome = m.homeTeamId === id;
                const oppId = isHome ? m.awayTeamId : m.homeTeamId;
                const oppName = teamName.get(oppId) ?? "?";
                const myScore = isHome ? m.homeScore : m.awayScore;
                const oppScore = isHome ? m.awayScore : m.homeScore;
                const done = m.status === "COMPLETED";
                const live = m.status === "LIVE";
                const result =
                  m.winnerTeamId === id
                    ? "W"
                    : m.winnerTeamId === null
                      ? "D"
                      : "L";
                const matchState = profileMatchState(m, nowMs);
                return (
                  <li key={m.id}>
                    <Link
                      href={`/matches/${m.id}`}
                      className="group flex min-h-14 min-w-0 items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-surface-2 sm:px-5"
                    >
                      <TeamCrest
                        name={oppName}
                        seed={oppId}
                        logoUrl={teamLogoUrl.get(oppId)}
                        size={28}
                        imageFit="cover"
                        className="shrink-0 rounded-lg"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium leading-snug [overflow-wrap:anywhere] group-hover:underline">
                          <span className="font-normal text-muted">vs </span>
                          {oppName}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted">
                          {matchRoundLabel(m, playoffRounds)}
                          {" · "}
                          {m.scheduledAt ? (
                            <LocalTime
                              ts={m.scheduledAt.getTime()}
                              variant="short"
                              initial={formatMatchTime(m.scheduledAt, "short")}
                            />
                          ) : done ? (
                            "Time not recorded"
                          ) : (
                            "Time TBD"
                          )}
                          {done && m.forfeit ? " · Forfeit" : ""}
                        </span>
                      </span>
                      {done || live ? (
                        <span className="shrink-0 font-display text-lg font-semibold tabular-nums">
                          {myScore}–{oppScore}
                        </span>
                      ) : null}
                      {done ? (
                        <Badge
                          tone={
                            result === "W"
                              ? "success"
                              : result === "L"
                                ? "danger"
                                : "neutral"
                          }
                          className="w-7 shrink-0 justify-center px-0"
                        >
                          <span aria-hidden>{result}</span>
                          <span className="sr-only">
                            {result === "W"
                              ? "Won"
                              : result === "L"
                                ? "Lost"
                                : "Draw"}
                          </span>
                        </Badge>
                      ) : (
                        <Badge
                          tone={live ? "danger" : "neutral"}
                          className="shrink-0"
                        >
                          {live
                            ? "Live"
                            : matchState === "Awaiting result"
                              ? "Awaiting result"
                              : "Upcoming"}
                        </Badge>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      )}

      {teamHeroes.length > 0 ? (
        <Card id="team-heroes" className="scroll-mt-40">
          <CardHeader
            title="Team hero pool"
            headingLevel={2}
            subtitle="Most-played heroes across the roster, with win rate"
          />
          <CardBody>
            <HeroPool heroes={teamHeroes} />
          </CardBody>
        </Card>
      ) : null}

      {h2h.length > 0 ? (
        <Card id="team-rivals" className="scroll-mt-40">
          <CardHeader
            title="Head-to-head"
            headingLevel={2}
            subtitle="Opponents met more than once"
          />
          <CardBody className="p-0">
            <ul className="divide-y divide-line/60">
              {h2h.map((r) => {
                const edge =
                  r.wins > r.losses
                    ? "success"
                    : r.losses > r.wins
                      ? "danger"
                      : "neutral";
                return (
                  <li
                    key={r.opponentId}
                    className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm transition-colors hover:bg-surface-2/40"
                  >
                    <Link
                      href={`/teams/${r.opponentId}`}
                      className="flex min-w-0 flex-1 items-center gap-2 font-medium hover:text-info"
                    >
                      <TeamCrest
                        name={teamName.get(r.opponentId) ?? "?"}
                        seed={r.opponentId}
                        logoUrl={teamLogoUrl.get(r.opponentId)}
                        size={20}
                        className="shrink-0 rounded"
                      />
                      <span className="[overflow-wrap:anywhere]">
                        {teamName.get(r.opponentId) ?? "?"}
                      </span>
                    </Link>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="text-xs text-muted">
                        {r.gamesFor}–{r.gamesAgainst} games
                      </span>
                      <Badge tone={edge}>
                        <SeriesRecord record={r} />
                      </Badge>
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {myScenario && stakesReport && played ? (
        <section
          id="team-outlook"
          aria-label="Playoff outlook"
          className="scroll-mt-40"
        >
          <WhatWeNeed scenario={myScenario} teamNames={teamName} />
        </section>
      ) : null}

      {jersey ? (
        <section
          id="team-jersey"
          aria-labelledby="team-jersey-title"
          className="scroll-mt-40 space-y-4"
        >
          <div>
            <h2 id="team-jersey-title" className="text-lg font-semibold">
              Team jersey
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
              Explore the Fourthwall front and back previews, then choose your
              player. Each jersey has a personalized name and position.
            </p>
          </div>
          <TeamJerseyPreview jersey={jersey} featured />
        </section>
      ) : null}
    </div>
  );
}

/**
 * The team's place beside its name ("#2 of 8", "Seed #2"). In the active
 * season it opens that table on Schedule; an archived team's page links its
 * season archive separately.
 */
function StandingBadge({
  href,
  where,
  children,
}: {
  href?: string;
  /** Spoken after the badge text when it is a link: "in the standings". */
  where: string;
  children: React.ReactNode;
}) {
  if (!href) return <Badge tone="accent">{children}</Badge>;
  return (
    <Link
      href={href}
      className="group rounded-full py-1 -my-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <Badge
        tone="accent"
        className="transition-colors group-hover:border-accent/70 group-hover:bg-accent/25"
      >
        {/* Its own element, so the badge's text can be found on its own. */}
        <span>{children}</span>
        <span className="sr-only"> {where}</span>
        <span aria-hidden>→</span>
      </Badge>
    </Link>
  );
}

/** A team's authoritative playoff status and remaining feasible result paths. */
function WhatWeNeed({
  scenario,
  teamNames,
}: {
  scenario: TeamScenario;
  teamNames: Map<string, string>;
}) {
  return (
    <Card className={scenario.status === "CLINCHED" ? "border-success/30" : "border-accent/30"}>
      <CardHeader
        title="Playoff outlook"
        headingLevel={2}
      />
      <CardBody>
        <PlayoffOutlook scenario={scenario} teamNames={teamNames} />
      </CardBody>
    </Card>
  );
}
