// The league table, or one table per group in a group-stage season. Callers
// pass the props they would give one <StandingsTable>; with `groups` set, each
// group gets its own titled table where the cut, the seeds and the field sizes
// the caller asked for are the group's (`standingsSections`). Without groups it
// renders exactly the one table it was given.

import { StandingsTable } from "./standings-table-server";
import { cn } from "@/lib/utils";
import type { StandingsSection } from "@/lib/season-groups";

type StandingsTableProps = Parameters<typeof StandingsTable>[0];

export function SeasonStandings({
  groups,
  sideBySide = false,
  ...table
}: StandingsTableProps & {
  /** `standingsSections(field)` when the season plays groups, else null. */
  groups: StandingsSection[] | null;
  /**
   * Set the groups' tables side by side once each can have 30rem (Schedule's
   * full-width card), stacking them on narrower screens.
   */
  sideBySide?: boolean;
}) {
  if (!groups) return <StandingsTable {...table} />;
  return (
    <div
      className={
        sideBySide
          ? // auto-fit: two tracks only when both fit. overflow-hidden clips
            // each section's top and left hairline (the shadow below) at the
            // card's edge, so the rules fall only BETWEEN tables, stacked or
            // side by side, with no empty cell left painted.
            "grid overflow-hidden [grid-template-columns:repeat(auto-fit,minmax(min(30rem,100%),1fr))]"
          : "divide-y divide-line"
      }
    >
      {groups.map((section) => (
        <section
          key={section.key ?? "table"}
          aria-label={section.label}
          className={cn("@container", sideBySide && "shadow-[-1px_-1px_0_0_var(--color-line)]")}
        >
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
