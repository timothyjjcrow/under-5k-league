import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { Toaster } from "@/components/toaster";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Under 5k League",
  description:
    "A sub-5000 MMR Dota 2 amateur league — sign in with Steam, join the season, get drafted, and compete.",
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
        <footer className="border-t border-line/70 py-6 text-center text-sm text-muted">
          Under 5k League · a sub-5000 MMR Dota 2 league
        </footer>
        <Toaster />
      </body>
    </html>
  );
}
