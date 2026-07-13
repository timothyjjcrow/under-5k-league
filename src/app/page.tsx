import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { getSeasonSnapshot, type SeasonSnapshot } from "@/lib/queries";
import { prisma } from "@/lib/prisma";
import {
  computeStandings,
  standingsMovement,
  type ClinchStatus,
} from "@/lib/standings";
import { clinchFromReport, seasonScenarioReport } from "@/lib/stakes";
import { matchStakes, stakesHeadline, type ScenarioReport } from "@/lib/scenarios";
import {
  bracketRounds,
  byKickoff,
  matchPhaseAbbrev,
  matchPhaseLabel,
  pickBracketSize,
  roundName,
  slotRound,
} from "@/lib/schedule";
import { buildBracketRounds, seedsFromFirstRound } from "@/lib/bracket-view";
import { Bracket } from "@/components/bracket";
import { formByTeam, type FormResult } from "@/lib/team-matches";
import { matchNightRoster, teamAvailability } from "@/lib/availability";
import { weeklyHonors } from "@/lib/honors";
import { heroMeta } from "@/lib/hero-meta";
import { heroById } from "@/lib/heroes";
import type { PlayerStat } from "@/lib/match-import";
import type { Match } from "@prisma/client";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  DiscordButton,
  EmptyState,
  FormStrip,
  HeroIcon,
  LinkifiedText,
  PlayerLink,
  Progress,
  RankBadge,
  RoleBadges,
  ScheduleCallout,
  Stat,
  SteamSafetyNote,
  TeamCrest,
  buttonClasses,
} from "@/components/ui";
import { averageMmr, mmrDistribution, roleCoverage } from "@/lib/pool-stats";
import {
  DRAFT_STATUS,
  INHOUSE,
  INHOUSE_ACTIVE_STATUSES,
  GAME_SERVER_REGION,
} from "@/lib/constants";
import { predictionOpen } from "@/lib/pickem";
import { HeroVideo } from "@/components/hero-video";
import { CountUp } from "@/components/count-up";
import { CheckinBanner } from "@/components/checkin-banner";
import {
  StandingsTableClient,
  type StandingsRowView,
} from "@/components/standings-table";
import { LocalTime } from "@/components/local-time";
import { formatMatchTime } from "@/lib/match-time";
import { sortNews } from "@/lib/news";
import { cn } from "@/lib/utils";

const PHASE_LABEL: Record<string, string> = {
  SIGNUPS: "Signups open",
  DRAFT: "Draft",
  REGULAR_SEASON: "Regular season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Season complete",
};

const PHASE_TONE: Record<string, "brand" | "accent" | "success" | "info"> = {
  SIGNUPS: "info",
  DRAFT: "accent",
  REGULAR_SEASON: "success",
  PLAYOFFS: "accent",
  COMPLETE: "brand",
};

const PHASE_ORDER = [
  "SIGNUPS",
  "DRAFT",
  "REGULAR_SEASON",
  "PLAYOFFS",
  "COMPLETE",
] as const;

const PHASE_STEP: Record<string, string> = {
  SIGNUPS: "Signups",
  DRAFT: "Draft",
  REGULAR_SEASON: "Season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Champion",
};

function fmtWhen(d: Date | null): string | null {
  if (!d) return null;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function Home() {
  const user = await getSessionUser();
  const snapshot = await getSeasonSnapshot(user?.id);

  if (!snapshot) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Hero
          phase={null}
          title="No season is running yet"
          subtitle="Check back soon — a new season will open for signups shortly. In the meantime, jump into an inhouse."
        />
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/inhouse" className={buttonClasses("accent")}>
            Play an inhouse →
          </Link>
          <Link href="/features" className={buttonClasses("secondary")}>
            See what the league offers
          </Link>
          <DiscordButton />
          {user?.role === "ADMIN" ? (
            <Link href="/admin" className={buttonClasses("secondary")}>
              Create the first season
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  const { season } = snapshot;

  // Primary call-to-action, surfaced right in the hero during signups.
  const isActiveReg = snapshot.myReg?.status === "ACTIVE";
  let heroAction: ReactNode = null;
  if (season.status === "SIGNUPS") {
    // The feature tour rides along during signups — new visitors can't see
    // most of the league (draft, fantasy, pick'em…) until later phases.
    const tourLink = (
      <Link href="/features" className={buttonClasses("secondary", "lg")}>
        See what you&apos;re joining
      </Link>
    );
    heroAction = !user ? (
      <>
        <Link href="/login" className={buttonClasses("primary", "lg")}>
          Sign in with Steam to join →
        </Link>
        {tourLink}
      </>
    ) : !isActiveReg ? (
      <>
        <Link href="/me" className={buttonClasses("primary", "lg")}>
          Join the season →
        </Link>
        {tourLink}
      </>
    ) : (
      tourLink
    );
  } else if (season.status === "DRAFT") {
    heroAction = (
      <Link href="/draft" className={buttonClasses("accent", "lg")}>
        Enter the draft room →
      </Link>
    );
  }

  // Past the draft, every view (and the hero itself) reads the season's
  // matches — fetch once here and hand them down.
  const showsMatches =
    season.status === "REGULAR_SEASON" ||
    season.status === "PLAYOFFS" ||
    season.status === "COMPLETE";
  const [matches, gamesOnRecord] = showsMatches
    ? await Promise.all([
        prisma.match.findMany({
          where: { seasonId: season.id },
          orderBy: [{ week: "asc" }],
        }),
        prisma.game.count({ where: { match: { seasonId: season.id } } }),
      ])
    : [[] as Match[], 0];

  // Live, animated figures surfaced right in the hero for a sense of momentum.
  let heroMeta: ReactNode = null;
  if (season.status === "SIGNUPS") {
    const { playerCount, capacity } = snapshot;
    heroMeta = (
      <>
        <HeroStat
          value={playerCount}
          label={playerCount === 1 ? "player signed up" : "players signed up"}
        />
        {capacity.canDraft ? (
          <Badge tone="success">Ready to draft</Badge>
        ) : (
          <HeroStat
            value={capacity.needed}
            label="more to start the draft"
            tone="accent"
          />
        )}
      </>
    );
  } else if (season.status === "DRAFT") {
    heroMeta = (
      <HeroStat
        value={snapshot.teams.length}
        label={snapshot.teams.length === 1 ? "team drafting" : "teams drafting"}
      />
    );
  } else if (season.status === "REGULAR_SEASON") {
    const regular = matches.filter((m) => m.phase === "REGULAR");
    const totalWeeks = regular.reduce((max, m) => Math.max(max, m.week), 0);
    const openWeeks = regular
      .filter((m) => m.status !== "COMPLETED")
      .map((m) => m.week);
    const currentWeek = openWeeks.length
      ? Math.min(...openWeeks)
      : totalWeeks;
    heroMeta = (
      <>
        {totalWeeks > 0 ? (
          <HeroStat
            value={currentWeek}
            label={`of ${totalWeeks} week${totalWeeks === 1 ? "" : "s"}`}
            prefix="Week"
          />
        ) : null}
        <HeroStat
          value={snapshot.teams.length}
          label={
            snapshot.teams.length === 1 ? "team competing" : "teams competing"
          }
        />
        {gamesOnRecord > 0 ? (
          <HeroStat value={gamesOnRecord} label="games on record" />
        ) : null}
      </>
    );
  } else if (season.status === "PLAYOFFS") {
    const playoff = matches.filter((m) => m.phase !== "REGULAR");
    const inBracket = new Set(
      playoff.flatMap((m) => [m.homeTeamId, m.awayTeamId]),
    );
    const losers = new Set(
      playoff
        .filter((m) => m.status === "COMPLETED" && m.winnerTeamId)
        .map((m) =>
          m.winnerTeamId === m.homeTeamId ? m.awayTeamId : m.homeTeamId,
        ),
    );
    const alive = [...inBracket].filter((id) => !losers.has(id)).length;
    heroMeta = (
      <>
        {alive > 0 ? (
          <HeroStat value={alive} label="teams still alive" tone="accent" />
        ) : null}
        {currentRoundLabel(playoff) ? (
          <Badge tone="accent">{currentRoundLabel(playoff)}</Badge>
        ) : null}
      </>
    );
  } else if (season.status === "COMPLETE") {
    const champion = snapshot.teams.find(
      (t) => t.id === season.championTeamId,
    );
    heroMeta = champion ? (
      <span className="flex items-center gap-2">
        <TeamCrest
          name={champion.name}
          seed={champion.id}
          size={26}
          className="rounded-md ring-2 ring-amber-400/50"
        />
        <span className="font-display text-lg font-semibold">
          {champion.name}
        </span>
        <Badge tone="brand">🏆 Champions</Badge>
      </span>
    ) : null;
    heroAction = (
      <Link
        href={`/recap?season=${season.id}`}
        className={buttonClasses("accent", "lg")}
      >
        Relive the season →
      </Link>
    );
  }

  return (
    <div className="space-y-8">
      <Hero
        phase={season.status}
        title={season.name}
        subtitle={phaseSubtitle(season.status)}
        action={heroAction}
        meta={heroMeta}
      />
      <SeasonTimeline phase={season.status} />
      <LeagueNews />
      <InhouseStrip />
      {season.status === "SIGNUPS" && (
        <SignupsView snapshot={snapshot} loggedIn={!!user} />
      )}
      {season.status === "DRAFT" && <DraftPhaseView snapshot={snapshot} />}
      {(season.status === "REGULAR_SEASON" || season.status === "PLAYOFFS") && (
        <>
          {user ? <MyNextMatch seasonId={season.id} userId={user.id} /> : null}
          <SeasonView snapshot={snapshot} userId={user?.id} matches={matches} />
        </>
      )}
      {season.status === "COMPLETE" && (
        <CompleteView snapshot={snapshot} matches={matches} />
      )}
    </div>
  );
}

/** "Semifinals underway" — the name of the earliest playoff round still open. */
function currentRoundLabel(playoff: Match[]): string | null {
  const slotted = playoff.filter((m) => m.bracketSlot);
  const first = slotted.filter((m) => slotRound(m.bracketSlot) === 0);
  if (first.length === 0) return null;
  const total = bracketRounds(first.length * 2);
  const open = slotted.filter((m) => m.status !== "COMPLETED");
  if (open.length === 0) return null;
  const round = Math.min(...open.map((m) => slotRound(m.bracketSlot)));
  return `${roundName(round, total)} underway`;
}

// Latest admin announcements — pinned first, capped at three with a link to
// the full /news archive. Renders nothing when the league has no news.
async function LeagueNews() {
  // News volume is tiny — fetch all so an old pinned post still surfaces.
  const posts = sortNews(await prisma.newsPost.findMany()).slice(0, 3);
  if (posts.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="League news"
        subtitle="The latest from the admins"
        action={
          <Link href="/news" className="text-sm text-info hover:underline">
            All news →
          </Link>
        }
      />
      <CardBody className="space-y-4">
        {posts.map((p) => (
          <div key={p.id} className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h3 className="min-w-0 truncate text-sm font-semibold">
                <Link href={`/news#${p.id}`} className="hover:text-info">
                  {p.pinned ? "📌 " : ""}
                  {p.title}
                </Link>
              </h3>
              <span className="text-xs text-muted">
                <LocalTime
                  ts={p.createdAt.getTime()}
                  variant="short"
                  initial={formatMatchTime(p.createdAt, "short")}
                />
              </span>
            </div>
            <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted">
              <LinkifiedText text={p.body} />
            </p>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

// The signed-in player's next unplayed match with one-click check-in — the
// thing a rostered player most wants from the home page mid-season.
async function MyNextMatch({
  seasonId,
  userId,
}: {
  seasonId: string;
  userId: string;
}) {
  const myTeams = await prisma.teamMember.findMany({
    where: { seasonId, userId },
    select: { teamId: true },
  });
  const teamIds = myTeams.map((t) => t.teamId);

  // Assigned standins are participants too — without this they'd get no
  // check-in prompt anywhere but the match page itself.
  const next = await prisma.match.findFirst({
    where: {
      seasonId,
      status: { not: "COMPLETED" },
      OR: [
        ...(teamIds.length
          ? [
              { homeTeamId: { in: teamIds } },
              { awayTeamId: { in: teamIds } },
            ]
          : []),
        { standins: { some: { standinUserId: userId } } },
      ],
    },
    // Chronological, not week order — an accepted reschedule can legally move
    // a match past the next week's night, and the banner should always point
    // at whatever plays first. Unscheduled matches sort last.
    orderBy: [
      { scheduledAt: { sort: "asc", nulls: "last" } },
      { week: "asc" },
      { createdAt: "asc" },
    ],
    include: { homeTeam: true, awayTeam: true },
  });
  if (!next) return null;

  const myRsvp = await prisma.matchAvailability.findUnique({
    where: { matchId_userId: { matchId: next.id, userId } },
    select: { status: true },
  });

  return (
    <CheckinBanner
      matchId={next.id}
      heading={`Your next match — ${matchPhaseLabel(next.phase, next.week)}: ${next.homeTeam.name} vs ${next.awayTeam.name}`}
      when={fmtWhen(next.scheduledAt)}
      whenTs={next.scheduledAt?.getTime()}
      myRsvp={myRsvp?.status ?? null}
      detailsHref={`/matches/${next.id}`}
    />
  );
}

function phaseSubtitle(status: string) {
  switch (status) {
    case "SIGNUPS":
      return "Sign up now — the draft begins once enough players have joined.";
    case "DRAFT":
      return "Captains are bidding on players to build their rosters.";
    case "REGULAR_SEASON":
      return "Weekly round-robin matches are underway.";
    case "PLAYOFFS":
      return "The top teams battle it out in the playoff bracket.";
    case "COMPLETE":
      return "That's a wrap. Congratulations to our champions!";
    default:
      return "";
  }
}

// ---------- Hero ----------

// A single animated hero figure — big count-up number + a muted label, with
// an optional word before the number ("Week 3 of 7").
function HeroStat({
  value,
  label,
  tone,
  prefix,
}: {
  value: number;
  label: string;
  tone?: "accent";
  prefix?: string;
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      {prefix ? <span className="text-sm text-muted">{prefix}</span> : null}
      <span
        className={cn(
          "font-display text-2xl font-bold tabular-nums sm:text-3xl",
          tone === "accent" ? "text-accent" : "text-fg",
        )}
      >
        <CountUp value={value} />
      </span>
      <span className="text-sm text-muted">{label}</span>
    </span>
  );
}

function Hero({
  phase,
  title,
  subtitle,
  action,
  meta,
}: {
  phase: string | null;
  title: string;
  subtitle: string;
  action?: ReactNode;
  meta?: ReactNode;
}) {
  const live = !!phase && phase !== "COMPLETE";
  return (
    <div className="relative overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-b from-surface-2/70 to-surface/40 px-6 py-14 text-center sm:px-10 sm:py-16">
      {/* Looping background video — fades in/out at the loop seam to hide the jump. */}
      <HeroVideo />
      {/* Themed tint over the video for contrast + palette cohesion. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-surface/40 via-bg/45 to-surface/75"
      />
      {/* Layered ambient background: masked grid + dual neon glows. */}
      <div
        aria-hidden
        className="hero-grid pointer-events-none absolute inset-0 opacity-60"
      />
      <div
        aria-hidden
        className="animate-hero-glow pointer-events-none absolute left-1/2 top-0 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/25 blur-3xl"
      />
      <div
        aria-hidden
        className="animate-hero-glow-alt pointer-events-none absolute -right-12 bottom-0 h-48 w-48 translate-y-1/3 rounded-full bg-accent/20 blur-3xl"
      />
      <div className="relative">
        {phase ? (
          <Badge tone={PHASE_TONE[phase] ?? "neutral"} className="mb-4">
            {live ? (
              <span
                aria-hidden
                className="animate-live-pulse mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-current"
              />
            ) : null}
            {PHASE_LABEL[phase] ?? phase}
          </Badge>
        ) : null}
        <h1 className="font-display text-5xl font-bold tracking-tight sm:text-6xl">
          {title}
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-muted sm:text-lg">{subtitle}</p>
        {/* Persistent league fact: the Dota region every game is played on. */}
        <div className="mt-4 flex justify-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs font-medium text-muted">
            <span aria-hidden>🌐</span>
            Game servers:{" "}
            <span className="font-semibold text-fg">{GAME_SERVER_REGION}</span>
          </span>
        </div>
        {meta ? (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            {meta}
          </div>
        ) : null}
        {action ? (
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {action}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// A slim stepper showing where the season is in its lifecycle. Real list
// semantics: a screen reader hears "Season progress, list, 5 items" and the
// active phase is announced via aria-current — the ticks/digits/connectors
// are purely visual (aria-hidden) with sr-only state text on each label.
function SeasonTimeline({ phase }: { phase: string }) {
  const current = PHASE_ORDER.findIndex((p) => p === phase);
  return (
    <div className="rounded-[var(--radius)] border border-line bg-surface/60 px-3 py-4 sm:px-6">
      <ol aria-label="Season progress" className="flex items-start">
        {PHASE_ORDER.map((p, i) => {
          const done = current >= 0 && i < current;
          const isCurrent = i === current;
          return (
            <li
              key={p}
              aria-current={isCurrent ? "step" : undefined}
              className="flex flex-1 flex-col items-center gap-1.5"
            >
              <div aria-hidden className="flex w-full items-center">
                <div
                  className={cn(
                    "h-0.5 flex-1 rounded",
                    i === 0
                      ? "opacity-0"
                      : current >= 0 && i <= current
                        ? "bg-success/50"
                        : "bg-line",
                  )}
                />
                <div
                  className={cn(
                    "grid h-8 w-8 shrink-0 place-items-center rounded-full border text-xs font-semibold",
                    isCurrent
                      ? "border-accent bg-accent/15 text-accent"
                      : done
                        ? "border-success/50 bg-success/10 text-success"
                        : "border-line bg-surface-2 text-muted",
                  )}
                >
                  {done ? "✓" : i + 1}
                </div>
                <div
                  className={cn(
                    "h-0.5 flex-1 rounded",
                    i === PHASE_ORDER.length - 1
                      ? "opacity-0"
                      : current >= 0 && i < current
                        ? "bg-success/50"
                        : "bg-line",
                  )}
                />
              </div>
              <span
                className={cn(
                  "text-center text-[11px] leading-tight",
                  isCurrent ? "font-medium text-fg" : "text-muted",
                )}
              >
                {PHASE_STEP[p]}
                {done ? (
                  <span className="sr-only"> (done)</span>
                ) : isCurrent ? (
                  <span className="sr-only"> (current)</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// The inhouse scene runs year-round but was invisible from the dashboard.
// A slim strip keeps it one click away in every phase. Read-only queries —
// lobby formation/resolution stays lazy on the /inhouse poll.
async function InhouseStrip() {
  const [queued, liveLobby] = await Promise.all([
    prisma.inhouseQueueEntry.count(),
    prisma.inhouseLobby.findFirst({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      select: { id: true },
    }),
  ]);

  const label = liveLobby
    ? "An inhouse is being played right now"
    : queued > 0
      ? `${queued} / ${INHOUSE.LOBBY_SIZE} queued for the next inhouse`
      : "The inhouse queue is open";
  const cta = liveLobby ? "Watch" : queued > 0 ? "Jump in" : "Start the queue";

  return (
    <Link
      href="/inhouse"
      className="group flex items-center justify-between gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 text-sm transition-colors hover:border-muted/60"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden>⚔️</span>
        {liveLobby ? (
          <span
            aria-hidden
            className="animate-live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-success"
          />
        ) : null}
        <span className="truncate text-muted">{label}</span>
      </span>
      <span className="shrink-0 font-medium text-accent group-hover:underline">
        {cta} →
      </span>
    </Link>
  );
}

// ---------- SIGNUPS ----------

async function SignupsView({
  snapshot,
  loggedIn,
}: {
  snapshot: SeasonSnapshot;
  loggedIn: boolean;
}) {
  const { season, playerCount, standinCount, capacity, myReg } = snapshot;
  const isActivePlayer =
    myReg?.status === "ACTIVE" && myReg.type === "PLAYER";
  const isStandin = myReg?.status === "ACTIVE" && myReg.type === "STANDIN";

  // Teams need captains as much as they need players — surface how many
  // have volunteered so the "can we actually draft?" picture is complete.
  const captainVolunteers = await prisma.registration.count({
    where: {
      seasonId: season.id,
      status: "ACTIVE",
      type: "PLAYER",
      wantsCaptain: true,
    },
  });

  return (
    <div className="space-y-6">
      <ScheduleCallout label={season.matchSchedule} />
      <Card>
        <CardBody className="space-y-5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {playerCount} / {capacity.minPlayers} players to start
              <span className="font-normal text-muted">
                {" "}
                · teams of {season.teamSize}
                {season.maxMmr > 0
                  ? ` · ${season.maxMmr} MMR soft limit`
                  : ""}
              </span>
            </span>
            <span className="text-muted">
              {capacity.canDraft
                ? "Ready to draft!"
                : `${capacity.needed} more needed`}
            </span>
          </div>
          <Progress value={playerCount} max={capacity.minPlayers} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Players" value={playerCount} />
            <Stat label="Standins" value={standinCount} />
            <Stat
              label="Teams ready"
              value={capacity.teamsFormable}
              hint={`of ${season.minTeams} needed`}
            />
            <Stat
              label="Captain volunteers"
              value={captainVolunteers}
              hint={`need ${season.minTeams}`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            {!loggedIn ? (
              <Link href="/login" className={buttonClasses("primary", "lg")}>
                Sign in with Steam to join
              </Link>
            ) : isActivePlayer ? (
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone="success">You&apos;re signed up to play</Badge>
                <Link href="/me" className={buttonClasses("secondary")}>
                  Edit your signup
                </Link>
              </div>
            ) : isStandin ? (
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone="info">You&apos;re registered as a standin</Badge>
                <Link href="/me" className={buttonClasses("secondary")}>
                  Switch to full player
                </Link>
              </div>
            ) : (
              <Link href="/me" className={buttonClasses("primary", "lg")}>
                Join the season →
              </Link>
            )}
            <DiscordButton size="lg" />
          </div>

          {!loggedIn ? <SteamSafetyNote /> : null}
        </CardBody>
      </Card>

      <PoolComposition seasonId={season.id} />

      <Card>
        <CardHeader
          title="Who's in"
          subtitle="Latest players to sign up"
          action={
            <Link href="/players" className="text-sm text-info hover:underline">
              View all →
            </Link>
          }
        />
        <CardBody>
          <RecentSignups seasonId={season.id} />
        </CardBody>
      </Card>
    </div>
  );
}

async function RecentSignups({ seasonId }: { seasonId: string }) {
  const regs = await prisma.registration.findMany({
    where: { seasonId, status: "ACTIVE", type: "PLAYER" },
    include: { user: true },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  if (regs.length === 0) {
    return (
      <EmptyState
        title="No signups yet"
        description="Be the first to join this season."
      />
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {regs.map((r) => (
        <PlayerLink
          key={r.id}
          userId={r.userId}
          className="flex items-center gap-2 rounded-full border border-line bg-surface-2/50 py-1 pl-1 pr-3 hover:border-muted/60 hover:no-underline"
        >
          <Avatar name={r.user.name} src={r.user.avatar} size={26} />
          <span className="text-sm">{r.user.name}</span>
          <RankBadge rankTier={r.user.rankTier} />
          <RoleBadges roles={r.roles} />
          <span className="text-xs text-muted">{r.mmr}</span>
        </PlayerLink>
      ))}
    </div>
  );
}

async function PoolComposition({ seasonId }: { seasonId: string }) {
  const regs = await prisma.registration.findMany({
    where: { seasonId, status: "ACTIVE", type: "PLAYER" },
    select: { roles: true, mmr: true },
  });
  if (regs.length === 0) return null;

  const roles = roleCoverage(regs);
  const dist = mmrDistribution(regs);
  const avg = averageMmr(regs);
  const maxRole = Math.max(1, ...roles.map((r) => r.count));
  const maxBucket = Math.max(1, ...dist.map((b) => b.count));

  return (
    <Card>
      <CardHeader
        title="Pool composition"
        subtitle={`Role coverage & MMR spread · avg ${avg} MMR`}
      />
      <CardBody className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">
            Preferred roles
          </div>
          {roles.map((r) => (
            <StatBar
              key={r.key}
              label={r.label}
              count={r.count}
              max={maxRole}
              tone="brand"
            />
          ))}
        </div>
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">
            MMR distribution
          </div>
          {dist.map((b) => (
            <StatBar
              key={b.label}
              label={b.label}
              count={b.count}
              max={maxBucket}
              tone="accent"
            />
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

function StatBar({
  label,
  count,
  max,
  tone,
}: {
  label: string;
  count: number;
  max: number;
  tone: "brand" | "accent";
}) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-24 shrink-0 truncate text-muted" title={label}>
        {label}
      </span>
      <div className="h-2.5 flex-1 rounded-full bg-surface-2">
        <div
          className={`bar-fill h-full rounded-full ${tone === "brand" ? "bg-brand" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-6 shrink-0 text-right tabular-nums">{count}</span>
    </div>
  );
}

// ---------- DRAFT ----------

// A read-only glance at the live auction so the dashboard tells the story
// without opening the draft room: who's on the block, what's left in the
// pool, and the latest sales. Never resolves clocks — that stays in /draft.
async function DraftPulse({ seasonId }: { seasonId: string }) {
  const draft = await prisma.draft.findUnique({ where: { seasonId } });
  if (!draft || draft.status === DRAFT_STATUS.NOT_STARTED) return null;

  const rostered = await prisma.teamMember.findMany({
    where: { seasonId },
    select: { userId: true },
  });
  const [poolLeft, sales, nominated, leadingTeam, nominatorTeam] =
    await Promise.all([
      prisma.registration.count({
        where: {
          seasonId,
          status: "ACTIVE",
          type: "PLAYER",
          userId: { notIn: rostered.map((m) => m.userId) },
        },
      }),
      prisma.teamMember.findMany({
        where: { seasonId, isCaptain: false },
        orderBy: { createdAt: "desc" },
        take: 3,
        include: { user: true, team: true },
      }),
      draft.nominatedUserId
        ? prisma.user.findUnique({ where: { id: draft.nominatedUserId } })
        : null,
      draft.currentBidTeamId
        ? prisma.team.findUnique({ where: { id: draft.currentBidTeamId } })
        : null,
      draft.nominatorTeamId
        ? prisma.team.findUnique({
            where: { id: draft.nominatorTeamId },
            select: { name: true },
          })
        : null,
    ]);

  return (
    <Card>
      <CardHeader
        title="Live from the draft room"
        action={
          <Link href="/draft" className={buttonClasses("accent", "sm")}>
            Watch live →
          </Link>
        }
      />
      <CardBody className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-3">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">
            On the block
          </div>
          {nominated ? (
            <div className="mt-2 flex items-center gap-2.5">
              <Avatar name={nominated.name} src={nominated.avatar} size={34} />
              <div className="min-w-0">
                <PlayerLink
                  userId={nominated.id}
                  className="block truncate font-medium"
                >
                  {nominated.name}
                </PlayerLink>
                <div className="truncate text-xs text-muted">
                  ${draft.currentBid}
                  {leadingTeam ? ` — ${leadingTeam.name} leads` : " opening bid"}
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">
              {draft.status === DRAFT_STATUS.COMPLETE
                ? "The draft is complete."
                : draft.status === DRAFT_STATUS.PAUSED
                  ? "The draft is paused."
                  : nominatorTeam
                    ? `${nominatorTeam.name} is on the clock to nominate.`
                    : "Waiting on the next nomination…"}
            </p>
          )}
        </div>
        <Stat label="Players left in pool" value={poolLeft} />
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">
            Latest sales
          </div>
          {sales.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm">
              {sales.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <PlayerLink userId={s.userId} className="min-w-0 truncate">
                    {s.user.name}
                  </PlayerLink>
                  {/* Price always shows; only the free-text team name gives
                      way — a shrink-0 span here crushed the player link and
                      bled past the card on phones. */}
                  <span className="flex min-w-0 items-center gap-1 text-xs text-muted">
                    <span className="shrink-0">${s.price} ·</span>
                    <span className="min-w-0 max-w-[10rem] truncate">
                      {s.team.name}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">No sales yet.</p>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function DraftPhaseView({ snapshot }: { snapshot: SeasonSnapshot }) {
  const { teams, season } = snapshot;
  return (
    <div className="space-y-6">
      <DraftPulse seasonId={season.id} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {teams.map((t) => {
          const spent = t.members.reduce((sum, m) => sum + m.price, 0);
          const startingBudget = t.budget + spent;
          return (
            <Card key={t.id} interactive>
              <CardHeader
                title={
                  <Link
                    href={`/teams/${t.id}`}
                    className="flex items-center gap-2 hover:text-info"
                  >
                    <TeamCrest
                      name={t.name}
                      seed={t.id}
                      size={24}
                      className="rounded-md"
                    />
                    {t.name}
                  </Link>
                }
                subtitle={
                  <span>
                    Captain:{" "}
                    <PlayerLink userId={t.captainId} className="text-muted">
                      {t.captain.name}
                    </PlayerLink>
                  </span>
                }
                action={<Badge tone="accent">${t.budget} left</Badge>}
              />
              <CardBody className="space-y-4">
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
                    <span>
                      Spent ${spent} of ${startingBudget}
                    </span>
                    <span>
                      {t.members.length}/{season.teamSize} roster
                    </span>
                  </div>
                  <Progress value={spent} max={startingBudget} />
                </div>
                <RosterList members={t.members} teamSize={season.teamSize} />
              </CardBody>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function RosterList({
  members,
  teamSize,
}: {
  members: SeasonSnapshot["teams"][number]["members"];
  teamSize: number;
}) {
  const slots = Array.from({ length: teamSize });
  return (
    <ul className="space-y-1.5">
      {slots.map((_, i) => {
        const m = members[i];
        return (
          <li
            key={i}
            className="flex items-center justify-between rounded-md border border-line/60 px-2.5 py-1.5 text-sm"
          >
            {m ? (
              <>
                <span className="flex items-center gap-2">
                  <Avatar name={m.user.name} src={m.user.avatar} size={22} />
                  <PlayerLink userId={m.userId}>{m.user.name}</PlayerLink>
                  {m.isCaptain ? (
                    <Badge tone="accent" className="ml-1">
                      C
                    </Badge>
                  ) : null}
                </span>
                <span className="text-muted">
                  {m.isCaptain ? "—" : `$${m.price}`}
                </span>
              </>
            ) : (
              <span className="text-muted/60">Empty slot</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------- REGULAR SEASON / PLAYOFFS ----------

async function SeasonView({
  snapshot,
  userId,
  matches,
}: {
  snapshot: SeasonSnapshot;
  userId?: string;
  matches: Match[];
}) {
  const { season, teams } = snapshot;
  const standings = computeStandings(
    teams.map((t) => t.id),
    matches,
  );
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const teamForm = formByTeam(
    teams.map((t) => t.id),
    matches,
  );

  // One scenario report powers the standings clinch marks, the this-week
  // stakes chips, and the your-team one-liner — computed once.
  const report =
    season.status === "REGULAR_SEASON"
      ? seasonScenarioReport(standings, matches, teams.length)
      : null;

  const myTeam = userId
    ? teams.find((t) => t.members.some((m) => m.userId === userId))
    : undefined;
  const myRow = myTeam
    ? standings.find((s) => s.teamId === myTeam.id)
    : undefined;
  const myRank = myTeam
    ? standings.findIndex((s) => s.teamId === myTeam.id) + 1
    : 0;
  const myScenario = myTeam ? (report?.teams.get(myTeam.id) ?? null) : null;
  const myStakeLine = myScenario ? stakeOneLiner(myScenario) : null;
  // "Next up" must be the SAME match the stake line's "next series" is about
  // (the engine orders by kickoff when times exist) — falling back to
  // chronological order, like the MyNextMatch banner above.
  const myOpen = myTeam
    ? matches.filter(
        (m) =>
          m.status !== "COMPLETED" &&
          (m.homeTeamId === myTeam.id || m.awayTeamId === myTeam.id),
      )
    : [];
  const myNextMatch =
    (myScenario?.nextMatchId
      ? myOpen.find((m) => m.id === myScenario.nextMatchId)
      : undefined) ?? [...myOpen].sort(byKickoff)[0];

  const playoffMatches = matches.filter((m) => m.phase !== "REGULAR");
  const bracketRoundsView = buildBracketRounds(
    playoffMatches,
    teamName,
    // Seeds come from the frozen first-round pairings, not live standings —
    // a corrected regular result must not relabel (or blank) bracket seeds.
    seedsFromFirstRound(playoffMatches),
    (d) => fmtWhen(d) ?? "",
  );
  const showBracket =
    season.status === "PLAYOFFS" && bracketRoundsView.length > 0;

  const recentResults = matches
    .filter((m) => m.status === "COMPLETED")
    .sort(
      (a, b) =>
        b.week - a.week || b.createdAt.getTime() - a.createdAt.getTime(),
    )
    .slice(0, 5);

  // Visible to everyone — spectators and unrostered players had no way to
  // see what's coming up without leaving the dashboard. Chronological, not
  // week order — a reschedule can move a match past its week-mates.
  const upcoming = matches
    .filter((m) => m.status !== "COMPLETED")
    .sort(byKickoff)
    .slice(0, 4);
  const openPickemIds = matches
    .filter((m) => predictionOpen(m))
    .map((m) => m.id);
  const pickemOpen = openPickemIds.length;
  const [seasonGames, picksMade] = await Promise.all([
    prisma.game.count({ where: { match: { seasonId: season.id } } }),
    userId && pickemOpen > 0
      ? prisma.prediction.count({
          where: { userId, matchId: { in: openPickemIds } },
        })
      : 0,
  ]);
  const fantasyLocked = seasonGames > 0;
  const picksMissing = pickemOpen - picksMade;

  return (
    <div className="space-y-6">
      {/* Side games — one tap from the dashboard into the engagement loop. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SideGameLink
          href="/pickem"
          icon="🔮"
          title="Pick'em"
          hint={
            pickemOpen > 0
              ? userId
                ? picksMissing > 0
                  ? `${picksMissing} pick${picksMissing === 1 ? "" : "s"} to make — call it`
                  : "All picks in — oracle board"
                : `${pickemOpen} ${pickemOpen === 1 ? "match" : "matches"} open — call it`
              : "See the oracle board"
          }
        />
        <SideGameLink
          href="/fantasy"
          icon="🧙"
          title="Fantasy"
          hint={fantasyLocked ? "Rosters locked — standings" : "Build your five"}
        />
        <SideGameLink
          href="/leaders"
          icon="🥇"
          title="Leaders"
          hint="Stat boards & weekly honors"
        />
        <SideGameLink
          href="/meta"
          icon="🧪"
          title="Hero meta"
          hint="What the league picks & wins with"
        />
      </div>

      {/* During playoffs the bracket IS the story — it leads, and the
          regular-season standings drop below as context. */}
      {showBracket ? (
        <Card>
          <CardHeader
            title="Playoff bracket"
            action={
              <Link
                href="/schedule"
                className="text-sm text-info hover:underline"
              >
                Full bracket →
              </Link>
            }
          />
          <CardBody className="p-0 pt-4">
            <Bracket
              rounds={bracketRoundsView}
              championTeamId={season.championTeamId}
            />
          </CardBody>
        </Card>
      ) : null}

      <ThisWeek
        season={season}
        matches={matches}
        teams={teams}
        teamName={teamName}
        report={report}
      />

      {/* min-w-0: grid items otherwise refuse to shrink below their content,
          letting a long team name widen the page on mobile. */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Standings"
              action={
                <Link
                  href="/schedule#this-week"
                  className="text-sm text-info hover:underline"
                >
                  Full schedule →
                </Link>
              }
            />
            <CardBody className="p-0">
              <StandingsTable
                standings={standings.slice(0, 8)}
                totalTeams={standings.length}
                teamName={teamName}
                formByTeam={teamForm}
                playoffCut={
                  season.status === "REGULAR_SEASON"
                    ? pickBracketSize(teams.length)
                    : undefined
                }
                clinch={clinchFromReport(report)}
                viewerTeamId={myTeam?.id}
                movement={standingsMovement(
                  teams.map((t) => t.id),
                  matches,
                )}
              />
            </CardBody>
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          {myTeam ? (
            <Card>
              <CardHeader
                title="Your team"
                subtitle={myTeam.name}
                action={
                  myRow && (teamForm.get(myTeam.id)?.length ?? 0) > 0 ? (
                    <FormStrip form={teamForm.get(myTeam.id)!} />
                  ) : undefined
                }
              />
              <CardBody className="space-y-3">
                {myRow && myRow.played > 0 ? (
                  <div className="grid grid-cols-3 gap-2">
                    <Stat label="Rank" value={`#${myRank}`} hint={`of ${teams.length}`} />
                    {/* W–L–D at Stat's default text-3xl wraps mid-number in
                        this narrow column — render it a size down. */}
                    <Stat
                      label="Record"
                      value={
                        <span className="text-xl leading-9">
                          {myRow.wins}–{myRow.losses}
                          {myRow.draws > 0 ? `–${myRow.draws}` : ""}
                        </span>
                      }
                    />
                    <Stat label="Points" value={myRow.points} />
                  </div>
                ) : null}
                {myStakeLine ? (
                  <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm">
                    {myStakeLine}
                  </div>
                ) : null}
                {myNextMatch ? (
                  <Link
                    href={`/matches/${myNextMatch.id}`}
                    className="block rounded-lg border border-line bg-surface-2/40 p-3 text-sm transition-colors hover:border-muted/60"
                  >
                    <div className="text-xs uppercase text-muted">
                      {matchPhaseLabel(myNextMatch.phase, myNextMatch.week)} ·
                      next up
                    </div>
                    <div className="mt-1 font-medium">
                      {teamName.get(myNextMatch.homeTeamId)} vs{" "}
                      {teamName.get(myNextMatch.awayTeamId)}
                    </div>
                    {myNextMatch.scheduledAt ? (
                      <div className="mt-1 text-xs text-muted">
                        <LocalTime
                          ts={myNextMatch.scheduledAt.getTime()}
                          variant="full"
                          initial={fmtWhen(myNextMatch.scheduledAt) ?? ""}
                        />
                      </div>
                    ) : null}
                  </Link>
                ) : (
                  <p className="text-sm text-muted">No upcoming matches.</p>
                )}
                <Link
                  href={`/teams/${myTeam.id}`}
                  className="inline-block text-sm font-medium text-info hover:underline"
                >
                  Team page →
                </Link>
              </CardBody>
            </Card>
          ) : null}

          {upcoming.length > 0 ? (
            <Card>
              <CardHeader title="Upcoming" />
              <CardBody className="p-0">
                <ul className="divide-y divide-line/60">
                  {upcoming.map((m) => (
                    <li key={m.id}>
                      <Link
                        href={`/matches/${m.id}`}
                        className="block px-4 py-2.5 text-sm hover:bg-surface-2/40"
                      >
                        <div className="text-xs uppercase text-muted">
                          {matchPhaseLabel(m.phase, m.week)}
                          {m.scheduledAt ? (
                            <>
                              {" · "}
                              <LocalTime
                                ts={m.scheduledAt.getTime()}
                                variant="full"
                                initial={fmtWhen(m.scheduledAt) ?? ""}
                              />
                            </>
                          ) : null}
                        </div>
                        <div className="mt-0.5 truncate font-medium">
                          {teamName.get(m.homeTeamId) ?? "?"}{" "}
                          <span className="font-normal text-muted">vs</span>{" "}
                          {teamName.get(m.awayTeamId) ?? "?"}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          {recentResults.length > 0 ? (
            <Card>
              <CardHeader title="Recent results" />
              <CardBody className="p-0">
                <ul className="divide-y divide-line/60">
                  {recentResults.map((m) => (
                    <li key={m.id}>
                      <Link
                        href={`/matches/${m.id}`}
                        className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm hover:bg-surface-2/40"
                      >
                        <span
                          className="w-7 shrink-0 font-mono text-[10px] uppercase tabular-nums text-muted"
                          title={matchPhaseLabel(m.phase, m.week)}
                        >
                          {matchPhaseAbbrev(m.phase, m.week)}
                        </span>
                        <span className="flex min-w-0 flex-1 items-center gap-1.5">
                          <TeamCrest
                            name={teamName.get(m.homeTeamId) ?? "?"}
                            seed={m.homeTeamId}
                            size={16}
                            className="rounded"
                          />
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate",
                              m.winnerTeamId === m.homeTeamId
                                ? "font-semibold"
                                : "text-muted",
                            )}
                          >
                            {teamName.get(m.homeTeamId) ?? "?"}
                          </span>
                          <span className="shrink-0 text-xs text-muted">v</span>
                          <TeamCrest
                            name={teamName.get(m.awayTeamId) ?? "?"}
                            seed={m.awayTeamId}
                            size={16}
                            className="rounded"
                          />
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate",
                              m.winnerTeamId === m.awayTeamId
                                ? "font-semibold"
                                : "text-muted",
                            )}
                          >
                            {teamName.get(m.awayTeamId) ?? "?"}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-xs tabular-nums">
                          {m.homeScore}–{m.awayScore}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          <LeaguePulse seasonId={season.id} teams={teams} teamName={teamName} />
        </div>
      </div>

    </div>
  );
}

/** One line of drama for the your-team card, from the scenario engine. */
function stakeOneLiner(s: {
  status: ClinchStatus;
  winAndIn: boolean;
  loseAndOut: boolean;
  magicNumber: number | null;
  nextMatchId: string | null;
}): string | null {
  if (s.status === "CLINCHED") return "✓ Playoff spot locked — play for seeding.";
  if (s.status === "ELIMINATED") return "Out of the race — play for pride.";
  if (s.nextMatchId === null) return null; // done playing; the table decides
  if (s.winAndIn && s.loseAndOut)
    return "⚡ Everything on the line: win the next series and you're in — lose it and you're out.";
  if (s.winAndIn) return "🎯 Win the next series and a playoff spot is locked.";
  if (s.loseAndOut) return "⚠️ Lose the next series and the playoffs are gone.";
  if (s.magicNumber != null && s.magicNumber > 0)
    return `🔢 Magic number ${s.magicNumber} — that many wins locks a spot.`;
  return null;
}

/**
 * The matches everyone cares about right now — this week's slate during the
 * regular season, the open round during playoffs — with per-team check-in
 * counts and a stakes chip when the scenario engine says a game is dramatic.
 */
async function ThisWeek({
  season,
  matches,
  teams,
  teamName,
  report,
}: {
  season: SeasonSnapshot["season"];
  matches: Match[];
  teams: SeasonSnapshot["teams"];
  teamName: Map<string, string>;
  report: ScenarioReport | null;
}) {
  const open = matches.filter((m) => m.status !== "COMPLETED");
  let focus: Match[] = [];
  let title = "This week";
  if (season.status === "PLAYOFFS") {
    focus = open.filter((m) => m.phase !== "REGULAR");
    title = "The round in progress";
  } else {
    const openRegular = open.filter((m) => m.phase === "REGULAR");
    if (openRegular.length > 0) {
      const week = Math.min(...openRegular.map((m) => m.week));
      focus = openRegular.filter((m) => m.week === week);
      title = `This week · Week ${week}`;
    }
  }
  if (focus.length === 0) return null;

  const [avail, standinRows] = await Promise.all([
    prisma.matchAvailability.findMany({
      where: { matchId: { in: focus.map((m) => m.id) } },
      select: { matchId: true, userId: true, status: true },
    }),
    prisma.standinAssignment.findMany({
      where: { matchId: { in: focus.map((m) => m.id) } },
      select: {
        matchId: true,
        teamId: true,
        standinUserId: true,
        replacingUserId: true,
      },
    }),
  ]);
  const rosterOf = new Map(
    teams.map((t) => [t.id, t.members.map((m) => m.userId)]),
  );
  const checkins = (matchId: string, teamId: string) => {
    // Standin-aware, same helper as /schedule — a covered player's absence
    // isn't a gap, and the standin's own RSVP is the one that counts.
    const roster = matchNightRoster(
      rosterOf.get(teamId) ?? [],
      standinRows.filter(
        (a) => a.matchId === matchId && a.teamId === teamId,
      ),
    );
    if (roster.length === 0) return null;
    const a = teamAvailability(
      roster,
      avail.filter((r) => r.matchId === matchId),
    );
    return { confirmed: a.confirmed, size: roster.length };
  };

  return (
    <Card>
      <CardHeader
        title={title}
        subtitle="Check in, scout the enemy, call the winner"
        action={
          <Link
            href="/schedule#this-week"
            className="text-sm text-info hover:underline"
          >
            Full schedule →
          </Link>
        }
      />
      <CardBody className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {focus.map((m) => {
          const headline = report
            ? stakesHeadline(
                matchStakes(m.id, m.homeTeamId, m.awayTeamId, report),
              )
            : null;
          // The full "Everything on the line…" label wraps into a mangled
          // pill at phone widths — chip context gets the short form.
          const stakes = headline?.startsWith("Everything on the line")
            ? "Win and in, lose and out"
            : headline;
          return (
            <Link
              key={m.id}
              href={`/matches/${m.id}`}
              className="block min-w-0 rounded-lg border border-line bg-surface-2/30 p-3 text-sm transition-colors hover:border-muted/60"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <span className="uppercase">
                  {matchPhaseLabel(m.phase, m.week)}
                </span>
                {m.scheduledAt ? (
                  <LocalTime
                    ts={m.scheduledAt.getTime()}
                    variant="full"
                    initial={fmtWhen(m.scheduledAt) ?? ""}
                  />
                ) : null}
                {stakes ? (
                  <Badge tone="accent" className="ml-auto rounded-md text-left">
                    {stakes}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-2 space-y-1">
                {[m.homeTeamId, m.awayTeamId].map((teamId) => {
                  const c = checkins(m.id, teamId);
                  return (
                    <div
                      key={teamId}
                      className="flex min-w-0 items-center gap-2"
                    >
                      <TeamCrest
                        name={teamName.get(teamId) ?? "?"}
                        seed={teamId}
                        size={18}
                        className="shrink-0 rounded"
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {teamName.get(teamId) ?? "?"}
                      </span>
                      {c ? (
                        <span
                          role="img"
                          aria-label={`${c.confirmed} of ${c.size} checked in`}
                          className={cn(
                            "shrink-0 text-xs tabular-nums",
                            c.confirmed === c.size
                              ? "text-success"
                              : "text-muted",
                          )}
                          title={`${c.confirmed} of ${c.size} checked in`}
                        >
                          <span aria-hidden>
                            ✓ {c.confirmed}/{c.size}
                          </span>
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </Link>
          );
        })}
      </CardBody>
    </Card>
  );
}

/**
 * A taste of the league's stat life: the latest weekly honors and the
 * most-contested hero, teasing /leaders and /meta. Hidden until games exist.
 */
async function LeaguePulse({
  seasonId,
  teams,
  teamName,
}: {
  seasonId: string;
  teams: SeasonSnapshot["teams"];
  teamName: Map<string, string>;
}) {
  const games = await prisma.game.findMany({
    where: { match: { seasonId } },
    select: {
      players: true,
      radiantWin: true,
      match: { select: { week: true, phase: true } },
    },
  });
  if (games.length === 0) return null;

  const parsed = games.map((g) => ({
    ...g,
    lines: safeParseStats(g.players),
  }));
  const teamOf = new Map(
    teams.flatMap((t) => t.members.map((m) => [m.userId, t.id] as const)),
  );

  // Latest regular week with games in — its honors are the freshest story.
  const regular = parsed.filter((g) => g.match.phase === "REGULAR");
  const latestWeek = regular.reduce((max, g) => Math.max(max, g.match.week), 0);
  const honors =
    latestWeek > 0
      ? weeklyHonors(
          regular
            .filter((g) => g.match.week === latestWeek)
            .map((g) => ({ radiantWin: g.radiantWin, players: g.lines })),
          teamOf,
        )
      : { player: null, team: null };
  const potw = honors.player
    ? await prisma.user.findUnique({
        where: { id: honors.player.userId },
        select: { id: true, name: true, avatar: true },
      })
    : null;

  // The league's most-contested hero so far.
  const meta = heroMeta(
    parsed.map((g) => ({
      radiantWin: g.radiantWin,
      lines: g.lines.map((p) => ({
        userId: p.userId,
        heroId: p.heroId,
        isRadiant: p.isRadiant,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
      })),
    })),
  );
  const topPick = meta.rows[0];
  const topHero = topPick ? heroById(topPick.heroId) : null;

  return (
    <Card>
      <CardHeader
        title="League pulse"
        action={
          <Link href="/leaders" className="text-sm text-info hover:underline">
            Leaders →
          </Link>
        }
      />
      <CardBody className="space-y-3 text-sm">
        {potw && honors.player ? (
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="shrink-0">
              ⭐
            </span>
            <span className="min-w-0 flex-1 truncate">
              <PlayerLink userId={potw.id} className="font-medium">
                {potw.name}
              </PlayerLink>{" "}
              <span className="text-muted">
                · Week {latestWeek} PotW · {honors.player.points} pts
              </span>
            </span>
          </div>
        ) : null}
        {honors.team ? (
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="shrink-0">
              🛡️
            </span>
            <span className="min-w-0 flex-1 truncate">
              <Link
                href={`/teams/${honors.team.teamId}`}
                className="font-medium hover:text-info"
              >
                {teamName.get(honors.team.teamId) ?? "?"}
              </Link>{" "}
              <span className="text-muted">
                · Week {latestWeek} team · {honors.team.gameWins} game win
                {honors.team.gameWins === 1 ? "" : "s"}
              </span>
            </span>
          </div>
        ) : null}
        {topPick ? (
          <div className="flex min-w-0 items-center gap-2">
            {/* Unknown hero ids still render — "Hero #N" fallback per /meta. */}
            {topHero ? (
              <HeroIcon hero={topHero} size={22} />
            ) : (
              <span
                aria-hidden
                className="h-[22px] w-[22px] shrink-0 rounded-md border border-line/70 bg-surface-2"
              />
            )}
            <span className="min-w-0 flex-1 truncate">
              <Link href="/meta" className="font-medium hover:text-info">
                {topHero?.name ?? `Hero #${topPick.heroId}`}
              </Link>{" "}
              <span className="text-muted">
                · most picked · {topPick.picks} pick
                {topPick.picks === 1 ? "" : "s"}, {topPick.winRate}% wins
              </span>
            </span>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function safeParseStats(json: string): PlayerStat[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function SideGameLink({
  href,
  icon,
  title,
  hint,
}: {
  href: string;
  icon: string;
  title: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="group flex min-w-0 items-center gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 transition-colors hover:border-muted/60"
    >
      <span aria-hidden className="text-xl">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium group-hover:text-info">
          {title}
        </span>
        <span className="block truncate text-xs text-muted">{hint}</span>
      </span>
    </Link>
  );
}

/**
 * Server-side adapter for the sortable client table: flattens the maps into
 * plain rows (Maps don't cross the client boundary) and drops clinch marks
 * when every team makes the bracket (they'd all be \u2713).
 */
export function StandingsTable({
  standings,
  teamName,
  formByTeam,
  playoffCut,
  clinch,
  viewerTeamId,
  movement,
  totalTeams,
}: {
  standings: ReturnType<typeof computeStandings>;
  teamName: Map<string, string>;
  formByTeam?: Map<string, FormResult[]>;
  /** How many top teams make playoffs \u2014 draws a "playoff cut" line when set. */
  playoffCut?: number;
  /** Per-team clinched/eliminated verdicts (see clinchStatuses). */
  clinch?: Map<string, ClinchStatus>;
  /** The signed-in viewer's team \u2014 its row gets a subtle highlight. */
  viewerTeamId?: string | null;
  /** Weekly rank movement (see standingsMovement). */
  movement?: Map<string, number>;
  /** League size before any slicing (dashboard passes the top 8 only). */
  totalTeams?: number;
}) {
  // "Everyone makes the bracket" must be judged against the whole league,
  // not the (possibly sliced) rows this table happens to show.
  const fieldSize = totalTeams ?? standings.length;
  const cutIsReal =
    playoffCut != null && playoffCut > 0 && playoffCut < fieldSize;
  const rows: StandingsRowView[] = standings.map((s, i) => ({
    teamId: s.teamId,
    name: teamName.get(s.teamId) ?? "\u2014",
    rank: i + 1,
    wins: s.wins,
    draws: s.draws,
    losses: s.losses,
    gameDiff: s.gameDiff,
    points: s.points,
    form: formByTeam ? formByTeam.get(s.teamId) ?? [] : null,
    clinch: cutIsReal ? clinch?.get(s.teamId) ?? null : null,
    move: movement?.get(s.teamId) ?? 0,
  }));
  return (
    <StandingsTableClient
      rows={rows}
      playoffCut={playoffCut}
      viewerTeamId={viewerTeamId}
      totalTeams={fieldSize}
    />
  );
}

// ---------- COMPLETE ----------

async function CompleteView({
  snapshot,
  matches,
}: {
  snapshot: SeasonSnapshot;
  matches: Match[];
}) {
  const { teams, season } = snapshot;
  const champion = teams.find((t) => t.id === season.championTeamId);
  const standings = computeStandings(
    teams.map((t) => t.id),
    matches,
  );
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const teamForm = formByTeam(
    teams.map((t) => t.id),
    matches,
  );
  const championRow = champion
    ? standings.find((s) => s.teamId === champion.id)
    : undefined;

  // The final's scoreline turns "champion: X" into a story.
  const finalMatch = champion
    ? matches.find(
        (m) =>
          m.phase === "FINAL" &&
          m.status === "COMPLETED" &&
          m.winnerTeamId === champion.id,
      )
    : undefined;
  const finalLine = finalMatch
    ? {
        score:
          finalMatch.winnerTeamId === finalMatch.homeTeamId
            ? `${finalMatch.homeScore}–${finalMatch.awayScore}`
            : `${finalMatch.awayScore}–${finalMatch.homeScore}`,
        loser: teamName.get(
          finalMatch.winnerTeamId === finalMatch.homeTeamId
            ? finalMatch.awayTeamId
            : finalMatch.homeTeamId,
        ),
      }
    : undefined;

  return (
    <div className="space-y-6">
      <Card className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400/15 blur-3xl"
        />
        <CardBody className="relative flex flex-col items-center gap-3 py-10 text-center">
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-amber-300/90">
            {season.name} Champion
          </div>
          {champion ? (
            <div className="relative">
              <TeamCrest
                name={champion.name}
                seed={champion.id}
                size={76}
                className="rounded-2xl shadow-lg ring-2 ring-amber-400/50"
              />
              <span
                aria-hidden
                className="absolute -bottom-2 -right-2 grid h-8 w-8 place-items-center rounded-full border border-amber-400/40 bg-surface text-lg shadow-md"
              >
                🏆
              </span>
            </div>
          ) : (
            <div className="text-5xl">🏆</div>
          )}
          <div className="text-2xl font-bold">
            {champion ? (
              <Link href={`/teams/${champion.id}`} className="hover:text-info">
                {champion.name}
              </Link>
            ) : (
              "To be crowned"
            )}
          </div>
          {finalLine ? (
            <div className="text-sm text-muted">
              Won the grand final{" "}
              <span className="font-medium text-fg">{finalLine.score}</span>
              {finalLine.loser ? ` over ${finalLine.loser}` : ""}
            </div>
          ) : null}
          {championRow ? (
            <div className="text-sm text-muted">
              <span className="font-medium text-fg">
                {championRow.wins}–{championRow.losses}
                {championRow.draws > 0 ? `–${championRow.draws}` : ""}
              </span>{" "}
              regular season · {championRow.points} pts
            </div>
          ) : null}
          {champion && champion.members.length > 0 ? (
            <div className="mt-1 flex flex-wrap justify-center gap-1.5">
              {champion.members.map((m) => (
                <PlayerLink
                  key={m.id}
                  userId={m.userId}
                  className="flex items-center gap-1.5 rounded-full border border-line bg-surface-2/50 py-0.5 pl-0.5 pr-2.5 text-xs hover:border-muted/60 hover:no-underline"
                >
                  <Avatar name={m.user.name} src={m.user.avatar} size={20} />
                  <span>{m.user.name}</span>
                </PlayerLink>
              ))}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <CompleteBracket
        matches={matches}
        teamName={teamName}
        championTeamId={season.championTeamId}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <Card>
            <CardHeader
              title="Final standings"
              action={
                <Link
                  href="/schedule#this-week"
                  className="text-sm text-info hover:underline"
                >
                  Full schedule →
                </Link>
              }
            />
            <CardBody className="p-0">
              <StandingsTable
                standings={standings}
                teamName={teamName}
                formByTeam={teamForm}
              />
            </CardBody>
          </Card>
        </div>
        <div className="min-w-0">
          <Card>
            <CardHeader title="The season lives on" />
            <CardBody className="space-y-3 text-sm">
              <p className="text-muted">
                Relive it — awards and superlatives, the stat boards, and the
                records this season may have etched into league history.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/recap?season=${season.id}`}
                  className={buttonClasses("accent")}
                >
                  🏆 Season recap →
                </Link>
                <Link href="/leaders" className={buttonClasses("secondary")}>
                  Leaderboards
                </Link>
                <Link href="/records" className={buttonClasses("secondary")}>
                  Record book
                </Link>
                <Link href="/seasons" className={buttonClasses("secondary")}>
                  Season archive
                </Link>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

// The championship run, in the classic bracket shape — the story of how the
// trophy was won belongs on the season's front page.
function CompleteBracket({
  matches,
  teamName,
  championTeamId,
}: {
  matches: Match[];
  teamName: Map<string, string>;
  championTeamId: string | null;
}) {
  const playoffMatches = matches.filter((m) => m.phase !== "REGULAR");
  const rounds = buildBracketRounds(
    playoffMatches,
    teamName,
    seedsFromFirstRound(playoffMatches),
    (d) => fmtWhen(d) ?? "",
  );
  if (rounds.length === 0) return null;
  return (
    <Card>
      <CardHeader title="How it was won" />
      <CardBody className="p-0 pt-4">
        <Bracket rounds={rounds} championTeamId={championTeamId} />
      </CardBody>
    </Card>
  );
}
