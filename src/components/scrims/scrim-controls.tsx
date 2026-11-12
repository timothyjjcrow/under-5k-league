import { ActionForm, SubmitButton } from "@/components/action-form";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { Card, CardBody, CardHeader, PlayerLink } from "@/components/ui";
import {
  addTeamCoach,
  cancelScrim,
  createScrim,
  joinScrim,
  removeTeamCoach,
} from "@/app/actions/scrims";

// A captain's scrim controls, drawn the same on /scrims and the Captains page
// (/captains). Each posts to the scrim actions, which re-check that the viewer
// captains an active team before anything is written.

export const SCRIM_INPUT_CLASS =
  "h-10 rounded-lg border border-line bg-surface-2/50 px-3 text-sm text-fg outline-none focus:border-accent/60";

/** "Post availability": a time and a format another captain can claim. */
export function ScrimPostForm() {
  return (
    <ActionForm
      action={createScrim}
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
    >
      {/* A datetime needs about 18rem; stretched across the card it pushed
          Format and Post to the far edge. A flex column, not space-y: the
          field's hidden twin is the last child, so space-y put a margin
          under the visible box and lifted it 6px above Format and Post. */}
      <label className="flex min-w-0 flex-col gap-1.5 text-sm sm:w-72">
        <span className="block text-xs font-medium text-muted">
          Available date and time
        </span>
        <LocalDatetimeField
          name="scheduledAt"
          tsName="scheduledAtTs"
          required
          className={`${SCRIM_INPUT_CLASS} w-full`}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="block text-xs font-medium text-muted">Format</span>
        <select name="bestOf" defaultValue="1" className={SCRIM_INPUT_CLASS}>
          <option value="1">Best of 1</option>
          <option value="2">Best of 2</option>
          <option value="3">Best of 3</option>
          <option value="5">Best of 5</option>
        </select>
      </label>
      <SubmitButton>Post availability</SubmitButton>
    </ActionForm>
  );
}

/** Claim another team's open time (shown only where `scrimJoinCheck` allows). */
export function ScrimJoinButton({ scrimId }: { scrimId: string }) {
  return (
    <ActionForm action={joinScrim} hidden={{ scrimId }}>
      <SubmitButton size="sm">Join scrim</SubmitButton>
    </ActionForm>
  );
}

/** Cancel a scrim the viewer's team posted or booked. */
export function ScrimCancelButton({
  scrimId,
  booked,
}: {
  scrimId: string;
  /** A claimed scrim; an open time otherwise. */
  booked: boolean;
}) {
  return (
    <ActionForm action={cancelScrim} hidden={{ scrimId }}>
      <SubmitButton
        size="sm"
        variant="ghost"
        confirm={
          booked
            ? "Cancel this scrim? The other captain is told, and no result can be added."
            : "Cancel this open scrim time?"
        }
      >
        Cancel
      </SubmitButton>
    </ActionForm>
  );
}

/** The captain's coaches: add by Dota id or profile link, remove one. */
export function TeamCoachesCard({
  team,
  id = "coaches",
  headingLevel = 2,
}: {
  team: {
    name: string;
    staff: readonly { id: string; userId: string; user: { name: string } }[];
  };
  id?: string;
  headingLevel?: 2 | 3;
}) {
  return (
    <Card id={id} tone="quiet">
      <CardHeader
        title={`${team.name} coaches`}
        subtitle="Coaches must have signed into the site once. They can manage your side’s casual guest IDs and fetch scrim results, but cannot post, claim, or cancel scrims."
        headingLevel={headingLevel}
      />
      <CardBody className="space-y-4">
        <ActionForm
          action={addTeamCoach}
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
        >
          <label className="min-w-0 flex-1 space-y-1.5 text-sm sm:max-w-md">
            <span className="block text-xs font-medium text-muted">
              Coach Dota ID, SteamID64, or profile URL
            </span>
            <input
              name="coachRef"
              required
              placeholder="Account ID or profile URL"
              className={`${SCRIM_INPUT_CLASS} w-full`}
            />
          </label>
          {/* Secondary: a set-once form must not compete with Post
              availability, the page's one main action. */}
          <SubmitButton size="sm" variant="secondary">
            Add coach
          </SubmitButton>
        </ActionForm>
        {team.staff.length > 0 ? (
          <ul className="divide-y divide-line/60 rounded-lg border border-line/70">
            {team.staff.map((staff) => (
              <li
                key={staff.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <PlayerLink userId={staff.userId}>{staff.user.name}</PlayerLink>
                <ActionForm action={removeTeamCoach} hidden={{ staffId: staff.id }}>
                  <SubmitButton
                    variant="ghost"
                    size="sm"
                    confirm={`Remove ${staff.user.name}'s coach access?`}
                  >
                    Remove
                  </SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No coaches assigned.</p>
        )}
      </CardBody>
    </Card>
  );
}
