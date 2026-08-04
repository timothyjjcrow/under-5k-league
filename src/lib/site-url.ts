// The canonical site origin. Prefer an explicit override, then Vercel's
// auto-provided production domain, then localhost for dev. Used for
// metadataBase, the sitemap, and robots.
function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function resolveSiteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    const explicit = httpOrigin(process.env.NEXT_PUBLIC_SITE_URL);
    if (explicit) return explicit;
    // Ignore a malformed or non-web override and retain a usable deployment
    // origin from Vercel or localhost below.
  }
  const vercelHost =
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelHost) {
    const deployment = httpOrigin(`https://${vercelHost}`);
    if (deployment) return deployment;
    // Fall through to the safe development origin.
  }
  return "http://localhost:3000";
}
