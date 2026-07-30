import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getAllGameLines } from "@/lib/cached-queries";
import { shareMetadata } from "@/lib/share-metadata";
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
  parseGamePlayers,
} from "@/lib/player-stats";
import type { PlayerStat } from "@/lib/match-import";
import { formatNetWorth, cn, hasText } from "@/lib/utils";
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
  HeroList,
  HeroPool,
  KDA,
  RankMedal,
  RoleBadges,
  Sparkline,
  Stat,
  TAP_SAFE,
  TeamCrest,
  textLink,
} from "@/components/ui";
import { INHOUSE_STATUS } from "@/lib/constants";
import {
  PROVISIONAL_GAMES,
  rankInhouse,
  summarizeInhouse,
} from "@/lib/inhouse-stats";
import { parseInhouseBox } from "@/lib/inhouse-box";
import { formatMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import { resultFor, type FormResult } from "@/lib/team-matches";
import { achievementsFor, gameMvp } from "@/lib/achievements";
import { careerReportCard, gradeFor, gradeTone, percentLabel } from "@/lib/benchmarks";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await prisma.user.findUnique({
    where: { id },
    select: { name: true },
  });
  // notFound() in metadata runs before the shell streams → real 404 status.
  if (!user) notFound();
  return shareMetadata(
    `${user.name} · Player`,
    `${user.name}'s player profile — record, heroes, and match history in GGD2L.`,
  );
}

export default async function PlayerProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
  ]);

  // Pass 2: only THIS player's games carry the heavy match/team/season joins
  // that feed the match history, stat tiles, achievements, and report card.
  const myGameIds = gamesLite
    .filter((g) => parseGamePlayers<PlayerStat>(g.players).some((p) => p.userId === id))
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

  // Career: every season this player was rostered in, with their team's record.
  const careerSeasonIds = [
    ...new Set(careerMemberships.map((m) => m.team.seasonId)),
  ];
  const careerMatches = careerSeasonIds.length
    ? await prisma.match.findMany({
        where: { seasonId: { in: careerSeasonIds }, status: "COMPLETED" },
      })
    : [];
  const careerRows = careerMemberships
    .map((m) => {
      const tally = { W: 0, L: 0, D: 0 };
      for (const match of careerMatches) {
        if (match.seasonId !== m.team.seasonId) continue;
        if (match.homeTeamId !== m.teamId && match.awayTeamId !== m.teamId) {
          continue;
        }
        tally[resultFor(m.teamId, match)]++;
      }
      return {
        membership: m,
        tally,
        champion: m.team.season.championTeamId === m.teamId,
      };
    })
    .sort(
      (a, b) =>
        b.membership.team.season.createdAt.getTime() -
        a.membership.team.season.createdAt.getTime(),
    );
  const titles = careerRows.filter((r) => r.champion).length;

  // Pull this player's line out of each imported game — every season's games.
  // The parsed box score is kept so achievements can identify each game's MVP.
  const gameRows = games
    .map((g) => {
      const parsed = parseGamePlayers<PlayerStat>(g.players);
      const stat = parsed.find((p) => p.userId === id);
      if (!stat) return null;
      return { game: g, stat, parsed };
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
  const achievementLines = gameRows.map(({ parsed, stat, game }) => ({
    kills: stat.kills,
    deaths: stat.deaths,
    assists: stat.assists,
    gpm: stat.gpm,
    lastHits: stat.lastHits,
    won: stat.isRadiant === game.radiantWin,
    mvp: gameMvp(parsed, game.radiantWin) === id,
  }));
  const badges = achievementsFor(achievementLines);
  // Career report card: worldwide percentile benchmarks over every graded line.
  const reportCard = careerReportCard(gameRows.map((r) => r.stat));
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

  // Team + record for this season, if drafted.
  const team = membership?.team ?? null;
  const standings =
    team && seasonTeams.length
      ? computeStandings(
          seasonTeams.map((t) => t.id),
          seasonMatches,
        )
      : [];
  const teamRow = team ? standings.find((s) => s.teamId === team.id) : undefined;
  const teamRank = team
    ? standings.findIndex((s) => s.teamId === team.id) + 1
    : 0;

  const roles = roleLabels(registration?.roles);
  const isStandin = registration?.type === "STANDIN";
  const isCaptain = !!membership?.isCaptain;
  const subtitle = season
    ? isStandin
      ? `Standin · ${season.name}`
      : team
        ? `${isCaptain ? "Captain" : "Player"} · ${team.name}`
        : registration
          ? `Registered · ${season.name}`
          : season.name
    : null;
  // A signature hero for the banner backdrop: most-played if we have games,
  // otherwise the player's first listed favorite.
  const signatureHero =
    (careerSummary.topHeroes[0]
      ? heroById(careerSummary.topHeroes[0].heroId)
      : null) ??
    parseHeroList(registration?.favoriteHeroes).matched[0] ??
    null;

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
                {registration ? (
                  <span>
                    <span className="font-semibold text-fg">
                      {registration.mmr}
                    </span>{" "}
                    MMR
                  </span>
                ) : null}
                {roles.length > 0 ? (
                  <RoleBadges roles={registration?.roles} />
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
                {viewer ? (
                  <DiscordTag
                    name={user.discordName}
                    verified={!!user.discordId}
                  />
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
                teamRow ? `${teamRow.wins}–${teamRow.losses} · ${teamRow.points} pts` : undefined
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

      {hasPerf ? (
        <Card>
          <CardHeader
            title="Performance"
            subtitle="Averages across every season's imported games"
          />
          <CardBody className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              {avgNet != null ? (
                <Stat label="Avg net worth" value={formatNetWorth(avgNet)} />
              ) : null}
              {avgGpm != null ? <Stat label="Avg GPM" value={avgGpm} /> : null}
              {avgLh != null ? <Stat label="Avg last hits" value={avgLh} /> : null}
            </div>
            {kdaByGame.length >= 2 ? (
              <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
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
        <Card>
          <CardHeader
            title="Report card"
            subtitle={`How they stack up vs the world on their heroes — OpenDota percentiles over ${reportCard.graded} graded game${reportCard.graded === 1 ? "" : "s"}`}
          />
          <CardBody className="space-y-4">
            <ul className="space-y-2">
              {reportCard.metrics.map((m) => {
                const grade = gradeFor(m.avgPct);
                const tone = gradeTone(grade);
                return (
                  <li key={m.key} className="flex items-center gap-3 text-sm">
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
                          style={{ width: `${Math.round(m.avgPct * 100)}%` }}
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
                    <span aria-hidden>💪</span>{" "}
                    <b>Strength:</b> {reportCard.best.label} —{" "}
                    {percentLabel(reportCard.best.avgPct)}
                  </div>
                ) : null}
                {reportCard.focus ? (
                  <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
                    <span aria-hidden>🎯</span>{" "}
                    <b>Work on:</b> {reportCard.focus.label} —{" "}
                    {percentLabel(reportCard.focus.avgPct)}
                  </div>
                ) : null}
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {registration &&
      (roles.length > 0 || registration.favoriteHeroes || registration.statement) ? (
        <Card>
          <CardHeader title="Signup profile" />
          <CardBody className="space-y-4 text-sm">
            {roles.length > 0 ? (
              <Detail label="Preferred roles">
                <RoleBadges roles={registration.roles} />
                <span className="text-muted">{roles.join(", ")}</span>
              </Detail>
            ) : null}
            {registration.favoriteHeroes ? (
              <Detail label="Signature heroes">
                <HeroList value={registration.favoriteHeroes} size={26} />
              </Detail>
            ) : null}
            {hasText(registration.statement) ? (
              <Detail label="Goals">
                <span className="text-muted">{registration.statement}</span>
              </Detail>
            ) : null}
            {hasText(registration.captainNote) ? (
              <Detail label="Note for captains">
                <span className="italic text-muted">
                  &ldquo;{registration.captainNote}&rdquo;
                </span>
              </Detail>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {careerSummary.topHeroes.length > 0 ? (
        <Card>
          <CardHeader title="Most played heroes" subtitle="All seasons" />
          <CardBody>
            <HeroPool heroes={careerSummary.topHeroes} />
          </CardBody>
        </Card>
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

      {careerRows.length > 0 ? (
        <Card>
          <CardHeader
            title="Seasons"
            subtitle={`${careerRows.length} season${careerRows.length === 1 ? "" : "s"} played${titles > 0 ? ` · ${titles} title${titles === 1 ? "" : "s"} 🏆` : ""}`}
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
                  className={cn("w-24 shrink-0 text-muted hover:text-info", TAP_SAFE)}
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
          </CardBody>
        </Card>
      ) : null}

      {/* Inhouse career — streamed; the ladder scan mustn't block the page. */}
      <Suspense fallback={<CardSkeleton rows={3} />}>
        <InhouseCareerCard userId={user.id} />
      </Suspense>

      <Card>
        <CardHeader
          title="Match history"
          subtitle={
            gameRows.length > 0
              ? multiSeasonHistory
                ? "All seasons"
                : historyGroups[0]?.seasonName
              : (season?.name ?? undefined)
          }
          action={
            recentFormStrip.length > 0 ? (
              <FormStrip form={recentFormStrip} size={5} />
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
              {historyGroups.map((group) => (
                <li key={group.seasonId}>
                  {multiSeasonHistory ? (
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
                              <span className="font-medium">{opponentName}</span>
                              <span className="ml-2 text-xs uppercase text-muted sm:hidden">
                                {matchPhaseAbbrev(game.match.phase, game.match.week)}
                              </span>
                              <span className="ml-2 hidden text-xs uppercase text-muted sm:inline">
                                {matchPhaseLabel(game.match.phase, game.match.week)}
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

// ---------- Inhouse career ----------

// The player's ladder identity, surfaced where people actually look each
// other up. Rank comes from the FULL ladder (Elo accumulates globally); the
// recent-game rows come from a separate small query with box scores.
async function InhouseCareerCard({ userId }: { userId: string }) {
  const [ladderLobbies, recent] = await Promise.all([
    prisma.inhouseLobby.findMany({
      where: { status: INHOUSE_STATUS.COMPLETED },
      select: {
        id: true,
        winnerTeam: true,
        createdAt: true,
        players: {
          select: {
            userId: true,
            team: true,
            user: { select: { name: true, avatar: true } },
          },
        },
      },
    }),
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
        createdAt: true,
        players: { select: { userId: true, team: true } },
      },
    }),
  ]);
  if (recent.length === 0) return null;

  const ladder = summarizeInhouse(
    ladderLobbies.map((l) => ({
      id: l.id,
      winnerTeam: l.winnerTeam,
      createdAt: l.createdAt,
      players: l.players.map((p) => ({
        userId: p.userId,
        name: p.user.name,
        avatar: p.user.avatar,
        team: p.team,
      })),
    })),
  );
  const me = ladder.find((r) => r.userId === userId);
  if (!me) return null;
  const { ranked } = rankInhouse(ladder);
  const rank = ranked.findIndex((r) => r.userId === userId);

  const games = recent.map((l) => {
    const mine = l.players.find((p) => p.userId === userId);
    const line = parseInhouseBox(l.boxScore).find((b) => b.userId === userId);
    const won = mine?.team != null && mine.team === l.winnerTeam;
    return { lobby: l, line, won };
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
            {rank >= 0 ? `#${rank + 1} of ${ranked.length}` : "unranked"}
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
          {games.map(({ lobby, line, won }) => {
            const hero = line ? heroById(line.heroId) : null;
            return (
              <Link
                key={lobby.id}
                href="/inhouse/history"
                className="flex items-center gap-3 py-2 text-sm transition-colors hover:bg-surface-2/40"
              >
                <span className="w-24 shrink-0 text-xs text-muted">
                  <LocalTime
                    ts={lobby.createdAt.getTime()}
                    variant="short"
                    initial={formatMatchTime(lobby.createdAt, "short")}
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
