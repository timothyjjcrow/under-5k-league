import { MATCH_PHASE } from "@/lib/constants";
import { SeasonFormatBuilder } from "@/components/admin/season-format-builder";
import { parseBreakDates } from "@/lib/season-breaks";
import { regularScheduleRevision } from "@/lib/schedule-revision";
import { Card, CardBody, CardHeader } from "@/components/ui";
import type { AdminData, Season } from "@/components/admin/season-admin-data";
import { seasonFormatEditState } from "@/components/admin/season-admin-rules";
import { SeasonBreaks } from "@/components/admin/season-breaks-section";

/**
 * Signups and the draft: the season builder before any fixture exists, so
 * the layout is chosen while the captains (one per team) are picked, not
 * met for the first time after the auction. It only saves here; Generate
 * joins it in Schedule & results once the auction is complete.
 */
export function SeasonFormatSetup({
  season,
  data,
  nowMs,
}: {
  season: Season;
  data: AdminData;
  nowMs: number;
}) {
  const regularMatches = data.matches.filter((m) => m.phase === MATCH_PHASE.REGULAR);
  const formatState = seasonFormatEditState(season, data);
  if (formatState.mode === "LOCKED") return null;
  const scheduleRevision = regularScheduleRevision(regularMatches.map((match) => match.id));
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Season format"
        subtitle="How the season runs: one table or two groups, how often teams meet and how many make the playoffs. Save it before the auction; the schedule is built from it afterwards."
      />
      <CardBody>
        <SeasonFormatBuilder
          placement="setup"
          season={{
            id: season.id,
            name: season.name,
            formatConfig: season.formatConfig,
            updatedAt: season.updatedAt.toISOString(),
          }}
          teamGroupKeys={data.teams.map((team) => team.groupKey)}
          mode={formatState.mode}
          countFinal={formatState.countFinal}
          regularCount={regularMatches.length}
          scheduleRevision={scheduleRevision}
          generateLockedReason={null}
          firstMatchNightTs={season.firstMatchNight?.getTime() ?? null}
          breakDates={parseBreakDates(season.breakDates)}
          nowMs={nowMs}
          regenerateConsequences={[]}
        />
        <div className="mt-3">
          <SeasonBreaks season={season} data={data} nowMs={nowMs} />
        </div>
      </CardBody>
    </Card>
  );
}
