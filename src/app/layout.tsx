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
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { resolveSiteUrl } from "@/lib/site-url";

const SITE_URL = resolveSiteUrl();
const DESCRIPTION =
  "An amateur Dota 2 league built around a soft 4.5K MMR limit — sign in with Steam, join the season, get drafted, and compete.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "GGD2L",
    template: "%s · GGD2L",
  },
  description: DESCRIPTION,
  applicationName: "GGD2L",
  openGraph: {
    title: "GGD2L",
    description: DESCRIPTION,
    siteName: "GGD2L",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "GGD2L",
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0f17",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [user, season, archivedCount] = await Promise.all([
    getSessionUser(),
    getActiveSeason(),
    prisma.season.count({ where: { isActive: false } }),
  ]);
  const myTeam =
    user && season
      ? await prisma.teamMember.findFirst({
          where: { seasonId: season.id, userId: user.id },
          select: { teamId: true },
        })
      : null;

  return (
    <html lang="en" className={`h-full antialiased ${display.variable}`}>
      <body className="flex min-h-full flex-col">
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        <SiteHeader
          user={user}
          phase={season?.status ?? null}
          seasonName={season?.name ?? null}
          myTeamId={myTeam?.teamId ?? null}
          hasHistory={archivedCount > 0}
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
          hasHistory={archivedCount > 0}
        />
        <Toaster />
        {/* Lazy automatic result sync — league + inhouse update themselves. */}
        <ResultSyncPing />
      </body>
    </html>
  );
}
