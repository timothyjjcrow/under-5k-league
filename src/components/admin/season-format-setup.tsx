import { MATCH_PHASE } from "@/lib/constants";
import { SeasonFormatBuilder } from "@/components/admin/season-format-builder";
import { parseBreakDates } from "@/lib/season-breaks";
import { regularScheduleRevision } from "@/lib/schedule-revision";
import { CardBody } from "@/components/ui";
import { knobsLabel } from "@/lib/season-builder";
import { parseFormatConfig } from "@/lib/season-format";
import { AdminSection } from "@/components/admin/admin-section";
import type { AdminData, Season } from "@/components/admin/season-admin-data";
import { seasonFormatEditState } from "@/components/admin/season-admin-rules";
import { SeasonBreaks } from "@/components/admin/season-breaks-section";

/**
 * Signups and the draft: the season builder before any fixture exists, so
 * the layout is chosen while the captains (one per team) are picked, not
 * met for the first time after the auction. It only saves here; Generate
 * joins it in Schedule & results once the auction is complete. Open until a
 * layout is saved; then it folds to that layout's one line, and it stays
 * folded from the auction on, when the team count is final.
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
  const stored = parseFormatConfig(season.formatConfig);
  const summary =
    stored.kind === "CUSTOM"
      ? `${knobsLabel(stored.knobs)}. Saved; the schedule is built from it after the auction.`
      : stored.kind === "UNREADABLE"
        ? "Saved by a newer version of the site: save a layout here to replace it."
        : "Recommended for the team count until you save a layout. Save it before the auction; the schedule is built from it afterwards.";
  return (
    <AdminSection
      id="adm-format"
      title="Season format"
      headingLevel={2}
      subtitle={summary}
      defaultOpen={stored.kind !== "CUSTOM" && !formatState.countFinal}
    >
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
    </AdminSection>
  );
}
