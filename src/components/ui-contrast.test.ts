import { describe, expect, it } from "vitest";
import { sourceFile } from "../../test/support/source-files";

/**
 * Text contrast of the shared Badge tones and solid Button variants, computed
 * from the real tokens in globals.css and the real class strings in ui.tsx.
 *
 * Badges put 12px text on a 15% tint of their own colour, and the red and
 * blue tones failed WCAG AA there (brand 3.1:1, danger 3.6:1, info 4.4:1 on
 * surface-2) for a long time without anyone noticing, because each colour
 * looks fine on its own. A solid danger button put white on #e5534b at 3.7:1.
 * This recomputes the ratios whenever a token or a tone changes.
 */

const css = sourceFile("src/app/globals.css").text;
const ui = sourceFile("src/components/ui.tsx").text;

const TOKENS = new Map(
  [...css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(
    (m) => [m[1], m[2]] as const,
  ),
);
const NAMED: Record<string, string> = { white: "#ffffff", black: "#000000" };

function hex(name: string): [number, number, number] {
  const value = NAMED[name] ?? TOKENS.get(name);
  if (!value) throw new Error(`unknown colour ${name}`);
  return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(rgb: [number, number, number]) {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: [number, number, number], b: [number, number, number]) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function over(
  fg: [number, number, number],
  bg: [number, number, number],
  alpha: number,
): [number, number, number] {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as [
    number,
    number,
    number,
  ];
}

/** `{ key: "class string" }` entries of a `const NAME = { … }` block. */
function classMap(name: string) {
  const start = ui.indexOf(`const ${name}`);
  if (start < 0) throw new Error(`ui.tsx has no ${name}`);
  const block = ui.slice(start);
  // The object literal runs to the first line that starts with "}".
  const body = block.slice(block.indexOf("{") + 1, block.indexOf("\n}"));
  return new Map(
    [...body.matchAll(/^\s*([a-z]+):\s*"([^"]+)"/gm)].map(
      (m) => [m[1], m[2]] as const,
    ),
  );
}

/** The colour a `bg-*` / `text-*` utility names, with its alpha if any. */
function colourOf(classes: string, prefix: "bg" | "text") {
  const m = new RegExp(`(?:^|\\s)${prefix}-([a-z0-9-]+?)(?:/(\\d+))?(?=\\s|$)`).exec(
    classes,
  );
  if (!m) return null;
  return { name: m[1], alpha: m[2] ? Number(m[2]) / 100 : 1 };
}

const CARD_SURFACES = ["bg", "surface", "surface-2"] as const;

describe("Badge tones", () => {
  const tones = classMap("badgeTones");

  it("finds every tone it guards", () => {
    expect([...tones.keys()].sort()).toEqual(
      ["accent", "brand", "danger", "info", "neutral", "success"].sort(),
    );
  });

  for (const [tone, classes] of tones) {
    it(`${tone} text clears 4.5:1 on its tint over every card surface`, () => {
      const bg = colourOf(classes, "bg")!;
      const text = colourOf(classes, "text")!;
      for (const surface of CARD_SURFACES) {
        const fill = over(hex(bg.name), hex(surface), bg.alpha);
        const contrast = ratio(hex(text.name), fill);
        expect(
          contrast,
          `${tone} badge on ${surface}: ${contrast.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("solid Button variants", () => {
  const variants = classMap("variantClasses");

  it("finds the solid variants it guards", () => {
    for (const v of ["primary", "danger", "accent", "secondary"])
      expect(variants.has(v), v).toBe(true);
  });

  for (const v of ["primary", "danger", "accent", "secondary"]) {
    it(`${v} text clears 4.5:1 on its own background`, () => {
      const classes = variants.get(v)!;
      const bg = colourOf(classes, "bg")!;
      const text = colourOf(classes, "text")!;
      expect(bg.alpha).toBe(1);
      const contrast = ratio(hex(text.name), hex(bg.name));
      expect(contrast, `${v}: ${contrast.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        4.5,
      );
    });
  }

  it("keeps the danger button distinct from the primary one", () => {
    expect(colourOf(variants.get("danger")!, "bg")!.name).not.toBe(
      colourOf(variants.get("primary")!, "bg")!.name,
    );
  });
});

describe("danger text on raised controls", () => {
  it("danger-soft clears 4.5:1 on surface-2, where ghost buttons hover", () => {
    expect(ratio(hex("danger-soft"), hex("surface-2"))).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});

describe("Card header rules", () => {
  const tones = classMap("cardTones");
  // CardHeader's own `border-b border-<token>`, and the override a tone may
  // put on its first child (the header, when the card has one).
  const headerRule = /border-b border-([a-z0-9-]+)/.exec(
    ui.slice(ui.indexOf("export function CardHeader")),
  )![1];
  const ruleOn = (classes: string) =>
    /\[&>:first-child\]:border-([a-z0-9-]+)/.exec(classes)?.[1] ?? headerRule;

  it("finds every tone it guards", () => {
    expect([...tones.keys()].sort()).toEqual(["default", "feature", "quiet"]);
  });

  // The default card's rule is 1.28:1 on its surface: a hairline, but a
  // visible one. On the feature tone the same token measured 1.01:1.
  for (const [tone, classes] of tones) {
    it(`${tone} keeps the header rule visible on its background`, () => {
      const bg = colourOf(classes, "bg")!;
      const fill = over(hex(bg.name), hex("bg"), bg.alpha);
      const contrast = ratio(hex(ruleOn(classes)), fill);
      expect(contrast, `${tone}: ${contrast.toFixed(2)}:1`).toBeGreaterThanOrEqual(1.2);
    });
  }
});
