// The stream overlay's page and its two routes' shared rules: what a match id
// and a version look like, the cache headers, and the HTML document the
// overlay route sends. Pure and tested; the drawing is
// src/app/overlay/overlay-client.js and overlay.css.
//
// Both routes are built to cost the site next to nothing on Vercel's Hobby
// plan (docs/DECISIONS.md): Vercel's CDN keeps each answer, so the page is
// drawn once per deployment and each version of the data once, however many
// times OBS asks.

/** A match id the overlay accepts: Prisma's cuids, and nothing that could
 *  leave its path segment. */
export const OVERLAY_MATCH_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The data route's version: the result cursor, then the refresh bucket or
 *  "f" (overlayRevision in overlay-client.js), both base 36. */
export const OVERLAY_REVISION = /^[0-9a-z]{1,12}\.[0-9a-z]{1,12}$/;

/**
 * The overlay's three layouts, as the match page offers them, with the size
 * each is drawn at. overlay.css scales every layout from exactly these sizes
 * (stream-overlay-page.test.ts reads it), so a Browser source of this size
 * fits the layout with no margin to spare.
 */
export const OVERLAY_WIDGETS = [
  { widget: "matchup", label: "Matchup bar", width: 1620, height: 250 },
  { widget: "players", label: "Player cards", width: 1020, height: 400 },
  { widget: "both", label: "Both together", width: 1620, height: 650 },
] as const;

export type OverlayWidget = (typeof OVERLAY_WIDGETS)[number]["widget"];

/** A layout's path: `?preview=1` adds the checkerboard for a normal browser. */
export function overlayPath(
  matchId: string,
  widget: OverlayWidget,
  options: { preview?: boolean } = {},
): string {
  const params = new URLSearchParams();
  if (widget !== "both") params.set("widget", widget);
  if (options.preview) params.set("preview", "1");
  const query = params.toString();
  return `/overlay/${encodeURIComponent(matchId)}${query ? `?${query}` : ""}`;
}

/** A day: a new deployment starts the CDN afresh anyway. */
const CDN_KEEP_SECONDS = 86_400;

/**
 * The page: the same for every visitor and every refresh, so the CDN keeps it
 * for the day and browsers check back with it (a CDN answer, no function
 * call) before each reuse, which picks up a new deployment's page.
 */
export const OVERLAY_PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, max-age=0, must-revalidate",
  "vercel-cdn-cache-control": `public, max-age=${CDN_KEEP_SECONDS}`,
  "x-robots-tag": "noindex",
} as const;

/**
 * One version of a match's data. The version is in the address, so an answer
 * never goes stale: a result or a new refresh bucket asks for a new address.
 */
export const OVERLAY_DATA_HEADERS = {
  "cache-control": "public, max-age=600",
  "vercel-cdn-cache-control": `public, max-age=${CDN_KEEP_SECONDS}`,
} as const;

/** No such match (or a malformed address): kept briefly, so a wrong link
 *  left open in OBS costs a function call every few minutes at most. */
export const OVERLAY_MISSING_HEADERS = {
  "cache-control": "public, max-age=60",
  "vercel-cdn-cache-control": "public, max-age=300",
} as const;

export type OverlayPageAssets = {
  /** overlay-client.js, verbatim. */
  script: string;
  /** overlay.css, verbatim. */
  css: string;
  /** Oswald's latin file, base64; null draws the fallback fonts. */
  fontBase64: string | null;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSON that can sit inside a <script> element: no "</script>" can end it. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The overlay's whole page: no site header or footer, a transparent
 * background, the display face embedded (OBS loads it once with the page)
 * and the drawing code inline. The match id rides in a JSON block the code
 * reads, never in markup.
 */
export function overlayPageHtml(input: {
  matchId: string;
  leagueName: string;
  /** The league's emblem (LEAGUE_CONFIG.branding.navLogo). */
  emblem: string;
  /** How the emblem blends on dark: "normal", or "lighten" for Europe's. */
  blend: string;
  assets: OverlayPageAssets;
}): string {
  if (/<\/script/i.test(input.assets.script)) {
    throw new Error("overlay script can't contain a closing script tag");
  }
  if (/<\/style/i.test(input.assets.css)) {
    throw new Error("overlay CSS can't contain a closing style tag");
  }
  const title = escapeHtml(`${input.leagueName} stream overlay`);
  const font = input.assets.fontBase64
    ? `@font-face{font-family:"Oswald";font-style:normal;font-weight:500 700;font-display:block;src:url(data:font/woff2;base64,${input.assets.fontBase64}) format("woff2");}`
    : "";
  const config = scriptJson({
    matchId: input.matchId,
    emblem: input.emblem,
    blend: input.blend,
  });
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${title}</title>`,
    `<style>${font}${input.assets.css}</style>`,
    "</head>",
    "<body>",
    '<main id="overlay"></main>',
    '<p class="ov-preview-hint">Preview: in OBS the background is see-through.</p>',
    `<script type="application/json" id="overlay-config">${config}</script>`,
    `<script type="module">${input.assets.script}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
