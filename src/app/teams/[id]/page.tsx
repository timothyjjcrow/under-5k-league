import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  RankBadge,
  Stat,
} from "@/components/ui";

export const metadata = { title: "Team · LD2L" };

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

  const [allTeams, allMatches, myMatches] = await Promise.all([
    prisma.team.findMany({ where: { seasonId: team.seasonId } }),
    prisma.match.findMany({ where: { seasonId: team.seasonId } }),
    prisma.match.findMany({
      where: {
        seasonId: team.seasonId,
        OR: [{ homeTeamId: id }, { awayTeamId: id }],
      },
      orderBy: [{ week: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  const standings = computeStandings(
    allTeams.map((t) => t.id),
    allMatches,
  );
  const rank = standings.findIndex((s) => s.teamId === id) + 1;
  const row = standings.find((s) => s.teamId === id);
  const teamName = new Map(allTeams.map((t) => [t.id, t.name]));

  return (
    <div className="space-y-6">
      <PageTitle
        title={team.name}
        subtitle={`${team.season.name} · captained by ${team.captain.name}`}
        action={
          <Link href="/schedule" className="text-sm text-info hover:underline">
            Standings →
          </Link>
        }
      />

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
        <CardHeader title="Roster" />
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
                  {m.user.name}
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
