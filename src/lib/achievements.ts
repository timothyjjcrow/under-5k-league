// Match MVPs and achievement badges — pure and unit-tested, computed from the
// per-player box scores the site already imports.

import { fantasyPoints, type FantasyStatLine } from "./fantasy";

export type MvpCandidate = FantasyStatLine & {
  userId?: string | null;
  isRadiant: boolean;
};

/**
 * The game's MVP: the mapped league player with the best fantasy line (the
 * win bonus means winners usually edge it, as an MVP should). Ties break by
 * kills, then fewer deaths, then userId for stability. Null when no line
 * belongs to a known player.
 */
export function gameMvp(
  players: MvpCandidate[],
  radiantWin: boolean,
): string | null {
  let best: { userId: string; pts: number; kills: number; deaths: number } | null =
    null;
  for (const p of players) {
    if (!p.userId) continue;
    const pts = fantasyPoints(p, p.isRadiant === radiantWin);
    if (
      !best ||
      pts > best.pts ||
      (pts === best.pts &&
        (p.kills > best.kills ||
          (p.kills === best.kills &&
            (p.deaths < best.deaths ||
              (p.deaths === best.deaths && p.userId < best.userId)))))
    ) {
      best = { userId: p.userId, pts, kills: p.kills, deaths: p.deaths };
    }
  }
  return best?.userId ?? null;
}

/** One of a player's game lines, annotated for achievement checks. */
export type AchievementLine = FantasyStatLine & {
  won: boolean;
  mvp: boolean;
};

export type Achievement = {
  key: string;
  emoji: string;
  label: string;
  desc: string;
  /** How many times it was earned (career milestones report 1). */
  count: number;
};

/** Badges earned across a player's game lines. Empty array = none yet. */
export function achievementsFor(lines: AchievementLine[]): Achievement[] {
  const per = (
    key: string,
    emoji: string,
    label: string,
    desc: string,
    test: (l: AchievementLine) => boolean,
  ): Achievement | null => {
    const count = lines.filter(test).length;
    return count > 0 ? { key, emoji, label, desc, count } : null;
  };

  const out: (Achievement | null)[] = [
    per("mvp", "🏅", "Match MVP", "Best line of a game", (l) => l.mvp),
    per(
      "deathless",
      "😇",
      "Deathless",
      "5+ kills without dying",
      (l) => l.deaths === 0 && l.kills >= 5,
    ),
    per(
      "spree",
      "🔪",
      "Killing spree",
      "15+ kills in a game",
      (l) => l.kills >= 15,
    ),
    per(
      "playmaker",
      "🤝",
      "Playmaker",
      "20+ assists in a game",
      (l) => l.assists >= 20,
    ),
    per(
      "tycoon",
      "💰",
      "Tycoon",
      "600+ GPM in a game",
      (l) => (l.gpm ?? 0) >= 600,
    ),
  ];

  const games = lines.length;
  const kills = lines.reduce((s, l) => s + l.kills, 0);
  if (games >= 10) {
    out.push({
      key: "veteran",
      emoji: "🎖️",
      label: "Veteran",
      desc: "10+ league games played",
      count: 1,
    });
  }
  if (kills >= 100) {
    out.push({
      key: "centurion",
      emoji: "⚔️",
      label: "Centurion",
      desc: "100+ career kills",
      count: 1,
    });
  }

  return out.filter((a): a is Achievement => a !== null);
}
