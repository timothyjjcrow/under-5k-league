import { describe, expect, it } from "vitest";
import { sourceFile } from "../../test/support/source-files";
import { contrastRatio, hexRgb, hslRgb } from "./contrast";
import {
  crestInk,
  hashHue,
  seasonTeamHues,
  teamHueStyleSheet,
  teamHueVar,
  teamInkVar,
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
      '[data-team-hue="cmteam1"]{--team-hue:12;--team-ink:#ffffff}' +
        '[data-team-hue="cm_team-2"]{--team-hue:300;--team-ink:#ffffff}',
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
    expect(css).toBe('[data-team-hue="fine"]{--team-hue:40;--team-ink:#ffffff}');
  });
});

describe("teamHueVar", () => {
  it("reads the published hue and falls back to the hash hue", () => {
    expect(teamHueVar("cmteam1")).toBe(
      `var(--team-hue, ${hashHue("cmteam1")})`,
    );
  });
});

describe("crestInk", () => {
  const HUES = Array.from({ length: 360 }, (_, hue) => hue);
  // The crest runs from hsl(h 62% 46%) to hsl(h 62% 28%) corner to corner;
  // the initials cover roughly the middle half of that diagonal.
  const UNDER_THE_INITIALS = [33, 35, 37, 39, 41];
  const worstOn = (hue: number, ink: string) =>
    Math.min(
      ...UNDER_THE_INITIALS.map((l) =>
        contrastRatio(hexRgb(ink), hslRgb(hue, 62, l)),
      ),
    );

  it("keeps the initials at 3:1 or better on every hue", () => {
    // White alone fell to about 2.6:1 on the yellows.
    const failing = HUES.filter((hue) => worstOn(hue, crestInk(hue)) < 3).map(
      (hue) => `${hue}: ${worstOn(hue, crestInk(hue)).toFixed(2)}:1`,
    );
    expect(failing).toEqual([]);
    expect(worstOn(60, "#ffffff")).toBeLessThan(3);
  });

  it("only ever picks white or the page's own background", () => {
    const bg = /--color-bg:\s*(#[0-9a-f]{6})\s*;/i.exec(
      sourceFile("src/app/globals.css").text,
    )![1];
    expect(new Set(HUES.map(crestInk))).toEqual(new Set(["#ffffff", bg]));
  });

  it("keeps white for the blues, purples and reds it already read on", () => {
    for (const hue of [0, 20, 220, 240, 270, 300, 340]) {
      expect(crestInk(hue), String(hue)).toBe("#ffffff");
    }
    for (const hue of [50, 60, 90, 120, 160]) {
      expect(crestInk(hue), String(hue)).not.toBe("#ffffff");
    }
  });

  it("publishes each team's ink beside its hue, and falls back with the hue", () => {
    expect(teamHueStyleSheet(new Map([["cmyellow", 60]]))).toBe(
      `[data-team-hue="cmyellow"]{--team-hue:60;--team-ink:${crestInk(60)}}`,
    );
    expect(teamInkVar("cmteam1")).toBe(
      `var(--team-ink, ${crestInk(hashHue("cmteam1"))})`,
    );
  });
});
