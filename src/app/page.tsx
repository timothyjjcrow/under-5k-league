import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { getSeasonSnapshot, type SeasonSnapshot } from "@/lib/queries";
import { prisma } from "@/lib/prisma";
import {
  clinchStatuses,
  computeStandings,
  type ClinchStatus,
} from "@/lib/standings";
import { pickBracketSize } from "@/lib/schedule";
import { buildBracketRounds, seedMap } from "@/lib/bracket-view";
import { Bracket } from "@/components/bracket";
import { formByTeam, type FormResult } from "@/lib/team-matches";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  DiscordButton,
  EmptyState,
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
} from "@/lib/constants";
import { predictionOpen } from "@/lib/pickem";
import { HeroVideo } from "@/components/hero-video";
import { CountUp } from "@/components/count-up";
import { CheckinBanner } from "@/components/checkin-banner";
import {
  StandingsTableClient,
  type StandingsRowView,
} from "@/components/standings-table";
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
  } else if (
    season.status === "REGULAR_SEASON" ||
    season.status === "PLAYOFFS"
  ) {
    heroMeta = (
      <HeroStat
        value={snapshot.teams.length}
        label={
          snapshot.teams.length === 1 ? "team competing" : "teams competing"
        }
      />
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
      <InhouseStrip />
      {season.status === "SIGNUPS" && (
        <SignupsView snapshot={snapshot} loggedIn={!!user} />
      )}
      {season.status === "DRAFT" && <DraftPhaseView snapshot={snapshot} />}
      {(season.status === "REGULAR_SEASON" || season.status === "PLAYOFFS") && (
        <>
          {user ? <MyNextMatch seasonId={season.id} userId={user.id} /> : null}
          <SeasonView snapshot={snapshot} userId={user?.id} />
        </>
      )}
      {season.status === "COMPLETE" && <CompleteView snapshot={snapshot} />}
    </div>
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
  if (myTeams.length === 0) return null;
  const teamIds = myTeams.map((t) => t.teamId);

  const next = await prisma.match.findFirst({
    where: {
      seasonId,
      status: { not: "COMPLETED" },
      OR: [{ homeTeamId: { in: teamIds } }, { awayTeamId: { in: teamIds } }],
    },
    orderBy: [{ week: "asc" }, { createdAt: "asc" }],
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
      heading={`Your next match — Week ${next.week}: ${next.homeTeam.name} vs ${next.awayTeam.name}`}
      when={fmtWhen(next.scheduledAt)}
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

// A single animated hero figure — big count-up number + a muted label.
function HeroStat({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: "accent";
}) {
  return (
    <span className="flex items-baseline gap-1.5">
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

// A slim stepper showing where the season is in its lifecycle.
function SeasonTimeline({ phase }: { phase: string }) {
  const current = PHASE_ORDER.findIndex((p) => p === phase);
  return (
    <div className="rounded-[var(--radius)] border border-line bg-surface/60 px-3 py-4 sm:px-6">
      <div className="flex items-start">
        {PHASE_ORDER.map((p, i) => {
          const done = current >= 0 && i < current;
          const isCurrent = i === current;
          return (
            <div key={p} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="flex w-full items-center">
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
              </span>
            </div>
          );
        })}
      </div>
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
  const [poolLeft, sales, nominated, leadingTeam] = await Promise.all([
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
                  <span className="shrink-0 text-xs text-muted">
                    ${s.price} · {s.team.name}
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
}: {
  snapshot: SeasonSnapshot;
  userId?: string;
}) {
  const { season, teams } = snapshot;
  const matches = await prisma.match.findMany({
    where: { seasonId: season.id },
    orderBy: [{ week: "asc" }],
  });
  const standings = computeStandings(
    teams.map((t) => t.id),
    matches,
  );
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const teamForm = formByTeam(
    teams.map((t) => t.id),
    matches,
  );

  const myTeam = userId
    ? teams.find((t) => t.members.some((m) => m.userId === userId))
    : undefined;
  const myNextMatch = myTeam
    ? matches.find(
        (m) =>
          m.status !== "COMPLETED" &&
          (m.homeTeamId === myTeam.id || m.awayTeamId === myTeam.id),
      )
    : undefined;

  const playoffMatches = matches.filter((m) => m.phase !== "REGULAR");
  const bracketRoundsView = buildBracketRounds(
    playoffMatches,
    teamName,
    seedMap(
      standings.map((s) => s.teamId),
      pickBracketSize(teams.length),
    ),
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
  // see what's coming up without leaving the dashboard.
  const upcoming = matches
    .filter((m) => m.status !== "COMPLETED")
    .slice(0, 4);
  const pickemOpen = matches.filter((m) => predictionOpen(m)).length;
  const fantasyLocked =
    (await prisma.game.count({ where: { match: { seasonId: season.id } } })) >
    0;

  return (
    <div className="space-y-6">
      {/* Side games — one tap from the dashboard into the engagement loop. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SideGameLink
          href="/pickem"
          icon="🔮"
          title="Pick'em"
          hint={
            pickemOpen > 0
              ? `${pickemOpen} ${pickemOpen === 1 ? "match" : "matches"} open — call it`
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

      {/* min-w-0: grid items otherwise refuse to shrink below their content,
          letting a long team name widen the page on mobile. */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Standings"
              action={
                <Link
                  href="/schedule"
                  className="text-sm text-info hover:underline"
                >
                  Full schedule →
                </Link>
              }
            />
            <CardBody className="p-0">
              <StandingsTable
                standings={standings.slice(0, 8)}
                teamName={teamName}
                formByTeam={teamForm}
                playoffCut={
                  season.status === "REGULAR_SEASON"
                    ? pickBracketSize(teams.length)
                    : undefined
                }
                clinch={
                  season.status === "REGULAR_SEASON"
                    ? clinchStatuses(
                        standings,
                        matches,
                        pickBracketSize(teams.length),
                      )
                    : undefined
                }
              />
            </CardBody>
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          {myTeam ? (
            <Card>
              <CardHeader title="Your team" subtitle={myTeam.name} />
              <CardBody className="space-y-3">
                {myNextMatch ? (
                  <Link
                    href={`/matches/${myNextMatch.id}`}
                    className="block rounded-lg border border-line bg-surface-2/40 p-3 text-sm transition-colors hover:border-muted/60"
                  >
                    <div className="text-xs uppercase text-muted">
                      Week {myNextMatch.week} · next up
                    </div>
                    <div className="mt-1 font-medium">
                      {teamName.get(myNextMatch.homeTeamId)} vs{" "}
                      {teamName.get(myNextMatch.awayTeamId)}
                    </div>
                    {myNextMatch.scheduledAt ? (
                      <div className="mt-1 text-xs text-muted">
                        {fmtWhen(myNextMatch.scheduledAt)}
                      </div>
                    ) : null}
                  </Link>
                ) : (
                  <p className="text-sm text-muted">No upcoming matches.</p>
                )}
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
                          {m.phase === "FINAL"
                            ? "Grand final"
                            : m.phase === "PLAYOFF"
                              ? "Playoffs"
                              : `Week ${m.week}`}
                          {m.scheduledAt
                            ? ` · ${fmtWhen(m.scheduledAt)}`
                            : ""}
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
        </div>
      </div>

    </div>
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
}: {
  standings: ReturnType<typeof computeStandings>;
  teamName: Map<string, string>;
  formByTeam?: Map<string, FormResult[]>;
  /** How many top teams make playoffs \u2014 draws a "playoff cut" line when set. */
  playoffCut?: number;
  /** Per-team clinched/eliminated verdicts (see clinchStatuses). */
  clinch?: Map<string, ClinchStatus>;
}) {
  const cutIsReal =
    playoffCut != null && playoffCut > 0 && playoffCut < standings.length;
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
  }));
  return <StandingsTableClient rows={rows} playoffCut={playoffCut} />;
}

// ---------- COMPLETE ----------

async function CompleteView({ snapshot }: { snapshot: SeasonSnapshot }) {
  const { teams, season } = snapshot;
  const champion = teams.find((t) => t.id === season.championTeamId);
  const matches = await prisma.match.findMany({
    where: { seasonId: season.id },
    orderBy: [{ week: "asc" }],
  });
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

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="Final standings"
              action={
                <Link
                  href="/schedule"
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
        <div>
          <Card>
            <CardHeader title="Season stats" />
            <CardBody className="space-y-3 text-sm">
              <p className="text-muted">
                Relive the season — awards, superlatives, and who topped the
                league across every game.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link href="/recap" className={buttonClasses("accent")}>
                  🏆 Season recap →
                </Link>
                <Link href="/leaders" className={buttonClasses("secondary")}>
                  Leaderboards
                </Link>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
