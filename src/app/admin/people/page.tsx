import { Suspense } from "react";
import { CardSkeleton } from "@/components/ui";
import { loadAdminContext } from "@/components/admin/admin-context";
import { AdminFrame, AdminGateScreen } from "@/components/admin/admin-frame";
import { AdminAnchor } from "@/components/admin/admin-section";
import { RosterMoves } from "@/components/admin/roster-moves";
import { DiscordReachCard } from "@/components/admin/discord-reach-card";
import { MedalApprovalsSection } from "@/components/admin/medal-approvals-section";
import { unlinkedRosterFor } from "@/components/admin/season-admin-rules";

export const metadata = { title: "People · Admin" };

// See /admin: Server Actions inherit this segment's function budget.
export const maxDuration = 60;

/**
 * People: roster moves (sign, release, promote), chasing Discord links, and
 * players over the medal limit asking to be let in, which covers inhouses
 * too and so shows with or without a season.
 */
export default async function AdminPeoplePage() {
  const ctx = await loadAdminContext();
  if (ctx.gate !== "admin") return <AdminGateScreen gate={ctx.gate} path="/admin/people" />;
  const { season, data } = ctx;
  return (
    <AdminFrame tab="people" counts={ctx.tabCounts}>
      {season && data ? (
        <AdminAnchor id="adm-roster">
          <RosterMoves season={season} data={data} />
        </AdminAnchor>
      ) : null}
      {/* Chasing Discord links is a weekly people task. Streamed: its
          membership sweep calls Discord. */}
      {season ? (
        <AdminAnchor id="adm-reach">
          <Suspense fallback={<CardSkeleton rows={3} />}>
            <DiscordReachCard
              seasonId={season.id}
              rosterUnlinked={data ? unlinkedRosterFor(season, data) : null}
              signupsSeasonName={season.status === "SIGNUPS" ? season.name : null}
            />
          </Suspense>
        </AdminAnchor>
      ) : null}
      <Suspense fallback={<CardSkeleton rows={2} />}>
        <MedalApprovalsSection />
      </Suspense>
    </AdminFrame>
  );
}
