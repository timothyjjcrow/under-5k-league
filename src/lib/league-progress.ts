import { isRelevantOpenMatch, type SlateMatch } from "./schedule";

/** Presentation counts only; this never advances a week, result, or season. */
export function leagueProgress(matches: SlateMatch[], nowMs: number) {
  const regular = matches.filter((match) => match.phase === "REGULAR");
  const tiebreakers = matches.filter((match) => match.phase === "TIEBREAKER");
  const tiebreakerOpen = tiebreakers.filter((match) => match.status !== "COMPLETED");
  const tiebreakerFocusWeeks = tiebreakerOpen
    .filter((match) => isRelevantOpenMatch(match, nowMs))
    .map((match) => match.week);
  const completed = regular.filter(
    (match) => match.status === "COMPLETED",
  ).length;
  const open = regular.filter((match) => match.status !== "COMPLETED");
  const live = open.filter((match) => match.status === "LIVE").length;
  const awaiting = open.filter((match) => !isRelevantOpenMatch(match, nowMs));
  const untimed = open.filter(
    (match) => match.status !== "LIVE" && !match.scheduledAt,
  ).length;
  const scheduled = open.length - live - awaiting.length - untimed;
  const focusWeeks = open
    .filter((match) => isRelevantOpenMatch(match, nowMs))
    .map((match) => match.week);
  const totalWeeks = Math.max(0, ...regular.map((match) => match.week));
  // Each week's own share of final results, so the week bars fill as the
  // season is played instead of only marking where it is.
  const weeks = Array.from({ length: totalWeeks }, (_, index) => {
    const inWeek = regular.filter((match) => match.week === index + 1);
    return {
      week: index + 1,
      total: inWeek.length,
      completed: inWeek.filter((match) => match.status === "COMPLETED").length,
    };
  });
  return {
    total: regular.length,
    completed,
    live,
    awaiting,
    untimed,
    scheduled,
    totalWeeks,
    weeks,
    focusWeek: focusWeeks.length ? Math.min(...focusWeeks) : null,
    tiebreakerTotal: tiebreakers.length,
    tiebreakerCompleted: tiebreakers.length - tiebreakerOpen.length,
    tiebreakerPending: tiebreakerOpen.length,
    tiebreakerFocusWeek: tiebreakerFocusWeeks.length
      ? Math.min(...tiebreakerFocusWeeks)
      : null,
  };
}

/**
 * One line for a page subtitle: "Week 5 of 5 · 12 of 15 series played". The
 * week names the league's current slate, so it drops out once no open fixture
 * is still current (every result in, or only overdue results left).
 */
export function progressSummary(progress: ReturnType<typeof leagueProgress>) {
  if (!progress.total) return null;
  const played = `${progress.completed} of ${progress.total} series played`;
  return progress.focusWeek != null
    ? `Week ${progress.focusWeek} of ${progress.totalWeeks} · ${played}`
    : played;
}
