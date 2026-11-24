import { archiveIncompleteSeasonAction } from "@/app/actions/admin-season";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { CardBody } from "@/components/ui";
import { SEASON_STATUS } from "@/lib/constants";
import { AdminSection } from "@/components/admin/admin-section";
import type { Season } from "@/components/admin/season-admin-data";

/**
 * The season handoff before a champion is crowned: why it is locked, and
 * the break-glass way out of an unfinished season (archive it and enter the
 * offseason). Once a champion is crowned OpenNextSeason takes its place.
 */
export function SeasonHandoffLocked({
  season,
  reason,
}: {
  season: Season;
  /** completedSeasonArchiveReadiness's reason the handoff is locked. */
  reason: string;
}) {
  return (
    <AdminSection
      id="adm-new-season"
      title="Season handoff"
      subtitle="The normal handoff unlocks after an authoritative champion is crowned."
    >
      <CardBody className="space-y-3">
        <div className="rounded-lg border border-accent/40 bg-accent/10 px-4 py-3 text-sm">
          <div className="font-medium text-fg">Handoff locked</div>
          <p className="mt-1 text-muted">{reason}</p>
          <p className="mt-1 text-muted">
            No data has to be discarded to continue the league. Use the phase
            control on Overview, or the result and playoff recovery controls
            on Matches, first.
          </p>
        </div>
        {season.status !== SEASON_STATUS.COMPLETE ? (
          <details className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-danger">
              Need to cancel this unfinished season?
            </summary>
            <p className="mt-2 text-muted">
              This is separate from a normal handoff. It closes every
              active-season signup, draft, match, sync, and reminder workflow
              immediately. Saved teams, signups, matches, and games remain in
              History, and an admin can reactivate the season later. If an
              auction is live, its lot and bids are preserved with both clocks
              paused for an admin to review.
            </p>
            <ActionForm
              action={archiveIncompleteSeasonAction}
              hidden={{
                expectedActiveSeasonId: season.id,
                expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
              }}
              className="mt-3"
            >
              <SubmitButton
                variant="danger"
                confirm={`Cancel and archive unfinished ${season.name}? Active league workflows stop immediately. Nothing is deleted; a live auction is paused, and reactivation remains available from Season history after you enter the offseason.`}
              >
                Cancel season and enter offseason
              </SubmitButton>
            </ActionForm>
          </details>
        ) : null}
      </CardBody>
    </AdminSection>
  );
}
