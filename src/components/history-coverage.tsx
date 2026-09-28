import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { participantUncoveredWhere } from "@/lib/game-participants";
import { backfillGameParticipantsAction } from "@/app/actions/game-participants";
import { captureRosterHistoryAction } from "@/app/actions/roster-history";
import { ActionForm, SubmitButton } from "./action-form";

/** The body of /admin's folded "Historical records" section, which draws
 * the frame and heading. */
export async function HistoryCoverage() {
  if ((await getSessionUser())?.role !== "ADMIN") return null;
  const [games, uncovered, tenures] = await Promise.all([
    prisma.game.count(), prisma.game.count({ where: participantUncoveredWhere() }),
    prisma.rosterTenure.count(),
  ]);
  return <div className="p-5 text-sm">
    <p className="text-muted">{games - uncovered} of {games} games indexed from their stored box scores; {tenures} roster intervals retained across all seasons. New imports and roster changes keep these records automatically.</p>
    <p className="mt-2 text-xs text-muted">Existing box scores remain readable during indexing. Capture preserves surviving memberships and marks missing end dates as unknown. It cannot recover deleted old rosters, original auction budgets, roles or approvals that were never recorded.</p>
    <div className="mt-3 flex flex-wrap gap-3">
      {uncovered > 0 ? <ActionForm action={backfillGameParticipantsAction}><SubmitButton size="sm">Index next 20 games</SubmitButton></ActionForm> : null}
      <ActionForm action={captureRosterHistoryAction}><SubmitButton size="sm">Capture surviving roster history</SubmitButton></ActionForm>
    </div>
    <p className="mt-2 text-xs text-muted">Each batch is limited and safe to repeat. Player identity corrections are available on an imported game&apos;s match page and require an audited reason.</p>
  </div>;
}
