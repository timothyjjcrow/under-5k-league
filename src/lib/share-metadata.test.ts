import { describe, expect, it } from "vitest";
import { shareMetadata } from "./share-metadata";

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
});
