import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { Toaster } from "@/components/toaster";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";

// The canonical site origin, used as `metadataBase` so OG/Twitter preview images
// resolve to absolute public URLs (Discord/Slack/etc. can't load a localhost
// image). Prefer an explicit override, then Vercel's auto-provided production
// domain, then localhost for dev.
function resolveSiteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  const vercelHost =
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelHost) return `https://${vercelHost}`;
  return "http://localhost:3000";
}

const SITE_URL = resolveSiteUrl();
const DESCRIPTION =
  "A sub-5000 MMR Dota 2 amateur league — sign in with Steam, join the season, get drafted, and compete.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Under 5k League",
    template: "%s · Under 5k League",
  },
  description: DESCRIPTION,
  applicationName: "Under 5k League",
  openGraph: {
    title: "Under 5k League",
    description: DESCRIPTION,
    siteName: "Under 5k League",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Under 5k League",
    description: DESCRIPTION,
  },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [user, season] = await Promise.all([getSessionUser(), getActiveSeason()]);
  const myTeam =
    user && season
      ? await prisma.teamMember.findFirst({
          where: { seasonId: season.id, userId: user.id },
          select: { teamId: true },
        })
      : null;

  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <SiteHeader
          user={user}
          phase={season?.status ?? null}
          seasonName={season?.name ?? null}
          myTeamId={myTeam?.teamId ?? null}
        />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
          {children}
        </main>
        <SiteFooter
          seasonName={season?.name ?? null}
          phase={season?.status ?? null}
        />
        <Toaster />
      </body>
    </html>
  );
}
