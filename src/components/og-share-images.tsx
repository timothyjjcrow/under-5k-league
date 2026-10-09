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
  fallbackOgImage,
  loadLeagueEmblem,
  renderOgImage,
} from "@/lib/og-assets";
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

/** Reads, then draws; a failed read gets the league's own picture. */
async function sharePicture(
  draw: () => Promise<Response | null>,
): Promise<Response> {
  try {
    return (await draw()) ?? notFoundImage();
  } catch {
    return fallbackOgImage();
  }
}

export function matchShareImage(id: string): Promise<Response> {
  return sharePicture(async () => {
    const card = await loadMatchCard(id, Date.now());
    if (!card) return null;
    return renderOgImage(<OgMatchCard {...card} {...await brand()} />);
  });
}

export function teamShareImage(id: string): Promise<Response> {
  return sharePicture(async () => {
    const card = await loadTeamCard(id, Date.now());
    if (!card) return null;
    return renderOgImage(<OgTeamCard {...card} {...await brand()} />);
  });
}

export function playerShareImage(id: string): Promise<Response> {
  return sharePicture(async () => {
    const card = await loadPlayerCard(id);
    if (!card) return null;
    // An account that only signed in keeps the plain preview its page has.
    if (card === "unjoined") return fallbackOgImage();
    return renderOgImage(<OgPlayerCard {...card} {...await brand()} />);
  });
}

export function seasonShareImage(id: string): Promise<Response> {
  return sharePicture(async () => {
    const card = await loadSeasonCard(id);
    if (!card) return null;
    return renderOgImage(<OgSeasonCard {...card} {...await brand()} />);
  });
}

/**
 * /inhouse's picture: the planned inhouse night, so the invite link unfurls
 * as the night. With no night set it is the league's own picture, as /inhouse
 * always had, never a 404.
 */
export function inhouseShareImage(): Promise<Response> {
  return sharePicture(async () => {
    const card = await loadInhouseNightCard(Date.now());
    if (!card) return fallbackOgImage();
    return renderOgImage(<OgInhouseNightCard {...card} {...await brand()} />);
  });
}
