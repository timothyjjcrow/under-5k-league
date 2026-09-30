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
