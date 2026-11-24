import { MATCH_PHASE } from "@/lib/constants";
import {
  plannedSeasonFormat,
  resolveSeasonFormat,
  seasonPlan,
  withBracket,
} from "@/lib/season-format";
import { SeasonBreaksControls } from "@/components/admin/season-breaks-controls";
import { parseBreakDates } from "@/lib/season-breaks";
import { projectPlayoffField } from "@/lib/playoff-field";
import type { AdminData, Season } from "@/components/admin/season-admin-data";

/**
 * The season plan the Breaks box counts rounds from: the built schedule's
 * (a bracket withdrawals shrank included, as /schedule prints it), or before
 * fixtures exist the one Generate would build for today's teams.
 */
function breaksPlan(season: Season, data: AdminData) {
  const lastRegularWeek = data.matches
    .filter((match) => match.phase === MATCH_PHASE.REGULAR)
    .reduce((max, match) => Math.max(max, match.week), 0);
  const format =
    lastRegularWeek > 0
      ? resolveSeasonFormat(season, data.teams, true)
      : plannedSeasonFormat(season, data.teams.length);
  if (!format) return [];
  const field = projectPlayoffField(data.teams, data.matches, season);
  return seasonPlan(
    withBracket(format, field.bracketSize),
    season.firstMatchNight,
    lastRegularWeek || format.regularWeeks,
    undefined,
    parseBreakDates(season.breakDates),
  );
}

/** The Breaks box for `season`, wherever the season builder is. */
export function SeasonBreaks({ season, data, nowMs }: { season: Season; data: AdminData; nowMs: number }) {
  return (
    <SeasonBreaksControls
      season={season}
      plan={breaksPlan(season, data)}
      fixtures={data.matches.map((match) => ({
        id: match.id,
        week: match.week,
        status: match.status,
        scheduledAt: match.scheduledAt,
      }))}
      nowMs={nowMs}
    />
  );
}
