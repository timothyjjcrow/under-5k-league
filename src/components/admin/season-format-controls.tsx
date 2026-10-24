// The schedule card's format box (/admin): the season the team count makes
// (one table or two groups, season-format.ts), its calendar, and in a group
// season each group, with a swap while the schedule can still be rebuilt.

import { swapGroupTeams } from "@/app/actions/admin-schedule-results";
import { ActionForm } from "@/components/action-form";
import { DangerSubmit } from "@/components/danger-submit";
import { SeasonPlanList } from "@/components/season-plan";
import {
  SEASON_GROUP_KEYS,
  describeSeasonFormat,
  resolveSeasonFormat,
  seasonPlan,
} from "@/lib/season-format";

type FormatTeam = { id: string; name: string; groupKey: string | null };

const FIELD =
  "h-8 min-w-0 max-w-full rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg";

export function SeasonFormatControls({
  season,
  teams,
  firstMatchNight,
  lastRegularWeek,
  regenerateOpen,
  regenerateConsequences,
}: {
  season: { id: string; name: string };
  /** The season's teams, withdrawn ones included (they keep their group). */
  teams: FormatTeam[];
  firstMatchNight: Date | null;
  /** The schedule's last regular week, 0 before one is generated. */
  lastRegularWeek: number;
  /** Whether the schedule can be regenerated now (no result yet). */
  regenerateOpen: boolean;
  /** What a regenerate destroys, for the swap's confirm. */
  regenerateConsequences: string[];
}) {
  const format = resolveSeasonFormat(teams, lastRegularWeek > 0);
  if (!format) return null;
  const plan = seasonPlan(format, firstMatchNight, lastRegularWeek || format.regularWeeks);
  const groups =
    format.kind === "GROUPS"
      ? SEASON_GROUP_KEYS.map((key) => ({
          key,
          teams: teams.filter((team) => team.groupKey === key),
        }))
      : [];
  const drawn =
    groups.length > 0 &&
    groups.reduce((sum, group) => sum + group.teams.length, 0) === teams.length;
  return (
    <section
      aria-label="Season format"
      className="rounded-lg border border-line bg-surface-2/40 px-4 py-3"
    >
      <h3 className="text-sm font-medium text-fg">
        Season format · {teams.length} teams
      </h3>
      <p className="mt-0.5 text-xs text-muted">
        {describeSeasonFormat(format)} The site sets this from the team count;
        one week after the regular season is kept for tiebreakers.
      </p>
      <SeasonPlanList plan={plan} className="mt-2" />
      {format.kind === "GROUPS" ? (
        drawn ? (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {groups.map((group) => (
              <div key={group.key} className="min-w-0">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Group {group.key}
                </h4>
                <ul className="mt-1 space-y-0.5 text-sm text-fg">
                  {group.teams.map((team) => (
                    <li key={team.id} className="truncate">
                      {team.name}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">
            Generate the schedule to draw the groups: teams are ranked by
            their roster&apos;s average signup MMR and dealt A, B, B, A, A, B…
          </p>
        )
      ) : null}
      {drawn && regenerateOpen ? (
        <ActionForm
          action={swapGroupTeams}
          hidden={{ expectedActiveSeasonId: season.id }}
          className="mt-3 flex flex-wrap items-end gap-2"
        >
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
            From group A
            <select name="teamA" required defaultValue="" className={FIELD}>
              <option value="" disabled>
                Pick a team
              </option>
              {groups[0].teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
            From group B
            <select name="teamB" required defaultValue="" className={FIELD}>
              <option value="" disabled>
                Pick a team
              </option>
              {groups[1].teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
          <DangerSubmit
            token={season.name}
            title="Swap these two teams and regenerate the schedule?"
            consequences={[
              "The two teams trade groups, and every regular-season fixture is rebuilt for the new groups from the week-1 night.",
              ...regenerateConsequences,
            ]}
            recovery="Swapping them back restores the groups. Check-ins, picks and bookings on the old fixtures cannot be restored."
          >
            Swap teams
          </DangerSubmit>
        </ActionForm>
      ) : null}
    </section>
  );
}
