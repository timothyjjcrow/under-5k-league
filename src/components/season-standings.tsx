// The league table, or one table per group in a group-stage season. Callers
// pass the props they would give one <StandingsTable>; with `groups` set, each
// group gets its own titled table where the cut, the seeds and the field sizes
// the caller asked for are the group's (`standingsSections`). Without groups it
// renders exactly the one table it was given.

import { StandingsTable } from "./standings-table-server";
import type { StandingsSection } from "@/lib/season-groups";

type StandingsTableProps = Parameters<typeof StandingsTable>[0];

export function SeasonStandings({
  groups,
  ...table
}: StandingsTableProps & {
  /** `standingsSections(field)` when the season plays groups, else null. */
  groups: StandingsSection[] | null;
}) {
  if (!groups) return <StandingsTable {...table} />;
  return (
    <div className="divide-y divide-line">
      {groups.map((section) => (
        <section key={section.key ?? "table"} aria-label={section.label} className="@container">
          <h3 className="bg-surface-2/35 px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-[0.15em] text-fg @lg:px-5">
            {section.title}
          </h3>
          <StandingsTable
            {...table}
            standings={section.standings}
            label={section.label}
            {...(section.seedLabelByTeam ? { seedLabelByTeam: section.seedLabelByTeam } : {})}
            {...(table.playoffCut !== undefined ? { playoffCut: section.playoffCut } : {})}
            {...(table.playoffSeedByTeam ? { playoffSeedByTeam: section.playoffSeedByTeam } : {})}
            {...(table.totalTeams !== undefined ? { totalTeams: section.totalTeams } : {})}
            {...(table.eligibleTeams !== undefined ? { eligibleTeams: section.eligibleTeams } : {})}
          />
        </section>
      ))}
    </div>
  );
}
