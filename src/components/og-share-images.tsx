// The link preview pictures' route bodies: each opengraph-image and
// twitter-image file beside the match, team, player and season pages, and
// /inhouse's, is one line calling these. A missing page's picture is a 404 like the page; a
// picture that can't be read or drawn is the league's own share image
// (fallbackOgImage), never a broken one.

import { LEAGUE_CONFIG } from "@/lib/league-config";
import {
  loadInhouseNightCard,
  loadMatchCard,
  loadPlayerCard,
  loadSeasonCard,
  loadTeamCard,
} from "@/lib/link-preview-images";
import {
  drawOgImage,
  fallbackOgImage,
  loadLeagueEmblem,
  ogImageResponse,
} from "@/lib/og-assets";
import { OG_CACHE_TTL_MS } from "@/lib/og-image";
import { createPictureCache, type PictureCache } from "@/lib/picture-cache";
import {
  OgInhouseNightCard,
  OgMatchCard,
  OgPlayerCard,
  OgSeasonCard,
  OgTeamCard,
  ogEmblem,
} from "./og-card";

async function brand() {
  return {
    emblem: ogEmblem(await loadLeagueEmblem(), LEAGUE_CONFIG.region === "eu"),
    leagueName: LEAGUE_CONFIG.name,
  };
}

function notFoundImage(): Response {
  return new Response(null, {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * What a picture body settles on: the drawn PNG; null for the league's own
 * picture (one that couldn't be drawn, or a page that keeps the league's);
 * or "missing" for no such page. Only a drawn PNG is kept.
 */
type SharePicture = ArrayBuffer | null | "missing";

// Drawing a picture costs about a second of the box's one vCPU, which both
// leagues and Postgres share, and no CDN caches it (docs/DECISIONS.md,
// Hosting). So a production process keeps each drawn picture for five
// minutes, what the CDN gave it on Vercel, keyed by its page's address: a
// page's opengraph-image and twitter-image share one entry, and a burst of
// unfurls draws once. Per process on purpose: a picture up to five minutes
// stale is fine, and the two processes of a release's overlap each draw
// their own. On globalThis so every route's bundle shares the one cache. Not
// in development, where a layout edit must show on the next request.
const PICTURE_CACHE_MAX_ENTRIES = 100;
const PICTURE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const host = globalThis as typeof globalThis & {
  ggd2lSharePictures?: PictureCache<SharePicture>;
};
function sharePictureCache(): PictureCache<SharePicture> | null {
  if (process.env.NODE_ENV !== "production") return null;
  return (host.ggd2lSharePictures ??= createPictureCache<SharePicture>({
    ttlMs: OG_CACHE_TTL_MS,
    maxEntries: PICTURE_CACHE_MAX_ENTRIES,
    maxBytes: PICTURE_CACHE_MAX_BYTES,
    keepBytes: (picture) =>
      picture && picture !== "missing" ? picture.byteLength : null,
  }));
}

/**
 * Reads, then draws, or serves the picture kept for `page` (the page's own
 * address, no query); a failed read gets the league's own picture.
 */
async function sharePicture(
  page: string,
  draw: () => Promise<SharePicture>,
): Promise<Response> {
  try {
    const cache = sharePictureCache();
    const { value, ageMs } = cache
      ? await cache.get(page, draw)
      : { value: await draw(), ageMs: 0 };
    if (value === "missing") return notFoundImage();
    return value ? ogImageResponse(value, ageMs) : fallbackOgImage();
  } catch {
    return fallbackOgImage();
  }
}

export function matchShareImage(id: string): Promise<Response> {
  return sharePicture(`/matches/${id}`, async () => {
    const card = await loadMatchCard(id, Date.now());
    if (!card) return "missing";
    return drawOgImage(<OgMatchCard {...card} {...await brand()} />);
  });
}

export function teamShareImage(id: string): Promise<Response> {
  return sharePicture(`/teams/${id}`, async () => {
    const card = await loadTeamCard(id, Date.now());
    if (!card) return "missing";
    return drawOgImage(<OgTeamCard {...card} {...await brand()} />);
  });
}

export function playerShareImage(id: string): Promise<Response> {
  return sharePicture(`/players/${id}`, async () => {
    const card = await loadPlayerCard(id);
    if (!card) return "missing";
    // An account that only signed in keeps the plain preview its page has.
    if (card === "unjoined") return null;
    return drawOgImage(<OgPlayerCard {...card} {...await brand()} />);
  });
}

export function seasonShareImage(id: string): Promise<Response> {
  return sharePicture(`/seasons/${id}`, async () => {
    const card = await loadSeasonCard(id);
    if (!card) return "missing";
    return drawOgImage(<OgSeasonCard {...card} {...await brand()} />);
  });
}

/**
 * /inhouse's picture: the planned inhouse night, so the invite link unfurls
 * as the night. With no night set it is the league's own picture, as /inhouse
 * always had, never a 404.
 */
export function inhouseShareImage(): Promise<Response> {
  return sharePicture("/inhouse", async () => {
    const card = await loadInhouseNightCard(Date.now());
    if (!card) return null;
    return drawOgImage(<OgInhouseNightCard {...card} {...await brand()} />);
  });
}
