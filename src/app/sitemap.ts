import type { MetadataRoute } from "next";
import { resolveSiteUrl } from "@/lib/site-url";

// The public, index-worthy routes. Auth-gated / per-entity pages are excluded.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = resolveSiteUrl();
  const now = new Date();
  const routes = ["", "/players", "/teams", "/leaders", "/schedule", "/inhouse"];
  return routes.map((route) => ({
    url: `${base}${route}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: route === "" ? 1 : 0.7,
  }));
}
