import type { NextConfig } from "next";

// Stable media (the hero loops) never changes, so let the browser + Vercel's
// CDN cache it forever. This turns bandwidth cost from "per page view" into
// "per new visitor". If a clip is ever updated, give it a new filename to bust
// the cache.
const LONG_CACHE = "public, max-age=31536000, immutable";
const CACHED_MEDIA = ["/hero-loop.mp4"];

// Baseline security headers on every response. Deliberately no script/style CSP
// directives (Next injects inline hydration scripts that a strict script-src
// would break). The remaining directives are hydration-safe: they prevent
// clickjacking, external form posts, injected base URLs, and legacy plugins.
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Content-Security-Policy",
    value:
      "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      ...CACHED_MEDIA.map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: LONG_CACHE }],
      })),
    ];
  },
};

export default nextConfig;
