import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OVERLAY_DATA_HEADERS,
  OVERLAY_MATCH_ID,
  OVERLAY_MISSING_HEADERS,
  OVERLAY_PAGE_HEADERS,
  OVERLAY_REVISION,
  OVERLAY_WIDGETS,
  overlayPageHtml,
  overlayPath,
} from "./stream-overlay-page";

const ASSETS = { script: "console.log(1);", css: "body{margin:0}", fontBase64: "AAAA" };

function page(over: Partial<Parameters<typeof overlayPageHtml>[0]> = {}) {
  return overlayPageHtml({
    matchId: "cmatch123",
    leagueName: "GGD2L",
    emblem: "/brand/ggd2l-nav.png",
    blend: "normal",
    assets: ASSETS,
    ...over,
  });
}

describe("overlay addresses", () => {
  it("accepts Prisma's ids and nothing that leaves the path segment", () => {
    expect(OVERLAY_MATCH_ID.test("cmv53fmbx000v2s40cnlvrqqy")).toBe(true);
    for (const bad of ["", "../admin", "a/b", "a.b", "x".repeat(65), "a b", "a%2F"]) {
      expect(OVERLAY_MATCH_ID.test(bad)).toBe(false);
    }
  });

  it("accepts a version of cursor and bucket in base 36", () => {
    for (const good of ["0.2qkf3", "mgd8xz1a.2qkf3", "mgd8xz1a.f"]) {
      expect(OVERLAY_REVISION.test(good)).toBe(true);
    }
    for (const bad of ["", "abc", "a.b.c", "A.b", "a.", ".b", "a-b", "a".repeat(13) + ".b"]) {
      expect(OVERLAY_REVISION.test(bad)).toBe(false);
    }
  });

  it("builds each layout's path, with the preview flag on request", () => {
    expect(overlayPath("m1", "both")).toBe("/overlay/m1");
    expect(overlayPath("m1", "matchup")).toBe("/overlay/m1?widget=matchup");
    expect(overlayPath("m1", "players", { preview: true })).toBe(
      "/overlay/m1?widget=players&preview=1",
    );
    expect(overlayPath("m1", "both", { preview: true })).toBe("/overlay/m1?preview=1");
  });
});

describe("the sizes the match page gives each layout", () => {
  const css = readFileSync(
    new URL("../app/overlay/overlay.css", import.meta.url),
    "utf8",
  );
  /** The width and height (in rem, ten pixels each) a root rule scales from. */
  function designSize(selector: string): { width: number; height: number } {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} in overlay.css`).toBeGreaterThanOrEqual(0);
    const rule = css.slice(at, css.indexOf("}", at));
    const match = /min\(calc\(100vw \/ (\d+)\), calc\(100vh \/ (\d+)\)\)/.exec(rule);
    expect(match, `${selector}'s font-size`).not.toBeNull();
    return { width: Number(match![1]) * 10, height: Number(match![2]) * 10 };
  }

  it.each(OVERLAY_WIDGETS.map((w) => [w.widget, w] as const))(
    "%s is drawn at exactly the size the link says",
    (widget, { width, height }) => {
      const selector = widget === "both" ? ":root" : `:root.ov-widget-${widget}`;
      expect(designSize(selector)).toEqual({ width, height });
    },
  );
});

describe("overlayPageHtml", () => {
  it("is a whole page of its own: no site layout, the code inline", () => {
    const html = page();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<main id="overlay"></main>');
    expect(html).toContain(`<script type="module">${ASSETS.script}</script>`);
    expect(html).toContain(ASSETS.css);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain("<title>GGD2L stream overlay</title>");
  });

  it("embeds the display face, and leaves it out when the file is missing", () => {
    expect(page()).toContain("src:url(data:font/woff2;base64,AAAA)");
    expect(page({ assets: { ...ASSETS, fontBase64: null } })).not.toContain("@font-face");
  });

  it("hands the code its config as JSON a closing tag can't break out of", () => {
    const html = page({ matchId: "</script><script>alert(1)</script>" });
    const config = /<script type="application\/json" id="overlay-config">(.*?)<\/script>/.exec(html);
    expect(config).not.toBeNull();
    expect(config![1]).not.toContain("<");
    expect(JSON.parse(config![1])).toEqual({
      matchId: "</script><script>alert(1)</script>",
      emblem: "/brand/ggd2l-nav.png",
      blend: "normal",
    });
  });

  it("escapes the league's name in the title", () => {
    expect(page({ leagueName: "A&B <League>" })).toContain(
      "<title>A&amp;B &lt;League&gt; stream overlay</title>",
    );
  });

  it("refuses code or CSS that would close its own element", () => {
    expect(() => page({ assets: { ...ASSETS, script: "x='</script>'" } })).toThrow();
    expect(() => page({ assets: { ...ASSETS, css: "a{}</style>" } })).toThrow();
  });
});

describe("cache headers", () => {
  it("lets Vercel's CDN keep the page and each data version, never a browser's stale page", () => {
    expect(OVERLAY_PAGE_HEADERS).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      "vercel-cdn-cache-control": "public, max-age=86400",
    });
    expect(OVERLAY_DATA_HEADERS["vercel-cdn-cache-control"]).toBe("public, max-age=86400");
    expect(OVERLAY_MISSING_HEADERS["vercel-cdn-cache-control"]).toBe("public, max-age=300");
  });
});
