import { describe, expect, it } from "vitest";
import {
  hashHue,
  seasonTeamHues,
  teamHueStyleSheet,
  teamHueVar,
  type HueTeam,
} from "./team-hues";

const team = (id: string, createdAtMs: number, seasonId = "s1"): HueTeam => ({
  id,
  seasonId,
  createdAtMs,
});

/** Shortest distance between two hues on the colour wheel. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

describe("seasonTeamHues", () => {
  it("spaces a season's teams evenly round the wheel in creation order", () => {
    const teams = [
      team("t3", 3000),
      team("t1", 1000),
      team("t4", 4000),
      team("t2", 2000),
    ];
    const hues = seasonTeamHues(teams);
    const start = hashHue("s1");
    expect(hues.get("t1")).toBe(start % 360);
    expect(hues.get("t2")).toBe((start + 90) % 360);
    expect(hues.get("t3")).toBe((start + 180) % 360);
    expect(hues.get("t4")).toBe((start + 270) % 360);
  });

  it("keeps every pair of teams at least 360/n degrees apart", () => {
    // The old per-id hash put these ids within a few degrees of each other
    // often enough to matter; spacing is now by construction.
    const ids = ["cmaa", "cmab", "cmac", "cmad", "cmae", "cmaf", "cmag"];
    const hues = seasonTeamHues(ids.map((id, i) => team(id, i)));
    const values = [...hues.values()];
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        expect(hueGap(values[i], values[j])).toBeGreaterThanOrEqual(
          Math.floor(360 / ids.length),
        );
      }
    }
  });

  it("breaks a creation-time tie by id so the result is deterministic", () => {
    const a = seasonTeamHues([team("b", 5), team("a", 5)]);
    const b = seasonTeamHues([team("a", 5), team("b", 5)]);
    expect(a).toEqual(b);
    expect(a.get("a")).toBe(hashHue("s1"));
  });

  it("spaces each season on its own", () => {
    const hues = seasonTeamHues([
      team("a1", 1, "season-a"),
      team("b1", 1, "season-b"),
      team("a2", 2, "season-a"),
    ]);
    expect(hues.get("a1")).toBe(hashHue("season-a"));
    expect(hues.get("a2")).toBe((hashHue("season-a") + 180) % 360);
    // A season with one team simply starts (and ends) on its own hue.
    expect(hues.get("b1")).toBe(hashHue("season-b"));
  });

  it("returns whole-degree hues in range", () => {
    const hues = seasonTeamHues(
      Array.from({ length: 7 }, (_, i) => team(`t${i}`, i)),
    );
    for (const hue of hues.values()) {
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("is empty for no teams", () => {
    expect(seasonTeamHues([]).size).toBe(0);
  });
});

describe("teamHueStyleSheet", () => {
  it("writes one custom-property rule per team", () => {
    const css = teamHueStyleSheet(
      new Map([
        ["cmteam1", 12],
        ["cm_team-2", 300],
      ]),
    );
    expect(css).toBe(
      '[data-team-hue="cmteam1"]{--team-hue:12}' +
        '[data-team-hue="cm_team-2"]{--team-hue:300}',
    );
  });

  it("leaves out anything that isn't a plain id and a whole hue", () => {
    const css = teamHueStyleSheet(
      new Map([
        ['x"]{}body{display:none}[a="', 10],
        ["</style><script>", 20],
        ["ok", 1.5],
        ["fine", 40],
      ]),
    );
    expect(css).toBe('[data-team-hue="fine"]{--team-hue:40}');
  });
});

describe("teamHueVar", () => {
  it("reads the published hue and falls back to the hash hue", () => {
    expect(teamHueVar("cmteam1")).toBe(
      `var(--team-hue, ${hashHue("cmteam1")})`,
    );
  });
});
