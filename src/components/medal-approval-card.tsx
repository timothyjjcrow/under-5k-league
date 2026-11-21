import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { askForMedalApproval } from "@/app/actions/medal-approval";
import { HARD_MMR_CEILING } from "@/lib/constants";
import {
  approvedMedalLine,
  MEDAL_APPROVAL_CARD_ANCHOR,
  MEDAL_APPROVAL_NOTE_MAX,
  type MedalApprovalView,
} from "@/lib/medal-approval";

const MMR_FORMAT = new Intl.NumberFormat("en-US");

/**
 * /me's card for a player over the league's medal line (medal-approval.ts):
 * ask an admin to approve them, then the answer. Season-independent, since an
 * approval covers inhouses too; the inhouse room's refusal points here.
 * Renders nothing when the medal refuses nobody.
 */
export function MedalApprovalCard({ view }: { view: MedalApprovalView }) {
  if (view.kind === "none") return null;
  const line = `${MMR_FORMAT.format(HARD_MMR_CEILING)} MMR`;
  return (
    <section id={MEDAL_APPROVAL_CARD_ANCHOR} className="scroll-mt-24">
      <Card>
        <CardHeader
          headingLevel={2}
          title={view.kind === "approved" ? "Approved over the medal limit" : "Over the medal limit"}
          subtitle={
            view.kind === "approved"
              ? undefined
              : `Your ${view.medal} medal is over the league's ${line} line, so league signups and inhouses turn it away. An admin can approve you anyway, at an MMR they set.`
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
                  placeholder="For example: my medal is from an old season, and I play around 4,500 now."
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
            <p>{approvedMedalLine(view.mmr)}</p>
          )}
        </CardBody>
      </Card>
    </section>
  );
}
