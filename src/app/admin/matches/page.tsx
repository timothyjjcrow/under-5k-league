import { Suspense } from "react";
import Link from "@/components/app-link";
import { ADMIN_MATCH_ROW_PREFIX } from "@/lib/match-anchors";
import { adminTab } from "@/lib/admin-tabs";
import { CardSkeleton, EmptyState, buttonClasses } from "@/components/ui";
import { RevealHashTarget } from "@/components/reveal-hash-target";
import { ImportProgress } from "@/components/import-progress";
import { loadAdminContext } from "@/components/admin/admin-context";
import { AdminFrame, AdminGateScreen } from "@/components/admin/admin-frame";
import { AdminAnchor } from "@/components/admin/admin-section";
import { TiebreakerControls } from "@/components/admin/tiebreaker-controls";
import { ScheduleControls } from "@/components/admin/schedule-controls";
import { PlayoffControls } from "@/components/admin/playoff-controls";
import { StandinControls } from "@/components/admin/standin-controls";
import { AutoSyncHealth } from "@/components/admin/auto-sync-health";

export const metadata = { title: "Matches · Admin" };

// See /admin: Server Actions inherit this segment's function budget.
export const maxDuration = 60;

/**
 * Matches: the fixtures and everything that happens to them. Tiebreakers
 * (when a tie needs settling), Schedule & results, Playoffs, Standins, and
 * the automatic result sync with the saved imports waiting on review. Each
 * card shows only in the phases where it has work or data
 * (adminSeasonCards), so before the auction the tab says why it is empty.
 */
export default async function AdminMatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ importPage?: string | string[] }>;
}) {
  const ctx = await loadAdminContext();
  if (ctx.gate !== "admin") return <AdminGateScreen gate={ctx.gate} path="/admin/matches" />;
  const { season, data, nowMs, cards } = ctx;
  const importQuery = await searchParams;
  const anyCard =
    ctx.showTiebreakers || !!cards?.schedule || !!cards?.playoffs || !!cards?.standins;
  return (
    <AdminFrame tab="matches" counts={ctx.tabCounts}>
      {/* A link to a match's result row (Overview's to-dos and Tonight, the
          match page's admin tools) lands inside a folded week. */}
      <RevealHashTarget prefix={ADMIN_MATCH_ROW_PREFIX} />
      {season && data ? (
        <>
          {ctx.showTiebreakers ? (
            <AdminAnchor id="adm-tiebreakers">
              <TiebreakerControls season={season} data={data} nowMs={nowMs} />
            </AdminAnchor>
          ) : null}
          {cards?.schedule ? (
            <AdminAnchor id="adm-schedule">
              <ScheduleControls season={season} data={data} nowMs={nowMs} />
            </AdminAnchor>
          ) : null}
          {cards?.playoffs ? (
            <AdminAnchor id="adm-playoffs">
              <PlayoffControls season={season} data={data} nowMs={nowMs} />
            </AdminAnchor>
          ) : null}
          {cards?.standins ? (
            <AdminAnchor id="adm-standins">
              <StandinControls season={season} data={data} viewerId={ctx.user.id} />
            </AdminAnchor>
          ) : null}
        </>
      ) : null}
      {!anyCard ? (
        <EmptyState
          title={season ? "No fixtures yet" : "No active season"}
          description={
            season
              ? "Fixtures are generated after the auction, from the season format chosen on Season. Results, playoffs and standins appear here then."
              : "Matches appear here once a season is open and its auction is done."
          }
          action={
            <Link href={adminTab("season").path} className={buttonClasses("secondary", "sm")}>
              Go to Season
            </Link>
          }
        />
      ) : null}
      {/* The auto-sync card and the import review are spaced like every other
          card, and the anchor hides when neither has anything to show
          (outside the regular season and playoffs, with no import waiting). */}
      {season ? (
        <AdminAnchor id="adm-sync" className="space-y-5 empty:hidden">
          <AutoSyncHealth season={season} />
          <Suspense fallback={<CardSkeleton rows={3} />}>
            <ImportProgress
              seasonId={season.id}
              page={importQuery.importPage}
              query={importQuery}
            />
          </Suspense>
        </AdminAnchor>
      ) : null}
    </AdminFrame>
  );
}
