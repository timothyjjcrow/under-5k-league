import type { NextConfig } from "next";

// Stable media (the hero loops) never changes, so let the browser + Vercel's
// CDN cache it forever. This turns bandwidth cost from "per page view" into
// "per new visitor". If a clip is ever updated, give it a new filename to bust
// the cache.
const LONG_CACHE = "public, max-age=31536000, immutable";
const CACHED_MEDIA = ["/hero-loop.mp4", "/inhouse-bg.mp4"];

const nextConfig: NextConfig = {
  async headers() {
    return CACHED_MEDIA.map((source) => ({
      source,
      headers: [{ key: "Cache-Control", value: LONG_CACHE }],
    }));
  },
};

export default nextConfig;
