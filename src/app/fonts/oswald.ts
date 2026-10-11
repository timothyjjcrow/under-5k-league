import localFont from "next/font/local";

// Oswald, the display face for headings and stat numbers, self-hosted so no
// build or dev server asks Google for it. next/font/google downloaded it while
// compiling, and Turbopack fails to resolve a font file when Google answers
// with query-string font URLs ("next/font/google queries have exactly one
// entry"): CI's Playwright server then never started.
//
// The files are what fonts.googleapis.com serves for
// `Oswald:wght@500;600;700&display=swap` (Oswald v57): one variable woff2 per
// subset, used for all three weights, each with Google's unicode-range. Every
// subset is its own family so a browser still downloads one only for text
// that needs it (a Polish or Cyrillic name pulls latin-ext or cyrillic).
// `--font-oswald` in globals.css chains the five. The files carry Oswald's
// copyright and licence URL; the licence text is src/lib/og-fonts/OFL.txt
// (a second copy reads as a copied file to the release classifier, which
// then demands a maintenance release).
//
// Latin goes LAST in that chain and alone carries the preload and the
// metric-matched fallback (Arial resized to Oswald's metrics, measured from
// the latin file's a-z). The fallback covers every script, so a family listed
// after it would never be reached. The order changes no glyph: the combining
// marks latin shares with latin-ext and vietnamese are the same outlines in
// each file, and latin has no U+2020, which latin-ext draws either way.
//
// next/font needs literal options, so the weights and paths repeat.

export const oswaldLatinExt = localFont({
  src: [
    { path: "./oswald/latin-ext.woff2", weight: "500", style: "normal" },
    { path: "./oswald/latin-ext.woff2", weight: "600", style: "normal" },
    { path: "./oswald/latin-ext.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  preload: false,
  adjustFontFallback: false,
  variable: "--font-oswald-latin-ext",
});

export const oswaldVietnamese = localFont({
  src: [
    { path: "./oswald/vietnamese.woff2", weight: "500", style: "normal" },
    { path: "./oswald/vietnamese.woff2", weight: "600", style: "normal" },
    { path: "./oswald/vietnamese.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB",
    },
  ],
  preload: false,
  adjustFontFallback: false,
  variable: "--font-oswald-vietnamese",
});

export const oswaldCyrillic = localFont({
  src: [
    { path: "./oswald/cyrillic.woff2", weight: "500", style: "normal" },
    { path: "./oswald/cyrillic.woff2", weight: "600", style: "normal" },
    { path: "./oswald/cyrillic.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  declarations: [
    {
      prop: "unicode-range",
      value: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
    },
  ],
  preload: false,
  adjustFontFallback: false,
  variable: "--font-oswald-cyrillic",
});

export const oswaldCyrillicExt = localFont({
  src: [
    { path: "./oswald/cyrillic-ext.woff2", weight: "500", style: "normal" },
    { path: "./oswald/cyrillic-ext.woff2", weight: "600", style: "normal" },
    { path: "./oswald/cyrillic-ext.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F",
    },
  ],
  preload: false,
  adjustFontFallback: false,
  variable: "--font-oswald-cyrillic-ext",
});

export const oswaldLatin = localFont({
  src: [
    { path: "./oswald/latin.woff2", weight: "500", style: "normal" },
    { path: "./oswald/latin.woff2", weight: "600", style: "normal" },
    { path: "./oswald/latin.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-oswald-latin",
});

/** The classes that define each subset's variable, for `<html>`. */
export const oswaldVariables = [
  oswaldLatinExt,
  oswaldVietnamese,
  oswaldCyrillic,
  oswaldCyrillicExt,
  oswaldLatin,
]
  .map((font) => font.variable)
  .join(" ");
