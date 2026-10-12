import type { MetadataRoute } from "next";
import { resolveSiteUrl } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  const base = resolveSiteUrl();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Private / auth-gated areas shouldn't be crawled, nor the casters'
      // stream overlay (a tool for OBS, every page of it noindex anyway).
      disallow: ["/admin", "/api", "/me", "/draft", "/login", "/overlay"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
