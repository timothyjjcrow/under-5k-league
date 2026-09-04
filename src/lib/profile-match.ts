import { isRelevantOpenMatch, type SlateMatch } from "./schedule";

/** Pick a profile's match spotlight without calling old fixtures "up next". */
export function profileMatch<T extends SlateMatch>(
  matches: T[],
  nowMs: number,
  activeSeason: boolean,
): T | null {
  const byKickoff = (a: T, b: T) =>
    (a.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
      (b.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
    a.week - b.week ||
    a.id.localeCompare(b.id);
  if (activeSeason) {
    const live = matches
      .filter((match) => match.status === "LIVE")
      .sort(byKickoff);
    if (live[0]) return live[0];
    const next = matches
      .filter((match) => isRelevantOpenMatch(match, nowMs))
      .sort(byKickoff);
    if (next[0]) return next[0];
  }
  const completed = matches
    .filter((match) => match.status === "COMPLETED")
    .sort(
      (a, b) =>
        (b.scheduledAt?.getTime() ?? 0) - (a.scheduledAt?.getTime() ?? 0) ||
        b.week - a.week ||
        b.id.localeCompare(a.id),
    );
  if (!activeSeason) return completed[0] ?? null;
  return completed[0] ?? [...matches].sort(byKickoff)[0] ?? null;
}

export function profileMatchState(match: SlateMatch, nowMs: number) {
  if (match.status === "COMPLETED") return "Latest result";
  if (match.status === "LIVE") return "Live now";
  if (!isRelevantOpenMatch(match, nowMs)) return "Awaiting result";
  if (!match.scheduledAt) return "Time TBD";
  if (match.scheduledAt.getTime() <= nowMs) return "Awaiting result";
  return "Next series";
}
