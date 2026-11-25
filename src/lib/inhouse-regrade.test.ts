import { describe, expect, it } from "vitest";
import game from "../../test/fixtures/opendota-inhouse-game.json";
import type { OpenDotaMatch, OpenDotaPlayer } from "./dota";
import { inhouseBoxStats, type InhouseBoxPlayer } from "./inhouse-box";
import {
  INHOUSE_REGRADE_CHECK_MINUTES,
  inhouseRegradeDueAtMs,
  inhouseRegradeKey,
  inhouseRegradeValue,
  inhouseRegradeWakeAtMs,
  needsInhouseRegrade,
  parseInhouseRegrade,
  withParsedStats,
  type InhouseRegradeMarker,
} from "./inhouse-regrade";
import { gradeGame } from "./player-grades";

const MIN = 60_000;
const parsedMatch = game as unknown as OpenDotaMatch;

/** The fixture as OpenDota sends it before the parse: no replay stats. */
const PARSED_ONLY = [
  "damage_taken",
  "stuns",
  "obs_placed",
  "sen_placed",
  "observer_kills",
  "sentry_kills",
  "camps_stacked",
  "towers_killed",
  "roshans_killed",
  "lane_efficiency_pct",
  "life_state_dead",
  "firstblood_claimed",
  "multi_kills",
] as const;
const summaryMatch: OpenDotaMatch = {
  ...parsedMatch,
  version: null,
  players: parsedMatch.players.map((p) => {
    const out: Record<string, unknown> = { ...p };
    for (const key of PARSED_ONLY) delete out[key];
    return out as OpenDotaPlayer;
  }),
};

function lines(od: OpenDotaMatch): InhouseBoxPlayer[] {
  return od.players.map((p, i) => ({
    userId: `u${i}`,
    name: `P${i}`,
    team: p.isRadiant ? 1 : 2,
    isRadiant: !!p.isRadiant,
    heroId: p.hero_id,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    netWorth: p.net_worth ?? null,
    gpm: p.gold_per_min ?? null,
    lastHits: p.last_hits ?? null,
    ...inhouseBoxStats(p),
  }));
}

function graded(box: InhouseBoxPlayer[]): InhouseBoxPlayer[] {
  const grades = gradeGame(box, {
    radiantWin: parsedMatch.radiant_win,
    durationSecs: parsedMatch.duration,
    mmrByUser: new Map(),
    baseline: [],
  });
  return box.map((l, i) => ({ ...l, grade: grades[i] }));
}

describe("the re-grade marker", () => {
  const marker: InhouseRegradeMarker = {
    lobbyId: "lobby-1",
    dotaMatchId: "8123456789",
    resultAtMs: 1_790_000_000_000,
    tries: 2,
    messageId: null,
  };

  it("round-trips through its Setting row and refuses anything else", () => {
    const key = inhouseRegradeKey(marker.lobbyId);
    expect(parseInhouseRegrade(key, inhouseRegradeValue(marker))).toEqual(marker);
    // With the Discord post's id once the outbox has sent it.
    const posted = { ...marker, messageId: "1311111111111111111" };
    expect(inhouseRegradeValue(posted)).toBe(
      "8123456789:1790000000000:2:1311111111111111111",
    );
    expect(parseInhouseRegrade(key, inhouseRegradeValue(posted))).toEqual(posted);
    expect(parseInhouseRegrade(key, "8123456789:1790000000000:2:")).toBeNull();
    expect(parseInhouseRegrade(key, "8123456789:x:2")).toBeNull();
    expect(parseInhouseRegrade(key, "")).toBeNull();
    expect(parseInhouseRegrade("inhouse-regrade:", inhouseRegradeValue(marker))).toBeNull();
    expect(parseInhouseRegrade("other:lobby-1", inhouseRegradeValue(marker))).toBeNull();
  });

  it("checks on the schedule after the result, then stops", () => {
    INHOUSE_REGRADE_CHECK_MINUTES.forEach((minutes, tries) => {
      expect(inhouseRegradeDueAtMs({ ...marker, tries })).toBe(
        marker.resultAtMs + minutes * MIN,
      );
    });
    expect(
      inhouseRegradeDueAtMs({ ...marker, tries: INHOUSE_REGRADE_CHECK_MINUTES.length }),
    ).toBeNull();
    // The first check comes soon, and the last within a day.
    expect(INHOUSE_REGRADE_CHECK_MINUTES[0]).toBe(10);
    expect(INHOUSE_REGRADE_CHECK_MINUTES.at(-1)).toBe(24 * 60);
  });

  it("wakes the worker at the earliest check, or at once for a row nothing can run", () => {
    const now = marker.resultAtMs + 5 * MIN;
    const row = (lobbyId: string, tries: number) => ({
      key: inhouseRegradeKey(lobbyId),
      value: inhouseRegradeValue({ ...marker, lobbyId, tries }),
    });
    expect(inhouseRegradeWakeAtMs([], now)).toBeNull();
    expect(inhouseRegradeWakeAtMs([row("a", 3), row("b", 1)], now)).toBe(
      marker.resultAtMs + 30 * MIN,
    );
    expect(
      inhouseRegradeWakeAtMs([row("a", 3), { key: inhouseRegradeKey("c"), value: "?" }], now),
    ).toBe(now);
    expect(
      inhouseRegradeWakeAtMs([row("a", INHOUSE_REGRADE_CHECK_MINUTES.length)], now),
    ).toBe(now);
  });
});

describe("needsInhouseRegrade", () => {
  it("is true only for a game graded before its replay was parsed", () => {
    expect(needsInhouseRegrade(graded(lines(summaryMatch)))).toBe(true);
    expect(needsInhouseRegrade(graded(lines(parsedMatch)))).toBe(false);
    // Ungraded (a game from before grades, or a grading failure).
    expect(needsInhouseRegrade(lines(summaryMatch))).toBe(false);
  });
});

describe("withParsedStats", () => {
  const box = graded(lines(summaryMatch));

  it("is null while the replay is unparsed", () => {
    expect(withParsedStats(box, summaryMatch)).toBeNull();
  });

  it("adds the replay's stats to the stored lines and drops their grades", () => {
    const merged = withParsedStats(box, parsedMatch)!;
    expect(merged).toHaveLength(box.length);
    merged.forEach((line, i) => {
      // The stored result stands: who, which side, which hero, K/D/A.
      expect(line).toMatchObject({
        userId: box[i].userId,
        name: box[i].name,
        team: box[i].team,
        heroId: box[i].heroId,
        kills: box[i].kills,
        deaths: box[i].deaths,
      });
      expect(line.grade).toBeUndefined();
      expect(typeof line.damageTaken).toBe("number");
    });
    // Graded again, nothing is missing any more.
    expect(needsInhouseRegrade(graded(merged))).toBe(false);
  });

  it("matches each line by side and hero, whatever order OpenDota sends", () => {
    const reversed = { ...parsedMatch, players: [...parsedMatch.players].reverse() };
    expect(withParsedStats(box, reversed)).toEqual(withParsedStats(box, parsedMatch));
  });

  it("is null when a line has no single player to match", () => {
    const swapped = {
      ...parsedMatch,
      players: parsedMatch.players.map((p, i) =>
        i === 0 ? { ...p, hero_id: 9999 } : p,
      ),
    };
    expect(withParsedStats(box, swapped)).toBeNull();
    expect(withParsedStats(box.slice(1), parsedMatch)).toBeNull();
  });
});
