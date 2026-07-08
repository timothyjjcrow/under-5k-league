import type { MetadataRoute } from "next";
import { resolveSiteUrl } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  const base = resolveSiteUrl();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Private / auth-gated areas shouldn't be crawled.
      disallow: ["/admin", "/api", "/me", "/draft", "/login"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
