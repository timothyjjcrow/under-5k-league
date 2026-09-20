import type { MatchLike } from "./standings";

export type SingleEliminationSide = { teamId: string | null; feeder: string | null };
export type SingleEliminationGame = {
  key: string;
  bracket: number;
  stage: number;
  index: number;
  home: SingleEliminationSide;
  away: SingleEliminationSide;
  winner: string | null;
  loser: string | null;
};

/** One immutable draw, at most eight entrants per tree, and no consolation games. */
export function singleEliminationPlan(draw: string[], places: number, key: string, matches: MatchLike[] = []) {
  const qualifying = places < draw.length;
  // One tree per available place where possible. Very large groups use more
  // trees; the disclosed draw then separates winners for the remaining spots.
  const count = Math.max(qualifying ? places : 1, Math.ceil(draw.length / 8));
  const brackets: { teamIds: string[]; byes: string[]; games: SingleEliminationGame[]; winner: string | null }[] = [];
  const fixtures = new Map(matches.map((m) => [m.bracketSlot, m]));
  const finishes = new Map<string, number>();
  const games: SingleEliminationGame[] = [];
  let cursor = 0;
  for (let b = 0; b < count; b++) {
    // Smaller trees come first: any bye advantage follows the published draw.
    const size = Math.floor(draw.length / count) + (b >= count - draw.length % count ? 1 : 0);
    const ids = draw.slice(cursor, cursor + size);
    cursor += size;
    const levels = Math.ceil(Math.log2(size));
    const width = 2 ** levels;
    const byes = ids.slice(0, width - size);
    let sides: SingleEliminationSide[] = [];
    let entrant = byes.length;
    for (const id of byes) sides.push({ teamId: id, feeder: null }, { teamId: null, feeder: null });
    while (entrant < ids.length) sides.push({ teamId: ids[entrant++], feeder: null });
    if (size === 1) sides = [{ teamId: ids[0], feeder: null }];
    const bracketGames: SingleEliminationGame[] = [];
    for (let stage = 1; stage <= levels; stage++) {
      const next: SingleEliminationSide[] = [];
      for (let i = 0; i < sides.length; i += 2) {
        const home = sides[i], away = sides[i + 1];
        if (!away.teamId && !away.feeder) { next.push(home); continue; }
        const slot = `${key}:${b}:${stage}:${i / 2}`;
        const actual = fixtures.get(slot);
        const complete = actual?.status === "COMPLETED";
        const winner = complete ? actual.winnerTeamId : null;
        const loser = complete ? actual.homeTeamId === winner ? actual.awayTeamId : actual.homeTeamId : null;
        const game = { key: slot, bracket: b, stage, index: i / 2, home, away, winner, loser };
        bracketGames.push(game);
        games.push(game);
        if (loser) finishes.set(loser, levels - stage + 1);
        next.push({ teamId: winner, feeder: slot });
      }
      sides = next;
    }
    const winner = sides[0]?.teamId ?? null;
    if (winner) finishes.set(winner, 0);
    brackets.push({ teamIds: ids, byes: size === 1 ? ids : byes, games: bracketGames, winner });
  }
  const resolved = games.every((game) => game.winner != null);
  const drawRank = new Map(draw.map((id, index) => [id, index]));
  const order = [...draw].sort((a, b) =>
    (finishes.get(a) ?? -1) - (finishes.get(b) ?? -1) || drawRank.get(a)! - drawRank.get(b)!,
  );
  return { brackets, games, resolved, order, places, draw };
}
