import { setLeagueId } from "@/app/actions/admin-season";
import { syncLeagueAction } from "@/app/actions/admin-schedule-results";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { CardBody, textLink } from "@/components/ui";
import { AdminSection } from "@/components/admin/admin-section";
import type { Season } from "@/components/admin/season-admin-data";

export function LeagueControls({ season }: { season: Season }) {
  return (
    <AdminSection
      id="adm-league"
      title="Dota league integration"
      subtitle="Link a Valve league id to auto-import every league game."
    >
      <CardBody className="space-y-3">
        {/* The manual sync used to hang off the card header. It can't ride the
            <summary> — a click on a button in there toggles the disclosure
            instead of submitting — so it leads the body. */}
        <div className="flex justify-end">
          <ActionForm action={syncLeagueAction}>
            <SubmitButton
              variant="secondary"
              size="sm"
              disabled={!season.dotaLeagueId}
            >
              Sync league games
            </SubmitButton>
          </ActionForm>
        </div>
        <ActionForm
          action={setLeagueId}
          hidden={{
            expectedActiveSeasonId: season.id,
            expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div>
            <label
              htmlFor="dotaLeagueId"
              className="mb-1 block text-xs text-muted"
            >
              Valve league id
            </label>
            <input
              id="dotaLeagueId"
              name="dotaLeagueId"
              defaultValue={season.dotaLeagueId ?? ""}
              placeholder="e.g. 17119"
              className="h-10 w-56 max-w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
            />
          </div>
          <SubmitButton variant="secondary" size="sm">
            Save league id
          </SubmitButton>
        </ActionForm>
        <div className="rounded-lg border border-line bg-surface-2/40 p-3 text-xs text-muted">
          <p className="mb-1 font-medium text-fg">
            Make league games show in the Dota client:
          </p>
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>
              Register the league at{" "}
              <a
                href="https://www.dota2.com/league"
                target="_blank"
                rel="noreferrer"
                className={textLink()}
              >
                dota2.com/league
              </a>{" "}
              to get a league id, then paste it above.
            </li>
            <li>
              Host each match in a <b>private lobby</b> and set its{" "}
              <b>League</b> field to your league id.
            </li>
            <li>
              Those games become spectatable via DotaTV in-client and are tagged
              with your league id.
            </li>
            <li>
              Results from those lobbies sync automatically, with no match IDs
              or public player data needed. Press <b>Sync league games</b> to
              check now.
            </li>
          </ol>
        </div>
        <p className="rounded-lg border border-line bg-surface-2/40 p-3 text-xs text-muted">
          <span className="font-medium text-fg">Player data refreshes itself:</span>{" "}
          about once an hour the automation worker updates Steam names and
          avatars, the medals and scouting stats of the few players checked
          longest ago, and adds report-card stats and end-of-game items to
          a few games imported before those were stored. It pauses when
          OpenDota refuses a
          request and while an auction is live. To refresh right away, use
          the Refresh player data now button in{" "}
          <a href="#adm-captains" className={textLink()}>
            Captains &amp; draft
          </a>
          .
        </p>
      </CardBody>
    </AdminSection>
  );
}
