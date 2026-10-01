import { describe, expect, it } from "vitest";
import {
  jsxElements,
  propValue,
  type JsxElementInfo,
} from "../../test/support/jsx-elements";
import { sourceFile, sourceFiles } from "../../test/support/source-files";
import { contrastRatio, hexRgb, hslRgb, type Rgb } from "./contrast";
import { teamHueVar } from "./team-hues";
import { TEAM_TINT_ALPHA, teamStripe, teamTint } from "./team-tint";

/**
 * A team's wash must never cost the text on it its contrast. Computed from the
 * real tokens in globals.css, the real Badge tones in ui.tsx, the season
 * card's grade colours and the colour teamTint actually returns, for every
 * hue a team can get, over every background a wash is allowed to sit on. The
 * yellows are the hard case: a light hue lifts the background towards the
 * light text.
 */

const css = sourceFile("src/app/globals.css").text;
const ui = sourceFile("src/components/ui.tsx").text;
const seasonCard = sourceFile("src/components/player-season-card.tsx").text;

const TOKENS = new Map(
  [...css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(
    (m) => [m[1], hexRgb(m[2])] as const,
  ),
);
function token(name: string): Rgb {
  const value = TOKENS.get(name);
  if (!value) throw new Error(`globals.css has no --color-${name}`);
  return value;
}

function over(top: Rgb, base: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => top[i] * alpha + base[i] * (1 - alpha)) as [
    number,
    number,
    number,
  ];
}

/** The backgrounds a wash may sit on (the host test below enforces it). */
const HERO_BANNER =
  "bg-gradient-to-br from-surface-2/70 via-surface/50 to-surface/30";
const BASES: Record<string, Rgb> = {
  "the page background": token("bg"),
  "a card surface": token("surface"),
  // The team and profile headers' gradient, at its lightest corner.
  "a hero banner": over(token("surface-2"), token("bg"), 0.7),
};

/** The wash's colour and strength, read back from what teamTint returns. */
function washOf(style: string) {
  const m =
    /hsl\(var\(--team-hue, \d+\) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)% \/ (\d*\.?\d+)\)/.exec(
      style,
    );
  if (!m) throw new Error(`not a team wash: ${style}`);
  return {
    saturation: Number(m[1]),
    lightness: Number(m[2]),
    alpha: Number(m[3]),
  };
}

/** `{ tone: { bg, alpha, text } }` from ui.tsx's badgeTones. */
function badgeTones() {
  const block = ui.slice(ui.indexOf("const badgeTones"));
  const body = block.slice(block.indexOf("{") + 1, block.indexOf("\n}"));
  return [...body.matchAll(/^\s*([a-z]+):\s*"([^"]+)"/gm)].map((m) => {
    const bg = /(?:^|\s)bg-([a-z0-9-]+?)(?:\/(\d+))?(?=\s|$)/.exec(m[2])!;
    const text = /(?:^|\s)text-([a-z0-9-]+?)(?=\s|$)/.exec(m[2])!;
    return {
      tone: m[1],
      bg: token(bg[1]),
      alpha: bg[2] ? Number(bg[2]) / 100 : 1,
      text: token(text[1]),
    };
  });
}

/** `{ tone, text, alpha }` from player-season-card.tsx's GRADE_TEXT. */
function gradeColours() {
  const block = seasonCard.slice(seasonCard.indexOf("const GRADE_TEXT"));
  const body = block.slice(block.indexOf("{") + 1, block.indexOf("}"));
  return [
    ...body.matchAll(/^\s*([a-z]+):\s*"text-([a-z0-9-]+?)(?:\/(\d+))?"/gm),
  ].map((m) => ({
    tone: m[1],
    text: token(m[2]),
    alpha: m[3] ? Number(m[3]) / 100 : 1,
  }));
}

describe("a team's wash", () => {
  const flat = washOf(String(teamTint("cmteam").style.backgroundColor));
  const tones = badgeTones();
  const grades = gradeColours();

  it("is the strength the module says, wherever it fades", () => {
    expect(flat.alpha).toBe(TEAM_TINT_ALPHA);
    for (const fade of ["to right", "to left"] as const) {
      const image = String(teamTint("cmteam", fade).style.backgroundImage);
      expect(image).toContain(`linear-gradient(${fade}, `);
      const stops = [
        ...image.matchAll(/hsl\(var\(--team-hue, \d+\) [^)]*\)/g),
      ].map((m) => m[0]);
      expect(stops.length).toBe(2);
      // No stop is stronger than the flat wash the sweep below checks.
      for (const stop of stops) {
        expect(washOf(stop).alpha).toBeLessThanOrEqual(flat.alpha);
      }
    }
  });

  it("finds the Badge tones and grade colours it checks", () => {
    expect(tones.map((t) => t.tone).sort()).toEqual(
      ["accent", "brand", "danger", "info", "neutral", "success"].sort(),
    );
    expect(grades.map((g) => g.tone).sort()).toEqual(
      ["accent", "default", "muted", "success"].sort(),
    );
  });

  it("keeps text, links and every Badge at 4.5:1 on every hue", () => {
    const failures: string[] = [];
    for (const [where, base] of Object.entries(BASES)) {
      for (let hue = 0; hue < 360; hue++) {
        const fill = over(
          hslRgb(hue, flat.saturation, flat.lightness),
          base,
          flat.alpha,
        );
        const check = (label: string, text: Rgb, under: Rgb) => {
          const ratio = contrastRatio(text, under);
          if (ratio < 4.5) {
            failures.push(`${label} on ${where}, hue ${hue}: ${ratio.toFixed(2)}:1`);
          }
        };
        check("text", token("fg"), fill);
        check("muted text", token("muted"), fill);
        check("a link", token("info"), fill);
        // The season card's grade letters, checked on the bare wash although
        // they sit on a darker box inside it.
        for (const g of grades) {
          check(`a ${g.tone} grade`, over(g.text, fill, g.alpha), fill);
        }
        for (const t of tones) {
          check(`the ${t.tone} Badge`, t.text, over(t.bg, fill, t.alpha));
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("would fail on a lighter surface, which is why hosts are checked", () => {
    // surface-2 leaves the success and danger Badges almost no headroom.
    const fill = over(
      hslRgb(60, flat.saturation, flat.lightness),
      token("surface-2"),
      flat.alpha,
    );
    const success = tones.find((t) => t.tone === "success")!;
    expect(
      contrastRatio(success.text, over(success.bg, fill, success.alpha)),
    ).toBeLessThan(4.5);
  });
});

describe("teamTint and teamStripe", () => {
  it("name the team on the element they paint, with its hue", () => {
    for (const props of [
      teamTint("cmteam1"),
      teamTint("cmteam1", "to left"),
      teamStripe("cmteam1"),
    ]) {
      expect(props["data-team-hue"]).toBe("cmteam1");
      expect(JSON.stringify(props.style)).toContain(teamHueVar("cmteam1"));
    }
  });

  it("draw the stripe inside the border, without moving the content", () => {
    expect(teamStripe("cmteam1").style).toEqual({
      boxShadow: `inset 3px 0 0 hsl(${teamHueVar("cmteam1")} 62% 46%)`,
    });
  });
});

describe("every wash on the site", () => {
  const files = sourceFiles(["src/**/*.tsx"], 150);
  const washes: JsxElementInfo[] = files.flatMap((file) =>
    jsxElements(file).filter((el) =>
      el.spreads.some((s) => /\bteamTint\(/.test(s)),
    ),
  );

  it("finds the washes it polices", () => {
    expect(washes.length).toBeGreaterThanOrEqual(3);
  });

  it("is an empty, decorative layer", () => {
    // Empty: the hue it sets on itself can't reach a nested crest of another
    // team. Decorative: hidden from screen readers and from the pointer.
    for (const el of washes) {
      expect(el.selfClosing, el.at).toBe(true);
      expect(el.attributes.has("aria-hidden"), el.at).toBe(true);
      expect(propValue(el.attributes.get("className")), el.at).toMatch(
        /\bpointer-events-none\b[\s\S]*\babsolute\b|\babsolute\b[\s\S]*\bpointer-events-none\b/,
      );
    }
  });

  it("sits on a background the contrast sweep covers", () => {
    // A Card with no background override (bg-surface), an opaque bg-surface
    // box, or a hero banner. Anything lighter needs its own sweep first.
    const hostOf = (el: JsxElementInfo) => {
      const host = el.parent;
      if (!host) return null;
      const classes = propValue(host.attributes.get("className")) ?? "";
      if (host.tag === "Card" && !/\bbg-/.test(classes)) return "a card surface";
      if (/(?:^|[\s"'`])bg-surface(?=[\s"'`]|$)/.test(classes)) {
        return "a card surface";
      }
      if (classes.includes(HERO_BANNER)) return "a hero banner";
      return null;
    };
    for (const el of washes) {
      expect(hostOf(el), `${el.at}: wash on an unchecked background`).not.toBe(
        null,
      );
    }
  });
});
