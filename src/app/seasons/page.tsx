import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { deleteSeason } from "@/app/actions/admin";
import { ActionForm, SubmitButton } from "@/components/action-form";
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
  const [seasons, viewer] = await Promise.all([
    prisma.season.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        teams: { select: { id: true, name: true } },
        _count: { select: { registrations: true, matches: true } },
      },
    }),
    getSessionUser(),
  ]);
  const isAdmin = viewer?.role === "ADMIN";

  return (
    <div className="space-y-8">
      <PageTitle
        title="Season history"
        subtitle="Every season the league has run — champions, standings, and rosters."
      />

      {seasons.length === 0 ? (
        <EmptyState title="No seasons yet" />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {seasons.map((s) => {
            const champion = s.championTeamId
              ? s.teams.find((t) => t.id === s.championTeamId)
              : null;
            return (
              <div key={s.id} className="flex h-full flex-col gap-1.5">
                <Link
                  href={`/seasons/${s.id}`}
                  className="group block flex-1 hover:no-underline"
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
                {isAdmin && !s.isActive ? (
                  <ActionForm action={deleteSeason} hidden={{ seasonId: s.id }}>
                    <SubmitButton
                      variant="secondary"
                      size="sm"
                      className="text-danger"
                      confirm={`Permanently delete ${s.name}? Its teams, matches, and draft history are erased. This cannot be undone.`}
                    >
                      🗑 Remove from history
                    </SubmitButton>
                  </ActionForm>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
