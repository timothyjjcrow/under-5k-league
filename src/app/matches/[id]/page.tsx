import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { shareMetadata } from "@/lib/share-metadata";
import { getHeroNames } from "@/lib/dota";
import { formatNetWorth, cn } from "@/lib/utils";
import { heroById } from "@/lib/heroes";
import { recentForm, headToHead } from "@/lib/team-matches";
import { gameMvp } from "@/lib/achievements";
import { CheckinBanner } from "@/components/checkin-banner";
import { LocalTime } from "@/components/local-time";
import { formatMatchTime } from "@/lib/match-time";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  cancelReschedule,
  proposeReschedule,
  respondReschedule,
} from "@/app/actions/reschedule";
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
import { computeStandings } from "@/lib/standings";
import { seasonScenarioReport, type StakesMatchRow } from "@/lib/stakes";
import { matchStakes, stakesHeadline } from "@/lib/scenarios";
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
  return shareMetadata(
    title,
    `${title} — box score and results in the Under 4.5K League.`,
  );
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
    },
  });
  if (!match) notFound();

  // Hero names are only rendered by the box-score branch — don't make the
  // preview/empty-state paths wait on an OpenDota round trip they never use.
  const heroes = match.games.length > 0 ? await getHeroNames() : {};
  const games = match.games.map((g) => ({
    ...g,
    parsed: safeParse(g.players),
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

  return (
    <div className="space-y-6">
      <PageTitle
        title={`${match.homeTeam.name} vs ${match.awayTeam.name}`}
        subtitle={`Week ${match.week}${match.phase !== "REGULAR" ? ` · ${match.phase}` : ""}`}
        action={
          <Link href="/schedule" className={buttonClasses("secondary", "sm")}>
            ← Schedule
          </Link>
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
        <CardBody className="relative space-y-3 py-7">
          <div className="flex items-center gap-3 sm:gap-6">
            <TeamSide
              name={match.homeTeam.name}
              teamId={match.homeTeamId}
              score={match.homeScore}
              win={match.winnerTeamId === match.homeTeamId}
            />
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-widest text-muted">
              series
            </span>
            <TeamSide
              name={match.awayTeam.name}
              teamId={match.awayTeamId}
              score={match.awayScore}
              win={match.winnerTeamId === match.awayTeamId}
              right
            />
          </div>
          {/* The basics for everyone — CheckinBanner's time renders only for
              participants, so spectators need kickoff/format/status here. */}
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted">
            {match.scheduledAt ? (
              <LocalTime
                ts={match.scheduledAt.getTime()}
                variant="full"
                initial={formatMatchTime(match.scheduledAt, "full")}
              />
            ) : (
              <span>time TBD</span>
            )}
            <Badge>Bo{match.bestOf}</Badge>
            {match.status === "COMPLETED" ? (
              <Badge>Final</Badge>
            ) : match.status === "LIVE" || games.length > 0 ? (
              <Badge tone="accent">LIVE</Badge>
            ) : null}
          </div>
        </CardBody>
      </Card>

      {/* Rescheduling stays available while the series is live — a proposal
          made before game 1 must remain answerable after it's imported. */}
      {match.status !== "COMPLETED" ? <RescheduleSection match={match} /> : null}

      {games.length === 0 && match.status !== "COMPLETED" ? (
        <Suspense fallback={<CardSkeleton rows={5} />}>
          {/* Rosters, scouting (scans all seasons' box scores) and the stakes
              banner stream in so the header + check-in paint immediately. */}
          <MatchPreview match={match} />
        </Suspense>
      ) : games.length === 0 ? (
        <EmptyState
          title="No games recorded yet"
          description="Games are pulled from Dota (OpenDota) once the match has been played."
        />
      ) : (
        games.map((g, i) => {
          const radiant = g.parsed.filter((p) => p.isRadiant);
          const dire = g.parsed.filter((p) => !p.isRadiant);
          const winnerName = g.winnerTeamId ? teamName.get(g.winnerTeamId) : null;
          const radiantName = g.radiantTeamId
            ? (teamName.get(g.radiantTeamId) ?? "Radiant")
            : "Radiant";
          const direName = g.direTeamId
            ? (teamName.get(g.direTeamId) ?? "Dire")
            : "Dire";
          const maxNet = Math.max(1, ...g.parsed.map((p) => p.netWorth ?? 0));
          const mvpId = gameMvp(g.parsed, g.radiantWin);
          const radiantNet = radiant.reduce((s, p) => s + (p.netWorth ?? 0), 0);
          const direNet = dire.reduce((s, p) => s + (p.netWorth ?? 0), 0);
          return (
            <Card key={g.id}>
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
                    {winnerName ? <Badge tone="success">{winnerName} won</Badge> : null}
                    <a
                      href={`https://www.opendota.com/matches/${g.dotaMatchId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-info hover:underline"
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
                  heroes={heroes}
                  userName={userName}
                  userAvatar={userAvatar}
                  maxNet={maxNet}
                />
                <SidePlayers
                  label={direName}
                  win={!g.radiantWin}
                  mvpId={mvpId}
                  players={dire}
                  heroes={heroes}
                  userName={userName}
                  userAvatar={userAvatar}
                  maxNet={maxNet}
                />
              </CardBody>
            </Card>
          );
        })
      )}
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
    homeTeam: { name: string; captainId: string };
    awayTeam: { name: string; captainId: string };
    standins: {
      id: string;
      teamId: string;
      standin: { id: string; name: string };
      replaced: { id: string; name: string } | null;
    }[];
  };
}) {
  const viewer = await getSessionUser();
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
    prisma.matchAvailability.findMany({ where: { matchId: match.id } }),
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

  const isParticipant =
    !!viewer &&
    (members.some((m) => m.userId === viewer.id) ||
      match.standins.some((s) => s.standin.id === viewer.id));
  const myRsvp = viewer ? (rsvpByUser.get(viewer.id) ?? null) : null;

  const h2hRow = headToHead(match.homeTeamId, seasonMatches).find(
    (h) => h.opponentId === match.awayTeamId,
  );

  const side = (teamId: string, name: string) => {
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
    return { teamId, name, roster, subs, replacedIds, form };
  };
  const sides = [
    side(match.homeTeamId, match.homeTeam.name),
    side(match.awayTeamId, match.awayTeam.name),
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

      <Card>
        <CardHeader
          title="Matchup"
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
                    size={24}
                    className="rounded-md"
                  />
                  <span className="truncate">{s.name}</span>
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
                        <Avatar name={m.user.name} src={m.user.avatar} size={22} />
                        <PlayerLink userId={m.userId} className="truncate">
                          {m.user.name}
                        </PlayerLink>
                        {m.isCaptain ? <Badge tone="accent">C</Badge> : null}
                        <RankBadge rankTier={m.user.rankTier} />
                        <RoleBadges roles={reg?.roles ?? ""} />
                      </span>
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
                        <PlayerLink userId={sub.standin.id} className="truncate">
                          {sub.standin.name}
                        </PlayerLink>
                        <span className="truncate text-xs text-muted">
                          in for {sub.replaced?.name ?? "?"}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs">
                        {subRsvp === "IN" ? (
                          <span className="text-success">✓ in</span>
                        ) : subRsvp === "OUT" ? (
                          <span className="text-danger">✗ out</span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </span>
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
          roster: s.roster.map((m) => ({
            userId: m.userId,
            name: m.user.name,
            roles: regByUser.get(m.userId)?.roles ?? "",
          })),
        }))}
      />

      <p className="text-center text-xs text-muted">
        The box score appears here once the match is played and imported from
        Dota (OpenDota).
      </p>
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
    homeTeam: { name: string };
    awayTeam: { name: string };
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
    select: { id: true },
  });
  const standings = computeStandings(
    teams.map((t) => t.id),
    seasonMatches,
  );
  const report = seasonScenarioReport(standings, seasonMatches, teams.length);
  if (!report) return null;

  const stakes = matchStakes(match.id, match.homeTeamId, match.awayTeamId, report);
  const headline = stakesHeadline(stakes);
  const decided = stakes.some(
    (s) => report.teams.get(s.teamId)?.status != null,
  );
  if (!headline && !decided) return null;

  const nameOf = new Map([
    [match.homeTeamId, match.homeTeam.name],
    [match.awayTeamId, match.awayTeam.name],
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
    roster: { userId: string; name: string; roles: string }[];
  }[];
}) {
  const allGames = await prisma.game.findMany({
    select: {
      players: true,
      radiantWin: true,
      durationSecs: true,
      startTime: true,
    },
  });
  const scoutGames: ScoutGame[] = allGames.map((g) => ({
    radiantWin: g.radiantWin,
    durationSecs: g.durationSecs,
    startTime: g.startTime,
    lines: safeParse(g.players).map((p) => ({
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

  if (dossiers.every((d) => d.empty)) return null;
  const heroNames = await getHeroNames();

  return (
    <Card>
      <CardHeader
        title="Scouting report"
        subtitle="Know your enemy — comfort heroes, ban targets, and pace from every game on record."
      />
      <CardBody className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {dossiers.map((d) => (
          <div key={d.teamId} className="min-w-0 rounded-lg border border-line p-3">
            <div className="mb-2.5 flex min-w-0 items-center gap-2">
              <TeamCrest name={d.name} seed={d.teamId} size={22} className="rounded-md" />
              <span className="truncate font-display text-base font-semibold">
                {d.name}
              </span>
            </div>
            {d.empty ? (
              <p className="py-4 text-center text-sm text-muted">
                No league history yet — they&apos;re a mystery.
              </p>
            ) : (
              <div className="space-y-3">
                <ThreatList board={d.board} heroNames={heroNames} />
                <ComfortPicks pools={d.pools} heroNames={heroNames} />
                <PaceLine pace={d.pace} coverage={d.coverage} />
              </div>
            )}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

function ThreatList({
  board,
  heroNames,
}: {
  board: ThreatBoard;
  heroNames: Record<number, string>;
}) {
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
                {heroNames[r.heroId] ?? hero?.name ?? `Hero ${r.heroId}`}
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
  heroNames,
}: {
  pools: { userId: string; name: string; pool: HeroPoolRow[] }[];
  heroNames: Record<number, string>;
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
            <PlayerLink userId={p.userId} className="w-28 shrink-0 truncate text-xs">
              {p.name}
            </PlayerLink>
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {p.pool.slice(0, 3).map((h) => {
                const hero = heroById(h.heroId);
                const name = heroNames[h.heroId] ?? hero?.name ?? `Hero ${h.heroId}`;
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
  score,
  win,
  right,
}: {
  name: string;
  teamId: string;
  score: number;
  win: boolean;
  right?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-3",
        right && "flex-row-reverse",
      )}
    >
      <TeamCrest name={name} seed={teamId} size={44} />
      <Link
        href={`/teams/${teamId}`}
        className={cn(
          "min-w-0 flex-1 truncate font-display text-lg font-semibold hover:text-info",
          right && "text-right",
          win ? "text-fg" : "text-muted",
        )}
      >
        {name}
      </Link>
      <span
        className={cn(
          "shrink-0 font-display text-4xl font-bold tabular-nums",
          win ? "text-fg" : "text-muted",
        )}
      >
        {score}
      </span>
    </div>
  );
}

// The team net-worth split — Dota's signature "who's ahead" summary as a
// single bar (Radiant green / Dire red) with the current gold lead.
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
    <div className="md:col-span-2">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-emerald-300">
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
          <span className="truncate">{radiantName}</span>
          <span className="font-mono text-muted">{formatNetWorth(radiantNet)}</span>
        </span>
        <span className="shrink-0 text-muted">
          {lead === 0
            ? "Even net worth"
            : `${leaderName} +${formatNetWorth(Math.abs(lead))}`}
        </span>
        <span className="flex min-w-0 items-center justify-end gap-1.5 font-medium text-rose-300">
          <span className="font-mono text-muted">{formatNetWorth(direNet)}</span>
          <span className="truncate">{direName}</span>
          <span className="h-2 w-2 shrink-0 rounded-full bg-rose-400" />
        </span>
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="bg-emerald-500/70 transition-all"
          style={{ width: `${radPct}%` }}
        />
        <div className="flex-1 bg-rose-500/70" />
      </div>
    </div>
  );
}

function SidePlayers({
  label,
  win,
  players,
  heroes,
  userName,
  userAvatar,
  maxNet,
  mvpId,
}: {
  label: string;
  win: boolean;
  players: PlayerStat[];
  heroes: Record<number, string>;
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
        "rounded-lg border p-3",
        win ? "border-success/40 bg-success/5" : "border-line",
      )}
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-display text-base font-semibold">
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
          const heroName = heroes[p.heroId] ?? hero?.name ?? `Hero ${p.heroId}`;
          const nwPct =
            p.netWorth != null ? Math.round((p.netWorth / maxNet) * 100) : 0;
          return (
            <li
              key={idx}
              className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-2/50"
            >
              <div className="flex items-center gap-2.5">
                {hero ? (
                  <HeroIcon hero={hero} size={30} />
                ) : (
                  <span className="h-[30px] w-[30px] shrink-0 rounded-md border border-line/70 bg-surface-2" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {p.userId ? (
                      <Avatar
                        name={displayName}
                        src={userAvatar.get(p.userId) ?? null}
                        size={18}
                      />
                    ) : null}
                    {p.userId ? (
                      <PlayerLink userId={p.userId} className="truncate text-sm">
                        {displayName}
                      </PlayerLink>
                    ) : (
                      <span className="truncate text-sm">{displayName}</span>
                    )}
                    {p.userId && p.userId === mvpId ? (
                      <Badge tone="accent" title="Best line of the game">
                        MVP
                      </Badge>
                    ) : null}
                  </div>
                  <div className="truncate text-[11px] text-muted">
                    {heroName}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <KDA
                    kills={p.kills}
                    deaths={p.deaths}
                    assists={p.assists}
                    className="block text-xs"
                  />
                  {hasGpm || hasLh ? (
                    <div className="text-[11px] tabular-nums text-muted">
                      {[
                        hasGpm ? `${p.gpm ?? "—"} gpm` : null,
                        hasLh ? `${p.lastHits ?? "—"} lh` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  ) : null}
                </div>
                {hasNet ? (
                  <div className="w-14 shrink-0 text-right">
                    <div className="font-mono text-xs tabular-nums text-accent">
                      {formatNetWorth(p.netWorth)}
                    </div>
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-accent/80"
                        style={{ width: `${nwPct}%` }}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
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

function safeParse(json: string): PlayerStat[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Captain-to-captain rescheduling: propose a time, the other captain accepts
// (retimes the match) or declines. Only the two captains ever see this card.
/**
 * Captain-only wrapper so the reschedule card renders on every unplayed OR
 * live match — not just the pre-import preview (a proposal made before game 1
 * must stay answerable after the game is imported).
 */
async function RescheduleSection({
  match,
}: {
  match: {
    id: string;
    status: string;
    scheduledAt: Date | null;
    homeTeam: { name: string; captainId: string };
    awayTeam: { name: string; captainId: string };
  };
}) {
  const viewer = await getSessionUser();
  const isCaptain =
    !!viewer &&
    (match.homeTeam.captainId === viewer.id ||
      match.awayTeam.captainId === viewer.id);
  if (isCaptain) {
    return <RescheduleCard match={match} viewerId={viewer!.id} />;
  }
  // Everyone else gets a read-only heads-up that a time change is pending, so
  // spectators/scouts aren't blindsided by a moved match.
  const pending = await prisma.rescheduleRequest.findFirst({
    where: { matchId: match.id, status: "PENDING" },
    select: { proposedTime: true },
  });
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
}: {
  match: {
    id: string;
    status: string;
    scheduledAt: Date | null;
    homeTeam: { name: string; captainId: string };
    awayTeam: { name: string; captainId: string };
  };
  viewerId: string;
}) {
  if (match.status === "COMPLETED") return null;
  const pending = await prisma.rescheduleRequest.findFirst({
    where: { matchId: match.id, status: "PENDING" },
    include: { proposedBy: { select: { name: true } } },
  });
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
            ? "Agree a new time with the other captain — accepting retimes the match for everyone."
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
                  <SubmitButton variant="primary" size="sm">
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
            <span aria-label="Proposed new time" role="group">
              <LocalDatetimeField
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
