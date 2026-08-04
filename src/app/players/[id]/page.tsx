import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  getAllGameLines,
  getAllGameScores,
  getAllGamesForRecords,
} from "@/lib/cached-queries";
import { shareMetadata } from "@/lib/share-metadata";
import { singleSearchParam } from "@/lib/search-params";
import { getActiveSeason } from "@/lib/season";
import { steamIdToAccountId } from "@/lib/dota";
import { heroById, heroPortrait, parseHeroList } from "@/lib/heroes";
import { roleLabels } from "@/lib/roles";
import { computeStandings } from "@/lib/standings";
import { matchPhaseAbbrev, matchPhaseLabel } from "@/lib/schedule";
import { getSessionUser } from "@/lib/auth";
import { DiscordTag } from "@/components/discord-tag";
import {
  currentStreak,
  summarizePlayerGames,
  wonGame,
  type PlayerGameLine,
  decodeGamePlayers,
  trustedGamePlayers,
} from "@/lib/player-stats";
import type { PlayerStat } from "@/lib/match-import";
import { playerHeroPool, type ScoutGame } from "@/lib/scouting";
import { topAffinities, type MeetingGame } from "@/lib/compare";
import { leagueRecords, toRecordGames, type PlayerRecord } from "@/lib/records";
import { formatNetWorth, cn, hasText } from "@/lib/utils";
import { rankMedalName } from "@/lib/rank";
import { pubTitle, pubToken } from "@/lib/player-pool";
import { parsePubStats, poolPubRecord, pubActivity } from "@/lib/pub-stats";
import {
  Avatar,
  Badge,
  buttonClasses,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  EmptyState,
  FormStrip,
  HeroIcon,
  HeroList,
  HeroPool,
  KDA,
  PlayerLink,
  RankMedal,
  RoleBadges,
  SectionTitle,
  Sparkline,
  Stat,
  TAP_SAFE,
  TeamCrest,
  textLink,
} from "@/components/ui";
import {
  INHOUSE_STATUS,
  MATCH_STATUS,
  REGISTRATION_STATUS,
} from "@/lib/constants";
import { PROVISIONAL_GAMES } from "@/lib/inhouse-stats";
import { loadInhouseLadder } from "@/lib/inhouse-ladder";
import { parseInhouseBox } from "@/lib/inhouse-box";
import { inhousePlayedAt } from "@/lib/inhouse-history";
import { formatMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import { resultFor, type FormResult } from "@/lib/team-matches";
import { achievementsFor, gameMvp } from "@/lib/achievements";
import {
  careerReportCard,
  gradeFor,
  gradeTone,
  percentLabel,
} from "@/lib/benchmarks";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import { canViewLeagueContact } from "@/lib/visibility";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [user, gameScores] = await Promise.all([
    prisma.user.findUnique({
      where: { id },
      select: { name: true, rankTier: true, pubStats: true },
    }),
    getAllGameScores(),
  ]);
  // notFound() in metadata runs before the shell streams → real 404 status.
  if (!user) notFound();
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
  return shareMetadata(
    `${user.name} · Player`,
    `${user.name}'s player profile${highlights.length > 0 ? ` · ${highlights.join(" · ")}` : ""} — match history in GGD2L.`,
  );
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

  const [season, viewer] = await Promise.all([
    getActiveSeason(),
    getSessionUser(),
  ]);
  const isSelf = viewer?.id === id;

  const [
    registration,
    membership,
    seasonTeams,
    seasonMatches,
    careerMemberships,
    gamesLite,
    recentInhouse,
    recordRows,
    viewerRegistration,
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
    prisma.teamMember.findMany({
      where: { userId: id },
      include: { team: { include: { season: true } } },
    }),
    // A player's userId lives inside each game's stored box-score JSON, not a
    // column, so pass 1 is a lightweight scan (no joins) to find their game ids.
    // Cached (viewer-independent) so every profile view doesn't re-scan the
    // whole Game table — see getAllGameLines.
    getAllGameLines(),
    // Latest completed inhouse game doubles as the activity-card data and the
    // gate for the streamed ladder card, so league-only players never mount a
    // skeleton that will immediately disappear.
    prisma.inhouseLobby.findFirst({
      where: {
        status: INHOUSE_STATUS.COMPLETED,
        players: { some: { userId: id } },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        matchStartTime: true,
        startedAt: true,
        createdAt: true,
      },
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
  ]);
  const recentInhousePlayedAt = recentInhouse
    ? inhousePlayedAt(recentInhouse)
    : null;

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

  const accountId = user.dotaAccountId ?? steamIdToAccountId(user.steamId);

  // A signup row exists for WITHDRAWN/REMOVED players too — only an ACTIVE one
  // may render as a live signup (MMR, roles, Standin badge, the whole Signup
  // profile card). WITHDRAWN gets an honest badge instead of reading as a
  // biddable "Registered"; REMOVED renders exactly as unregistered — a
  // moderation decision is not a public scarlet letter.
  const activeReg =
    registration?.status === REGISTRATION_STATUS.ACTIVE ? registration : null;
  const canSeeLeagueContact = canViewLeagueContact(
    viewer,
    id,
    viewerRegistration?.status === REGISTRATION_STATUS.ACTIVE,
  );
  const withdrewThisSeason =
    registration?.status === REGISTRATION_STATUS.WITHDRAWN;

  // All-time league records THIS player holds. Same mapping as /records
  // (shared toRecordGames) so the chips can never disagree with the book.
  const heldRecords = leagueRecords(toRecordGames(recordRows)).players.filter(
    (r) => r.userId === id,
  );

  // Pub scouting (public data — same visibility rule as the medal): the token
  // gate comes from poolPubRecord (null when nothing is scoutable), the hero
  // card uses the full stored top-5. One clock for every recency label.
  // eslint-disable-next-line react-hooks/purity -- async server component
  const nowMs = Date.now();
  const pubScout = poolPubRecord(user.pubStats);
  const pubActivityNow = pubScout
    ? pubActivity(pubScout.lastPlayedAt, nowMs)
    : null;
  const pubHeroes = parsePubStats(user.pubStats)?.topHeroes ?? [];

  // Career: every season this player was rostered in, with their team's record.
  const careerSeasonIds = [
    ...new Set(careerMemberships.map((m) => m.team.seasonId)),
  ];
  const careerMatches = careerSeasonIds.length
    ? await prisma.match.findMany({
        where: { seasonId: { in: careerSeasonIds } },
      })
    : [];
  const careerMatchesBySeason = new Map<string, typeof careerMatches>();
  for (const match of careerMatches) {
    const seasonMatches = careerMatchesBySeason.get(match.seasonId) ?? [];
    seasonMatches.push(match);
    careerMatchesBySeason.set(match.seasonId, seasonMatches);
  }
  const championBySeason = new Map<string, string | null>();
  for (const membership of careerMemberships) {
    const careerSeason = membership.team.season;
    if (championBySeason.has(careerSeason.id)) continue;
    championBySeason.set(
      careerSeason.id,
      resolveChampionPresentation(
        careerSeason,
        careerMatchesBySeason.get(careerSeason.id) ?? [],
      ).championTeamId,
    );
  }
  const careerRows = careerMemberships
    .map((m) => {
      const tally = { W: 0, L: 0, D: 0 };
      for (const match of careerMatchesBySeason.get(m.team.seasonId) ?? []) {
        if (match.status !== MATCH_STATUS.COMPLETED) continue;
        if (match.homeTeamId !== m.teamId && match.awayTeamId !== m.teamId) {
          continue;
        }
        tally[resultFor(m.teamId, match)]++;
      }
      return {
        membership: m,
        tally,
        champion: championBySeason.get(m.team.seasonId) === m.teamId,
      };
    })
    .sort(
      (a, b) =>
        b.membership.team.season.createdAt.getTime() -
        a.membership.team.season.createdAt.getTime(),
    );
  const titles = careerRows.filter((r) => r.champion).length;

  // Served cover — the standin's season, which used to vanish from every
  // player-visible surface the moment each match completed (/me filters to
  // pending, the rostered-seasons card never saw them). Recognition is the
  // league's cheapest standin-recruitment tool for season two. COMPLETED
  // matches only: pending bookings are /me's operational state, not history.
  const coverServed = await prisma.standinAssignment.findMany({
    where: { standinUserId: id, match: { status: "COMPLETED" } },
    select: {
      match: {
        select: {
          seasonId: true,
          season: { select: { name: true, createdAt: true } },
        },
      },
    },
  });
  const coverSeasons = [
    ...coverServed
      .reduce((acc, c) => {
        const cur = acc.get(c.match.seasonId);
        if (cur) cur.count += 1;
        else
          acc.set(c.match.seasonId, {
            seasonId: c.match.seasonId,
            name: c.match.season.name,
            createdAt: c.match.season.createdAt,
            count: 1,
          });
        return acc;
      }, new Map<string, { seasonId: string; name: string; createdAt: Date; count: number }>())
      .values(),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  // Pull this player's line out of each imported game — every season's games.
  // The parsed box score is kept so achievements can identify each game's MVP;
  // won/mvp are computed once here and shared by the tiles, the badge math,
  // and the match-history rows (the 🏅 chip).
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
  // Stat tiles show the active season once it has games, career otherwise —
  // so veterans keep a record during SIGNUPS/DRAFT of a new season.
  const hasSeasonGames = seasonSummary.games > 0;
  const tiles = hasSeasonGames ? seasonSummary : careerSummary;
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
  const overallGrade =
    reportCard.avgPct != null ? gradeFor(reportCard.avgPct) : null;

  // Per-hero W-L/KDA for the hero card, and rivalry math for the nemesis/duo
  // card — both pure folds over lines already in memory (zero new queries).
  // ScoutGame/MeetingGame are the exact shapes the match-preview dossier and
  // /players/compare already consume.
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

  const meetingGames: MeetingGame[] = gameRows.map((r) => ({
    radiantWin: r.game.radiantWin,
    lines: r.parsed.map((p) => ({
      userId: p.userId ?? null,
      isRadiant: p.isRadiant,
    })),
  }));
  const affinities = topAffinities(meetingGames, id);
  const affinityIds = [
    ...new Set(
      [affinities.nemesis?.userId, affinities.duo?.userId].filter(
        (v): v is string => !!v,
      ),
    ),
  ];
  const affinityUsers = affinityIds.length
    ? await prisma.user.findMany({
        where: { id: { in: affinityIds } },
        select: { id: true, name: true },
      })
    : [];
  const affinityName = new Map(affinityUsers.map((u) => [u.id, u.name]));
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

  // Group the career match history by season. gameRows is newest-first, so a
  // Map keyed by seasonId yields seasons newest-first by first appearance —
  // and a season stays one group even if a game with no start time (startTime
  // defaults to 0) sorts out of order. A per-season header shows only when the
  // player has games across more than one season.
  const bySeason = new Map<
    string,
    { seasonId: string; seasonName: string; rows: typeof gameRows }
  >();
  for (const row of gameRows) {
    const sId = row.game.match.seasonId;
    const group = bySeason.get(sId);
    if (group) group.rows.push(row);
    else
      bySeason.set(sId, {
        seasonId: sId,
        seasonName: row.game.match.season.name,
        rows: [row],
      });
  }
  const historyGroups = [...bySeason.values()];
  const multiSeasonHistory = historyGroups.length > 1;
  // An unknown `?season=` falls back to the all-seasons view rather than
  // presenting a misleading empty history (links copied from an old profile
  // should stay useful after a season gets removed or renamed).
  const selectedHistoryGroup = historySeasonParam
    ? historyGroups.find((group) => group.seasonId === historySeasonParam)
    : undefined;
  const visibleHistoryGroups = selectedHistoryGroup
    ? [selectedHistoryGroup]
    : historyGroups;
  const latestLeagueGame = gameRows.find((row) => row.game.startTime > 0);

  // Team + record for this season, if drafted.
  const team = membership?.team ?? null;
  const standings =
    team && seasonTeams.length
      ? computeStandings(
          seasonTeams.map((t) => t.id),
          seasonMatches,
        )
      : [];
  const teamRow = team
    ? standings.find((s) => s.teamId === team.id)
    : undefined;
  const teamRank = team
    ? standings.findIndex((s) => s.teamId === team.id) + 1
    : 0;

  const roles = roleLabels(activeReg?.roles);
  const isStandin = activeReg?.type === "STANDIN";
  const isCaptain = !!membership?.isCaptain;
  const subtitle = season
    ? isStandin
      ? `Standin · ${season.name}`
      : team
        ? `${isCaptain ? "Captain" : "Player"} · ${team.name}`
        : activeReg
          ? `Registered · ${season.name}`
          : season.name
    : null;
  // A signature hero for the banner backdrop: most-played if we have games,
  // otherwise the player's first listed favorite.
  const signatureHero =
    (careerSummary.topHeroes[0]
      ? heroById(careerSummary.topHeroes[0].heroId)
      : null) ??
    parseHeroList(activeReg?.favoriteHeroes).matched[0] ??
    null;

  // Band/card visibility, computed once so a SectionTitle can never render
  // above an empty band. Everything gates on data presence, never phase.
  const signupCardVisible =
    !!activeReg &&
    (hasText(activeReg.statement) ||
      hasText(activeReg.captainNote) ||
      activeReg.wantsCaptain);
  const selfPickedHeroes = activeReg?.favoriteHeroes;
  const heroCardVisible =
    leagueHeroes.length > 0 ||
    pubHeroes.length > 0 ||
    hasText(selfPickedHeroes);
  const connectionsVisible = !!affinities.nemesis || !!affinities.duo;
  const activityVisible =
    !!latestLeagueGame || !!recentInhouse || !!pubActivityNow;
  const newSignupVisible = !!activeReg && gameRows.length === 0;
  const signupSnapshotVisible =
    !!activeReg && (newSignupVisible || signupCardVisible);

  // Economy averages + a standout game. Net-worth/GPM/last-hits are optional per
  // game (older imports may lack them), so average only over games that have it.
  type GameRow = (typeof gameRows)[number];
  const avgOf = (
    rows: GameRow[],
    pick: (s: PlayerStat) => number | null | undefined,
  ) =>
    rows.length
      ? Math.round(
          rows.reduce((sum, r) => sum + (pick(r.stat) ?? 0), 0) / rows.length,
        )
      : null;
  const avgNet = avgOf(
    gameRows.filter((r) => r.stat.netWorth != null),
    (s) => s.netWorth,
  );
  const avgGpm = avgOf(
    gameRows.filter((r) => r.stat.gpm != null),
    (s) => s.gpm,
  );
  const avgLh = avgOf(
    gameRows.filter((r) => r.stat.lastHits != null),
    (s) => s.lastHits,
  );
  const bestGame =
    gameRows.length > 0
      ? [...gameRows].sort(
          (a, b) =>
            (b.stat.netWorth ?? 0) - (a.stat.netWorth ?? 0) ||
            b.stat.kills + b.stat.assists - (a.stat.kills + a.stat.assists),
        )[0]
      : null;
  const hasPerf = avgNet != null || avgGpm != null;
  const bestView = bestGame
    ? {
        matchId: bestGame.game.matchId,
        hero: heroById(bestGame.stat.heroId),
        heroId: bestGame.stat.heroId,
        won: bestGame.stat.isRadiant === bestGame.game.radiantWin,
        kills: bestGame.stat.kills,
        deaths: bestGame.stat.deaths,
        assists: bestGame.stat.assists,
        netWorth: bestGame.stat.netWorth,
        gpm: bestGame.stat.gpm,
        week: bestGame.game.match.week,
        opponent:
          bestGame.stat.teamId === bestGame.game.match.homeTeamId
            ? bestGame.game.match.awayTeam.name
            : bestGame.stat.teamId === bestGame.game.match.awayTeamId
              ? bestGame.game.match.homeTeam.name
              : `${bestGame.game.match.homeTeam.name} / ${bestGame.game.match.awayTeam.name}`,
      }
    : null;

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <Link href="/players" className={textLink("text-sm")}>
            ← All players
          </Link>
          <Link
            href={`/players/compare?a=${user.id}`}
            className={textLink("text-sm")}
          >
            Compare vs… →
          </Link>
        </div>
        <div className="relative overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-br from-surface-2/70 via-surface/50 to-surface/30 shadow-sm">
          {/* Signature hero portrait fading in from the right. */}
          {signatureHero ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-2/3 sm:w-1/2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={heroPortrait(signatureHero)}
                alt=""
                className="profile-hero-bg h-full w-full object-cover object-center opacity-30"
              />
            </div>
          ) : null}
          {/* Ambient graphics shared with the home hero for brand cohesion. */}
          <div
            aria-hidden
            className="hero-grid pointer-events-none absolute inset-0 opacity-50"
          />
          <div
            aria-hidden
            className="animate-hero-glow pointer-events-none absolute -left-8 top-0 h-40 w-40 -translate-y-1/3 rounded-full bg-brand/20 blur-3xl"
          />
          <div
            aria-hidden
            className="animate-hero-glow-alt pointer-events-none absolute -right-8 bottom-0 h-40 w-40 translate-y-1/3 rounded-full bg-accent/15 blur-3xl"
          />
          <div className="relative flex flex-wrap items-center gap-5 p-6">
            <Avatar
              name={user.name}
              src={user.avatar}
              size={88}
              className="shrink-0 shadow-lg shadow-black/40 ring-2 ring-line/80"
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="font-display text-3xl font-bold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">
                  {user.name}
                </h1>
                {user.role === "ADMIN" ? (
                  <Badge tone="accent">Admin</Badge>
                ) : null}
                {isCaptain ? <Badge tone="brand">Captain</Badge> : null}
                {isStandin ? <Badge tone="info">Standin</Badge> : null}
                {withdrewThisSeason ? (
                  <Badge tone="neutral">Withdrew this season</Badge>
                ) : null}
                <RankMedal rankTier={user.rankTier} size={34} showLabel />
              </div>
              {subtitle ? (
                <div className="mt-1 text-sm text-muted">
                  {subtitle}
                  {isSelf ? (
                    <>
                      {" · "}
                      <Link href="/me" className={textLink()}>
                        Edit your signup →
                      </Link>
                    </>
                  ) : null}
                </div>
              ) : null}
              {/* gap-y-2, not gap-y-1.5: every link in this row carries
                  TAP_SAFE, which grows the hit box 4px above and below, so two
                  wrapped rows need >=8px between them. At 6px the Dotabuff and
                  OpenDota boxes overlapped by 2px (measured) and OpenDota
                  painted last, so a tap on the bottom edge of Dotabuff opened
                  OpenDota. Same rule player-pool.tsx already states: hit boxes
                  may touch, never overlap. */}
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
                {activeReg ? (
                  <span>
                    <span className="font-semibold text-fg">
                      {activeReg.mmr}
                    </span>{" "}
                    MMR
                  </span>
                ) : null}
                {roles.length > 0 ? (
                  <RoleBadges roles={activeReg?.roles} />
                ) : null}
                {pubScout ? (
                  <span
                    className="tabular-nums"
                    title={pubTitle(pubScout, nowMs)}
                  >
                    {pubToken(pubScout)}
                  </span>
                ) : null}
                {pubActivityNow?.quiet ? (
                  <span title="No visible pub games in over two months — the listed MMR may describe who they used to be">
                    last played {pubActivityNow.label}
                  </span>
                ) : null}
                {canSeeLeagueContact && user.fhUnavailable === true ? (
                  /* Members-only operational flag, like the Discord tokens
                     below. === true on purpose: null is UNKNOWN and unknown
                     must never render as a negative. */
                  <span
                    className="text-muted"
                    title="Expose Public Match Data is off in their Dota client — their games can't auto-import, so results need the manual report paths"
                  >
                    private match data
                  </span>
                ) : null}
                {user.profileUrl ? (
                  <a
                    href={user.profileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={textLink()}
                  >
                    Steam ↗
                  </a>
                ) : null}
                {accountId ? (
                  <>
                    <a
                      href={`https://www.dotabuff.com/players/${accountId}`}
                      target="_blank"
                      rel="noreferrer"
                      className={textLink()}
                    >
                      Dotabuff ↗
                    </a>
                    <a
                      href={`https://www.opendota.com/players/${accountId}`}
                      target="_blank"
                      rel="noreferrer"
                      className={textLink()}
                    >
                      OpenDota ↗
                    </a>
                  </>
                ) : null}
                {canSeeLeagueContact ? (
                  <DiscordTag
                    name={user.discordName}
                    verified={!!user.discordId}
                  />
                ) : null}
                {canSeeLeagueContact && !user.discordName ? (
                  /* Members-only like the tag itself: on draft night the
                     absence IS the information — this player can't be reached
                     where the league lives. */
                  <span
                    className="text-muted"
                    title="No Discord linked or entered — the league coordinates on Discord, so reaching this player takes extra work"
                  >
                    no Discord
                  </span>
                ) : null}
              </div>
            </div>
            {team ? (
              // basis-full below sm: this card and the name column are flex
              // siblings, and the column carries `min-w-0` (it must, or a long
              // name widens the page). min-w-0 sets its min-content
              // contribution to ZERO, so the row can never overflow and
              // `flex-wrap` NEVER FIRES — the card kept its full 153px and the
              // name column absorbed the whole shortfall. Measured at 375px it
              // was 12px wide, and `[overflow-wrap:anywhere]` on the h1 then
              // rendered the player's name ONE CHARACTER PER LINE: a 504px-tall
              // h1 in a 908px hero card, with Dotabuff/OpenDota squeezed to
              // 57px and wrapped onto two lines ~940px down. Broken at every
              // phone width, healthy by 640px — which is why it never showed up
              // on a desktop. Taking the card out of the line is the fix that
              // cannot backfire: the floor has to go on the item that is
              // ALLOWED to shrink, and a min-width on the name column instead
              // overflows the page below ~320px.
              <Link
                href={`/teams/${team.id}`}
                className="basis-full rounded-lg border border-line bg-surface/60 px-4 py-2 text-sm backdrop-blur transition-colors hover:border-muted/60 sm:basis-auto"
              >
                <div className="text-xs uppercase tracking-wide text-muted">
                  Team
                </div>
                <div className="font-medium">{team.name}</div>
                {membership ? (
                  <div className="text-xs text-muted">
                    {membership.isCaptain
                      ? "Captain"
                      : `Drafted for $${membership.price}`}
                  </div>
                ) : null}
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      {tiles.games > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label={hasSeasonGames ? "Record" : "Career record"}
            value={`${tiles.wins}–${tiles.losses}`}
            hint={
              hasSeasonGames && careerSummary.games > seasonSummary.games
                ? `${tiles.winRate}% · career ${careerSummary.wins}–${careerSummary.losses}`
                : `${tiles.winRate}% win rate`
            }
          />
          <Stat label="Games" value={tiles.games} hint={streakLabel} />
          <Stat
            label="Avg KDA"
            value={`${tiles.avgKills}/${tiles.avgDeaths}/${tiles.avgAssists}`}
            hint={`${tiles.kda} ratio`}
          />
          {team ? (
            <Stat
              label="Team rank"
              value={teamRank > 0 ? `#${teamRank}` : "—"}
              hint={
                teamRow
                  ? `${teamRow.wins}–${teamRow.losses} · ${teamRow.points} pts`
                  : undefined
              }
            />
          ) : (
            <Stat
              label="Hero pool"
              value={careerSummary.topHeroes.length}
              hint="heroes played"
            />
          )}
        </div>
      ) : null}

      {/* ---------- How they play ---------- */}
      {/* Bands: an h2 SectionTitle over an auto-fit grid. auto-fit, NEVER
          grid-cols-1 (it silently wins the cascade and collapses the band at
          every width — the dashboard rule): every card here is conditional,
          so an absent one must collapse its track instead of leaving a hole. */}
      {hasPerf || reportCard.graded > 0 ? (
        <section className="space-y-3">
          <SectionTitle>How they play</SectionTitle>
          <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(20rem,100%),1fr))]">
            {hasPerf ? (
              <Card className="min-w-0">
                <CardHeader
                  title="Performance"
                  subtitle="Averages across every season's imported games"
                />
                <CardBody className="space-y-4">
                  {/* auto-fit, not grid-cols-3: each Stat is individually
                      null-gated (legacy imports lack economy fields), and a
                      fixed 3-track grid holds a hole per missing metric. */}
                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(8rem,100%),1fr))]">
                    {avgNet != null ? (
                      <Stat
                        label="Avg net worth"
                        value={formatNetWorth(avgNet)}
                      />
                    ) : null}
                    {avgGpm != null ? (
                      <Stat label="Avg GPM" value={avgGpm} />
                    ) : null}
                    {avgLh != null ? (
                      <Stat label="Avg last hits" value={avgLh} />
                    ) : null}
                  </div>
                  {kdaByGame.length >= 2 ? (
                    /* max-w-md: full width, justify-between held ~700px of
                       dead middle between label and sparkline at desktop. */
                    <div className="flex max-w-md items-center justify-between gap-4 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
                      <div>
                        <div className="text-xs font-medium uppercase tracking-wide text-muted">
                          KDA by game
                        </div>
                        <div className="text-xs text-muted">
                          last {kdaByGame.length}
                        </div>
                      </div>
                      <Sparkline values={kdaByGame} width={160} height={38} />
                    </div>
                  ) : null}
                  {bestView ? (
                    <Link
                      href={`/matches/${bestView.matchId}`}
                      className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 p-3 text-sm transition-colors hover:border-muted/60"
                    >
                      <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
                        Standout
                      </span>
                      {bestView.hero ? (
                        <HeroIcon hero={bestView.hero} size={30} />
                      ) : null}
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">
                          {bestView.hero?.name ?? `Hero ${bestView.heroId}`}
                        </span>
                        <span className="block text-xs text-muted">
                          vs {bestView.opponent} · Wk {bestView.week}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <KDA
                          kills={bestView.kills}
                          deaths={bestView.deaths}
                          assists={bestView.assists}
                          className="block text-xs"
                        />
                        <span className="block text-xs text-muted">
                          {formatNetWorth(bestView.netWorth)}
                          {bestView.gpm != null ? ` · ${bestView.gpm} GPM` : ""}
                        </span>
                      </span>
                      <Badge tone={bestView.won ? "success" : "danger"}>
                        {bestView.won ? "W" : "L"}
                      </Badge>
                    </Link>
                  ) : null}
                </CardBody>
              </Card>
            ) : null}
            {reportCard.graded > 0 ? (
              <Card className="min-w-0">
                <CardHeader
                  title="Report card"
                  subtitle={`How they stack up vs the world on their heroes — OpenDota percentiles over ${reportCard.graded} graded game${reportCard.graded === 1 ? "" : "s"}`}
                />
                <CardBody className="space-y-4">
                  {overallGrade != null && reportCard.avgPct != null ? (
                    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-4 py-3">
                      <span
                        className={cn(
                          "font-display text-4xl font-bold leading-none",
                          gradeTone(overallGrade) === "success"
                            ? "text-success"
                            : gradeTone(overallGrade) === "accent"
                              ? "text-accent"
                              : gradeTone(overallGrade) === "muted"
                                ? "text-muted"
                                : "text-fg/80",
                        )}
                      >
                        {overallGrade}
                      </span>
                      <span className="text-sm text-muted">
                        overall — {percentLabel(reportCard.avgPct)} vs the world
                        on their heroes
                      </span>
                    </div>
                  ) : null}
                  <ul className="space-y-2">
                    {reportCard.metrics.map((m) => {
                      const grade = gradeFor(m.avgPct);
                      const tone = gradeTone(grade);
                      return (
                        <li
                          key={m.key}
                          className="flex items-center gap-3 text-sm"
                        >
                          <span className="w-28 shrink-0 truncate text-xs text-muted sm:w-32">
                            {m.label}
                          </span>
                          <span
                            role="img"
                            aria-label={`${m.label}: ${percentLabel(m.avgPct)}, grade ${grade}`}
                            className="min-w-0 flex-1"
                          >
                            <span className="block h-2 w-full overflow-hidden rounded-full bg-surface-2">
                              <span
                                className={cn(
                                  "block h-full rounded-full",
                                  tone === "success"
                                    ? "bg-success/80"
                                    : tone === "accent"
                                      ? "bg-accent/80"
                                      : tone === "muted"
                                        ? "bg-line"
                                        : "bg-fg/40",
                                )}
                                style={{
                                  width: `${Math.round(m.avgPct * 100)}%`,
                                }}
                              />
                            </span>
                          </span>
                          <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted">
                            {percentLabel(m.avgPct).replace(" percentile", "")}
                            <b
                              className={cn(
                                "ml-1.5 font-semibold",
                                tone === "success"
                                  ? "text-success"
                                  : tone === "accent"
                                    ? "text-accent"
                                    : "text-fg/80",
                              )}
                            >
                              {grade}
                            </b>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {reportCard.best || reportCard.focus ? (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {reportCard.best ? (
                        <div className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-xs">
                          <span aria-hidden>💪</span> <b>Strength:</b>{" "}
                          {reportCard.best.label} —{" "}
                          {percentLabel(reportCard.best.avgPct)}
                        </div>
                      ) : null}
                      {reportCard.focus ? (
                        <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
                          <span aria-hidden>🎯</span> <b>Work on:</b>{" "}
                          {reportCard.focus.label} —{" "}
                          {percentLabel(reportCard.focus.avgPct)}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            ) : null}
          </div>
        </section>
      ) : null}

      {activityVisible ||
      signupSnapshotVisible ||
      heroCardVisible ||
      heldRecords.length > 0 ||
      connectionsVisible ? (
        <section className="space-y-3">
          <SectionTitle>Player profile</SectionTitle>
          <div className="grid gap-6 lg:grid-cols-2">
            {activityVisible || signupSnapshotVisible ? (
              <Card
                className={cn(
                  "min-w-0",
                  activityVisible && signupSnapshotVisible && "lg:col-span-2",
                )}
              >
                <CardHeader
                  title={
                    signupSnapshotVisible
                      ? "League snapshot"
                      : "Recent activity"
                  }
                  subtitle={
                    signupSnapshotVisible
                      ? "Signup details, availability, and recent activity"
                      : "The latest signal from league and public play"
                  }
                />
                <CardBody className="space-y-5 text-sm">
                  {activityVisible ? (
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-line/60 bg-surface-2/30 px-3 py-2.5">
                      {signupSnapshotVisible ? (
                        <h4 className="text-xs font-medium uppercase tracking-wide text-muted">
                          Recent activity
                        </h4>
                      ) : null}
                      {latestLeagueGame ? (
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="text-muted">League game</span>
                          <Link
                            href={`/matches/${latestLeagueGame.game.matchId}`}
                            className="font-medium hover:text-info hover:underline"
                          >
                            <LocalTime
                              ts={latestLeagueGame.game.startTime * 1000}
                              variant="short"
                              initial={formatMatchTime(
                                new Date(
                                  latestLeagueGame.game.startTime * 1000,
                                ),
                                "short",
                              )}
                            />
                          </Link>
                        </div>
                      ) : null}
                      {recentInhouse ? (
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="text-muted">Inhouse game</span>
                          <Link
                            href={`/inhouse/history#result-${recentInhouse.id}`}
                            className="font-medium hover:text-info hover:underline"
                          >
                            <LocalTime
                              ts={recentInhousePlayedAt!.getTime()}
                              variant="short"
                              initial={formatMatchTime(
                                recentInhousePlayedAt!,
                                "short",
                              )}
                            />
                          </Link>
                        </div>
                      ) : null}
                      {pubActivityNow ? (
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="text-muted">Public pub</span>
                          <span className="font-medium">
                            last played {pubActivityNow.label}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {signupSnapshotVisible && activeReg ? (
                    <div className="space-y-4">
                      <h4 className="font-medium text-fg">Signup profile</h4>
                      {newSignupVisible ? (
                        <div className="rounded-lg border border-line/60 bg-surface-2/30 px-3 py-2.5">
                          <h4 className="font-medium text-fg">
                            Ready for the first game
                          </h4>
                          <p className="mt-0.5 text-xs text-muted">
                            League stats appear after the first imported match.
                          </p>
                        </div>
                      ) : null}
                      <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
                        {roles.length > 0 ? (
                          <Detail label="Preferred roles">
                            <RoleBadges roles={activeReg.roles} />
                          </Detail>
                        ) : null}
                        {hasText(selfPickedHeroes) ? (
                          <Detail label="Wants to play">
                            <HeroList value={selfPickedHeroes} size={24} />
                          </Detail>
                        ) : null}
                        {activeReg.wantsCaptain ? (
                          <Detail label="Captaincy">
                            <Badge tone="brand">Wants to captain</Badge>
                          </Detail>
                        ) : null}
                        {hasText(activeReg.statement) ? (
                          <Detail label="Goals">
                            <span className="text-muted">
                              {activeReg.statement}
                            </span>
                          </Detail>
                        ) : null}
                        {hasText(activeReg.captainNote) ? (
                          <Detail label="Note for captains">
                            <span className="italic text-muted">
                              &ldquo;{activeReg.captainNote}&rdquo;
                            </span>
                          </Detail>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            ) : null}

            {heroCardVisible ? (
              <Card
                className={cn(
                  "min-w-0",
                  activityVisible && signupSnapshotVisible && "lg:col-span-2",
                )}
              >
                <CardHeader
                  title="Hero pool"
                  subtitle="League games, public pubs, and heroes they want to play"
                />
                <CardBody className="space-y-4">
                  {leagueHeroes.length > 0 ? (
                    <div className="space-y-2">
                      <div className="text-xs font-medium uppercase tracking-wide text-muted">
                        In this league
                      </div>
                      <HeroPool heroes={leagueHeroes} />
                    </div>
                  ) : null}
                  {hasText(selfPickedHeroes) ? (
                    <div className="space-y-2">
                      <div className="text-xs font-medium uppercase tracking-wide text-muted">
                        Wants to play
                      </div>
                      <HeroList value={selfPickedHeroes} size={26} />
                    </div>
                  ) : null}
                  {pubHeroes.length > 0 ? (
                    <div className="space-y-2">
                      <div className="text-xs font-medium uppercase tracking-wide text-muted">
                        In public pubs
                      </div>
                      <HeroPool heroes={pubHeroes} limit={5} />
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            ) : null}

            {heldRecords.length > 0 ? (
              <Card className="min-w-0">
                <CardHeader
                  title="League records"
                  subtitle="All-time single-game records"
                  action={
                    <Link href="/records" className={textLink("text-sm")}>
                      Record book →
                    </Link>
                  }
                />
                <CardBody className="flex flex-wrap gap-2">
                  {heldRecords.map((record) => {
                    const hero = heroById(record.heroId);
                    return (
                      <Link
                        key={record.key}
                        href={`/matches/${record.matchId}`}
                        className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-sm transition-colors hover:border-muted/60"
                        title={`${record.title}: ${recordDisplayValue(record)}`}
                      >
                        <span aria-hidden>{record.emoji}</span>
                        {hero ? <HeroIcon hero={hero} size={22} /> : null}
                        <span>
                          <span className="block font-medium">
                            {record.title}
                          </span>
                          <span className="block font-mono text-xs tabular-nums text-muted">
                            {recordDisplayValue(record)}
                          </span>
                        </span>
                        <Badge tone={record.won ? "success" : "danger"}>
                          {record.won ? "W" : "L"}
                        </Badge>
                      </Link>
                    );
                  })}
                </CardBody>
              </Card>
            ) : null}

            {connectionsVisible ? (
              <Card className="min-w-0">
                <CardHeader
                  title="League connections"
                  subtitle="Across imported league games"
                />
                <CardBody className="space-y-4 text-sm">
                  {affinities.nemesis ? (
                    <Connection
                      label="Nemesis"
                      emoji="⚔️"
                      profileId={id}
                      playerId={affinities.nemesis.userId}
                      playerName={affinityName.get(affinities.nemesis.userId)}
                      games={affinities.nemesis.games}
                      wins={affinities.nemesis.wins}
                      losses={affinities.nemesis.losses}
                      detail="as rivals"
                    />
                  ) : null}
                  {affinities.duo ? (
                    <Connection
                      label="Best duo"
                      emoji="🤝"
                      profileId={id}
                      playerId={affinities.duo.userId}
                      playerName={affinityName.get(affinities.duo.userId)}
                      games={affinities.duo.games}
                      wins={affinities.duo.wins}
                      losses={affinities.duo.losses}
                      detail="as teammates"
                    />
                  ) : null}
                </CardBody>
              </Card>
            ) : null}
          </div>
        </section>
      ) : null}

      {badges.length > 0 ? (
        <Card>
          <CardHeader
            title="Achievements"
            subtitle="Earned across every season's imported games"
          />
          <CardBody className="flex flex-wrap gap-2">
            {badges.map((b) => (
              <span
                key={b.key}
                title={b.desc}
                className="flex items-center gap-1.5 rounded-full border border-line bg-surface-2/50 px-3 py-1 text-sm"
              >
                <span aria-hidden>{b.emoji}</span>
                {b.label}
                {b.count > 1 ? (
                  <span className="font-mono text-xs tabular-nums text-muted">
                    ×{b.count}
                  </span>
                ) : null}
              </span>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {careerRows.length > 0 || coverSeasons.length > 0 ? (
        <Card>
          <CardHeader
            title="Seasons"
            subtitle={
              careerRows.length > 0
                ? `${careerRows.length} season${careerRows.length === 1 ? "" : "s"} played${titles > 0 ? ` · ${titles} title${titles === 1 ? "" : "s"} 🏆` : ""}`
                : // A standin-only career is still a career — this card used
                  // to not render at all for the people who kept match nights
                  // running.
                  "Stood in when teams needed cover"
            }
          />
          <CardBody className="divide-y divide-line/60 p-0">
            {careerRows.map(({ membership: m, tally, champion }) => (
              <div
                key={m.id}
                // gap-y-2 for the TAP_SAFE rule below: at gap-y-1 (4px) the two
                // links' grown hit boxes would overlap when this row wraps.
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 text-sm"
              >
                <Link
                  href={`/seasons/${m.team.seasonId}`}
                  className={cn(
                    "w-24 shrink-0 text-muted hover:text-info",
                    TAP_SAFE,
                  )}
                >
                  {m.team.season.name}
                </Link>
                {/* Two unrelated fixes on one element, both measured.

                    basis-40 below sm — the same collapse as the hero, in its
                    other flavour. This is the `min-w-0 flex-1` child, and its
                    three siblings are all `shrink-0` (season 96px, the Captain
                    badge 67px, the W–L–D cell 36px). min-w-0 zeroes its
                    line-breaking contribution, so the row never overflows,
                    `flex-wrap` never fires, and the team name gets whatever is
                    left: measured 0px at 320, 21px at 360 and 36px at 375
                    against 119px of name — a captain reading their own profile
                    saw a crest, "Captain" and "3–0–1" with the team name gone.
                    It looks fine on a desktop because it is healthy from
                    ~500px. `truncate` is why the hero's squeezed-text tripwire
                    cannot see this one: one line, no ratio to measure.

                    TAP_SAFE — the link is a flex box sized by its 22px crest,
                    so it measured exactly 22px tall, under WCAG 2.5.8's 24px
                    floor, with two targets inside 24px of it. Being `flex` and
                    not inline, the spec's in-a-run-of-text exemption does not
                    cover it either. */}
                <Link
                  href={`/teams/${m.teamId}`}
                  className={cn(
                    "flex min-w-0 flex-1 basis-40 items-center gap-2 hover:text-info sm:basis-auto",
                    TAP_SAFE,
                  )}
                >
                  <TeamCrest
                    name={m.team.name}
                    seed={m.teamId}
                    size={22}
                    className="shrink-0 rounded-md"
                  />
                  <span className="truncate font-medium">{m.team.name}</span>
                  {champion ? <span title="Champion">🏆</span> : null}
                </Link>
                <span className="shrink-0 text-xs text-muted">
                  {m.isCaptain ? (
                    <Badge tone="accent">Captain</Badge>
                  ) : (
                    `$${m.price}`
                  )}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums">
                  {tally.W}–{tally.L}
                  {tally.D > 0 ? `–${tally.D}` : ""}
                </span>
              </div>
            ))}
            {coverSeasons.map((s) => (
              <div
                key={`cover-${s.seasonId}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 text-sm"
              >
                <Link
                  href={`/seasons/${s.seasonId}`}
                  className={cn(
                    "w-24 shrink-0 text-muted hover:text-info",
                    TAP_SAFE,
                  )}
                >
                  {s.name}
                </Link>
                <span className="min-w-0 flex-1 text-muted">
                  🧩 Stood in — {s.count} match{s.count === 1 ? "" : "es"}{" "}
                  covered
                </span>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {/* Inhouse career — only stream for players with a completed game. */}
      {recentInhouse ? (
        <Suspense fallback={<CardSkeleton rows={3} />}>
          <InhouseCareerCard userId={user.id} />
        </Suspense>
      ) : null}

      <Card>
        <CardHeader
          title="Match history"
          subtitle={
            gameRows.length > 0
              ? selectedHistoryGroup
                ? selectedHistoryGroup.seasonName
                : multiSeasonHistory
                  ? "All seasons"
                  : historyGroups[0]?.seasonName
              : (season?.name ?? undefined)
          }
          action={
            recentFormStrip.length > 0 || multiSeasonHistory ? (
              <div className="flex flex-wrap items-center gap-2">
                {recentFormStrip.length > 0 ? (
                  <FormStrip form={recentFormStrip} size={5} />
                ) : null}
                {multiSeasonHistory ? (
                  <form
                    method="get"
                    action={`/players/${id}`}
                    className="flex items-center gap-2"
                  >
                    <label>
                      <span className="sr-only">Show games from season</span>
                      <select
                        name="season"
                        defaultValue={selectedHistoryGroup?.seasonId ?? ""}
                        className="h-10 rounded-lg border border-line bg-surface-2/50 px-2 text-xs text-fg outline-none focus:border-accent/60 sm:h-8"
                      >
                        <option value="">All seasons</option>
                        {historyGroups.map((group) => (
                          <option key={group.seasonId} value={group.seasonId}>
                            {group.seasonName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="submit"
                      className={buttonClasses("secondary", "sm")}
                    >
                      View
                    </button>
                  </form>
                ) : null}
              </div>
            ) : undefined
          }
        />
        <CardBody className="p-0">
          {gameRows.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No games recorded yet"
                description="Games appear here once this player's matches are imported."
              />
            </div>
          ) : (
            <ul className="divide-y divide-line/60">
              {visibleHistoryGroups.map((group) => (
                <li key={group.seasonId}>
                  {multiSeasonHistory && !selectedHistoryGroup ? (
                    <Link
                      href={`/seasons/${group.seasonId}`}
                      className="flex items-center justify-between bg-surface-2/40 px-5 py-1.5 text-xs font-medium uppercase tracking-wide text-muted hover:text-info"
                    >
                      <span className="truncate">{group.seasonName}</span>
                      <span className="shrink-0 tabular-nums">
                        {group.rows.length} game
                        {group.rows.length === 1 ? "" : "s"}
                      </span>
                    </Link>
                  ) : null}
                  <ul className="divide-y divide-line/60">
                    {group.rows.map(({ game, stat }) => {
                      const won = wonGame({
                        isRadiant: stat.isRadiant,
                        radiantWin: game.radiantWin,
                        kills: 0,
                        deaths: 0,
                        assists: 0,
                        heroId: 0,
                      });
                      const hero = heroById(stat.heroId);
                      const opponentName =
                        stat.teamId === game.match.homeTeamId
                          ? game.match.awayTeam.name
                          : stat.teamId === game.match.awayTeamId
                            ? game.match.homeTeam.name
                            : `${game.match.homeTeam.name} / ${game.match.awayTeam.name}`;
                      return (
                        <li key={game.id}>
                          <Link
                            href={`/matches/${game.matchId}`}
                            className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-surface-2/40"
                          >
                            <Badge tone={won ? "success" : "danger"}>
                              {won ? "W" : "L"}
                            </Badge>
                            {hero ? <HeroIcon hero={hero} size={26} /> : null}
                            {/* Phones: two-line clamp + the compact phase
                                abbrev — a long opponent name (the fixture
                                stress-seeds a 47-char one) beside the two
                                rigid siblings (W/L badge, KDA) left a
                                single-line truncate rendering ~35% of itself
                                at 360px, right on the e2e-mid collapse
                                tripwire's line, with Linux/Android font
                                metrics deciding pass or fail. From sm up this
                                is byte-identical to the old single-line row. */}
                            <span className="min-w-0 flex-1 line-clamp-2 sm:line-clamp-none sm:truncate">
                              <span className="text-muted">vs </span>
                              <span className="font-medium">
                                {opponentName}
                              </span>
                              <span className="ml-2 text-xs uppercase text-muted sm:hidden">
                                {matchPhaseAbbrev(
                                  game.match.phase,
                                  game.match.week,
                                )}
                              </span>
                              <span className="ml-2 hidden text-xs uppercase text-muted sm:inline">
                                {matchPhaseLabel(
                                  game.match.phase,
                                  game.match.week,
                                )}
                              </span>
                            </span>
                            <KDA
                              kills={stat.kills}
                              deaths={stat.deaths}
                              assists={stat.assists}
                              className="shrink-0 text-xs"
                            />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-32 shrink-0 text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      <span className="flex flex-wrap items-center gap-2">{children}</span>
    </div>
  );
}

function recordDisplayValue(record: PlayerRecord): string {
  switch (record.key) {
    case "netWorth":
      return formatNetWorth(record.value);
    case "gpm":
      return `${record.value} GPM`;
    default:
      return String(record.value);
  }
}

function Connection({
  label,
  emoji,
  profileId,
  playerId,
  playerName,
  games,
  wins,
  losses,
  detail,
}: {
  label: string;
  emoji: string;
  profileId: string;
  playerId: string;
  playerName: string | undefined;
  games: number;
  wins: number;
  losses: number;
  detail: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span aria-hidden className="pt-0.5 text-lg">
        {emoji}
      </span>
      <div className="min-w-0">
        <div className="text-xs font-medium uppercase tracking-wide text-muted">
          {label}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <PlayerLink
            userId={playerId}
            className="font-semibold hover:text-info"
          >
            {playerName ?? "Unknown player"}
          </PlayerLink>
          <Link
            href={`/players/compare?a=${encodeURIComponent(profileId)}&b=${encodeURIComponent(playerId)}`}
            className={textLink("text-xs")}
          >
            Compare →
          </Link>
        </div>
        <div className="text-xs text-muted">
          <span className="tabular-nums">
            {wins}–{losses}
          </span>{" "}
          {detail} across {games} game{games === 1 ? "" : "s"}
        </div>
      </div>
    </div>
  );
}

// ---------- Inhouse career ----------

// The player's ladder identity, surfaced where people actually look each
// other up. Rank comes from the FULL ladder (Elo accumulates globally); the
// recent-game rows come from a separate small query with box scores.
async function InhouseCareerCard({ userId }: { userId: string }) {
  const [ladder, recent] = await Promise.all([
    loadInhouseLadder(),
    prisma.inhouseLobby.findMany({
      where: {
        status: INHOUSE_STATUS.COMPLETED,
        players: { some: { userId } },
      },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: {
        id: true,
        winnerTeam: true,
        radiantTeam: true,
        radiantScore: true,
        direScore: true,
        boxScore: true,
        matchStartTime: true,
        startedAt: true,
        createdAt: true,
        players: { select: { userId: true, team: true } },
      },
    }),
  ]);
  if (recent.length === 0) return null;

  const me = [...ladder.ranked, ...ladder.provisional].find(
    (r) => r.userId === userId,
  );
  if (!me) return null;
  const rank = ladder.ranked.findIndex((r) => r.userId === userId);

  const games = recent.map((l) => {
    const mine = l.players.find((p) => p.userId === userId);
    const line = parseInhouseBox(l.boxScore).find((b) => b.userId === userId);
    const won = mine?.team != null && mine.team === l.winnerTeam;
    return { lobby: l, line, won, playedAt: inhousePlayedAt(l) };
  });

  return (
    <Card>
      <CardHeader
        title="Inhouse"
        subtitle="Pick-up ladder across every inhouse game"
        action={
          <Link href="/inhouse" className={textLink("text-sm")}>
            Ladder →
          </Link>
        }
      />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
          <span className="tabular-nums">
            <span className="font-semibold">{me.rating}</span>
            <span className="text-muted"> Elo</span>
            <span className="ml-1 text-xs text-muted">(peak {me.peak})</span>
          </span>
          <span className="text-muted tabular-nums">
            {rank >= 0 ? `#${rank + 1} of ${ladder.ranked.length}` : "unranked"}
          </span>
          <span className="tabular-nums">
            <span className="text-success">{me.wins}W</span>
            <span className="text-muted">–</span>
            <span className="text-danger">{me.losses}L</span>
            <span className="ml-1 text-xs text-muted">
              {Math.round(me.winRate * 100)}%
            </span>
          </span>
          <FormStrip form={me.form} size={4} />
          {me.games < PROVISIONAL_GAMES ? (
            <Badge tone="neutral">provisional</Badge>
          ) : null}
        </div>

        <div className="divide-y divide-line/60 border-t border-line/60">
          {games.map(({ lobby, line, won, playedAt }) => {
            const hero = line ? heroById(line.heroId) : null;
            return (
              <Link
                key={lobby.id}
                href={`/inhouse/history#result-${lobby.id}`}
                className="flex items-center gap-3 py-2 text-sm transition-colors hover:bg-surface-2/40"
              >
                <span className="w-24 shrink-0 text-xs text-muted">
                  <LocalTime
                    ts={playedAt.getTime()}
                    variant="short"
                    initial={formatMatchTime(playedAt, "short")}
                  />
                </span>
                <Badge tone={won ? "success" : "danger"}>
                  {won ? "Win" : "Loss"}
                </Badge>
                <span className="font-mono text-xs tabular-nums text-muted">
                  {lobby.radiantScore ?? 0}–{lobby.direScore ?? 0}
                </span>
                <span className="flex min-w-0 flex-1 items-center justify-end gap-2">
                  {hero ? (
                    <>
                      <HeroIcon hero={hero} size={24} />
                      <span className="hidden truncate text-xs text-muted sm:inline">
                        {hero.name}
                      </span>
                    </>
                  ) : null}
                  {line ? (
                    <KDA
                      kills={line.kills}
                      deaths={line.deaths}
                      assists={line.assists}
                      className="shrink-0 text-xs"
                    />
                  ) : null}
                </span>
              </Link>
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}
