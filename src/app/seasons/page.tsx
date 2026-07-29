import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { deleteSeason, reactivateSeasonAction } from "@/app/actions/admin";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { DangerSubmit } from "@/components/danger-submit";
import {
  Badge,
  buttonClasses,
  Card,
  CardBody,
  EmptyState,
  PageTitle,
  TeamCrest,
  textLink,
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
        action={
          <Link
            href="/hall-of-fame"
            className={textLink("text-sm")}
          >
            Hall of Fame →
          </Link>
        }
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
                  <div className="flex flex-col gap-2">
                    <ActionForm
                      action={reactivateSeasonAction}
                      hidden={{ seasonId: s.id }}
                    >
                      <SubmitButton
                        variant="secondary"
                        size="sm"
                        confirm={`Make ${s.name} the active season again? The current active season is archived (nothing is deleted — you can switch back the same way).`}
                      >
                        ↩ Make active again
                      </SubmitButton>
                    </ActionForm>
                    {/* TYPE-TO-CONFIRM, not window.confirm. This is the only
                        truly unrecoverable action in the app — a hard cascade
                        delete of every match, game, box score, registration,
                        roster, draft price, fantasy roster and pick'em pick in
                        the season, which also silently rewrites the
                        cross-season boards (/records, /hall-of-fame, /meta,
                        career stats) because they scan all Game rows. And it
                        sat 8px from "Make active again" as a same-sized
                        sibling, behind a dialog whose OK button is focused by
                        default. One stray Enter is not an acceptable barrier
                        for that. Its own row, danger styling, and the admin
                        has to type the season's name. */}
                    {/* The BACKUP, offered right where the risk is. Delete is
                        the only unrecoverable action in the app and the only
                        safeguard was a CLI script the panel never mentions, so
                        the export sits directly above it and the delete dialog
                        points at it by name. */}
                    <a
                      href={`/api/admin/season-export?seasonId=${s.id}`}
                      className={buttonClasses("secondary", "sm")}
                      download
                    >
                      ⤓ Download archive (JSON)
                    </a>
                    <ActionForm action={deleteSeason} hidden={{ seasonId: s.id }}>
                      <DangerSubmit
                        token={s.name}
                        title={`Permanently delete ${s.name}?`}
                        consequences={[
                          `All ${s._count.matches} match(es) and every imported game, box score and MVP in them.`,
                          `All ${s._count.registrations} signup(s), every team and roster, and every draft price paid.`,
                          "Fantasy rosters and pick'em picks for this season.",
                          "Its results disappear from the all-time record book, hall of fame, hero meta and every player's career stats.",
                        ]}
                        recovery="There is no undo for this. Download the archive first (the button above this one) — it is the only copy you will have. If you only want the season out of the way, it is already archived; leave it."
                      >
                        🗑 Delete permanently
                      </DangerSubmit>
                    </ActionForm>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
