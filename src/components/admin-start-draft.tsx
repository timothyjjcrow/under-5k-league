import { startDraft } from "@/app/actions/admin-captains-draft";
import { ActionForm } from "@/components/action-form";
import { StartDraftSubmit } from "@/components/start-draft-submit";
import type { ButtonSize } from "@/components/ui";
import {
  discordReachWarning,
  getDiscordReachFunnel,
} from "@/lib/discord-roles";

// The Start-draft button, shared by the Captains & draft card on /admin and
// the draft room's waiting room. Both render THIS form over the same
// startDraft server action, with the confirm built by startDraftConfirm
// (draft-setup.ts) plus the Discord line below, so the start guards and the
// warning an admin reads are the same wherever they press it. The line naming
// captains who aren't in the draft room is added last, by the button itself
// (see start-draft-submit.tsx), because only the page showing it knows that.

/**
 * The Start-draft form itself, rendered twice: as the Suspense fallback with
 * the base confirm (the button must exist the moment the page paints), and
 * by StartDraftControl with the Discord reachability line appended.
 */
export function StartDraftForm({
  seasonId,
  confirm,
  disabled,
  size = "sm",
}: {
  seasonId: string;
  confirm: string;
  disabled: boolean;
  size?: ButtonSize;
}) {
  return (
    <ActionForm
      action={startDraft}
      hidden={{ expectedActiveSeasonId: seasonId }}
    >
      <StartDraftSubmit confirm={confirm} disabled={disabled} size={size} />
    </ActionForm>
  );
}

/**
 * House rule: a consequential confirm states the real numbers BEFORE the
 * click. This one appends who the league cannot reach on Discord — missing
 * from the server, stuck behind its rules screen, or never linked — because
 * the moment before the draft is the last cheap chance to chase a join:
 * afterwards these players are locked onto rosters that need to schedule
 * with them every week.
 */
export async function StartDraftControl({
  seasonId,
  confirmBase,
  disabled,
  size = "sm",
}: {
  seasonId: string;
  confirmBase: string;
  disabled: boolean;
  size?: ButtonSize;
}) {
  const reach = await getDiscordReachFunnel(seasonId);
  return (
    <StartDraftForm
      seasonId={seasonId}
      confirm={confirmBase + discordReachWarning(reach)}
      disabled={disabled}
      size={size}
    />
  );
}
