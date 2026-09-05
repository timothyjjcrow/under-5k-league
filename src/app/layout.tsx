import { LEAGUE_CONFIG } from "@/lib/league-config";
import type { Metadata, Viewport } from "next";
import { Oswald } from "next/font/google";
import "./globals.css";

// Condensed display face for headings & stat numbers — the "jersey/billboard"
// esports voice. Body text stays on the neutral system sans for readability.
const display = Oswald({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-oswald",
  display: "swap",
});
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { Toaster } from "@/components/toaster";
import { ResultSyncPing } from "@/components/result-sync-ping";
import { NavigationContextTracker } from "@/components/context-back-link";
import { SiteAnalytics } from "@/components/site-analytics";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { resolveSiteUrl } from "@/lib/site-url";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

const SITE_URL = resolveSiteUrl();
const DESCRIPTION =
  "An amateur Dota 2 league built around a soft 4.5K MMR limit — sign in with Steam, join the season, get drafted, and compete.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: LEAGUE_CONFIG.name,
    template: `%s · ${LEAGUE_CONFIG.name}`,
  },
  description: DESCRIPTION,
  applicationName: LEAGUE_CONFIG.name,
  openGraph: {
    title: LEAGUE_CONFIG.name,
    description: DESCRIPTION,
    siteName: LEAGUE_CONFIG.name,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: LEAGUE_CONFIG.name,
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0f17",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [user, season, archivedSeason, resultCursorAtRender] =
    await Promise.all([
      getSessionUser(),
      getActiveSeason(),
      prisma.season.findFirst({
        where: { isActive: false },
        select: { id: true },
      }),
      // This is the causality boundary for ResultSyncPing's first heartbeat.
      // If a concurrent request changes a result after this render, even a
      // heartbeat that loses the import claim can see the cursor advance and
      // refresh the stale RSC payload.
      getSetting(SETTING_KEYS.RESULT_CHANGED_AT),
    ]);
  const hasHistory = archivedSeason != null;
  const myTeam =
    user && season
      ? await prisma.teamMember.findFirst({
          where: { seasonId: season.id, userId: user.id },
          select: { teamId: true },
        })
      : null;

  return (
    <html
      lang="en"
      className={`h-full antialiased ${display.variable}`}
      data-scroll-behavior="smooth"
    >
      <body className="flex min-h-full flex-col">
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        <SiteHeader
          user={user}
          phase={season?.status ?? null}
          seasonName={season?.name ?? null}
          myTeamId={myTeam?.teamId ?? null}
          hasHistory={hasHistory}
        />
        <main
          id="main"
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6"
        >
          {children}
        </main>
        <SiteFooter
          seasonName={season?.name ?? null}
          phase={season?.status ?? null}
          hasHistory={hasHistory}
        />
        <Toaster />
        <NavigationContextTracker />
        {/* Observe worker progress so parked pages refresh after results land. */}
        <ResultSyncPing initialCursor={resultCursorAtRender} />
        {/* The SDK counts navigation, not room polling or server refreshes. */}
        {process.env.VERCEL_ENV === "production" ? <SiteAnalytics /> : null}
      </body>
    </html>
  );
}
