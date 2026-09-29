import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLeagueConfig } from "./league-config";

// The logo masters are 0.3-2.2MB, and Europe's was once served as the header
// logo, the tab icon, the app icons and a square link preview all at once, so
// a phone's first visit was mostly logo. These checks keep every file a page
// loads right-sized, in both regions.

const PUBLIC = join(process.cwd(), "public");
const HEADER_HEIGHT = 76; // the header's h-[76px] emblem

function file(url: string): string {
  return join(PUBLIC, url.replace(/^\//, ""));
}

/** A PNG's width and height, read from its IHDR chunk. */
function pngSize(url: string): { width: number; height: number } {
  const bytes = readFileSync(file(url));
  expect(bytes.subarray(1, 4).toString("ascii"), url).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function sizesOf(sizes: string): { width: number; height: number } {
  const [width, height] = sizes.split("x").map(Number);
  return { width, height };
}

describe.each(["us", "eu"] as const)("%s brand assets", (region) => {
  const { branding } = createLeagueConfig({ NEXT_PUBLIC_LEAGUE_REGION: region });

  it("points every branding field at a file that exists", () => {
    const urls = [
      branding.logo,
      branding.navLogo,
      branding.appleIcon,
      branding.openGraphImage,
      branding.twitterImage,
      ...branding.icons.map((icon) => icon.url),
      ...branding.appIcons.map((icon) => icon.src),
    ];
    for (const url of urls) expect(existsSync(file(url)), url).toBe(true);
  });

  it("serves a small header and footer emblem that stays sharp on phones", () => {
    expect(branding.navLogo).not.toBe(branding.logo);
    expect(statSync(file(branding.navLogo)).size).toBeLessThan(100_000);
    const size = pngSize(branding.navLogo);
    expect(size).toEqual({ width: branding.navWidth, height: branding.navHeight });
    expect(size.height).toBeGreaterThanOrEqual(2 * HEADER_HEIGHT);
  });

  it("uses tab and home-screen icons of the size they declare", () => {
    for (const icon of branding.icons) {
      expect(statSync(file(icon.url)).size, icon.url).toBeLessThan(10_000);
      if ("sizes" in icon) {
        expect(pngSize(icon.url), icon.url).toEqual(sizesOf(icon.sizes));
      }
    }
    expect(pngSize(branding.appleIcon)).toEqual({ width: 180, height: 180 });
    for (const icon of branding.appIcons) {
      if (icon.type === "image/png") {
        expect(pngSize(icon.src), icon.src).toEqual(sizesOf(icon.sizes));
      }
    }
    expect(branding.appIcons.map((icon) => icon.sizes)).toEqual(
      expect.arrayContaining(["192x192", "512x512"]),
    );
  });

  it("shares wide 1200x630 link previews, so Discord doesn't crop them", () => {
    expect(pngSize(branding.openGraphImage)).toEqual({ width: 1200, height: 630 });
    expect(pngSize(branding.twitterImage)).toEqual({ width: 1200, height: 630 });
  });
});
