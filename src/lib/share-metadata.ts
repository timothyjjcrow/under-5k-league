import type { Metadata } from "next";

/**
 * Per-page share metadata. Next.js *replaces* (does not deep-merge) the
 * `openGraph`/`twitter` objects when a route redefines them, so overriding the
 * title/description would otherwise drop the site's share image + card. This
 * re-includes them (from the app/opengraph-image.png + app/twitter-image.png
 * file conventions) so social previews keep the image while showing the
 * entity-specific title/description.
 */
export function shareMetadata(
  title: string,
  description: string,
  pathname?: string,
): Metadata {
  return {
    title,
    description,
    ...(pathname ? { alternates: { canonical: pathname } } : {}),
    openGraph: {
      title,
      description,
      siteName: "GGD2L",
      type: "website",
      images: ["/opengraph-image.png"],
      ...(pathname ? { url: pathname } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/twitter-image.png"],
    },
  };
}
