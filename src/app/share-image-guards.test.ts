import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  sourceFile,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

/**
 * Source contracts for the link preview pictures: the opengraph-image and
 * twitter-image routes beside the match, team, player and season pages, and
 * /inhouse's (the inhouse night). The
 * e2e suite checks that the pages point at them; these pin what no request
 * shows: that every picture is drawn per request, and that the server only
 * ever fetches a crest or avatar through the allowlisted fetchOgImage.
 */
const ROUTES = sourceFiles("src/app/**/{opengraph,twitter}-image.tsx", 8);

describe("link preview picture routes", () => {
  it("come in pairs, so Discord and X show the same picture", () => {
    const folders = (name: string) =>
      ROUTES.filter((f) => path.posix.basename(f.path) === name)
        .map((f) => path.posix.dirname(f.path))
        .sort();
    expect(folders("opengraph-image.tsx")).toEqual(folders("twitter-image.tsx"));
    expect(folders("opengraph-image.tsx")).toEqual([
      "src/app/inhouse",
      "src/app/matches/[id]",
      "src/app/players/[id]",
      "src/app/seasons/[id]",
      "src/app/teams/[id]",
    ]);
  });

  it("render per request at the shared size, through the shared bodies", () => {
    for (const route of ROUTES) {
      const text = stripLineComments(route.text);
      // Without force-dynamic Next may render a picture once and keep it:
      // a match's would show its kickoff after the final.
      expect(text, route.path).toContain('export const dynamic = "force-dynamic";');
      expect(text, route.path).toContain("export const size = OG_SIZE;");
      expect(text, route.path).toContain('export const contentType = "image/png";');
      expect(text, route.path).toMatch(/export const alt = "[^"]+";/);
      expect(text, route.path).toMatch(
        /return (?:(match|team|player|season)ShareImage\(\(await params\)\.id\)|inhouseShareImage\(\));/,
      );
      expect(text, route.path).not.toMatch(/ImageResponse|prisma\.|fetch\(/);
    }
  });
});

describe("link preview picture reads", () => {
  it("fetch crests and avatars only through fetchOgImage's allowlist", () => {
    for (const file of [
      "src/lib/link-preview-images.ts",
      "src/components/og-share-images.tsx",
      "src/components/og-card.tsx",
    ]) {
      expect(stripLineComments(sourceFile(file).text), file).not.toMatch(
        /\bfetch\(/,
      );
    }
    const assets = stripLineComments(sourceFile("src/lib/og-assets.ts").text);
    expect(assets.match(/\bfetch\(/g)).toHaveLength(1);
    const fetchOgImage = assets.slice(
      assets.indexOf("export async function fetchOgImage("),
      assets.indexOf("export async function renderOgImage("),
    );
    expect(fetchOgImage).toMatch(/if \(!ogImageUrlAllowed\(url\)\) return null;\s*try \{\s*const res = await fetch\(/);
    expect(fetchOgImage).toContain('redirect: "error"');
    expect(fetchOgImage).toContain("signal: AbortSignal.timeout(");
  });

  it("read the bundled fonts, emblems and medals from files that exist", () => {
    // A wrong path fails quietly: the picture falls back to next/og's own
    // font or leaves the emblem or medal out. So every literal path is
    // checked here.
    const assets = stripLineComments(sourceFile("src/lib/og-assets.ts").text);
    const files = [
      ...assets.matchAll(/join\(process\.cwd\(\),((?:\s*"[^"]+",?)+)\s*\)/g),
    ].map((call) => [...call[1].matchAll(/"([^"]+)"/g)].map((s) => s[1]));
    const fonts = files.filter((f) => f.at(-1)!.endsWith(".ttf"));
    expect(fonts).toHaveLength(2);
    // Two league emblems, then the player card's medals: eight medallions
    // (Herald to Immortal) and five star rings, the files RankMedal draws.
    const pngs = files.filter((f) => f.at(-1)!.endsWith(".png"));
    expect(pngs).toHaveLength(15);
    expect(
      pngs.filter((f) => f.join("/").startsWith("public/ranks/")).map((f) => f.at(-1)),
    ).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `rank_icon_${n}.png`),
      ...[1, 2, 3, 4, 5].map((n) => `rank_star_${n}.png`),
    ]);
    for (const file of files) {
      expect(existsSync(path.join(REPO_ROOT, ...file)), file.join("/")).toBe(true);
    }
    for (const font of fonts) {
      // TrueType's magic number, and the licence travels with the fonts.
      const bytes = readFileSync(path.join(REPO_ROOT, ...font));
      expect([...bytes.subarray(0, 4)], font.join("/")).toEqual([0, 1, 0, 0]);
      expect(
        existsSync(path.join(REPO_ROOT, ...font.slice(0, -1), "OFL.txt")),
      ).toBe(true);
    }
  });

  it("write no emoji, which the renderer would fetch from the internet", () => {
    // next/og draws a glyph its bundled fonts lack by downloading one at
    // render time (Twemoji for an emoji), so a picture's own words stay in
    // Oswald: no emoji and no "×". The player's picture borrows words from
    // the season card's rules, so those files count too.
    const files = [
      "src/components/og-card.tsx",
      "src/components/og-share-images.tsx",
      "src/lib/og-image.ts",
      "src/lib/link-preview-images.ts",
      "src/lib/player-card.ts",
    ];
    for (const file of files) {
      const text = sourceFile(file).text;
      expect(text, file).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text, file).not.toContain("×");
    }
  });

  it("draw every picture through renderOgImage, which falls back to the league's", () => {
    const bodies = stripLineComments(
      sourceFile("src/components/og-share-images.tsx").text,
    );
    // One draw per exported picture body, whatever their number.
    const pictures = bodies.match(/export function \w+ShareImage\(/g) ?? [];
    expect(pictures.length).toBeGreaterThanOrEqual(5);
    expect(bodies.match(/return renderOgImage\(</g)).toHaveLength(pictures.length);
    expect(bodies).not.toContain("new ImageResponse");
  });
});

describe("link preview picture layout", () => {
  it("breaks a long name with no spaces inside its column", () => {
    // Without word-break a name with no spaces ("ImmovableObjectGaming", a
    // 60-character team name, a long Steam name) only wrapped at spaces and
    // ran off the 1200x630 card or over the other team's name.
    const card = sourceFile("src/components/og-card.tsx").text;
    const clamp = card.slice(card.indexOf("function clampStyle"));
    expect(clamp.slice(0, clamp.indexOf("\n}\n"))).toContain('wordBreak: "break-word"');
    expect(card).toContain("<OgChip gold maxWidth={760}>{`Champion: ${champion.name}`}</OgChip>");
  });
});
