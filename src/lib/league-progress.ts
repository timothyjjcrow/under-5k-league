import { isRelevantOpenMatch, type SlateMatch } from "./schedule";

/** Presentation counts only; this never advances a week, result, or season. */
export function leagueProgress(matches: SlateMatch[], nowMs: number) {
  const regular = matches.filter((match) => match.phase === "REGULAR");
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
  return {
    total: regular.length,
    completed,
    live,
    awaiting,
    untimed,
    scheduled,
    totalWeeks: Math.max(0, ...regular.map((match) => match.week)),
    focusWeek: focusWeeks.length ? Math.min(...focusWeeks) : null,
  };
}
