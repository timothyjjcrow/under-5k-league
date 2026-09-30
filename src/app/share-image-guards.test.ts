import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  sourceFile,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

/**
 * Source contracts for the link preview pictures: the opengraph-image and
 * twitter-image routes beside the match, team, player and season pages. The
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
        /return (match|team|player|season)ShareImage\(\(await params\)\.id\);/,
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

  it("draw every picture through renderOgImage, which falls back to the league's", () => {
    const bodies = stripLineComments(
      sourceFile("src/components/og-share-images.tsx").text,
    );
    expect(bodies.match(/return renderOgImage\(</g)).toHaveLength(4);
    expect(bodies).not.toContain("new ImageResponse");
  });
});
