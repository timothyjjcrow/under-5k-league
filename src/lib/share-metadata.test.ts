import { describe, expect, it } from "vitest";
import { playerProfileMetadata, shareMetadata } from "./share-metadata";

describe("shareMetadata", () => {
  it("mirrors title/description into both social objects and re-includes the images", () => {
    // Next.js REPLACES openGraph/twitter wholesale when a route redefines them
    // (no deep merge), so the whole point of this helper is that the image
    // arrays come back alongside the overridden text. Pin the exact shape.
    expect(shareMetadata("Team page", "The Radiant Rejects, week 4")).toEqual({
      title: "Team page",
      description: "The Radiant Rejects, week 4",
      openGraph: {
        title: "Team page",
        description: "The Radiant Rejects, week 4",
        siteName: "GGD2L",
        type: "website",
        images: ["/opengraph-image.png"],
      },
      twitter: {
        card: "summary_large_image",
        title: "Team page",
        description: "The Radiant Rejects, week 4",
        images: ["/twitter-image.png"],
      },
    });
  });

  it("passes text through verbatim — no escaping or truncation here", () => {
    const title = 'x — "the" 1-char <player>';
    const meta = shareMetadata(title, "");
    expect(meta.title).toBe(title);
    expect(meta.openGraph?.title).toBe(title);
    expect(meta.twitter?.title).toBe(title);
    expect(meta.description).toBe("");
  });

  it("leaves the images out for a page that draws its own picture", () => {
    // Next uses a folder's opengraph-image and twitter-image files only when
    // the page's metadata names no images (mergeStaticMetadata checks for an
    // `images` key at all), so the key must be absent, not empty.
    const meta = shareMetadata("Week 3 · A vs B", "Season 7", undefined, {
      pageImage: true,
    });
    expect(meta.openGraph).not.toHaveProperty("images");
    expect(meta.twitter).not.toHaveProperty("images");
    expect(meta.openGraph).toMatchObject({ title: "Week 3 · A vs B", siteName: "GGD2L" });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("adds a canonical and Open Graph URL when the route supplies a pathname", () => {
    const meta = shareMetadata(
      "Record book",
      "All-time league records",
      "/records",
    );
    expect(meta.alternates).toEqual({ canonical: "/records" });
    expect(meta.openGraph).toMatchObject({ url: "/records" });
  });
});

describe("playerProfileMetadata", () => {
  it("keeps profiles out of search results but lets links unfurl", () => {
    const meta = playerProfileMetadata("Player 3", ["Legend medal", "Bane player"]);
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.title).toBe("Player 3 · Player");
    expect(meta.description).toBe(
      "Player 3's player profile · Legend medal · Bane player — match history in GGD2L.",
    );
    expect(meta.openGraph).toMatchObject({ title: "Player 3 · Player" });
  });

  it("leaves the images to the profile's own picture files", () => {
    const meta = playerProfileMetadata("Player 3", []);
    expect(meta.openGraph).not.toHaveProperty("images");
    expect(meta.twitter).not.toHaveProperty("images");
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("leaves the highlights off when there are none", () => {
    expect(playerProfileMetadata("x", []).description).toBe(
      "x's player profile — match history in GGD2L.",
    );
  });
});
