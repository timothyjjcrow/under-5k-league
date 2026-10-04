import type { MetadataRoute } from "next";
import { getPublicLeagueContent } from "@/lib/public-navigation";
import { resolveSiteUrl } from "@/lib/site-url";

// Which pages are listed depends on the league's data, so this is read per
// request (behind the shared public snapshot) and never at build time.
export const dynamic = "force-dynamic";

type Route = {
  path: string;
  changeFrequency: "daily" | "weekly" | "monthly";
  priority: number;
  /** Listed only once the page has something to show (default: always). */
  when?: boolean;
};

// The public, index-worthy routes. Auth-gated / per-entity pages are excluded,
// and so is /recap, which only redirects to a season's own page. So are pages
// that would be empty: the statistics pages until a league game is on record
// and the Hall of Fame until a champion is (the menus use the same rules,
// src/lib/site-nav.ts).
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = resolveSiteUrl();
  const { hasGames, hasChampion } = await getPublicLeagueContent(null);
  const routes: Route[] = [
    { path: "", changeFrequency: "daily", priority: 1 },
    { path: "/players", changeFrequency: "daily", priority: 0.8 },
    { path: "/teams", changeFrequency: "daily", priority: 0.8 },
    { path: "/schedule", changeFrequency: "daily", priority: 0.8 },
    { path: "/scrims", changeFrequency: "daily", priority: 0.7 },
    { path: "/leaders", changeFrequency: "daily", priority: 0.8, when: hasGames },
    { path: "/meta", changeFrequency: "daily", priority: 0.7, when: hasGames },
    { path: "/fantasy", changeFrequency: "daily", priority: 0.7 },
    { path: "/pickem", changeFrequency: "daily", priority: 0.7 },
    { path: "/news", changeFrequency: "weekly", priority: 0.8 },
    { path: "/records", changeFrequency: "weekly", priority: 0.7, when: hasGames },
    {
      path: "/players/compare",
      changeFrequency: "weekly",
      priority: 0.6,
      when: hasGames,
    },
    {
      path: "/hall-of-fame",
      changeFrequency: "weekly",
      priority: 0.7,
      when: hasChampion,
    },
    { path: "/seasons", changeFrequency: "weekly", priority: 0.7 },
    { path: "/inhouse", changeFrequency: "daily", priority: 0.7 },
    { path: "/inhouse/history", changeFrequency: "weekly", priority: 0.6 },
    { path: "/how-it-works", changeFrequency: "monthly", priority: 0.6 },
    { path: "/rules", changeFrequency: "monthly", priority: 0.6 },
  ];
  return routes
    .filter((route) => route.when ?? true)
    .map((route) => ({
      url: `${base}${route.path}`,
      changeFrequency: route.changeFrequency,
      priority: route.priority,
    }));
}
