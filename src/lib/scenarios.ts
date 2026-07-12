// Exact playoff-scenario engine: "what do we need tonight?" Pure + testable.
// Refines the conservative clinchStatuses bounds (standings.ts) by enumerating
// every remaining-match outcome when the tree is small enough. Mirrors
// standings scoring exactly (3 pts series win, 1 draw, 0 loss) and its
// tiebreaker-agnostic philosophy: a team is only "in" if it's in even when
// every tie counts against it, and only "out" if it's out even when every tie
// counts for it. EVERY match enumerates a draw branch regardless of bestOf
// parity — recordResult accepts drawn/abandoned scores (1-1 Bo3, 0-0 Bo1) for
// regular matches, so "exact" must cover them or a CLINCHED team could still
// miss the cut. Never contradicts a non-null clinchStatuses result —
// enumeration can only turn null into certainty.

import {
  clinchStatuses,
  type ClinchStatus,
  type TeamStanding,
} from "./standings";

/** A REGULAR-phase match that hasn't been COMPLETED yet. */
export type ScenarioMatch = {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  /** Kept for context/labels; any series can end drawn (partial/forfeit). */
  bestOf: number;
};

export type TeamScenario = {
  teamId: string;
  /**
   * clinchStatuses refined by enumeration when `exact` — CLINCHED/ELIMINATED
   * only when proven over every possible remaining outcome (ties counted
   * against/for them respectively).
   */
  status: ClinchStatus;
  /**
   * Winning their NEXT remaining match (first in `remaining` input order —
   * pass matches in schedule order) guarantees a playoff spot even if every
   * other result goes against them. Deliberately false when already CLINCHED
   * or with no remaining match: `status` carries the locked story, this flag
   * is reserved for teams whose night actually decides something.
   */
  winAndIn: boolean;
  /**
   * Losing their next remaining match guarantees missing the cut even if
   * everything else breaks their way. False when already ELIMINATED or with
   * no remaining match (same reasoning as winAndIn).
   */
  loseAndOut: boolean;
  /**
   * Fewest additional series WINS that guarantee a spot regardless of all
   * other results (0 = clinched on banked points); null if even winning out
   * can't guarantee it. Always the conservative points bound, even when
   * `exact`: it never deducts opponents' maxPts for head-to-head games, so
   * enumeration may prove CLINCHED while this stays > 0 or null. Kept crude
   * on purpose — a magic number that quietly assumed specific other results
   * would stop meaning "regardless of everything else".
   */
  magicNumber: number | null;
  /**
   * Fewest additional series LOSSES after which missing is guaranteed
   * regardless of other results; null if even losing out can't doom them.
   * Also a pure bound: losses aren't credited to the opponents who inflict
   * them, so this can be null while loseAndOut (which does credit the focal
   * opponent) is true.
   */
  eliminationLosses: number | null;
  /** Best achievable final regular-season rank (1-based, optimistic ties). A bound unless `exact`. */
  bestRank: number;
  /** Worst possible final rank (pessimistic ties). A bound unless `exact`. */
  worstRank: number;
  /** True when full enumeration ran (leaf count within the cap). */
  exact: boolean;
  /** Leaves where the team is DEFINITELY in (ties-against); null unless `exact`. */
  madeCount: number | null;
  /** Total enumerated leaves; null unless `exact`. */
  leafCount: number | null;
  /**
   * The match winAndIn/loseAndOut are about — the team's next remaining one.
   * Null when they have nothing left to play. Surfaces MUST check this before
   * pinning a "win and in" line on a specific match page.
   */
  nextMatchId: string | null;
};

export type ScenarioReport = {
  cut: number;
  exact: boolean;
  teams: Map<string, TeamScenario>;
};

const DEFAULT_CAP = 200000;

/**
 * Full scenario report for a league: layer 1 computes cheap points bounds for
 * every team (always); layer 2 enumerates every remaining outcome combination
 * (home win / away win / draw) when the leaf count fits in `opts.cap`
 * (default 200k) and refines status, win-and-in, lose-and-out, and the rank
 * range. Per-leaf work is O(teams²) — league sizes are tiny.
 */
export function scenarioReport(
  standings: TeamStanding[],
  remaining: ScenarioMatch[],
  cut: number,
  opts?: { cap?: number },
): ScenarioReport {
  const cap = opts?.cap ?? DEFAULT_CAP;
  const n = standings.length;
  const index = new Map(standings.map((s, i) => [s.teamId, i]));
  // A match referencing a team outside `standings` can't be scored — drop it.
  const matches = remaining.filter(
    (m) => index.has(m.homeTeamId) && index.has(m.awayTeamId),
  );

  const banked = standings.map((s) => s.points);
  const remCount = new Array<number>(n).fill(0);
  const nextMatch = new Array<number | null>(n).fill(null);
  const mHome: number[] = [];
  const mAway: number[] = [];
  matches.forEach((m, i) => {
    const h = index.get(m.homeTeamId)!;
    const a = index.get(m.awayTeamId)!;
    mHome.push(h);
    mAway.push(a);
    remCount[h]++;
    remCount[a]++;
    if (nextMatch[h] === null) nextMatch[h] = i;
    if (nextMatch[a] === null) nextMatch[a] = i;
  });
  const maxPts = banked.map((p, i) => p + 3 * remCount[i]);

  // ---- Layer 1: pure points bounds, no enumeration ----
  const bounds = standings.map((_, t) => {
    // magicNumber: k wins put them at banked+3k; guaranteed in when at most
    // cut−1 others could still reach that (at their unadjusted maxPts —
    // conservative, no head-to-head deduction). k=0 matches clinchStatuses'
    // CLINCHED test exactly.
    let magicNumber: number | null = null;
    for (let k = 0; k <= remCount[t]; k++) {
      let couldCatch = 0;
      for (let o = 0; o < n; o++) {
        if (o !== t && maxPts[o] >= banked[t] + 3 * k) couldCatch++;
      }
      if (couldCatch <= cut - 1) {
        magicNumber = k;
        break;
      }
    }

    // eliminationLosses: L losses cap them at maxPts−3L even winning the
    // rest; doomed when `cut` others are past that on banked points alone.
    // L=0 matches clinchStatuses' ELIMINATED test exactly.
    let eliminationLosses: number | null = null;
    for (let L = 0; L <= remCount[t]; L++) {
      let certainlyAhead = 0;
      for (let o = 0; o < n; o++) {
        if (o !== t && banked[o] > maxPts[t] - 3 * L) certainlyAhead++;
      }
      if (certainlyAhead >= cut) {
        eliminationLosses = L;
        break;
      }
    }

    // winAndIn / loseAndOut against the next remaining match: the one place
    // layer 1 uses head-to-head — the focal opponent can no longer win (or
    // lose) that series, so their max (or banked floor) shifts by 3.
    let winAndIn = false;
    let loseAndOut = false;
    const mi = nextMatch[t];
    if (mi !== null) {
      const opp = mHome[mi] === t ? mAway[mi] : mHome[mi];
      let couldCatch = 0;
      let certainlyAhead = 0;
      for (let o = 0; o < n; o++) {
        if (o === t) continue;
        const oMax = o === opp ? maxPts[o] - 3 : maxPts[o];
        if (oMax >= banked[t] + 3) couldCatch++;
        const oMin = o === opp ? banked[o] + 3 : banked[o];
        if (oMin > maxPts[t] - 3) certainlyAhead++;
      }
      winAndIn = couldCatch <= cut - 1;
      loseAndOut = certainlyAhead >= cut;
    }

    let bestRank = 1;
    let worstRank = 1;
    for (let o = 0; o < n; o++) {
      if (o === t) continue;
      if (banked[o] > maxPts[t]) bestRank++;
      if (maxPts[o] >= banked[t]) worstRank++;
    }

    return {
      magicNumber,
      eliminationLosses,
      winAndIn,
      loseAndOut,
      bestRank,
      worstRank,
    };
  });

  // ---- Layer 2: exact enumeration when the outcome tree is small enough ----
  // Three outcomes per match — home win / away win / draw. The draw branch is
  // unconditional: recordResult lets a regular series of ANY length complete
  // drawn (1-1 Bo3 forfeit, 0-0 abandonment), and "exact" claims must survive
  // every recordable result.
  let leafBudget = 1;
  let withinCap = true;
  for (let i = 0; i < matches.length; i++) {
    leafBudget *= 3;
    if (leafBudget > cap) {
      withinCap = false;
      break;
    }
  }

  const teams = new Map<string, TeamScenario>();

  if (withinCap) {
    const delta = new Array<number>(n).fill(0);
    const leafPts = new Array<number>(n).fill(0);
    const outcome = new Array<number>(matches.length).fill(-1);
    const allIn = new Array<boolean>(n).fill(true);
    const allOut = new Array<boolean>(n).fill(true);
    const made = new Array<number>(n).fill(0);
    const winOk = new Array<boolean>(n).fill(true);
    const loseOk = new Array<boolean>(n).fill(true);
    const bestRank = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
    const worstRank = new Array<number>(n).fill(0);
    let leaves = 0;

    const visitLeaf = () => {
      leaves++;
      for (let i = 0; i < n; i++) leafPts[i] = banked[i] + delta[i];
      for (let t = 0; t < n; t++) {
        let ge = 0;
        let gt = 0;
        for (let o = 0; o < n; o++) {
          if (o === t) continue;
          if (leafPts[o] > leafPts[t]) {
            gt++;
            ge++;
          } else if (leafPts[o] === leafPts[t]) {
            ge++;
          }
        }
        const inLeaf = ge <= cut - 1; // in even with ties against
        const outLeaf = gt >= cut; // out even with ties for
        if (inLeaf) made[t]++;
        else allIn[t] = false;
        if (!outLeaf) allOut[t] = false;
        if (1 + gt < bestRank[t]) bestRank[t] = 1 + gt;
        if (1 + ge > worstRank[t]) worstRank[t] = 1 + ge;
        const mi = nextMatch[t];
        if (mi !== null) {
          // A drawn focal series is neither a win nor a loss — unconstrained.
          const won = outcome[mi] === (mHome[mi] === t ? 0 : 1);
          const lost = outcome[mi] === (mHome[mi] === t ? 1 : 0);
          if (won && !inLeaf) winOk[t] = false;
          if (lost && !outLeaf) loseOk[t] = false;
        }
      }
    };

    const dfs = (i: number): void => {
      if (i === matches.length) {
        visitLeaf();
        return;
      }
      const h = mHome[i];
      const a = mAway[i];
      outcome[i] = 0; // home win
      delta[h] += 3;
      dfs(i + 1);
      delta[h] -= 3;
      outcome[i] = 1; // away win
      delta[a] += 3;
      dfs(i + 1);
      delta[a] -= 3;
      outcome[i] = 2; // draw — recordable for any series length
      delta[h] += 1;
      delta[a] += 1;
      dfs(i + 1);
      delta[h] -= 1;
      delta[a] -= 1;
      outcome[i] = -1;
    };
    dfs(0);

    standings.forEach((s, t) => {
      const status: ClinchStatus = allIn[t]
        ? "CLINCHED"
        : allOut[t]
          ? "ELIMINATED"
          : null;
      teams.set(s.teamId, {
        teamId: s.teamId,
        status,
        winAndIn:
          nextMatch[t] !== null && winOk[t] && status !== "CLINCHED",
        loseAndOut:
          nextMatch[t] !== null && loseOk[t] && status !== "ELIMINATED",
        magicNumber: bounds[t].magicNumber,
        eliminationLosses: bounds[t].eliminationLosses,
        bestRank: bestRank[t],
        worstRank: worstRank[t],
        exact: true,
        madeCount: made[t],
        leafCount: leaves,
        nextMatchId: nextMatch[t] !== null ? matches[nextMatch[t]!].id : null,
      });
    });
    return { cut, exact: true, teams };
  }

  // Over the cap: status falls back to the same conservative bounds
  // clinchStatuses computes, fed shim MatchLikes for the remaining schedule.
  const fallback = clinchStatuses(
    standings,
    matches.map((m) => ({
      homeTeamId: m.homeTeamId,
      awayTeamId: m.awayTeamId,
      status: "SCHEDULED",
      homeScore: 0,
      awayScore: 0,
      winnerTeamId: null,
      phase: "REGULAR",
    })),
    cut,
  );
  standings.forEach((s, t) => {
    const status = fallback.get(s.teamId) ?? null;
    teams.set(s.teamId, {
      teamId: s.teamId,
      status,
      winAndIn: bounds[t].winAndIn && status !== "CLINCHED",
      loseAndOut: bounds[t].loseAndOut && status !== "ELIMINATED",
      magicNumber: bounds[t].magicNumber,
      eliminationLosses: bounds[t].eliminationLosses,
      bestRank: bounds[t].bestRank,
      worstRank: bounds[t].worstRank,
      exact: false,
      madeCount: null,
      leafCount: null,
      nextMatchId: nextMatch[t] !== null ? matches[nextMatch[t]!].id : null,
    });
  });
  return { cut, exact: false, teams };
}

const LABEL_LOCKED = "Playoff spot locked — playing for seeding";
const LABEL_OUT = "Out of the race — playing for pride";
const LABEL_ALL_ON_LINE = "Everything on the line: win and in, lose and out";
const LABEL_WIN_IN = "Win and they're in";
const LABEL_LOSE_OUT = "Lose and they're out";
const LABEL_ONE_MORE = "One more win locks a playoff spot";
const LABEL_HUNT = "In the hunt for a playoff spot";

function labelFor(s: TeamScenario, isNextMatch: boolean): string {
  if (s.status === "CLINCHED") return LABEL_LOCKED;
  if (s.status === "ELIMINATED") return LABEL_OUT;
  // winAndIn/loseAndOut are guarantees about the team's NEXT match only —
  // pinning them on any other match page would promise the wrong game.
  if (isNextMatch) {
    if (s.winAndIn && s.loseAndOut) return LABEL_ALL_ON_LINE;
    if (s.winAndIn) return LABEL_WIN_IN;
    if (s.loseAndOut) return LABEL_LOSE_OUT;
  }
  if (s.magicNumber === 1) return LABEL_ONE_MORE;
  return LABEL_HUNT;
}

/**
 * What this specific match means for each side, one line per team (first
 * matching rule wins: locked, out, everything-on-the-line, win-and-in,
 * lose-and-out, one-more-win, in-the-hunt). The win-and-in family only ever
 * describes a team's next remaining match, so it's suppressed when `matchId`
 * isn't that match. Teams missing from the report are skipped.
 */
export function matchStakes(
  matchId: string,
  homeTeamId: string,
  awayTeamId: string,
  report: ScenarioReport,
): { teamId: string; label: string }[] {
  const stakes: { teamId: string; label: string }[] = [];
  for (const teamId of [homeTeamId, awayTeamId]) {
    const s = report.teams.get(teamId);
    if (s) stakes.push({ teamId, label: labelFor(s, s.nextMatchId === matchId) });
  }
  return stakes;
}

// Most dramatic first — everything-on-the-line beats win-and-in beats
// lose-and-out beats one-more-win. Locked/out/hunt lines never headline.
const DRAMATIC = [
  LABEL_ALL_ON_LINE,
  LABEL_WIN_IN,
  LABEL_LOSE_OUT,
  LABEL_ONE_MORE,
];

/**
 * The single most dramatic stake line, for a banner — or null when nothing
 * about the match is on a knife's edge (ties broken by input order).
 */
export function stakesHeadline(
  stakes: { teamId: string; label: string }[],
): string | null {
  let best: string | null = null;
  let bestDrama = DRAMATIC.length;
  for (const s of stakes) {
    const drama = DRAMATIC.indexOf(s.label);
    if (drama !== -1 && drama < bestDrama) {
      bestDrama = drama;
      best = s.label;
    }
  }
  return best;
}
