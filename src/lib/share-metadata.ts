import { LEAGUE_CONFIG } from "./league-config";
import type { Metadata } from "next";

/**
 * Per-page share metadata. Next.js *replaces* (does not deep-merge) the
 * `openGraph`/`twitter` objects when a route redefines them, so overriding the
 * title/description would otherwise drop the site's share image + card. This
 * re-includes the deployment's regional brand images so previews keep the image while showing the
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
      siteName: LEAGUE_CONFIG.name,
      type: "website",
      images: [LEAGUE_CONFIG.branding.openGraphImage],
      ...(pathname ? { url: pathname } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [LEAGUE_CONFIG.branding.twitterImage],
    },
  };
}
