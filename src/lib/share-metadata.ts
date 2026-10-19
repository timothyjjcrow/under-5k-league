import { LEAGUE_CONFIG } from "./league-config";
import type { Metadata } from "next";

/**
 * Per-page share metadata. Next.js *replaces* (does not deep-merge) the
 * `openGraph`/`twitter` objects when a route redefines them, so overriding the
 * title/description would otherwise drop the site's share image + card. This
 * re-includes the deployment's regional brand images so previews keep the image while showing the
 * entity-specific title/description.
 *
 * `pageImage` is for a page whose folder draws its own picture (an
 * opengraph-image and a twitter-image file: the match, team, player and
 * season pages). It leaves the images out, because Next uses a folder's image
 * files only where the page's metadata names no images itself.
 *
 * `image` names a picture drawn somewhere else (the queue invite's
 * `/inhouse/queue` pictures, which `/inhouse?join=1` shows in place of
 * /inhouse's own): its opengraph and twitter addresses and their alt text.
 */
export function shareMetadata(
  title: string,
  description: string,
  pathname?: string,
  options: {
    pageImage?: boolean;
    image?: { openGraph: string; twitter: string; alt: string };
  } = {},
): Metadata {
  const { image } = options;
  return {
    title,
    description,
    ...(pathname ? { alternates: { canonical: pathname } } : {}),
    openGraph: {
      title,
      description,
      siteName: LEAGUE_CONFIG.name,
      type: "website",
      ...(image
        ? {
            images: [
              { url: image.openGraph, width: 1200, height: 630, alt: image.alt },
            ],
          }
        : options.pageImage
          ? {}
          : { images: [LEAGUE_CONFIG.branding.openGraphImage] }),
      ...(pathname ? { url: pathname } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      ...(image
        ? { images: [{ url: image.twitter, alt: image.alt }] }
        : options.pageImage
          ? {}
          : { images: [LEAGUE_CONFIG.branding.twitterImage] }),
    },
  };
}

/**
 * A player profile's share metadata. Profiles stay out of search results: a
 * search for someone's Steam name shouldn't bring up the MMR they typed,
 * their goals and their note for captains. Links still unfurl in Discord, and
 * crawlers still follow the profile's links. Don't also block /players/ in
 * robots.txt: a crawler that can't fetch the page never sees the noindex.
 */
export function playerProfileMetadata(
  name: string,
  highlights: readonly string[],
): Metadata {
  return {
    ...shareMetadata(
      `${name} · Player`,
      `${name}'s player profile${highlights.length > 0 ? ` · ${highlights.join(" · ")}` : ""} — match history in ${LEAGUE_CONFIG.name}.`,
      undefined,
      // The profile's own picture (players/[id]/opengraph-image).
      { pageImage: true },
    ),
    robots: { index: false, follow: true },
  };
}
