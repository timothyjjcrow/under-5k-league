import Link from "next/link";
import { prisma } from "@/lib/prisma";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  PageTitle,
  TeamCrest,
} from "@/components/ui";

export const metadata = { title: "Season history" };

const PHASE_LABEL: Record<string, string> = {
  SIGNUPS: "Signups open",
  DRAFT: "Drafting",
  REGULAR_SEASON: "In season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Complete",
};

export default async function SeasonsPage() {
  const seasons = await prisma.season.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      teams: { select: { id: true, name: true } },
      _count: { select: { registrations: true, matches: true } },
    },
  });

  return (
    <div className="space-y-8">
      <PageTitle
        title="Season history"
        subtitle="Every season the league has run — champions, standings, and rosters."
      />

      {seasons.length === 0 ? (
        <EmptyState title="No seasons yet" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {seasons.map((s) => {
            const champion = s.championTeamId
              ? s.teams.find((t) => t.id === s.championTeamId)
              : null;
            return (
              <Link
                key={s.id}
                href={`/seasons/${s.id}`}
                className="group block hover:no-underline"
              >
                <Card interactive className="h-full">
                  <CardBody className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-display text-xl font-bold group-hover:text-info">
                        {s.name}
                      </span>
                      {s.isActive ? (
                        <Badge tone="brand">Current</Badge>
                      ) : (
                        <Badge tone="neutral">
                          {PHASE_LABEL[s.status] ?? s.status}
                        </Badge>
                      )}
                    </div>
                    {champion ? (
                      <div className="flex items-center gap-2 text-sm">
                        <TeamCrest
                          name={champion.name}
                          seed={champion.id}
                          size={26}
                          className="rounded-lg"
                        />
                        <span>
                          🏆 <b>{champion.name}</b>
                        </span>
                      </div>
                    ) : (
                      <div className="text-sm text-muted">
                        {s.isActive
                          ? "Season in progress"
                          : "No champion recorded"}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                      <span>{s.teams.length} teams</span>
                      <span>{s._count.registrations} signups</span>
                      <span>{s._count.matches} matches</span>
                      <span>{new Date(s.createdAt).getFullYear()}</span>
                    </div>
                  </CardBody>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
