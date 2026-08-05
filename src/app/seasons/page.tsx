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

import { HISTORY_PHASE_LABEL as PHASE_LABEL } from "@/lib/season-copy";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import { productionDeleteBackupRequired } from "@/lib/backup-receipt.mjs";

export const metadata = { title: "Season history" };

export default async function SeasonsPage() {
  const [seasons, viewer] = await Promise.all([
    prisma.season.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        teams: { select: { id: true, name: true } },
        matches: {
          where: { phase: { not: "REGULAR" } },
          select: {
            id: true,
            phase: true,
            bracketSlot: true,
            status: true,
            winnerTeamId: true,
            homeTeamId: true,
            awayTeamId: true,
          },
        },
        draft: { select: { status: true } },
        _count: { select: { registrations: true, matches: true } },
      },
    }),
    getSessionUser(),
  ]);
  const isAdmin = viewer?.role === "ADMIN";
  const activeSeason = seasons.find((season) => season.isActive) ?? null;
  const backupReceiptRequired = productionDeleteBackupRequired(process.env);

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

      {isAdmin && activeSeason ? (
        <Card>
          <CardBody className="space-y-2">
            <p className="font-semibold">
              Reactivation is available from the offseason
            </p>
            <p className="text-sm text-muted">
              {activeSeason.name} is currently active. To avoid silently
              cancelling a live league, first use Season handoff to archive a
              completed season or explicitly cancel an unfinished one. Then
              return here to resume an archived season.
            </p>
            <Link
              href="/admin#adm-new-season"
              className={textLink("text-sm")}
            >
              Review season handoff →
            </Link>
          </CardBody>
        </Card>
      ) : null}

      {seasons.length === 0 ? (
        <EmptyState title="No seasons yet" />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {seasons.map((s) => {
            const championPresentation = resolveChampionPresentation(
              s,
              s.matches,
            );
            const champion = championPresentation.championTeamId
              ? s.teams.find(
                  (team) => team.id === championPresentation.championTeamId,
                )
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
                        {s.status === "COMPLETE"
                          ? "Champion state needs review"
                          : s.isActive
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
                    {activeSeason ? (
                      <button
                        type="button"
                        disabled
                        className={buttonClasses("secondary", "sm")}
                      >
                        ↩ Enter offseason to reactivate
                      </button>
                    ) : (
                      <ActionForm
                        action={reactivateSeasonAction}
                        hidden={{
                          seasonId: s.id,
                          expectedTargetUpdatedAt: s.updatedAt.toISOString(),
                        }}
                      >
                        <SubmitButton
                          variant="secondary"
                          size="sm"
                          confirm={
                            s.status === "COMPLETE"
                              ? `Reactivate completed ${s.name} for corrections? This ends the offseason and makes it the current public season. It remains Complete until you deliberately use a correction or recovery control; no results or history change now.`
                              : `Resume ${s.name}? This ends the offseason and restores ${PHASE_LABEL[s.status] ?? s.status} exactly as saved. The signup, draft, and match tools allowed in that phase become active again. Nothing is deleted.${s.draft?.status === "IN_PROGRESS" || s.draft?.status === "PAUSED" ? " Its auction will remain paused until an admin resumes it." : ""}`
                          }
                        >
                          {s.status === "COMPLETE"
                            ? "↩ Reactivate for corrections"
                            : "↩ Resume season"}
                        </SubmitButton>
                      </ActionForm>
                    )}
                    {/* TYPE-TO-CONFIRM, not window.confirm. This is the only
                        truly unrecoverable action in the app — a hard cascade
                        delete of every match, game, box score, registration,
                        roster, draft price, fantasy roster and pick'em pick in
                        the season, which also silently rewrites the
                        cross-season boards (/records, /hall-of-fame, /meta,
                        career stats) because they scan all Game rows. And it
                        sat 8px from the reactivation control as a same-sized
                        sibling, behind a dialog whose OK button is focused by
                        default. One stray Enter is not an acceptable barrier
                        for that. Its own row, danger styling, and the admin
                        has to type the season's name. */}
                    <p className="rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-xs text-muted">
                      The JSON download is an audit/reference archive only. It
                      cannot restore the database and does not satisfy the
                      production backup requirement.
                    </p>
                    <a
                      href={`/api/admin/season-export?seasonId=${s.id}`}
                      className={buttonClasses("secondary", "sm")}
                      download
                    >
                      ⤓ Download audit archive (JSON)
                    </a>
                    <ActionForm
                      action={deleteSeason}
                      hidden={{
                        seasonId: s.id,
                        expectedSeasonUpdatedAt: s.updatedAt.toISOString(),
                      }}
                    >
                      <DangerSubmit
                        token={s.name}
                        title={`Permanently delete ${s.name}?`}
                        consequences={[
                          `All ${s._count.matches} match(es) and every imported game, box score and MVP in them.`,
                          `All ${s._count.registrations} signup(s), every team and roster, and every draft price paid.`,
                          "Fantasy rosters and pick'em picks for this season.",
                          "Its results disappear from the all-time record book, hall of fame, hero meta and every player's career stats.",
                        ]}
                        recovery="There is no in-app undo. The JSON audit archive above is not a database backup and cannot restore the deleted rows. If you only want the season out of the way, it is already archived; leave it."
                        evidence={
                          backupReceiptRequired
                            ? {
                                name: "backupReceipt",
                                label: "Recent full-database backup receipt",
                                description:
                                  "Create a fresh full backup, verify it with BACKUP_RECEIPT_SECRET configured, and paste the emitted receipt. It expires after 24 hours and must match this production database.",
                                placeholder: "ld2l-backup-v1.…",
                              }
                            : undefined
                        }
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
