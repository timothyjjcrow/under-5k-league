import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import { headToHead, recentForm } from "@/lib/team-matches";
import { roleCoverage } from "@/lib/pool-stats";
import { cn, initials } from "@/lib/utils";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FormStrip,
  PlayerLink,
  RankBadge,
  Stat,
} from "@/components/ui";

export const metadata = { title: "Team · Under 5k League" };

// Deterministic hue (0–359) from a string, so each team gets a stable, distinct
// color identity for its crest + banner glow (teams have no uploaded logos).
function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function fmtDate(d: Date | null): string | null {
  if (!d) return null;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
      season: true,
      captain: true,
      members: { include: { user: true }, orderBy: { price: "desc" } },
    },
  });
  if (!team) notFound();

  const memberIds = team.members.map((m) => m.userId);
  const [allTeams, allMatches, myMatches, rosterRegs] = await Promise.all([
    prisma.team.findMany({ where: { seasonId: team.seasonId } }),
    prisma.match.findMany({ where: { seasonId: team.seasonId } }),
    prisma.match.findMany({
      where: {
        seasonId: team.seasonId,
        OR: [{ homeTeamId: id }, { awayTeamId: id }],
      },
      orderBy: [{ week: "asc" }, { createdAt: "asc" }],
    }),
    memberIds.length
      ? prisma.registration.findMany({
          where: { seasonId: team.seasonId, userId: { in: memberIds } },
          select: { roles: true },
        })
      : Promise.resolve([]),
  ]);

  const standings = computeStandings(
    allTeams.map((t) => t.id),
    allMatches,
  );
  const rank = standings.findIndex((s) => s.teamId === id) + 1;
  const row = standings.find((s) => s.teamId === id);
  const teamName = new Map(allTeams.map((t) => [t.id, t.name]));

  const form = recentForm(id, myMatches);
  const h2h = headToHead(id, myMatches).sort(
    (a, b) => b.wins - a.wins || a.losses - b.losses,
  );
  const spent = team.members.reduce((sum, m) => sum + m.price, 0);
  const coverage = roleCoverage(rosterRegs);
  const hasRoleData = coverage.some((r) => r.count > 0);
  const hue = hueFromString(team.id);

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 flex items-center justify-between">
          <Link href="/teams" className="text-sm text-info hover:underline">
            ← All teams
          </Link>
          <Link href="/schedule" className="text-sm text-info hover:underline">
            Standings →
          </Link>
        </div>
        <div className="relative overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-br from-surface-2/70 via-surface/50 to-surface/30 shadow-sm">
          {/* Ambient graphics tinted with the team's own color identity. */}
          <div
            aria-hidden
            className="hero-grid pointer-events-none absolute inset-0 opacity-50"
          />
          <div
            aria-hidden
            className="animate-hero-glow pointer-events-none absolute -left-8 top-0 h-40 w-40 -translate-y-1/3 rounded-full blur-3xl"
            style={{ backgroundColor: `hsl(${hue} 70% 50% / 0.22)` }}
          />
          <div
            aria-hidden
            className="animate-hero-glow-alt pointer-events-none absolute -right-8 bottom-0 h-40 w-40 translate-y-1/3 rounded-full bg-accent/15 blur-3xl"
          />
          <div className="relative flex flex-wrap items-center gap-5 p-6">
            <div
              className="grid h-20 w-20 shrink-0 place-items-center rounded-2xl font-display text-2xl font-bold uppercase text-white shadow-lg ring-1 ring-white/15"
              style={{
                backgroundImage: `linear-gradient(135deg, hsl(${hue} 62% 46%), hsl(${hue} 62% 28%))`,
              }}
            >
              {initials(team.name)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
                  {team.name}
                </h1>
                {rank > 0 ? (
                  <Badge tone="accent">
                    #{rank} of {allTeams.length}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-1 text-sm text-muted">{team.season.name}</div>
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
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Record" value={`${row?.wins ?? 0}–${row?.losses ?? 0}`} />
        <Stat label="Points" value={row?.points ?? 0} />
        <Stat
          label="Rank"
          value={rank > 0 ? `#${rank}` : "—"}
          hint={`of ${allTeams.length}`}
        />
        <Stat
          label={team.season.status === "DRAFT" ? "Budget" : "Roster"}
          value={
            team.season.status === "DRAFT"
              ? `$${team.budget}`
              : `${team.members.length}/${team.season.teamSize}`
          }
        />
      </div>

      <Card>
        <CardHeader
          title="Roster"
          subtitle={
            spent > 0
              ? `Spent $${spent} · $${team.budget} left`
              : undefined
          }
        />
        <CardBody className="space-y-1.5">
          {team.members.length === 0 ? (
            <p className="text-sm text-muted">No players yet.</p>
          ) : (
            team.members.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between rounded-md border border-line/60 px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <Avatar name={m.user.name} src={m.user.avatar} size={26} />
                  <PlayerLink userId={m.userId}>{m.user.name}</PlayerLink>
                  {m.isCaptain ? <Badge tone="accent">Captain</Badge> : null}
                  <RankBadge rankTier={m.user.rankTier} />
                </span>
                <span className="text-muted">
                  {m.isCaptain ? "—" : `$${m.price}`}
                </span>
              </div>
            ))
          )}
        </CardBody>
      </Card>

      {hasRoleData ? (
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
                  <div className="text-xs font-medium text-muted">{r.short}</div>
                  <div
                    className={cn(
                      "mt-1 text-lg font-semibold tabular-nums",
                      r.count === 0 ? "text-danger" : "text-fg",
                    )}
                  >
                    {r.count}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-muted">
                    {r.count === 0 ? "gap" : r.count === 1 ? "player" : "players"}
                  </div>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {h2h.length > 0 ? (
        <Card>
          <CardHeader title="Head-to-head" subtitle="Completed series by opponent" />
          <CardBody className="p-0">
            <ul className="divide-y divide-line/60">
              {h2h.map((r) => {
                const record = `${r.wins}–${r.losses}${r.draws > 0 ? `–${r.draws}` : ""}`;
                const edge =
                  r.wins > r.losses ? "success" : r.losses > r.wins ? "danger" : "neutral";
                return (
                  <li
                    key={r.opponentId}
                    className="flex items-center justify-between px-5 py-2.5 text-sm"
                  >
                    <Link
                      href={`/teams/${r.opponentId}`}
                      className="font-medium hover:text-info"
                    >
                      {teamName.get(r.opponentId) ?? "?"}
                    </Link>
                    <span className="flex items-center gap-3">
                      <span className="text-xs text-muted">
                        {r.gamesFor}–{r.gamesAgainst} games
                      </span>
                      <Badge tone={edge}>{record}</Badge>
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Matches" />
        <CardBody className="p-0">
          {myMatches.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No matches scheduled yet" />
            </div>
          ) : (
            <ul className="divide-y divide-line/60">
              {myMatches.map((m) => {
                const isHome = m.homeTeamId === id;
                const oppId = isHome ? m.awayTeamId : m.homeTeamId;
                const myScore = isHome ? m.homeScore : m.awayScore;
                const oppScore = isHome ? m.awayScore : m.homeScore;
                const won = m.winnerTeamId === id;
                const when = fmtDate(m.scheduledAt);
                return (
                  <li key={m.id}>
                    <Link
                      href={`/matches/${m.id}`}
                      className="flex items-center justify-between px-5 py-3 text-sm hover:bg-surface-2/40"
                    >
                      <span className="flex items-center gap-3">
                        <span className="w-12 text-xs text-muted">
                          Wk {m.week}
                        </span>
                        <span>
                          vs{" "}
                          <span className="font-medium">
                            {teamName.get(oppId) ?? "?"}
                          </span>
                          {when ? (
                            <span className="ml-2 text-xs text-muted">
                              {when}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        {m.status === "COMPLETED" ? (
                          <>
                            <Badge tone={won ? "success" : "danger"}>
                              {won ? "W" : oppScore === myScore ? "T" : "L"}
                            </Badge>
                            <span className="font-mono">
                              {myScore}–{oppScore}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs text-muted">upcoming</span>
                        )}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
