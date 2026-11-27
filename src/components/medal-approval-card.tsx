import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { askForMedalApproval } from "@/app/actions/medal-approval";
import { APPROVAL_REASON } from "@/lib/constants";
import {
  approvedMedalLine,
  MEDAL_APPROVAL_CARD_ANCHOR,
  MEDAL_APPROVAL_NOTE_MAX,
  medalLimitLine,
  smurfCheckLine,
  type MedalApprovalView,
} from "@/lib/medal-approval";

/** The card's title for each state and reason. */
function cardTitle(view: Exclude<MedalApprovalView, { kind: "none" }>): string {
  const smurf = view.reason === APPROVAL_REASON.SMURF;
  if (view.kind === "approved") {
    return smurf ? "Passed the smurf check" : "Approved over the medal limit";
  }
  return smurf ? "Smurf check" : "Over the medal limit";
}

/**
 * /me's card for a player over the league's medal line, or one the smurf
 * check flags (medal-approval.ts, smurf-check.ts): ask an admin to approve
 * them, then the answer. Season-independent, since an approval covers
 * inhouses too; the inhouse room's refusal points here. `signedUp` (an
 * ACTIVE signup this season) makes the line say their signup stands.
 * Renders nothing when neither refuses them.
 */
export function MedalApprovalCard({
  view,
  signedUp = false,
}: {
  view: MedalApprovalView;
  signedUp?: boolean;
}) {
  if (view.kind === "none") return null;
  const smurf = view.reason === APPROVAL_REASON.SMURF;
  return (
    <section id={MEDAL_APPROVAL_CARD_ANCHOR} className="scroll-mt-24">
      <Card>
        <CardHeader
          headingLevel={2}
          title={cardTitle(view)}
          subtitle={
            view.kind === "approved"
              ? undefined
              : smurf
                ? smurfCheckLine(view.signals, signedUp)
                : medalLimitLine(view.medal, signedUp)
          }
        />
        <CardBody className="space-y-3 text-sm">
          {view.kind === "ask" ? (
            <ActionForm action={askForMedalApproval} className="space-y-3">
              <div>
                <label htmlFor="medal-approval-note" className="block text-sm font-medium">
                  Anything the admins should know{" "}
                  <span className="font-normal text-muted">(optional)</span>
                </label>
                <textarea
                  id="medal-approval-note"
                  name="note"
                  rows={3}
                  maxLength={MEDAL_APPROVAL_NOTE_MAX}
                  placeholder={
                    smurf
                      ? "For example: this is my main now, and my old account was … at about 3,800."
                      : "For example: my medal is from an old season, and I play around 4,500 now."
                  }
                  className="mt-1.5 w-full rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-accent/60"
                />
              </div>
              <SubmitButton>Ask an admin to approve</SubmitButton>
            </ActionForm>
          ) : view.kind === "pending" ? (
            <p>
              You&apos;ve asked. An admin will approve or decline it, and the
              answer shows here.
            </p>
          ) : view.kind === "declined" ? (
            <p>
              An admin declined your request. Message a league admin on
              Discord if something has changed.
            </p>
          ) : (
            <p>{approvedMedalLine(view.mmr, view.reason)}</p>
          )}
        </CardBody>
      </Card>
    </section>
  );
}
