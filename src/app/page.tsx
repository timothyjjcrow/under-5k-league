import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { getSeasonSnapshot, type SeasonSnapshot } from "@/lib/queries";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Progress,
  RankBadge,
  RoleBadges,
  Stat,
  buttonClasses,
} from "@/components/ui";
import { averageMmr, mmrDistribution, roleCoverage } from "@/lib/pool-stats";
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
          subtitle="Check back soon — a new season will open for signups shortly."
        />
        {user?.role === "ADMIN" ? (
          <div className="mt-6 text-center">
            <Link href="/admin" className={buttonClasses("accent")}>
              Create the first season
            </Link>
          </div>
        ) : null}
      </div>
    );
  }

  const { season } = snapshot;

  return (
    <div className="space-y-8">
      <Hero
        phase={season.status}
        title={season.name}
        subtitle={phaseSubtitle(season.status)}
      />
      <SeasonTimeline phase={season.status} />
      {season.status === "SIGNUPS" && (
        <SignupsView snapshot={snapshot} loggedIn={!!user} />
      )}
      {season.status === "DRAFT" && <DraftPhaseView snapshot={snapshot} />}
      {(season.status === "REGULAR_SEASON" || season.status === "PLAYOFFS") && (
        <SeasonView snapshot={snapshot} userId={user?.id} />
      )}
      {season.status === "COMPLETE" && <CompleteView snapshot={snapshot} />}
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

function Hero({
  phase,
  title,
  subtitle,
}: {
  phase: string | null;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-b from-surface-2/70 to-surface/40 px-6 py-12 text-center sm:px-10 sm:py-14">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-48 w-48 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/20 blur-3xl"
      />
      <div className="relative">
        <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-brand text-2xl font-bold text-brand-fg shadow-lg shadow-brand/30 ring-1 ring-white/10">
          5K
        </div>
        {phase ? (
          <Badge tone={PHASE_TONE[phase] ?? "neutral"} className="mb-4">
            {PHASE_LABEL[phase] ?? phase}
          </Badge>
        ) : null}
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
        <p className="mx-auto mt-3 max-w-xl text-muted">{subtitle}</p>
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

// ---------- SIGNUPS ----------

function SignupsView({
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

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="space-y-5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {playerCount} / {capacity.minPlayers} players to start
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
            <Stat label="Team size" value={season.teamSize} />
          </div>

          <div className="pt-1">
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
          </div>
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
        <div
          key={r.id}
          className="flex items-center gap-2 rounded-full border border-line bg-surface-2/50 py-1 pl-1 pr-3"
        >
          <Avatar name={r.user.name} src={r.user.avatar} size={26} />
          <span className="text-sm">{r.user.name}</span>
          <RankBadge rankTier={r.user.rankTier} />
          <RoleBadges roles={r.roles} />
          <span className="text-xs text-muted">{r.mmr}</span>
        </div>
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
          className={`h-full rounded-full ${tone === "brand" ? "bg-brand" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-6 shrink-0 text-right tabular-nums">{count}</span>
    </div>
  );
}

// ---------- DRAFT ----------

function DraftPhaseView({ snapshot }: { snapshot: SeasonSnapshot }) {
  const { teams, season } = snapshot;
  return (
    <div className="space-y-6">
      <div className="text-center">
        <Link href="/draft" className={buttonClasses("accent", "lg")}>
          Enter the draft room →
        </Link>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {teams.map((t) => (
          <Card key={t.id}>
            <CardHeader
              title={t.name}
              subtitle={`Captain: ${t.captain.name}`}
              action={<Badge tone="accent">${t.budget} left</Badge>}
            />
            <CardBody>
              <RosterList
                members={t.members}
                teamSize={season.teamSize}
              />
            </CardBody>
          </Card>
        ))}
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
                  {m.user.name}
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

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
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
            />
          </CardBody>
        </Card>
      </div>
      <div className="space-y-6">
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
      </div>
    </div>
  );
}

export function StandingsTable({
  standings,
  teamName,
}: {
  standings: ReturnType<typeof computeStandings>;
  teamName: Map<string, string>;
}) {
  if (standings.length === 0) {
    return (
      <div className="p-5">
        <EmptyState title="No standings yet" description="Play some matches!" />
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs uppercase text-muted">
          <th className="px-5 py-2.5 font-medium">#</th>
          <th className="px-2 py-2.5 font-medium">Team</th>
          <th className="px-2 py-2.5 text-center font-medium">W</th>
          <th className="px-2 py-2.5 text-center font-medium">L</th>
          <th className="px-2 py-2.5 text-center font-medium">Diff</th>
          <th className="px-5 py-2.5 text-right font-medium">Pts</th>
        </tr>
      </thead>
      <tbody>
        {standings.map((row, i) => (
          <tr key={row.teamId} className="border-b border-line/50 last:border-0">
            <td className="px-5 py-2.5 text-muted">{i + 1}</td>
            <td className="px-2 py-2.5 font-medium">
              <Link
                href={`/teams/${row.teamId}`}
                className="hover:text-info"
              >
                {teamName.get(row.teamId) ?? "—"}
              </Link>
            </td>
            <td className="px-2 py-2.5 text-center">{row.wins}</td>
            <td className="px-2 py-2.5 text-center">{row.losses}</td>
            <td className="px-2 py-2.5 text-center text-muted">
              {row.gameDiff > 0 ? `+${row.gameDiff}` : row.gameDiff}
            </td>
            <td className="px-5 py-2.5 text-right font-semibold">
              {row.points}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- COMPLETE ----------

function CompleteView({ snapshot }: { snapshot: SeasonSnapshot }) {
  const { teams, season } = snapshot;
  const champion = teams.find((t) => t.id === season.championTeamId);
  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="text-5xl">🏆</div>
          <div className="text-sm uppercase tracking-wide text-muted">
            Champion
          </div>
          <div className="text-2xl font-bold">
            {champion ? champion.name : "To be crowned"}
          </div>
          <Link href="/schedule" className={buttonClasses("secondary")}>
            View final standings
          </Link>
        </CardBody>
      </Card>
    </div>
  );
}
