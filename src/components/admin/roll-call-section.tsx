import { rollCallCountLine } from "@/lib/roll-call";
import { loadAdminRollCall } from "@/lib/roll-call-service";
import { RollCallControls } from "@/components/admin/roll-call-controls";
import { AdminSection } from "@/components/admin/admin-section";

/**
 * The Roll call section: Home's "I'm in" for the season's match night,
 * opened and closed here, with who is in and who hasn't answered. Opens
 * itself while the roll call is open.
 */
export async function AdminRollCall() {
  // Async server component: rendered once per request.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const rollCall = await loadAdminRollCall(nowMs);
  if (!rollCall) return null;
  const total = rollCall.view
    ? rollCall.view.locked.length + rollCall.view.waiting.length
    : 0;
  return (
    <AdminSection
      id="adm-roll-call"
      title="Roll call"
      subtitle={
        rollCall.open && rollCall.view
          ? `Open on Home: ${rollCallCountLine(rollCall.view.locked.length, total)}. Players signed up for the draft tap "I'm in" for the match night.`
          : 'Before the first match night, ask every player signed up for the draft to tap "I\'m in" on Home: they can play the match night every week and will play for whichever team drafts them.'
      }
      defaultOpen={rollCall.open}
    >
      <RollCallControls rollCall={rollCall} />
    </AdminSection>
  );
}
