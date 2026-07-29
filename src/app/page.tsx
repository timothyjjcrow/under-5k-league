import { Fragment, Suspense, type ReactNode } from "react";
import { getSeasonGameLeaders } from "@/lib/cached-queries";
import { parseGamePlayers } from "@/lib/player-stats";
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
  focusSlate,
  pickBracketSize,
  roundName,
  slotRound,
} from "@/lib/schedule";
import { buildBracketRounds, seedsFromFirstRound } from "@/lib/bracket-view";
import { Bracket } from "@/components/bracket";
import { formByTeam, type FormResult } from "@/lib/team-matches";
import {
  expectedSideSize,
  matchNightRoster,
  teamAvailability,
} from "@/lib/availability";
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
  CardSkeleton,
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
  Skeleton,
  Stat,
  SteamSafetyNote,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { averageMmr, mmrDistribution, roleCoverage } from "@/lib/pool-stats";
import { queuePresentCutoff } from "@/lib/inhouse";
import { WeekReminderPing } from "@/components/week-reminder-ping";
import { DiscordSetupPrompt } from "@/components/discord-setup";
import {
  AUTO_SYNC,
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
import { Countdown } from "@/components/countdown";
import { NewsMedia } from "@/components/news-media";
import { formatMatchTime } from "@/lib/match-time";
import { firstMedia } from "@/lib/linkify";
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
        {/* next=/me: signing in "to join" should land on the signup form. */}
        <Link href="/login?next=/me" className={buttonClasses("primary", "lg")}>
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
        {/* Both states carry an ASK, because signups never close on a count —
            minTeams is a floor (see capacity.ts). Past it the badge alone was
            the whole story, and "Ready to draft" is a full stop: it answers
            "can the league run?" and says nothing to the person still deciding
            whether to be in it. The ask keeps the same HeroStat shape as the
            under-minimum one so the marquee reads identically either side of
            the threshold — only what it's counting toward changes. Which team
            number it would be is left to the card below; up here it just has to
            be true forever, and "another team" can't go stale. */}
        {capacity.canDraft ? (
          <>
            <Badge tone="success">Ready to draft</Badge>
            <HeroStat
              value={capacity.toNextTeam}
              label="more for another team"
              tone="accent"
            />
          </>
        ) : (
          <HeroStat
            value={capacity.needed}
            label="more to start the draft"
            tone="accent"
          />
        )}
        {season.draftAt ? (
          <span className="flex items-center text-sm text-muted">
            🗓️ Draft{" "}
            <Countdown targetMs={season.draftAt.getTime()} eventLabel="Draft" />
          </span>
        ) : null}
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

  // The hero's control slot. Mid-season heroAction is null — there is no
  // league-wide CTA once the season is running — and that is exactly when a
  // signed-in player has the most personal thing to do: check in for their next
  // match. Everything else falls through to the phase's own CTA buttons.
  const heroAside =
    showsMatches && user && !heroAction ? (
      <Suspense fallback={<Skeleton className="h-32 w-full rounded-[var(--radius)]" />}>
        <MyNextMatch seasonId={season.id} userId={user.id} />
      </Suspense>
    ) : null;

  return (
    <div className="space-y-8">
      <Hero
        phase={season.status}
        title={season.name}
        subtitle={phaseSubtitle(season.status)}
        action={heroAction}
        meta={heroMeta}
        aside={heroAside}
        rail={<SeasonTimeline phase={season.status} />}
      />
      {/* Signed up but unreachable — the one cohort every Discord notification
          in the app silently skips. Renders nothing for everyone else, and is
          phase-independent on purpose: a player who signs up during SIGNUPS and
          links nothing is still unreachable in week 4. */}
      {user ? (
        <Suspense fallback={null}>
          <DiscordSetupPrompt userId={user.id} seasonId={season.id} />
        </Suspense>
      ) : null}
      {/* Below the hero everything streams: the shell (hero + timeline) paints
          immediately while each section resolves its own queries behind a
          Suspense boundary, instead of the whole page blocking on the slowest.
          Sections that can render NOTHING (no news, no upcoming match, no games
          yet) use fallback={null} so an empty state never flashes a phantom
          skeleton that then collapses — only guaranteed-content sections show a
          placeholder. */}
      <Suspense fallback={null}>
        <LeagueNews />
      </Suspense>
      <Suspense fallback={<div className="skeleton h-12 rounded-[var(--radius)]" />}>
        <InhouseStrip />
      </Suspense>
      {season.status === "SIGNUPS" && (
        <Suspense fallback={<CardSkeleton rows={4} />}>
          <SignupsView snapshot={snapshot} loggedIn={!!user} />
        </Suspense>
      )}
      {season.status === "DRAFT" && <DraftPhaseView snapshot={snapshot} />}
      {(season.status === "REGULAR_SEASON" || season.status === "PLAYOFFS") && (
        <>
          {/* Lazy match-night Discord reminder — invisible, never blocks paint. */}
          <Suspense fallback={null}>
            <WeekReminderPing season={season} />
          </Suspense>
          {/* MyNextMatch is NOT rendered here any more — it lives in the hero's
              control slot, which is the whole point: the RSVP a captain depends
              on used to be the lowest-contrast strip on the page. */}
          <Suspense fallback={<SeasonViewSkeleton />}>
            <SeasonView snapshot={snapshot} userId={user?.id} matches={matches} />
          </Suspense>
        </>
      )}
      {season.status === "COMPLETE" && (
        <Suspense fallback={<CardSkeleton rows={4} />}>
          <CompleteView snapshot={snapshot} matches={matches} />
        </Suspense>
      )}
    </div>
  );
}

// Fallback for the mid-season dashboard. It MUST mirror the real bands — This
// week, the standings/your-team split, the three-up deck, then the side games —
// or the page paints one layout and then visibly rearranges into another.
function SeasonViewSkeleton() {
  return (
    <div className="space-y-6">
      <CardSkeleton rows={4} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <CardSkeleton rows={6} />
        </div>
        <div className="min-w-0">
          <CardSkeleton rows={4} />
        </div>
      </div>
      <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr))]">
        {Array.from({ length: 3 }).map((_, i) => (
          <CardSkeleton key={i} rows={3} className="min-w-0" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-16 rounded-[var(--radius)]" />
        ))}
      </div>
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
          <Link href="/news" className={textLink("text-sm")}>
            All news →
          </Link>
        }
      />
      <CardBody className="space-y-4">
        {posts.map((p) => {
          // Render the GIF below the clamped text, not inside it — a block embed
          // inside a -webkit-line-clamp box breaks the clamp. Capped shorter than
          // /news so three previews stay tidy.
          const media = firstMedia(p.body);
          return (
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
                <LinkifiedText text={p.body} images="hide" />
              </p>
              {media && (
                <NewsMedia
                  src={media.value}
                  kind={media.kind}
                  className="mt-2 block max-h-40 max-w-full rounded-lg border border-line"
                />
              )}
            </div>
          );
        })}
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
  const mine = {
    seasonId,
    status: { not: "COMPLETED" as const },
    OR: [
      ...(teamIds.length
        ? [{ homeTeamId: { in: teamIds } }, { awayTeamId: { in: teamIds } }]
        : []),
      { standins: { some: { standinUserId: userId } } },
    ],
  };
  // Chronological, not week order — an accepted reschedule can legally move a
  // match past the next week's night, and the banner should always point at
  // whatever plays first. Unscheduled matches sort last.
  const order = [
    { scheduledAt: { sort: "asc" as const, nulls: "last" as const } },
    { week: "asc" as const },
    { createdAt: "asc" as const },
  ];
  // A match nobody ever reported stays un-COMPLETED forever. Ordering purely by
  // kickoff then pinned every participant's banner to that dead week-1 fixture
  // for the rest of the season — they'd check in against it while the match
  // they were actually playing that night got no check-ins at all. Prefer the
  // earliest fixture that is still plausibly ahead of (or during) tonight, and
  // fall back to the stale one only when there's nothing else left.
  // async server component (renders once per request); see admin/page.tsx.
  // eslint-disable-next-line react-hooks/purity
  const freshFrom = new Date(Date.now() - AUTO_SYNC.WINDOW_HOURS * 3600_000);
  const next =
    (await prisma.match.findFirst({
      where: { ...mine, scheduledAt: { gte: freshFrom } },
      orderBy: order,
      include: { homeTeam: true, awayTeam: true },
    })) ??
    (await prisma.match.findFirst({
      where: { ...mine, scheduledAt: null },
      orderBy: order,
      include: { homeTeam: true, awayTeam: true },
    })) ??
    (await prisma.match.findFirst({
      where: mine,
      orderBy: order,
      include: { homeTeam: true, awayTeam: true },
    }));
  // The hero's control slot must never be an empty 23rem column, so an
  // unrostered viewer (or a player whose season is done) gets the spectator
  // form of the same thing rather than nothing at all.
  if (!next) {
    return (
      <Card className="p-4 text-sm">
        <div className="font-medium">No match of your own coming up</div>
        <p className="mt-1 text-muted">
          You&apos;re not on a roster for an upcoming fixture — the week&apos;s
          games are still worth watching.
        </p>
        <Link
          href="/schedule#this-week"
          className={buttonClasses("secondary", "sm", "mt-3 w-full")}
        >
          See this week&apos;s schedule →
        </Link>
      </Card>
    );
  }

  const [myRsvp, pendingReschedule] = await Promise.all([
    prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: next.id, userId } },
      select: { status: true },
    }),
    prisma.rescheduleRequest.findFirst({
      where: { matchId: next.id, status: "PENDING" },
      include: { proposedBy: { select: { name: true } } },
    }),
  ]);

  // A proposal awaiting THIS viewer's answer gets a strip right on the
  // dashboard — proposals used to rot on the match page unseen.
  const awaitingMyAnswer =
    !!pendingReschedule &&
    pendingReschedule.proposedById !== userId &&
    (next.homeTeam.captainId === userId || next.awayTeam.captainId === userId);

  return (
    <div className="space-y-2">
      <CheckinBanner
        variant="panel"
        eyebrow={`Your next match · ${matchPhaseLabel(next.phase, next.week)}`}
        matchId={next.id}
        heading={`${next.homeTeam.name} vs ${next.awayTeam.name}`}
        when={fmtWhen(next.scheduledAt)}
        whenTs={next.scheduledAt?.getTime()}
        myRsvp={myRsvp?.status ?? null}
        detailsHref={`/matches/${next.id}`}
      />
      {awaitingMyAnswer ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm">
          <span aria-hidden>⏳</span>
          <span className="min-w-0 flex-1">
            <strong>{pendingReschedule.proposedBy.name}</strong> proposed
            moving this match to{" "}
            <strong>
              <LocalTime
                ts={pendingReschedule.proposedTime.getTime()}
                variant="full"
                initial={formatMatchTime(pendingReschedule.proposedTime, "full")}
              />
            </strong>
          </span>
          <Link
            href={`/matches/${next.id}`}
            className={textLink("shrink-0")}
          >
            Respond →
          </Link>
        </div>
      ) : null}
    </div>
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

/**
 * The hero is a two-column marquee: the season's identity on the left, and ONE
 * control slot on the right holding whatever this viewer, in this phase, is
 * actually meant to do — the signup CTA, the draft-room door, or (mid-season,
 * where there used to be no call to action at all) their own match check-in.
 *
 * Three things it deliberately keeps from the old centred version: every
 * ambient layer, the phase Badge's exact text node, and the season name as the
 * page's only <h1>. What it drops is 60px of vertical padding and the
 * centre-alignment, which is what made ~250px of prime space carry no action.
 *
 * `aside` is optional — a signed-out visitor mid-season has nothing to act on,
 * and an empty 24rem column would be worse than none, so the identity column
 * simply takes the full width. Anything passed as `aside` MUST render
 * something; that is why MyNextMatch has a no-match branch.
 */
function Hero({
  phase,
  title,
  subtitle,
  action,
  meta,
  aside,
  rail,
}: {
  phase: string | null;
  title: string;
  subtitle: string;
  action?: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
  rail?: ReactNode;
}) {
  const live = !!phase && phase !== "COMPLETE";
  const control = aside ?? (action ? <HeroActions>{action}</HeroActions> : null);
  return (
    <section className="relative overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-b from-surface-2/70 to-surface/40">
      {/* Looping background video — fades in/out at the loop seam to hide the jump. */}
      <HeroVideo />
      {/* Themed tint over the video for contrast + palette cohesion. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-surface/40 via-bg/45 to-surface/75"
      />
      {/* Layered ambient background: masked grid + dual neon glows. Cropping
          them into a shorter box makes them read MORE, not less. */}
      <div
        aria-hidden
        className="hero-grid pointer-events-none absolute inset-0 opacity-60"
      />
      <div
        aria-hidden
        className="animate-hero-glow pointer-events-none absolute left-1/3 top-0 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/25 blur-3xl"
      />
      <div
        aria-hidden
        className="animate-hero-glow-alt pointer-events-none absolute -right-12 bottom-0 h-48 w-48 translate-y-1/3 rounded-full bg-accent/20 blur-3xl"
      />
      <div
        className={cn(
          "relative grid gap-6 p-5 sm:p-8",
          control
            ? "lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-center lg:gap-10"
            : "text-center",
        )}
      >
        <div className={cn("min-w-0", control ? "" : "mx-auto max-w-2xl")}>
          <div
            className={cn(
              "flex flex-wrap items-center gap-2",
              control ? "" : "justify-center",
            )}
          >
            {phase ? (
              <Badge tone={PHASE_TONE[phase] ?? "neutral"}>
                {live ? (
                  <span
                    aria-hidden
                    className="animate-live-pulse mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-current"
                  />
                ) : null}
                {PHASE_LABEL[phase] ?? phase}
              </Badge>
            ) : null}
            {/* Persistent league fact: the Dota region every game is played on.
                It rode its own centred row before, costing a whole line for a
                value that never changes. */}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs font-medium text-muted">
              <span aria-hidden>🌐</span>
              Game servers:{" "}
              <span className="font-semibold text-fg">
                {GAME_SERVER_REGION}
              </span>
            </span>
          </div>
          <h1 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            {title}
          </h1>
          <p className="mt-2 max-w-xl text-muted sm:text-lg">{subtitle}</p>
          {meta ? (
            <div
              className={cn(
                "mt-5 flex flex-wrap items-center gap-x-6 gap-y-2",
                control ? "" : "justify-center",
              )}
            >
              {meta}
            </div>
          ) : null}
        </div>
        {control ? <div className="min-w-0">{control}</div> : null}
      </div>
      {/* The season stepper used to be its own full-width band restating the
          phase badge two rows above it. As the hero's footer rail it costs no
          extra band and reads as part of the same object. */}
      {rail ? (
        <div className="relative border-t border-line/70 bg-bg/30 px-4 py-3 sm:px-8">
          {rail}
        </div>
      ) : null}
    </section>
  );
}

/** CTA buttons in the control slot: full-width and stacked, so a two-button
 *  phase reads as a primary + a secondary rather than two equal halves. */
function HeroActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 [&>a]:w-full [&>a]:justify-center">
      {children}
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
    // No frame of its own: it renders inside the hero's footer rail, which owns
    // the border and the background.
    <div>
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
                    "grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold",
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
    // Same presence rule as /inhouse: only recently-seen players count.
    prisma.inhouseQueueEntry.count({
      // eslint-disable-next-line react-hooks/purity -- async server component
      where: { lastSeenAt: { gte: queuePresentCutoff(Date.now()) } },
    }),
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
          {/* `minTeams` is the FLOOR the draft needs, never a cap: nothing
              refuses a signup past it (registrationGate checks the MMR ceiling
              and the SIGNUPS phase, nothing else) and startDraft forms one team
              per captain, so the 31st player on a 6-team season just becomes a
              7th team. This headline used to read "31 / 30 players to start"
              over a progress bar pegged at 100% — a fraction above 1, which is
              the universal shape of "sold out", shown to exactly the person
              deciding whether to bother signing up. Past the minimum it counts
              UP instead, and the bar retargets on the next whole team. */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
            <span className="min-w-0 font-medium">
              {capacity.canDraft
                ? `${playerCount} player${playerCount === 1 ? "" : "s"} signed up`
                : `${playerCount} / ${capacity.minPlayers} players to start`}
              <span className="font-normal text-muted">
                {" "}
                · teams of {season.teamSize}
                {season.maxMmr > 0
                  ? ` · ${season.maxMmr} MMR soft limit`
                  : ""}
              </span>
            </span>
            <span className="shrink-0 text-muted">
              {capacity.canDraft
                ? "Ready to draft — still open"
                : `${capacity.needed} more needed`}
            </span>
          </div>
          {season.draftAt ? (
            <p className="text-sm text-muted">
              🗓️ Draft night:{" "}
              <strong className="text-fg">
                <LocalTime
                  ts={season.draftAt.getTime()}
                  variant="full"
                  initial={formatMatchTime(season.draftAt, "full")}
                />
              </strong>
              <Countdown targetMs={season.draftAt.getTime()} eventLabel="Draft" />
            </p>
          ) : null}
          {capacity.canDraft ? (
            <div className="space-y-2">
              {/* Retargeted at the next whole team, so the bar keeps meaning
                  something instead of sitting full for the rest of signups. */}
              <Progress value={capacity.leftover} max={season.teamSize} />
              <p className="text-sm text-muted">
                The {season.minTeams}-team minimum is covered — signups stay open,
                and every {season.teamSize} more players is another team.{" "}
                <strong className="text-fg">
                  {capacity.toNextTeam} more
                </strong>{" "}
                would make it {capacity.teamsFormable + 1} full teams.
              </p>
            </div>
          ) : (
            <Progress value={playerCount} max={capacity.minPlayers} />
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Players" value={playerCount} />
            <Stat label="Standins" value={standinCount} />
            <Stat
              label="Teams ready"
              value={capacity.teamsFormable}
              hint={
                capacity.canDraft
                  ? `minimum ${season.minTeams}`
                  : `of ${season.minTeams} needed`
              }
            />
            <Stat
              label="Captain volunteers"
              value={captainVolunteers}
              /* One captain per TEAM, and the team count grows with the pool —
                 pinning this hint to minTeams told a 37-player season it needed
                 6 captains when seating everyone takes 7. */
              hint={`need ${Math.max(season.minTeams, capacity.teamsFormable)}`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            {!loggedIn ? (
              <Link
                href="/login?next=/me"
                className={buttonClasses("primary", "lg")}
              >
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

      <Suspense fallback={null}>
        <PoolComposition seasonId={season.id} />
      </Suspense>

      <Card>
        <CardHeader
          title="Who's in"
          subtitle="Latest players to sign up"
          action={
            <Link href="/players" className={textLink("text-sm")}>
              View all →
            </Link>
          }
        />
        <CardBody>
          <Suspense fallback={<Skeleton className="h-8 w-full" />}>
            <RecentSignups seasonId={season.id} />
          </Suspense>
        </CardBody>
      </Card>
    </div>
  );
}

async function RecentSignups({ seasonId }: { seasonId: string }) {
  const regs = await prisma.registration.findMany({
    where: { seasonId, status: "ACTIVE", type: "PLAYER" },
    // Only the fields the chips render — this list serializes into the page.
    include: {
      user: { select: { id: true, name: true, avatar: true, rankTier: true } },
    },
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
          {r.mmr > 0 ? <span className="text-xs text-muted">{r.mmr}</span> : null}
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
      <CardBody className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
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
                  <PlayerLink userId={s.userId} className="min-w-6 truncate">
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
      <Suspense fallback={null}>
        <DraftPulse seasonId={season.id} />
      </Suspense>
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
  //
  // It EXCLUDES the This-week slate. Taking "the next four unplayed matches"
  // outright meant that mid-week this card listed the exact fixtures the band
  // above it was already showing in full, with check-in counts and stakes —
  // the same three games read twice on one screen. What a reader actually
  // wants here is what comes AFTER tonight, which is only definable against
  // the same focusSlate the band above used.
  const slateIds = new Set(
    focusSlate(season.status, matches).slate.map((m) => m.id),
  );
  const upcoming = matches
    .filter((m) => m.status !== "COMPLETED" && !slateIds.has(m.id))
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

  // The side-game band renders BELOW the table now. It used to sit above both
  // the standings and This-week, so the secondary loop (pick'em, fantasy) got
  // the first full-width band on the page while the primary one — your match,
  // your team, the table — started below it.
  const sideGames = (
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
  );

  return (
    <div className="space-y-6">
      {/* During playoffs the bracket IS the story — it leads, and the
          regular-season standings drop below as context. */}
      {showBracket ? (
        // overflow-hidden on the CARD: Bracket's root is `overflow-x-auto` over
        // a `min-w-max` row, and Chrome propagates that inner width into the
        // page scroll area through the card (CLAUDE.md's SeasonGrid rule). All
        // four <Bracket> call sites were missing it.
        <Card className="overflow-hidden">
          <CardHeader
            title="Playoff bracket"
            action={
              <Link
                href="/schedule"
                className={textLink("text-sm")}
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

      <Suspense fallback={null}>
        <ThisWeek
          season={season}
          matches={matches}
          teams={teams}
          teamName={teamName}
          report={report}
        />
      </Suspense>

      {/* THE DASHBOARD BAND. Two grids, not one 2/3 + 1/3 split.
          The old layout put the standings alone in a col-span-2 column and
          stacked four cards in the 1/3 rail; CSS grid stretched the row to the
          taller side, so the lower-left of the page was a measured 728×790px of
          nothing. Splitting it means each band is sized by its own contents.
          min-w-0 on every item: grid items otherwise refuse to shrink below
          their content, letting a long team name widen the page on mobile. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div
          className={cn(
            "min-w-0",
            // No personal card to sit beside it? Then the table takes the
            // whole band rather than leaving a third of it empty.
            myTeam ? "lg:col-span-2" : "lg:col-span-3",
          )}
        >
          <Card>
            <CardHeader
              title="Standings"
              action={
                <Link
                  href="/schedule#this-week"
                  className={textLink("text-sm")}
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
        {myTeam ? (
          // order-first on phones: a rostered player's own team used to land
          // ~2,500px down the mobile page, below the full standings table.
          <div className="order-first min-w-0 lg:order-none">
            <Card tone="feature">
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
                    <Stat
                      label="Record"
                      size="md"
                      value={`${myRow.wins}–${myRow.losses}${
                        myRow.draws > 0 ? `–${myRow.draws}` : ""
                      }`}
                    />
                    <Stat label="Points" value={myRow.points} />
                  </div>
                ) : null}
                {/* The stake line and the next fixture are ONE block, not two
                    stacked boxes. They were always about the same match — the
                    tile is aligned to the scenario engine's `nextMatchId` so
                    "win the next series" and the fixture named underneath can
                    never disagree — and the hero's check-in panel is already
                    showing that fixture with its RSVP a screen above. Naming
                    the OPPONENT rather than "us vs them" drops the third
                    printing of the viewer's own team name on one card. */}
                {myNextMatch ? (
                  <Link
                    href={`/matches/${myNextMatch.id}`}
                    className={cn(
                      "block rounded-lg border p-3 text-sm transition-colors",
                      myStakeLine
                        ? "border-accent/30 bg-accent/5 hover:border-accent/50"
                        : "border-line bg-surface-2/40 hover:border-muted/60",
                    )}
                  >
                    {myStakeLine ? (
                      <div className="mb-2">{myStakeLine}</div>
                    ) : null}
                    <div className="text-xs uppercase text-muted">
                      {matchPhaseLabel(myNextMatch.phase, myNextMatch.week)} ·
                      next up
                    </div>
                    <div className="mt-1 font-medium">
                      vs{" "}
                      {teamName.get(
                        myNextMatch.homeTeamId === myTeam.id
                          ? myNextMatch.awayTeamId
                          : myNextMatch.homeTeamId,
                      ) ?? "?"}
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
                ) : myStakeLine ? (
                  // Done playing, but the table can still decide something.
                  <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm">
                    {myStakeLine}
                  </div>
                ) : (
                  <p className="text-sm text-muted">No upcoming matches.</p>
                )}
                <Link
                  href={`/teams/${myTeam.id}`}
                  className={textLink("inline-block text-sm font-medium")}
                >
                  Team page →
                </Link>
              </CardBody>
            </Card>
          </div>
        ) : null}
      </div>

      {/* Band two. auto-fit rather than a fixed column count: League pulse
          renders nothing until the league has games, and Upcoming/Recent each
          disappear at the ends of a season — a fixed lg:grid-cols-3 would leave
          a visible hole every time one of them opted out. auto-fit collapses
          the empty track instead, so two cards share the width and three split
          it, with no conditional spans to keep in sync. */}
      <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr))]">
          {upcoming.length > 0 ? (
            <Card className="min-w-0">
              <CardHeader
                title="Coming up"
                subtitle="After this week's slate"
              />
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
            <Card className="min-w-0">
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

          <Suspense fallback={null}>
            <LeaguePulse seasonId={season.id} teams={teams} teamName={teamName} />
          </Suspense>
      </div>

      {sideGames}
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
  // Same helper the "Coming up" card partitions against — see focusSlate.
  const { slate: focus, title } = focusSlate(season.status, matches);
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
    // Out of the SEASON's side size, not the roster we happen to have — a
    // 4-of-5 team used to render "4/4" in success green.
    return {
      confirmed: a.confirmed,
      size: expectedSideSize(season.teamSize, roster.length),
      short: Math.max(0, season.teamSize - roster.length),
    };
  };

  return (
    <Card>
      <CardHeader
        title={title}
        subtitle="Check in, scout the enemy, call the winner"
        action={
          <Link
            href="/schedule#this-week"
            className={textLink("text-sm")}
          >
            Full schedule →
          </Link>
        }
      />
      {/* auto-fit, not sm:grid-cols-2: a league plays an ODD number of matches
          per week whenever it has a bye, and a fixed two-up left a permanently
          empty cell next to the last fixture. */}
      <CardBody className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(17rem,100%),1fr))]">
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
                {m.status === "LIVE" ? (
                  <span
                    role="img"
                    aria-label={`Live — series at ${m.homeScore}–${m.awayScore}`}
                    className="inline-flex items-center gap-1.5 rounded-md bg-danger/10 px-1.5 py-0.5 font-mono text-xs tabular-nums text-danger"
                  >
                    <span aria-hidden className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-danger" />
                    </span>
                    <span aria-hidden>
                      LIVE {m.homeScore}–{m.awayScore}
                    </span>
                  </span>
                ) : m.scheduledAt ? (
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
                          aria-label={
                            c.short
                              ? `${c.confirmed} of ${c.size} checked in — ${c.short} seat(s) unfilled`
                              : `${c.confirmed} of ${c.size} checked in`
                          }
                          className={cn(
                            "shrink-0 text-xs tabular-nums",
                            c.confirmed === c.size
                              ? "text-success"
                              : c.short
                                ? "text-danger"
                                : "text-muted",
                          )}
                          title={
                            c.short
                              ? `${c.confirmed} of ${c.size} checked in — ${c.short} roster seat(s) unfilled`
                              : `${c.confirmed} of ${c.size} checked in`
                          }
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
  // Shared, tag-busted scan (cached-queries.ts) rather than a private copy of
  // the same query — an all-games roll-up repeated per request per viewer.
  const games = await getSeasonGameLeaders(seasonId);
  if (games.length === 0) return null;

  const parsed = games.map((g) => ({
    ...g,
    lines: parseGamePlayers<PlayerStat>(g.players),
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
    <Card className="min-w-0">
      <CardHeader
        title="League pulse"
        action={
          <Link href="/leaders" className={textLink("text-sm")}>
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

      {/* items-start, not the default stretch: the "season lives on" card is a
          short list of links and the final table is the full league, so
          stretching the row drew a 1/3-width box of empty border beside it —
          the COMPLETE twin of the void the mid-season deck used to have. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <Card>
            <CardHeader
              title="Final standings"
              action={
                <Link
                  href="/schedule#this-week"
                  className={textLink("text-sm")}
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
    <Card className="overflow-hidden">
      <CardHeader title="How it was won" />
      <CardBody className="p-0 pt-4">
        <Bracket rounds={rounds} championTeamId={championTeamId} />
      </CardBody>
    </Card>
  );
}
