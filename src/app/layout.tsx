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
import { draftNightSoon } from "@/lib/draft-setup";
import { prisma } from "@/lib/prisma";
import { resolveSiteUrl } from "@/lib/site-url";
import { getPublicReadSignals } from "@/lib/public-read-signals";
import {
  getPublicHasHistory,
  getPublicHasLiveMatch,
  getPublicLeagueContent,
  getPublicSeasonHasGames,
} from "@/lib/public-navigation";
import {
  getSeasonDraftStatus,
  getViewerFantasyEntered,
  getViewerRegistration,
} from "@/lib/queries";
import { joinSeasonCta, type NavContent } from "@/lib/site-nav";
import { siteDescription } from "@/lib/link-preview";
import { getTeamHueStyleSheet } from "@/lib/team-hue-snapshot";

const SITE_URL = resolveSiteUrl();
const DESCRIPTION = siteDescription();

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: LEAGUE_CONFIG.name,
    template: `%s · ${LEAGUE_CONFIG.name}`,
  },
  description: DESCRIPTION,
  applicationName: LEAGUE_CONFIG.name,
  icons: {
    icon: [...LEAGUE_CONFIG.branding.icons],
    apple: LEAGUE_CONFIG.branding.appleIcon,
  },
  openGraph: {
    title: LEAGUE_CONFIG.name,
    description: DESCRIPTION,
    siteName: LEAGUE_CONFIG.name,
    type: "website",
    images: [LEAGUE_CONFIG.branding.openGraphImage],
  },
  twitter: {
    card: "summary_large_image",
    title: LEAGUE_CONFIG.name,
    description: DESCRIPTION,
    images: [LEAGUE_CONFIG.branding.twitterImage],
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0f17",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [user, season, hasHistory, publicReadSignals, leagueContent, teamHueCss] =
    await Promise.all([
      getSessionUser(),
      getActiveSeason(),
      getPublicHasHistory(null),
      // This is the causality boundary for ResultSyncPing's first heartbeat.
      // If a concurrent request changes a result after this render, even a
      // heartbeat that loses the import claim can see the cursor advance and
      // refresh the stale RSC payload.
      getPublicReadSignals(),
      // The statistics pages and the Hall of Fame are only offered once they
      // have something to show: one game row and the Hall of Fame's own
      // champion test, behind the shared snapshot.
      getPublicLeagueContent(null),
      // Crest colours are decoration: without them crests use their
      // fallback hue, so a failure here must never take the page down.
      getTeamHueStyleSheet().catch(() => ""),
    ]);
  const resultCursorAtRender = publicReadSignals.resultChangedAt;
  // Draft night during Signups: link the draft room before Start.
  const draftRoomSoon = draftNightSoon(
    season?.status,
    season?.draftAt?.getTime(),
    // One time snapshot for this render.
    // eslint-disable-next-line react-hooks/purity
    Date.now(),
  );
  // The draft status, the viewer's signup and their fantasy entry are
  // request-cached (queries.ts): Home's page and link preview reuse them.
  const [myTeam, draftStatus, registration, seriesLive, seasonHasGames, fantasyEntered] =
    await Promise.all([
      user && season
        ? prisma.teamMember.findFirst({
            where: { seasonId: season.id, userId: user.id },
            select: { teamId: true },
          })
        : null,
      // The menus hide Schedule, Fantasy and Pick'em until the auction is
      // complete, and the phase chips name the auction's state. Only the
      // DRAFT phase needs it: one indexed row, one column.
      season?.status === "DRAFT" ? getSeasonDraftStatus(season.id) : null,
      // During signups the header offers "Join Season N" to anyone who
      // hasn't joined: one unique-key row, signed-in viewers only.
      user && season?.status === "SIGNUPS"
        ? getViewerRegistration(season.id, user.id)
        : null,
      // The header's "Series live" chip: one indexed row behind the shared
      // public snapshot, and only while matches can be live.
      season?.status === "REGULAR_SEASON" || season?.status === "PLAYOFFS"
        ? getPublicHasLiveMatch(season.id)
        : false,
      // Fantasy is offered until its rosters lock. The first import stamps
      // fantasyLockedAt; a season with games but no stamp is locked too. One
      // indexed row behind the shared snapshot, only while picks can be open.
      season &&
      season.fantasyLockedAt === null &&
      (season.status === "DRAFT" ||
        season.status === "REGULAR_SEASON" ||
        season.status === "PLAYOFFS")
        ? getPublicSeasonHasGames(season.id)
        : false,
      // After the lock, only managers who entered keep Fantasy in their
      // menus: one unique-key row, signed-in viewers only, once rosters can
      // be locked.
      user &&
      (season?.status === "REGULAR_SEASON" ||
        season?.status === "PLAYOFFS" ||
        season?.status === "COMPLETE")
        ? getViewerFantasyEntered(season.id, user.id)
        : false,
    ]);
  const navContent: NavContent = {
    hasHistory,
    hasGames: leagueContent.hasGames,
    hasChampion: leagueContent.hasChampion,
    fantasyLocked: season?.fantasyLockedAt != null || seasonHasGames,
    fantasyEntered,
  };
  const join = joinSeasonCta({
    phase: season?.status ?? null,
    seasonName: season?.name ?? null,
    signedIn: user !== null,
    registrationStatus: registration?.status ?? null,
    onRoster: myTeam !== null,
  });

  return (
    <html
      lang="en"
      className={`h-full antialiased ${display.variable}`}
      data-scroll-behavior="smooth"
    >
      <body className="flex min-h-full flex-col">
        {teamHueCss ? (
          // Each season's teams get evenly spaced crest colours (see
          // lib/team-hues.ts). Only team ids and integers go in here.
          <style dangerouslySetInnerHTML={{ __html: teamHueCss }} />
        ) : null}
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        <SiteHeader
          user={user}
          phase={season?.status ?? null}
          seasonName={season?.name ?? null}
          myTeamId={myTeam?.teamId ?? null}
          draftStatus={draftStatus}
          content={navContent}
          join={join}
          seriesLive={seriesLive}
          draftRoomSoon={draftRoomSoon}
          seasonId={season?.id ?? null}
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
          draftStatus={draftStatus}
          content={navContent}
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
