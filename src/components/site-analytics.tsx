"use client";

import { Analytics } from "@vercel/analytics/next";
import { publicPageView } from "@/lib/site-analytics";

export function SiteAnalytics() {
  return <Analytics beforeSend={publicPageView} />;
}
