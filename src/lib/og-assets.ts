// The link preview pictures' files and network reads. Every read here can
// fail without failing the picture: a missing font falls back to next/og's
// own, a missing emblem or crest is left out or drawn as initials, and a
// picture that still can't render sends the league's own image instead
// (renderOgImage).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { ReactElement } from "react";
import { LEAGUE_CONFIG } from "./league-config";
import {
  OG_CACHE_CONTROL,
  OG_SIZE,
  ogImageUrlAllowed,
  sniffImageType,
} from "./og-image";
import { rankMedalTier, rankStars } from "./rank";

type OgFont = {
  name: string;
  data: Buffer;
  weight: 400 | 600;
  style: "normal";
};

// Read once per server instance. The paths are literal so the build's file
// tracing ships the files with the routes that read them. The fonts sit under
// src/ on purpose: the release classifier treats a new top-level folder as an
// unknown path and asks for a maintenance release (share-image-guards.test.ts
// checks every path here exists).
let fonts: Promise<OgFont[] | null> | null = null;
function loadOgFonts(): Promise<OgFont[] | null> {
  fonts ??= Promise.all([
    readFile(join(process.cwd(), "src", "lib", "og-fonts", "Oswald-Regular.ttf")),
    readFile(join(process.cwd(), "src", "lib", "og-fonts", "Oswald-SemiBold.ttf")),
  ]).then(
    ([regular, semibold]): OgFont[] => [
      { name: "Oswald", data: regular, weight: 400, style: "normal" },
      { name: "Oswald", data: semibold, weight: 600, style: "normal" },
    ],
    () => null,
  );
  return fonts;
}

let emblem: Promise<string | null> | null = null;
/** The league's emblem (the header logo) as a data URI, or null. */
export function loadLeagueEmblem(): Promise<string | null> {
  emblem ??= readFile(
    LEAGUE_CONFIG.region === "eu"
      ? join(process.cwd(), "public", "brand", "ggd2l-europe-nav.png")
      : join(process.cwd(), "public", "brand", "ggd2l-nav.png"),
  ).then(
    (bytes) => `data:image/png;base64,${bytes.toString("base64")}`,
    () => null,
  );
  return emblem;
}

// The medal pictures RankMedal draws on the site (public/ranks): the
// medallion per medal, Herald to Immortal, and the star ring per star count.
const MEDAL_FILES = [
  join(process.cwd(), "public", "ranks", "rank_icon_1.png"),
  join(process.cwd(), "public", "ranks", "rank_icon_2.png"),
  join(process.cwd(), "public", "ranks", "rank_icon_3.png"),
  join(process.cwd(), "public", "ranks", "rank_icon_4.png"),
  join(process.cwd(), "public", "ranks", "rank_icon_5.png"),
  join(process.cwd(), "public", "ranks", "rank_icon_6.png"),
  join(process.cwd(), "public", "ranks", "rank_icon_7.png"),
  join(process.cwd(), "public", "ranks", "rank_icon_8.png"),
];
const STAR_FILES = [
  join(process.cwd(), "public", "ranks", "rank_star_1.png"),
  join(process.cwd(), "public", "ranks", "rank_star_2.png"),
  join(process.cwd(), "public", "ranks", "rank_star_3.png"),
  join(process.cwd(), "public", "ranks", "rank_star_4.png"),
  join(process.cwd(), "public", "ranks", "rank_star_5.png"),
];

const pngFiles = new Map<string, Promise<string | null>>();
function loadPng(file: string): Promise<string | null> {
  let png = pngFiles.get(file);
  if (!png) {
    png = readFile(file).then(
      (bytes) => `data:image/png;base64,${bytes.toString("base64")}`,
      () => null,
    );
    pngFiles.set(file, png);
  }
  return png;
}

/**
 * A medal for a picture, the way RankMedal draws it: the medallion with its
 * star ring on top (Immortal has none). Null for an unknown medal, or when
 * the medallion can't be read; a missing star ring leaves the medallion bare.
 */
export async function loadRankMedal(
  rankTier: number | null,
): Promise<{ icon: string; stars: string | null } | null> {
  const tier = rankMedalTier(rankTier);
  if (tier === 0) return null;
  const stars = tier < 8 ? rankStars(rankTier) : 0;
  const [icon, ring] = await Promise.all([
    loadPng(MEDAL_FILES[tier - 1]),
    stars > 0 ? loadPng(STAR_FILES[stars - 1]) : null,
  ]);
  return icon ? { icon, stars: ring } : null;
}

const OG_IMAGE_TIMEOUT_MS = 2_500;
const OG_IMAGE_MAX_BYTES = 1_500_000;

/**
 * A crest or avatar for a preview, as a data URI, or null for the initials.
 * Only allowlisted hosts (ogImageUrlAllowed), no redirects (a moved Imgur
 * image lands on its "removed" picture, and a redirect could point anywhere),
 * a short timeout, a size cap, and PNG or JPEG bytes only.
 */
export async function fetchOgImage(
  url: string | null | undefined,
): Promise<string | null> {
  if (!ogImageUrlAllowed(url)) return null;
  try {
    const res = await fetch(url!, {
      cache: "no-store",
      redirect: "error",
      headers: { accept: "image/png,image/jpeg;q=0.9" },
      signal: AbortSignal.timeout(OG_IMAGE_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) return null;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > OG_IMAGE_MAX_BYTES) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > OG_IMAGE_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    const type = sniffImageType(bytes);
    return type ? `data:image/${type};base64,${bytes.toString("base64")}` : null;
  } catch {
    return null;
  }
}

/**
 * Draw a preview. The picture is rendered here, not while it streams, so a
 * failure can still answer with the league's own image (a redirect Discord
 * and X follow) rather than a broken one.
 */
export async function renderOgImage(element: ReactElement): Promise<Response> {
  try {
    const loaded = await loadOgFonts();
    const image = new ImageResponse(element, {
      ...OG_SIZE,
      ...(loaded ? { fonts: loaded } : {}),
    });
    const png = await image.arrayBuffer();
    return new Response(png, {
      headers: {
        "content-type": "image/png",
        "cache-control": OG_CACHE_CONTROL,
      },
    });
  } catch {
    return fallbackOgImage();
  }
}

/**
 * The league's own share image, for a preview that can't be drawn. A
 * relative redirect: it resolves against whichever host served the picture.
 */
export function fallbackOgImage(): Response {
  return new Response(null, {
    status: 307,
    headers: {
      location: LEAGUE_CONFIG.branding.openGraphImage,
      "cache-control": "no-store",
    },
  });
}
