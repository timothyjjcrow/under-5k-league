import { AdminMedalApprovals } from "@/components/admin-medal-approvals";
import { MEDAL_APPROVALS_ANCHOR } from "@/lib/medal-approval";
import { loadMedalApprovalAdminRows } from "@/lib/medal-approval-service";
import { MEDAL_APPROVAL_STATUS } from "@/lib/constants";
import { AdminSection } from "@/components/admin/admin-section";

/**
 * The league's stream channel (broadcast.ts). Playoff and final matches link
 * to it on Home, the match page and /schedule: where they will be streamed,
 * then a live link from WATCH_OPENS_BEFORE_KICKOFF_MS before kickoff until the
 * series should be over, longer once a game is in (matchWatchWindow). One
 * link for the whole league, kept across seasons.
 */
/** The Inhouse night card (src/components/admin/inhouse-night-controls.tsx). */
export async function MedalApprovalsSection() {
  const rows = await loadMedalApprovalAdminRows();
  const pending = rows.filter(
    (r) => r.status === MEDAL_APPROVAL_STATUS.PENDING,
  ).length;
  return (
    <AdminSection
      id={MEDAL_APPROVALS_ANCHOR}
      title="Medal limit and smurf checks"
      subtitle={
        pending > 0
          ? `${pending} ${pending === 1 ? "player waits" : "players wait"} for an admin to approve or decline them.`
          : "Let a player over the medal limit, or one the smurf check flagged, sign up and join inhouses, at an MMR you set."
      }
      defaultOpen={pending > 0}
    >
      <AdminMedalApprovals rows={rows} />
    </AdminSection>
  );
}
