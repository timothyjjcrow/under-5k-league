import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import {
  OVERLAY_MATCH_ID,
  OVERLAY_MISSING_HEADERS,
  OVERLAY_PAGE_HEADERS,
  overlayPageHtml,
  type OverlayPageAssets,
} from "@/lib/stream-overlay-page";

// The OBS overlay's page (/overlay/<match id>): a route handler, not a page,
// so it renders outside the site's layout (no header, footer or analytics, a
// transparent background) and reads nothing from the database. Its data comes
// from /api/overlay; Vercel's CDN keeps this answer for the day.
export const dynamic = "force-dynamic";

// Read once per server instance (every request in development, so an edit
// to the drawing code shows on reload). The paths are literal so the build's
// file tracing ships the files with this route (route.test.ts checks them).
let assets: Promise<OverlayPageAssets> | null = null;
function loadAssets(): Promise<OverlayPageAssets> {
  if (assets && process.env.NODE_ENV === "production") return assets;
  const loading = Promise.all([
    readFile(join(process.cwd(), "src", "app", "overlay", "overlay-client.js"), "utf8"),
    readFile(join(process.cwd(), "src", "app", "overlay", "overlay.css"), "utf8"),
    // The display face: without it the overlay falls back to Bahnschrift or
    // Arial Narrow, so a missing file never takes the page down.
    readFile(join(process.cwd(), "src", "app", "fonts", "oswald", "latin.woff2")).then(
      (bytes) => bytes.toString("base64"),
      () => null,
    ),
  ]).then(([script, css, fontBase64]) => ({ script, css, fontBase64 }));
  // A failed read is retried on the next request instead of kept.
  loading.catch(() => {
    if (assets === loading) assets = null;
  });
  assets = loading;
  return loading;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!OVERLAY_MATCH_ID.test(id)) {
    return new Response("Not found", {
      status: 404,
      headers: { ...OVERLAY_MISSING_HEADERS, "content-type": "text/plain" },
    });
  }
  let page: OverlayPageAssets;
  try {
    page = await loadAssets();
  } catch {
    return new Response("The overlay is unavailable. Try again shortly.", {
      status: 503,
      headers: { "cache-control": "no-store", "content-type": "text/plain" },
    });
  }
  return new Response(
    overlayPageHtml({
      matchId: id,
      leagueName: LEAGUE_CONFIG.name,
      emblem: LEAGUE_CONFIG.branding.navLogo,
      blend: LEAGUE_CONFIG.branding.blendMode,
      assets: page,
    }),
    { headers: OVERLAY_PAGE_HEADERS },
  );
}
