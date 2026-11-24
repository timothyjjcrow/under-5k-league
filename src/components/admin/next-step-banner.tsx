import { adminHref } from "@/lib/admin-tabs";
import { capacityInfo } from "@/lib/capacity";
import { MATCH_PHASE, MATCH_STATUS } from "@/lib/constants";
import { formatLeagueTime } from "@/lib/zoned-time";
import { adminNextStep, type AdminNextStep } from "@/lib/admin-next-step";
import { cn } from "@/lib/utils";
import { projectPlayoffField } from "@/lib/playoff-field";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import { unverifiedCaptainMmrsFor } from "@/lib/captain-mmr";
import { nextRegularKickoff, regularResultsDue } from "@/lib/schedule-status";
import { textLink } from "@/components/ui";
import type { AdminData, Season } from "@/components/admin/season-admin-data";

/**
 * The admin page's "what do I do next?" line, from the pure, tested
 * adminNextStep. Built once per render: the banner under the page title and
 * the phase card both read it.
 */
export function adminNextStepFor(
  season: Season,
  data: AdminData,
  nowMs: number,
): AdminNextStep {
  const cap = capacityInfo(season, data.players.length);
  const nextKickoff = nextRegularKickoff(data.matches, nowMs);
  const regular = data.matches.filter((m) => m.phase === "REGULAR");
  const playoff = data.matches.filter(
    (m) => m.phase === "PLAYOFF" || m.phase === "FINAL",
  );
  const championPresentation = resolveChampionPresentation(
    season,
    data.matches,
  );
  const captainIds = new Set(data.teams.map((team) => team.captainId));
  return adminNextStep({
    seasonStatus: season.status,
    draftStatus: data.draft?.status ?? null,
    playerCount: data.players.length,
    minPlayers: cap.minPlayers,
    teamCount: data.teams.length,
    // Panel-only: the signup steps say how many teams the pool makes and
    // how many players offered to captain (Home repeats only the title).
    teamSize: season.teamSize,
    captainVolunteers: data.players.filter(
      (player) => player.wantsCaptain && !captainIds.has(player.userId),
    ).length,
    regularMatchCount: regular.length,
    untimedRegularCount: regular.filter(
      (m) =>
        m.status !== MATCH_STATUS.COMPLETED &&
        m.status !== MATCH_STATUS.LIVE &&
        !m.scheduledAt,
    ).length,
    pendingRegularResults: regular.filter((m) => m.status !== "COMPLETED")
      .length,
    outstandingRegularResults: regularResultsDue(data.matches, nowMs).length,
    nextKickoff: nextKickoff && {
      week: nextKickoff.week,
      label: formatLeagueTime(nextKickoff.at),
    },
    pendingTiebreakerResults: data.matches.filter(
      (m) => m.phase === "TIEBREAKER" && m.status !== "COMPLETED",
    ).length,
    existingTiebreakerCount: data.matches.filter(
      (match) => match.phase === MATCH_PHASE.TIEBREAKER,
    ).length,
    unresolvedPlayoffTieCount: projectPlayoffField(data.teams, data.matches, season)
      .seedingDeadHeatTeamIds.length,
    playoffMatchCount: playoff.length,
    unfinishedPlayoffCount: playoff.filter((m) => m.status !== "COMPLETED")
      .length,
    hasChampion: championPresentation.championTeamId != null,
    unlinkedDiscordCount: data.unlinkedDiscord,
    unverifiedCaptainMmrNames: unverifiedCaptainMmrsFor(season, data).map(
      (c) => c.name,
    ),
    hasLeagueTicket: !!season.dotaLeagueId,
  });
}

/**
 * THE ROADMAP, pinned under the page title. Several league transitions are
 * silent and fail quietly: the auction finishing does NOT advance the phase,
 * a schedule with no kickoff times disables auto-sync, reminders and pick'em
 * locks, and nothing else prompts "start the playoffs" or "record the final".
 * This line is the page's answer to "what do I do next?" in EVERY phase. It
 * used to sit inside the phase card, about 7,000px down a phone mid-season.
 */
export function NextStepBanner({ nextStep }: { nextStep: AdminNextStep }) {
  return (
    <section aria-label="Next step" className="space-y-2">
      <p
        className={cn(
          "rounded-lg border px-3 py-2 text-sm",
          nextStep.tone === "action"
            ? "border-accent/30 bg-accent/10 text-fg"
            : nextStep.tone === "warning"
              ? "border-danger/40 bg-danger/10 text-fg"
              : nextStep.tone === "done"
                ? "border-success/40 bg-success/10 text-fg"
                : "border-line bg-surface-2/40 text-muted",
        )}
      >
        <b className="text-fg">{nextStep.title}</b>
        {nextStep.detail ? <> {nextStep.detail}</> : null}
        {nextStep.jump ? (
          <>
            {" "}
            <a href={adminHref(nextStep.jump.href)} className={textLink("whitespace-nowrap")}>
              {nextStep.jump.label} →
            </a>
          </>
        ) : null}
      </p>
      {/* A standing condition, not this phase's step: Valve needs about 15
          days to issue a ticket, so this shows from the first signup rather
          than surfacing when week 1 is already lost. The link opens the
          collapsed league-id section on Season, which opens on the hash. */}
      {nextStep.ticketWarning ? (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-fg">
          {nextStep.ticketWarning}{" "}
          <a href={adminHref("adm-league")} className={textLink()}>
            Set the league id →
          </a>
        </p>
      ) : null}
    </section>
  );
}
