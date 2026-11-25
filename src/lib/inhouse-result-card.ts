// The room's result card: what a finished game shows its ten once the result
// lands (both sides, each player's Elo change, the MVP). Pure: built by
// buildInhouseState from the rows the room already reads for the banner
// window, rendered by the room.

import { heroById } from "./heroes";
import {
  inhouseGameMvp,
  inhouseGradeStatus,
  inhouseRoleAward,
  parseInhouseBox,
  type InhouseGradeStatus,
} from "./inhouse-box";
import { gradeView, type GradeView } from "./inhouse-grade-view";
import { GRADE_AWARDS, type GradeLetter } from "./player-grades";

export type ResultCardPlayer = {
  userId: string;
  name: string;
  isCaptain: boolean;
  /** Their Elo change as recorded with the result; null when it isn't known. */
  eloDelta: number | null;
};

export type ResultCardTeam = {
  isRadiant: boolean;
  won: boolean;
  players: ResultCardPlayer[];
};

/** The Elo changes stored with a result, or an empty map for unreadable JSON. */
function parseEloDeltas(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Both sides of a finished game, Radiant first, each with its captain first
 * and every player's Elo change as stored with the result. A change the row
 * doesn't carry (malformed JSON, a player added after the fact) is unknown
 * (null), never shown as zero.
 */
export function resultCardTeams(o: {
  players: readonly {
    userId: string;
    team: number | null;
    isCaptain: boolean;
    name: string;
  }[];
  radiantTeam: number;
  winnerTeam: number;
  eloDeltas: string;
}): [ResultCardTeam, ResultCardTeam] {
  const deltas = parseEloDeltas(o.eloDeltas);
  const side = (team: number): ResultCardTeam => ({
    isRadiant: team === o.radiantTeam,
    won: team === o.winnerTeam,
    players: o.players
      .filter((p) => p.team === team)
      // Captain first; the stored order otherwise.
      .sort((a, b) => Number(b.isCaptain) - Number(a.isCaptain))
      .map((p) => {
        const delta = deltas[p.userId];
        return {
          userId: p.userId,
          name: p.name,
          isCaptain: p.isCaptain,
          eloDelta:
            typeof delta === "number" && Number.isFinite(delta) ? delta : null,
        };
      }),
  });
  const radiant = o.radiantTeam === 2 ? 2 : 1;
  return [side(radiant), side(radiant === 1 ? 2 : 1)];
}

/**
 * The game's MVP from its stored box score (gameMvp, the rule the Discord
 * post and the queue board use): their name as the box score has it, and
 * their hero. Null with no box score, an unreadable one, or no line that
 * belongs to a known player: never a guess.
 */
export function resultCardMvp(o: {
  boxScore: string;
  radiantWin: boolean;
}): { userId: string; name: string; hero: string | null } | null {
  const box = parseInhouseBox(o.boxScore);
  if (box.length === 0) return null;
  const id = inhouseGameMvp(box, o.radiantWin);
  const line = id ? box.find((b) => b.userId === id) : null;
  if (!id || !line?.name) return null;
  return { userId: id, name: line.name, hero: heroById(line.heroId)?.name ?? null };
}

/**
 * How many of a finished game's ten are back in the queue: the card's "6 of
 * your ten are back in the queue", the nudge to run it back while everyone
 * is still here. Counts each player once.
 */
export function resultCardRequeued(
  teams: readonly Pick<ResultCardTeam, "players">[],
  queuedUserIds: readonly string[],
): { back: number; total: number } {
  const roster = new Set(teams.flatMap((t) => t.players.map((p) => p.userId)));
  const queued = new Set(queuedUserIds);
  let back = 0;
  for (const id of roster) if (queued.has(id)) back += 1;
  return { back, total: roster.size };
}

export type ResultCardGrades = {
  /** Every graded player's letter and score, by user id. */
  byUser: Record<string, { letter: GradeLetter; score: number }>;
  /** The viewer's own grade and how it was made; null when they have none. */
  mine: (GradeView & { heroName: string | null }) | null;
  /** The game's Top core or Top support. */
  roleAward: { label: string; userId: string; name: string } | null;
  /** Early (waiting on the replay), graded again with it, or final. */
  status: InhouseGradeStatus;
};

/**
 * The grades a finished game shows its ten in the room: everyone's letter,
 * the viewer's full grade, and the role award. Null for a game from before
 * grades (or one whose grading failed): the card then shows what it always
 * did.
 */
export function resultCardGrades(o: {
  boxScore: string;
  viewerId: string;
  durationSecs: number | null;
}): ResultCardGrades | null {
  const box = parseInhouseBox(o.boxScore);
  const status = inhouseGradeStatus(box);
  if (!status) return null;
  const byUser: ResultCardGrades["byUser"] = {};
  for (const line of box) {
    if (line.userId && line.grade) {
      byUser[line.userId] = { letter: line.grade.letter, score: line.grade.score };
    }
  }
  const mineLine = box.find((line) => line.userId === o.viewerId) ?? null;
  const heroName = mineLine ? (heroById(mineLine.heroId)?.name ?? null) : null;
  const view = mineLine
    ? gradeView(mineLine, box, { durationSecs: o.durationSecs, heroName })
    : null;
  const role = inhouseRoleAward(box);
  return {
    byUser,
    mine: view ? { ...view, heroName } : null,
    roleAward:
      role?.line.userId && role.line.name
        ? {
            label: GRADE_AWARDS[role.award].label,
            userId: role.line.userId,
            name: role.line.name,
          }
        : null,
    status,
  };
}
