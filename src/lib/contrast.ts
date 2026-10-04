// WCAG 2 contrast between sRGB colours. Pure and tested. A generated crest
// picks the ink of its initials with it (team-hues.ts), and the tint tests use
// it to prove a team's colour wash keeps the text on it readable.

/** Red, green and blue, each 0-255 (unrounded where a conversion made them). */
export type Rgb = readonly [number, number, number];

/** `#rrggbb` as channels. */
export function hexRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** CSS `hsl(hue saturation% lightness%)` as channels (the CSS Color 4 formula). */
export function hslRgb(hue: number, saturation: number, lightness: number): Rgb {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) =>
    255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
  return [channel(0), channel(8), channel(4)];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance([r, g, b]: Rgb): number {
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio, 1 to 21. Order doesn't matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
