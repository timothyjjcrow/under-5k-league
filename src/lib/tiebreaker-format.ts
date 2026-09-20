/** Browser-safe metadata helpers; no standings or server crypto dependency. */
export function parseSingleTiebreakerSlot(slot: string | null | undefined) {
  const parsed = slot?.match(/^(TBS:[a-f0-9]{64}:\d+:[a-f0-9]{64}):([0-9]+(?:\.[0-9]+)*):(\d+):([1-3]):(\d+)$/);
  if (!parsed) return null;
  const draw = parsed[2].split(".").map(Number);
  const bracket = Number(parsed[3]), stage = Number(parsed[4]), index = Number(parsed[5]);
  if (draw.length < 2 || new Set(draw).size !== draw.length ||
      draw.some((n) => !Number.isSafeInteger(n) || n < 0 || n >= draw.length) ||
      !Number.isSafeInteger(bracket) || bracket >= draw.length ||
      !Number.isSafeInteger(index) || index >= 2 ** (3 - stage)) return null;
  return {
    rootKey: parsed[1], tournamentKey: `${parsed[1]}:${parsed[2]}`,
    bracketKey: `${parsed[1]}:${parsed[2]}:${parsed[3]}`,
    draw, bracket, stage, index,
  };
}

export const TIEBREAKER_SUMMARY = "Best of 1 · One loss ends your run · Up to 3 games per team";
export const TIEBREAKER_RULES = "Normal standings rules come first. Remaining ties use single-elimination brackets of up to eight teams. Games run in parallel; the next game starts when both opponents are ready. The published draw assigns byes and settles equal finishes or places across brackets. No extra deciders.";

export function parseTiebreakerStage(slot: string | null | undefined): {
  bracketKey: string;
  stage: number;
} | null {
  const parsed = slot?.match(/^(TBD:[a-f0-9]{64}:\d+:[a-f0-9]{64}):([1-5]):0$/);
  return parsed ? { bracketKey: parsed[1], stage: Number(parsed[2]) } : null;
}

type Fixture = { phase: string; week: number; bracketSlot?: string | null };

export function hasLaterTiebreakerStage(match: Fixture, matches: Fixture[]): boolean {
  const single = parseSingleTiebreakerSlot(match.bracketSlot);
  if (single) return matches.some((other) => {
    const next = parseSingleTiebreakerSlot(other.bracketSlot);
    return other.phase === "TIEBREAKER" && !!next && next.bracketKey === single.bracketKey &&
      next.stage > single.stage &&
      Math.floor(single.index / 2 ** (next.stage - single.stage)) === next.index;
  });
  const stage = parseTiebreakerStage(match.bracketSlot);
  return matches.some((other) => {
    if (other.phase !== "TIEBREAKER") return false;
    if (other.week > match.week) return true;
    const next = parseTiebreakerStage(other.bracketSlot);
    return !!stage && !!next && next.bracketKey === stage.bracketKey && next.stage > stage.stage;
  });
}
