import { cache } from "react";
import { getSessionUser } from "@/lib/auth";
import { completedSeasonArchiveReadiness, getActiveSeason } from "@/lib/season";
import { adminSeasonCards, openBookingCount } from "@/lib/admin-sections";
import { matchNightSlate } from "@/lib/admin-match-night";
import { loadLeagueDeliveryHealth } from "@/lib/league-announcement-outbox";
import { projectPlayoffField } from "@/lib/playoff-field";
import { regularSeasonStatus } from "@/lib/schedule-status";
import { rollCallPhase } from "@/lib/roll-call";
import { MATCH_PHASE } from "@/lib/constants";
import { adminAnchorTarget, type AdminTabId } from "@/lib/admin-tabs";
import { loadSeasonAdminData } from "@/components/admin/season-admin-data";
import {
  autoSyncVisible,
  formatBuilderAnchor,
  rosterMovesVisible,
} from "@/components/admin/season-admin-rules";
import { adminNextStepFor } from "@/components/admin/next-step-banner";
import { loadAutomationAttention } from "@/components/admin/automation-runner";
import { adminAttentionList } from "@/components/admin/needs-attention-card";

/**
 * Everything the admin tabs share, read once per request (React `cache`):
 * the viewer's access, the active season's data, the next step and the to-do
 * list Overview shows, which cards render this phase, and how many to-dos
 * each tab holds for the tab bar. Database reads only: the cards that call
 * Discord or OpenDota stream on their own tabs.
 */
export const loadAdminContext = cache(async () => {
  const user = await getSessionUser();
  if (!user) return { gate: "anonymous" as const };
  if (user.role !== "ADMIN") return { gate: "denied" as const };

  const season = await getActiveSeason();
  // Delivery health is database-only, so it can sit on the blocking path.
  const [data, delivery] = await Promise.all([
    season ? loadSeasonAdminData(season.id, season.teamSize) : null,
    season ? loadLeagueDeliveryHealth().catch(() => null) : null,
  ]);
  // Async server code: it runs once per request, so Date.now() has no
  // re-render to be inconsistent across. "Outstanding" means past kickoff.
  const nowMs = Date.now();
  const nextStep = season && data ? adminNextStepFor(season, data, nowMs) : null;
  const tonight =
    season && data ? matchNightSlate(season.status, data.matches, nowMs) : [];
  // DB-only, and shared with the runner card on System.
  const automationLines = season && data ? await loadAutomationAttention() : [];
  const cards =
    season && data
      ? adminSeasonCards({
          seasonStatus: season.status,
          draftStatus: data.draft?.status,
          matches: data.matches,
          openBookings: openBookingCount(data.assignments, data.matches),
          archivedPostseasonGames:
            data.playoffArchive.length + data.tiebreakerArchive.length,
        })
      : null;
  const showTiebreakers =
    season != null &&
    data != null &&
    (data.matches.some((match) => match.phase === MATCH_PHASE.TIEBREAKER) ||
      (regularSeasonStatus(data.matches).allComplete &&
        projectPlayoffField(data.teams, data.matches, season).tiebreakers.groups
          .length > 0));
  const handoffReadiness =
    season && data
      ? completedSeasonArchiveReadiness(
          season,
          data.matches,
          data.teams.map((team) => team.id),
        )
      : null;
  // The season builder has its own card on Season while captains are
  // picked; once the schedule card shows, it lives inside that instead.
  const formatCard =
    season != null && data != null && formatBuilderAnchor(season, data) === "#adm-format";

  // Every card that renders this request, by anchor, with the name a link to
  // it reads: the to-do list links only to these, so a line never sends the
  // admin to a card this phase doesn't show.
  const sections = new Map<string, string>();
  if (season && data) {
    sections.set("adm-attention", "Needs attention");
    if (tonight.length > 0) sections.set("adm-tonight", "Tonight");
    sections.set("adm-season", "Phase");
    sections.set("adm-settings", "Settings");
    sections.set("adm-league", "League id");
    if (formatCard) sections.set("adm-format", "Season format");
    sections.set("adm-draft", "Draft");
    if (rollCallPhase(season.status)) sections.set("adm-roll-call", "Roll call");
    sections.set("adm-teams", "Teams");
    sections.set("adm-signups", "Signups");
    if (showTiebreakers) sections.set("adm-tiebreakers", "Tiebreakers");
    if (cards?.schedule) sections.set("adm-schedule", "Schedule & results");
    if (cards?.playoffs) sections.set("adm-playoffs", "Playoffs");
    if (rosterMovesVisible(season, data)) sections.set("adm-roster", "Roster moves");
    if (cards?.standins) sections.set("adm-standins", "Standins");
    sections.set("adm-reach", "Discord reach");
    if (autoSyncVisible(season)) sections.set("adm-sync", "Auto-sync");
  }
  sections.set("adm-new-season", season ? "Season handoff" : "Open a new season");
  sections.set("adm-poll", "Match night poll");
  sections.set("adm-medal-approvals", "Medal approvals");
  sections.set("adm-inhouse-night", "Inhouse night");
  sections.set("adm-inhouse-players", "Inhouse players");
  sections.set("adm-inhouse-discord", "Inhouse Discord");
  sections.set("adm-discord", "Discord");
  sections.set("adm-news", "News");
  sections.set("adm-stream", "Match stream");
  sections.set("adm-automation", "Automation");
  sections.set("adm-database", "Database performance");
  sections.set("adm-history", "Historical records");
  sections.set("adm-activity", "Activity");
  sections.set("adm-security", "Security");

  const attention =
    season && data
      ? adminAttentionList({ season, data, delivery, automation: automationLines })
      : { items: [], matches: [] };
  // What each tab holds from the to-do list: every line counts toward the
  // tab its link opens, each match to review toward Matches, and the missing
  // league ticket toward Season. Overview lists them all, so it has no count.
  const tabCounts: Partial<Record<AdminTabId, number>> = {};
  const count = (tab: AdminTabId | undefined) => {
    if (tab && tab !== "overview") tabCounts[tab] = (tabCounts[tab] ?? 0) + 1;
  };
  for (const item of attention.items) count(adminAnchorTarget(item.href)?.tab);
  for (let i = 0; i < attention.matches.length; i += 1) count("matches");
  if (nextStep?.ticketWarning) count("season");

  return {
    gate: "admin" as const,
    user,
    season,
    data,
    delivery,
    nowMs,
    nextStep,
    tonight,
    automationLines,
    cards,
    showTiebreakers,
    handoffReadiness,
    formatCard,
    sections,
    attention,
    tabCounts,
  };
});

export type AdminContext = Extract<
  Awaited<ReturnType<typeof loadAdminContext>>,
  { gate: "admin" }
>;
