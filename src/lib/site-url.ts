// The canonical site origin. Prefer an explicit override, then Vercel's
// auto-provided production domain, then localhost for dev. Used for
// metadataBase, the sitemap, and robots.
export function resolveSiteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  const vercelHost =
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelHost) return `https://${vercelHost}`;
  return "http://localhost:3000";
}
