import { LEAGUE_CONFIG } from "@/lib/league-config";
import { notFound } from "next/navigation";
import { SectionNav } from "@/components/section-nav";
import { ProfileCareer } from "@/components/profile-career";
import {
  ProfileHeader,
  UnjoinedProfile,
} from "@/components/profile-header";
import { ProfileHeroesAndRecords } from "@/components/profile-heroes-records";
import { ProfileMatchHistory } from "@/components/profile-match-history";
import { ProfileOverview } from "@/components/profile-overview";
import { ProfilePerformance } from "@/components/profile-performance";
import { profileMatch } from "@/lib/profile-match";
import { profileSections } from "@/lib/profile-sections";
import { prisma } from "@/lib/prisma";
import { getAllGamesForRecords } from "@/lib/cached-queries";
import { getPlayerGameFacts } from "@/lib/player-game-history";
import { getRosterHistory } from "@/lib/player-roster-history";
import { appearanceCareers } from "@/lib/appearance-careers";
import { playerProfileMetadata, shareMetadata } from "@/lib/share-metadata";
import { latestLeagueLine, profileSeasonRows } from "@/lib/profile-seasons";
import { singleSearchParam } from "@/lib/search-params";
import { getActiveSeason } from "@/lib/season";
import { effectiveDotaAccountId } from "@/lib/dota-account";
import { heroById, parseHeroList } from "@/lib/heroes";
import { projectPlayoffField } from "@/lib/playoff-field";
import { profileWantsCaptain } from "@/lib/player-directory-lifecycle";
import { matchRoundLabel, playoffTotalRounds } from "@/lib/schedule";
import { loadPlayoffRoundsBySeason } from "@/lib/playoff-rounds";
import { getSessionUser } from "@/lib/auth";
import {
  currentStreak,
  summarizePlayerGames,
  wonGame,
  type PlayerGameLine,
  decodeGamePlayers,
  trustedGamePlayers,
} from "@/lib/player-stats";
import { playerHeroPool, type ScoutGame } from "@/lib/scouting";
import { leagueRecords, toRecordGames } from "@/lib/records";
import { hasText } from "@/lib/utils";
import { aboutText } from "@/lib/about-you";
import { rankMedalName } from "@/lib/rank";
import {
  parsePubStats,
  poolPubRecord,
  pubCheckedAgo,
  pubLastPlayed,
} from "@/lib/pub-stats";
import {
  INHOUSE_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_STATUS,
} from "@/lib/constants";
import type { FormResult } from "@/lib/team-matches";
import { achievementsFor, gameMvp } from "@/lib/achievements";
import {
  groupBySeries,
  pickStandout,
  recordedAverage,
  seasonHistoryView,
  seriesOpponent,
  seriesOutcome,
} from "@/lib/profile-history";
import { careerReportCard, reportVerdicts } from "@/lib/benchmarks";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import { playoffRunTile, teamPlayoffRun } from "@/lib/playoff-run";
import { canViewLeagueContact } from "@/lib/visibility";
import { hasJoinedLeague } from "@/lib/profile-footprint";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [user, gameScores, joined] = await Promise.all([
    prisma.user.findUnique({
      where: { id },
      select: { name: true, rankTier: true, pubStats: true },
    }),
    getPlayerGameFacts(id),
    hasJoinedLeague(id),
  ]);
  // notFound() in metadata: crawlers wait for metadata, so they get a real
  // 404 status. Browsers get streamed metadata, so the not-found page
  // arrives with a 200 and Next's noindex tag (its documented streaming
  // behaviour).
  if (!user) notFound();
  // An account that only signed in: a plain, unindexed page, no medal or
  // hero highlights (see UnjoinedProfile).
  if (!joined) {
    return {
      ...shareMetadata(
        `${user.name} · Player`,
        `${user.name} hasn't joined a ${LEAGUE_CONFIG.name} season yet.`,
      ),
      robots: { index: false },
    };
  }
  const rank = rankMedalName(user.rankTier);
  const summary = summarizePlayerGames(
    gameScores.flatMap(({ players, radiantWin }) =>
      trustedGamePlayers(decodeGamePlayers(players))
        .filter((player) => player.userId === id)
        .map((player) => ({
          radiantWin,
          isRadiant: player.isRadiant,
          kills: player.kills,
          deaths: player.deaths,
          assists: player.assists,
          heroId: player.heroId,
        })),
    ),
  );
  const favoriteHero = heroById(
    summary.topHeroes[0]?.heroId ??
      parsePubStats(user.pubStats)?.topHeroes[0]?.heroId ??
      0,
  );
  const highlights = [
    rank !== "Unranked" ? `${rank} medal` : null,
    summary.games > 0
      ? `${summary.wins}–${summary.losses} league record`
      : null,
    favoriteHero ? `${favoriteHero.name} player` : null,
  ].filter((highlight): highlight is string => highlight !== null);
  return playerProfileMetadata(user.name, highlights);
}

export default async function PlayerProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ season?: string | string[] }>;
}) {
  const [{ id }, rawSearchParams] = await Promise.all([params, searchParams]);
  const historySeasonParam = singleSearchParam(rawSearchParams.season);
  if (historySeasonParam === null) notFound();
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) notFound();

  const [season, viewer, joined] = await Promise.all([
    getActiveSeason(),
    getSessionUser(),
    hasJoinedLeague(id),
  ]);
  const isSelf = viewer?.id === id;
  // Signing in once creates an account, and pick'em, fantasy and inhouse
  // boards link to it. Until they join something the league records, the page
  // is their name and avatar only: no season subtitle (it read as a signup),
  // medal, pub numbers or outbound links. The sign-in medal fetch stays; the
  // inhouse queue uses it to sanity-check typed MMR.
  if (!joined) {
    return (
      <UnjoinedProfile user={user} isSelf={isSelf} poolListed={!!season} />
    );
  }

  const [
    registration,
    membership,
    seasonTeams,
    seasonMatches,
    rosterHistory,
    gamesLite,
    recentInhouse,
    recordRows,
    viewerRegistration,
    coversServed,
    draft,
  ] = await Promise.all([
    season
      ? prisma.registration.findUnique({
          where: { seasonId_userId: { seasonId: season.id, userId: id } },
        })
      : null,
    season
      ? prisma.teamMember.findFirst({
          where: { seasonId: season.id, userId: id },
          include: { team: { include: { captain: true } } },
        })
      : null,
    season ? prisma.team.findMany({ where: { seasonId: season.id } }) : [],
    season ? prisma.match.findMany({ where: { seasonId: season.id } }) : [],
    getRosterHistory(id),
    // Participant indexes narrow covered history; old sources retain a safe fallback.
    getPlayerGameFacts(id),
    // Any completed inhouse game gates the streamed ladder card, so
    // league-only players never mount a skeleton that will immediately
    // disappear.
    prisma.inhouseLobby.findFirst({
      where: {
        status: INHOUSE_STATUS.COMPLETED,
        players: { some: { userId: id } },
      },
      select: { id: true },
    }),
    // All-time record book input — the cached /records scan ("games"-tagged).
    // Awaited in the page body on purpose: an unstable_cache wrapper awaited
    // inside a nested Suspense component silently never resolved once
    // (documented in cached-queries.ts).
    getAllGamesForRecords(),
    season && viewer
      ? prisma.registration.findUnique({
          where: {
            seasonId_userId: { seasonId: season.id, userId: viewer.id },
          },
          select: { status: true },
        })
      : null,
    // Cover they actually served: bookings on COMPLETED matches (pending ones
    // are /me's to-do list, not history). Feeds the Seasons card's
    // "Stood in for N matches" credit.
    prisma.standinAssignment.findMany({
      where: { standinUserId: id, match: { status: MATCH_STATUS.COMPLETED } },
      select: {
        matchId: true,
        teamId: true,
        match: {
          select: {
            seasonId: true,
            homeTeam: { select: { id: true, name: true, logoUrl: true } },
            awayTeam: { select: { id: true, name: true, logoUrl: true } },
          },
        },
      },
    }),
    // Only for the "Wants to captain" badge's window (captain selection).
    season
      ? prisma.draft.findUnique({
          where: { seasonId: season.id },
          select: { status: true },
        })
      : null,
  ]);
  // Pass 2: only THIS player's games carry the heavy match/team/season joins
  // that feed the match history, stat tiles, achievements, and report card.
  const myGameIds = gamesLite
    .filter((g) =>
      trustedGamePlayers(decodeGamePlayers(g.players)).some(
        (p) => p.userId === id,
      ),
    )
    .map((g) => g.id);
  const games = myGameIds.length
    ? await prisma.game.findMany({
        where: { id: { in: myGameIds } },
        include: {
          match: { include: { homeTeam: true, awayTeam: true, season: true } },
        },
        orderBy: { startTime: "desc" },
      })
    : [];
  // Bracket depth for every season this player has playoff games in, so the
  // history rows name the round ("Semifinal") the way the match page does.
  const playoffRoundsBySeason = await loadPlayoffRoundsBySeason(
    games
      .filter((g) => g.match.phase === MATCH_PHASE.PLAYOFF)
      .map((g) => g.match.seasonId),
  );

  const accountId = effectiveDotaAccountId(user);

  // A signup row exists for WITHDRAWN/REMOVED players too — only an ACTIVE one
  // may render as a live signup (MMR, roles, Standin badge, their goals and
  // note for captains). Both render exactly as unregistered: the subtitle is
  // the bare season name, never "Registered", so nobody reads them as
  // biddable, and whether someone withdrew or was removed is theirs (on /me)
  // and the admins' to know, not a public label.
  const activeReg =
    registration?.status === REGISTRATION_STATUS.ACTIVE ? registration : null;
  const canSeeLeagueContact = canViewLeagueContact(
    viewer,
    id,
    viewerRegistration?.status === REGISTRATION_STATUS.ACTIVE,
  );

  // All-time league records THIS player holds. Same mapping as /records
  // (shared toRecordGames) so the chips can never disagree with the book.
  const heldRecords = leagueRecords(toRecordGames(recordRows)).players.filter(
    (r) => r.userId === id,
  );

  // Pub scouting (public data — same visibility rule as the medal): the token
  // gate comes from poolPubRecord (null when nothing is scoutable), the hero
  // card uses the full stored top-5. One clock for every recency label.
  // The pub numbers show only for an ACTIVE signup this season, the people
  // captains scout and the admin sync keeps refreshing. Anyone else's
  // snapshot is whatever OpenDota said at their last refresh, which can be
  // months old, so it isn't shown as if it were current.
  // eslint-disable-next-line react-hooks/purity -- async server component
  const nowMs = Date.now();
  const pubScout = activeReg
    ? poolPubRecord(user.pubStats, user.pubStatsAt)
    : null;
  const pubLast = pubScout ? pubLastPlayed(pubScout, nowMs) : null;
  const pubHeroes = parsePubStats(user.pubStats)?.topHeroes ?? [];
  const pubCheckedLabel = pubCheckedAgo(
    user.pubStatsAt?.getTime() ?? null,
    nowMs,
  );

  // Seasons card: every season they played in, were rostered in, or stood in
  // for, with the champion resolved the same way every public page does.
  const careerSeasonIds = [
    ...new Set([
      ...games.map((game) => game.match.seasonId),
      ...rosterHistory.map((row) => row.seasonId),
      ...coversServed.map((cover) => cover.match.seasonId),
    ]),
  ];
  const [careerSeasonRows, careerMatches] = careerSeasonIds.length
    ? await Promise.all([
        prisma.season.findMany({
          where: { id: { in: careerSeasonIds } },
          select: {
            id: true,
            name: true,
            createdAt: true,
            status: true,
            championTeamId: true,
          },
        }),
        prisma.match.findMany({ where: { seasonId: { in: careerSeasonIds } } }),
      ])
    : [[], []];
  const champions = new Map(
    careerSeasonRows.flatMap((row) => {
      const teamId = resolveChampionPresentation(
        row,
        careerMatches.filter((match) => match.seasonId === row.id),
      ).championTeamId;
      return teamId ? [[row.id, teamId] as const] : [];
    }),
  );
  const careerRows = appearanceCareers(
    games,
    careerMatches,
    [...champions].map(([seasonId, teamId]) => ({ seasonId, teamId })),
  ).rows.filter((row) => row.userId === id);
  const careerTeamList = [
    ...games.flatMap((game) => [game.match.homeTeam, game.match.awayTeam]),
    ...coversServed.flatMap((cover) => [
      cover.match.homeTeam,
      cover.match.awayTeam,
    ]),
    ...rosterHistory.flatMap((row) =>
      row.teamId
        ? [{ id: row.teamId, name: row.teamName, logoUrl: row.teamLogoUrl }]
        : [],
    ),
  ];
  const teamLogos = new Map(
    careerTeamList.map((team) => [team.id, team.logoUrl ?? null]),
  );
  const seasonRows = profileSeasonRows({
    seasons: new Map(careerSeasonRows.map((row) => [row.id, row])),
    appearances: careerRows,
    tenures: rosterHistory,
    covers: coversServed.map((cover) => ({
      seasonId: cover.match.seasonId,
      teamId: cover.teamId,
      matchId: cover.matchId,
    })),
    teamNames: new Map(careerTeamList.map((team) => [team.id, team.name])),
    champions,
  });

  // Pull this player's line out of each imported game — every season's games.
  // The parsed box score is kept so achievements can identify each game's MVP;
  // won/mvp are computed once here and shared by the tiles, the badge math,
  // the standout game and the match-history rows.
  const gameRows = games
    .map((g) => {
      const parsed = trustedGamePlayers(decodeGamePlayers(g.players));
      const stat = parsed.find((p) => p.userId === id);
      if (!stat) return null;
      return {
        game: g,
        stat,
        parsed,
        won: stat.isRadiant === g.radiantWin,
        mvp: gameMvp(parsed, g.radiantWin) === id,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const toLine = ({
    game,
    stat,
  }: (typeof gameRows)[number]): PlayerGameLine => ({
    isRadiant: stat.isRadiant,
    radiantWin: game.radiantWin,
    kills: stat.kills,
    deaths: stat.deaths,
    assists: stat.assists,
    heroId: stat.heroId,
  });
  const careerLines = gameRows.map(toLine);
  const seasonLines = season
    ? gameRows.filter((r) => r.game.match.seasonId === season.id).map(toLine)
    : [];
  const careerSummary = summarizePlayerGames(careerLines);
  const seasonSummary = summarizePlayerGames(seasonLines);
  // The overview's tiles show this season once it has games, career before.
  const hasSeasonGames = seasonSummary.games > 0;
  // Trophy case + report card: career-wide, same rows as the match history.
  const achievementLines = gameRows.map(({ stat, won, mvp }) => ({
    kills: stat.kills,
    deaths: stat.deaths,
    assists: stat.assists,
    gpm: stat.gpm,
    lastHits: stat.lastHits,
    won,
    mvp,
  }));
  const badges = achievementsFor(achievementLines);
  // Career report card: worldwide percentile benchmarks over every graded line.
  const reportCard = careerReportCard(gameRows.map((r) => r.stat));
  // No letter grades until there are enough graded games to mean something,
  // and "Work on" only for the player themselves.
  const verdicts = reportVerdicts(reportCard, isSelf);

  // Per-hero W-L/KDA for the hero card — a pure fold over lines already in
  // memory (zero new queries). ScoutGame is the exact shape the match-preview
  // dossier already consumes.
  const scoutGames: ScoutGame[] = gameRows.map((r) => ({
    radiantWin: r.game.radiantWin,
    durationSecs: r.game.durationSecs,
    startTime: r.game.startTime,
    lines: r.parsed.map((p) => ({
      userId: p.userId ?? null,
      heroId: p.heroId,
      isRadiant: p.isRadiant,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
    })),
  }));
  // NOTE: playerHeroPool tiebreaks games → winRate → heroId while the old
  // topHeroes source tiebreaks games → wins — a full tie can reorder tiles.
  const leagueHeroes = playerHeroPool(id, scoutGames);

  const streak = currentStreak(careerLines); // newest-first (games desc)
  const streakLabel =
    streak.count > 1 ? `${streak.type}${streak.count} streak` : undefined;
  // Recent W/L form (newest first), reusing the team form strip.
  const recentFormStrip: FormResult[] = careerLines
    .slice(0, 8)
    .map((l) => (wonGame(l) ? "W" : "L"));
  // KDA per game, oldest→newest, for a performance trend sparkline.
  const kdaByGame = [...careerLines]
    .reverse()
    .map(
      (l) =>
        Math.round(((l.kills + l.assists) / Math.max(1, l.deaths)) * 10) / 10,
    );

  // Match history is one entry per series (how the league scores), latest
  // first. gameRows is newest-first, so series and seasons keep that order.
  const seriesHistory = groupBySeries(
    gameRows.map((row) => ({
      ...row,
      matchId: row.game.matchId,
      startTime: row.game.startTime,
    })),
  ).map(({ matchId, games: seriesGames }) => {
    const match = seriesGames[0].game.match;
    // The team they played for in this series (a standin's covered team).
    const teamId =
      seriesGames
        .map((row) => row.stat.teamId)
        .find((t) => t === match.homeTeamId || t === match.awayTeamId) ?? null;
    const firstPlayed = seriesGames.find((row) => row.game.startTime > 0);
    const playedAt = firstPlayed
      ? new Date(firstPlayed.game.startTime * 1000)
      : match.scheduledAt;
    return {
      matchId,
      match,
      games: seriesGames,
      outcome: seriesOutcome(match, teamId, seriesGames),
      opponentName: seriesOpponent(match, teamId),
      round: matchRoundLabel(
        match,
        playoffRoundsBySeason.get(match.seasonId) ?? 0,
      ),
      playedAt,
    };
  });
  const history = seasonHistoryView(seriesHistory, historySeasonParam);
  const latestLeagueGame = gameRows.find((row) => row.game.startTime > 0);

  // Team + record for this season, if drafted.
  const team = membership?.team ?? null;
  const standings =
    team && seasonTeams.length
      ? projectPlayoffField(seasonTeams, seasonMatches).standings
      : [];
  const teamRow = team
    ? standings.find((s) => s.teamId === team.id)
    : undefined;
  const teamRank = team
    ? standings.findIndex((s) => s.teamId === team.id) + 1
    : 0;
  // Once the season has a bracket, the regular-season rank stops saying where
  // the team stands: the tile shows their playoff run instead.
  const playoffRun =
    team && season
      ? teamPlayoffRun(
          team.id,
          seasonMatches,
          resolveChampionPresentation(season, seasonMatches).championTeamId,
        )
      : null;
  const playoffTile = playoffRun ? playoffRunTile(playoffRun) : null;

  const isStandin = activeReg?.type === "STANDIN";
  const isCaptain = !!membership?.isCaptain;
  // Season context only: the badges already say Captain / Standin and the
  // team box names the team, so the subtitle doesn't repeat either. Someone
  // not in the current season (or with no season running) gets their latest
  // league line instead of a season they haven't joined, so last season's
  // champion still reads as one after the handoff.
  const inCurrentSeason = !!activeReg || !!team;
  const pastLine = inCurrentSeason ? null : latestLeagueLine(seasonRows);
  const subtitle =
    pastLine ??
    (season
      ? activeReg && !team && !isStandin
        ? `Registered · ${season.name}`
        : season.name
      : null);
  // A signature hero for the banner backdrop: most-played if we have games,
  // otherwise the player's first listed favorite.
  const signatureHero =
    (careerSummary.topHeroes[0]
      ? heroById(careerSummary.topHeroes[0].heroId)
      : null) ??
    parseHeroList(activeReg?.favoriteHeroes).matched[0] ??
    null;

  const hasLeagueGames = gameRows.length > 0;
  // What they wrote about themselves, shown once under the header. Signups
  // from before the form had one "About you" box keep two answers; they show
  // joined, never one dropped.
  const signupAbout = activeReg ? aboutText(activeReg) || null : null;
  // Only while they could still be picked as one (the /players badge's
  // window); once the auction starts, or once on a team, it is old news.
  const wantsCaptainNow =
    !!season &&
    profileWantsCaptain({
      wantsCaptain: !!activeReg?.wantsCaptain,
      onTeam: !!team,
      standin: isStandin,
      seasonStatus: season.status,
      draftStatus: draft?.status,
    });
  const selfPickedHeroes = activeReg?.favoriteHeroes;

  // Economy averages + a standout game. Net-worth/GPM/last-hits are optional per
  // game (older imports may lack them), so average only over games that have it.
  const avgNet = recordedAverage(gameRows.map((r) => r.stat.netWorth));
  const avgGpm = recordedAverage(gameRows.map((r) => r.stat.gpm));
  const avgLh = recordedAverage(gameRows.map((r) => r.stat.lastHits));
  // Their best performance by impact points (the Match MVP rating), so a
  // support's big game can stand out, not just the richest one.
  const bestGame = pickStandout(gameRows);
  const bestView = bestGame
    ? {
        matchId: bestGame.game.matchId,
        hero: heroById(bestGame.stat.heroId),
        heroId: bestGame.stat.heroId,
        won: bestGame.won,
        kills: bestGame.stat.kills,
        deaths: bestGame.stat.deaths,
        assists: bestGame.stat.assists,
        netWorth: bestGame.stat.netWorth,
        gpm: bestGame.stat.gpm,
        round: matchRoundLabel(
          bestGame.game.match,
          playoffRoundsBySeason.get(bestGame.game.match.seasonId) ?? 0,
        ),
        opponent: seriesOpponent(bestGame.game.match, bestGame.stat.teamId),
      }
    : null;

  const teamSpotlight = team
    ? profileMatch(
        seasonMatches.filter(
          (match) =>
            match.homeTeamId === team.id || match.awayTeamId === team.id,
        ),
        nowMs,
        season?.status !== "COMPLETE",
      )
    : null;
  const featuredMatch = teamSpotlight ?? latestLeagueGame?.game.match ?? null;
  const featured = featuredMatch
    ? {
        match: featuredMatch,
        teams: teamSpotlight
          ? seasonTeams
          : latestLeagueGame
            ? [
                latestLeagueGame.game.match.homeTeam,
                latestLeagueGame.game.match.awayTeam,
              ]
            : [],
        playoffRounds: teamSpotlight
          ? playoffTotalRounds(seasonMatches)
          : latestLeagueGame
            ? (playoffRoundsBySeason.get(
                latestLeagueGame.game.match.seasonId,
              ) ?? 0)
            : 0,
        nowMs,
        teamContext: !!teamSpotlight,
      }
    : null;

  // Which bands render (and the tabs that jump to them), decided once.
  const sections = profileSections({
    leagueGames: hasLeagueGames,
    economy: avgNet != null || avgGpm != null,
    gradedGames: reportCard.graded > 0,
    heroes:
      leagueHeroes.length > 0 ||
      pubHeroes.length > 0 ||
      hasText(selfPickedHeroes),
    records: heldRecords.length > 0,
    achievements: badges.length > 0,
    seasons: seasonRows.length > 0,
    inhouse: !!recentInhouse,
  });

  return (
    <div className="space-y-6">
      <ProfileHeader
        user={user}
        isSelf={isSelf}
        poolListed={!!season}
        canSeeLeagueContact={canSeeLeagueContact}
        comparable={hasLeagueGames}
        signatureHero={signatureHero}
        isCaptain={isCaptain}
        isStandin={isStandin}
        wantsCaptainNow={wantsCaptainNow}
        subtitle={subtitle}
        subtitleIsPastSeason={!!pastLine}
        signup={activeReg}
        pubScout={pubScout}
        pubLast={pubLast}
        nowMs={nowMs}
        accountId={accountId}
        team={team}
        draftPrice={
          membership && !membership.isCaptain ? membership.price : null
        }
        signupAbout={signupAbout}
      />

      {/* Tabs only earn their space with three or more sections to jump
          between; a new signup's page is short enough to scroll. */}
      {sections.nav.length >= 3 ? (
        <SectionNav items={sections.nav} label="Player sections" sticky />
      ) : null}

      <ProfileOverview
        hasLeagueGames={hasLeagueGames}
        hasSeasonGames={hasSeasonGames}
        seasonName={season?.name}
        seasonSummary={seasonSummary}
        careerSummary={careerSummary}
        streakLabel={streakLabel}
        team={team ? { rank: teamRank, row: teamRow, playoffTile } : null}
        featured={featured}
        inhouseUserId={sections.inhouseInOverview ? user.id : null}
      />

      {sections.matches ? (
        <ProfileMatchHistory
          playerId={id}
          history={history}
          recentForm={recentFormStrip}
        />
      ) : null}

      {sections.performance ? (
        <ProfilePerformance
          showPerformance={sections.performanceCard}
          showReportCard={sections.reportCard}
          avgNet={avgNet}
          avgGpm={avgGpm}
          avgLh={avgLh}
          kdaByGame={kdaByGame}
          bestView={bestView}
          reportCard={reportCard}
          verdicts={verdicts}
        />
      ) : null}

      {sections.profile ? (
        <ProfileHeroesAndRecords
          showHeroes={sections.heroes}
          showRecords={sections.records}
          leagueHeroes={leagueHeroes}
          selfPickedHeroes={selfPickedHeroes}
          pubHeroes={pubHeroes}
          pubCheckedLabel={pubCheckedLabel}
          heldRecords={heldRecords}
        />
      ) : null}

      {sections.career ? (
        <ProfileCareer
          badges={badges}
          seasonRows={seasonRows}
          teamLogos={teamLogos}
          inhouseUserId={sections.inhouseInCareer ? user.id : null}
        />
      ) : null}
    </div>
  );
}
