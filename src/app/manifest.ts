import { LEAGUE_CONFIG } from "@/lib/league-config";
import type { MetadataRoute } from "next";
import { siteDescription } from "@/lib/link-preview";

// Web app manifest — makes the site installable (add-to-home-screen), which
// matters for the mobile-majority audience. Icons reuse the existing app icons.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: LEAGUE_CONFIG.name,
    short_name: LEAGUE_CONFIG.name,
    description: siteDescription(),
    start_url: "/",
    display: "standalone",
    background_color: "#0b0f17",
    theme_color: "#0b0f17",
    icons: [...LEAGUE_CONFIG.branding.appIcons],
  };
}
