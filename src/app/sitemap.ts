import type { MetadataRoute } from "next";
import { resolveSiteUrl } from "@/lib/site-url";

// The public, index-worthy routes. Auth-gated / per-entity pages are excluded.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = resolveSiteUrl();
  const routes = [
    { path: "", changeFrequency: "daily", priority: 1 },
    { path: "/players", changeFrequency: "daily", priority: 0.8 },
    { path: "/teams", changeFrequency: "daily", priority: 0.8 },
    { path: "/schedule", changeFrequency: "daily", priority: 0.8 },
    { path: "/leaders", changeFrequency: "daily", priority: 0.8 },
    { path: "/meta", changeFrequency: "daily", priority: 0.7 },
    { path: "/fantasy", changeFrequency: "daily", priority: 0.7 },
    { path: "/pickem", changeFrequency: "daily", priority: 0.7 },
    { path: "/news", changeFrequency: "weekly", priority: 0.8 },
    { path: "/records", changeFrequency: "weekly", priority: 0.7 },
    { path: "/players/compare", changeFrequency: "weekly", priority: 0.6 },
    { path: "/hall-of-fame", changeFrequency: "weekly", priority: 0.7 },
    { path: "/seasons", changeFrequency: "weekly", priority: 0.7 },
    { path: "/recap", changeFrequency: "weekly", priority: 0.7 },
    { path: "/inhouse", changeFrequency: "daily", priority: 0.7 },
    { path: "/inhouse/history", changeFrequency: "weekly", priority: 0.6 },
    { path: "/features", changeFrequency: "monthly", priority: 0.6 },
  ] as const;
  return routes.map((route) => ({
    url: `${base}${route.path}`,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
