import type { MetadataRoute } from "next";

// Web app manifest — makes the site installable (add-to-home-screen), which
// matters for the mobile-majority audience. Icons reuse the existing app icons.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "GGD2L",
    short_name: "GGD2L",
    description:
      "An amateur Dota 2 league built around a soft 4.5K MMR limit — sign in with Steam, join the season, get drafted, and compete.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0f17",
    theme_color: "#0b0f17",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/apple-icon.png", type: "image/png", sizes: "512x512" },
    ],
  };
}
