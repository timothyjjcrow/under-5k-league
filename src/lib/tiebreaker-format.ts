/** Browser-safe metadata helpers; no standings or server crypto dependency. */
export function parseTiebreakerStage(slot: string | null | undefined): {
  bracketKey: string;
  stage: number;
} | null {
  const parsed = slot?.match(/^(TBD:[a-f0-9]{64}:\d+:[a-f0-9]{64}):([1-5]):0$/);
  return parsed ? { bracketKey: parsed[1], stage: Number(parsed[2]) } : null;
}

type Fixture = { phase: string; week: number; bracketSlot?: string | null };

export function hasLaterTiebreakerStage(match: Fixture, matches: Fixture[]): boolean {
  const stage = parseTiebreakerStage(match.bracketSlot);
  return matches.some((other) => {
    if (other.phase !== "TIEBREAKER") return false;
    if (other.week > match.week) return true;
    const next = parseTiebreakerStage(other.bracketSlot);
    return !!stage && !!next && next.bracketKey === stage.bracketKey && next.stage > stage.stage;
  });
}
