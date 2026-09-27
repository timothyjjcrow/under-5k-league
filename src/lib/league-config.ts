export type LeagueRegion = "us" | "eu";

type LeagueEnvironment = {
  NEXT_PUBLIC_LEAGUE_REGION?: string;
  NEXT_PUBLIC_APP_NAME?: string;
  NEXT_PUBLIC_DISCORD_INVITE_URL?: string;
  NEXT_PUBLIC_LEAGUE_TIMEZONE?: string;
  NEXT_PUBLIC_MATCH_DAY?: string;
  NEXT_PUBLIC_MATCH_TIME?: string;
  NEXT_PUBLIC_INHOUSE_LEAGUE_NAME?: string;
};

const US_DISCORD_INVITE = "https://discord.gg/H7PJ4VxUGh";

/** Public deployment identity. Each region still owns a separate database,
 * Discord server, and bot; changing this setting never partitions shared data. */
export function createLeagueConfig(env: LeagueEnvironment) {
  const configuredRegion = env.NEXT_PUBLIC_LEAGUE_REGION?.trim().toLowerCase();
  if (configuredRegion && configuredRegion !== "us" && configuredRegion !== "eu") {
    throw new Error("NEXT_PUBLIC_LEAGUE_REGION must be us or eu.");
  }
  const region: LeagueRegion = configuredRegion === "eu" ? "eu" : "us";
  const europe = region === "eu";
  const timeZone = env.NEXT_PUBLIC_LEAGUE_TIMEZONE?.trim() ||
    (europe ? "Europe/Berlin" : "America/Los_Angeles");
  // A bad timezone must fail configuration instead of silently scheduling in
  // the host machine's timezone. Intl also recognizes supported IANA aliases.
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new Error("NEXT_PUBLIC_LEAGUE_TIMEZONE must be a valid IANA timezone.");
  }

  const name = env.NEXT_PUBLIC_APP_NAME?.trim() || (europe ? "GGD2L Europe" : "GGD2L");
  const discordInviteUrl = env.NEXT_PUBLIC_DISCORD_INVITE_URL?.trim() ||
    (europe ? "" : US_DISCORD_INVITE);
  const day = env.NEXT_PUBLIC_MATCH_DAY?.trim() || (europe ? "" : "Sundays");
  const time = env.NEXT_PUBLIC_MATCH_TIME?.trim() || (europe ? "" : "6:00 PM");
  const announced = Boolean(day && time);
  // "Pacific", not "PST": the league night stays on the local clock, which is
  // PDT for most of the year.
  const timezone = env.NEXT_PUBLIC_LEAGUE_TIMEZONE?.trim() || (europe ? timeZone : "Pacific");
  const inhouseLeagueName = env.NEXT_PUBLIC_INHOUSE_LEAGUE_NAME?.trim() ||
    (europe ? "European inhouse league ticket (to be configured)" : "Under 5K In-House League");

  // The footer's one line on who runs the league, what is public and who to
  // ask about a profile. Deliberately no policy page and no promised
  // timelines; Discord is only named where the region has an invite.
  const footerNote = `${name} is run by volunteers. Your Steam name, avatar, medal and league results are public here. To fix or remove your profile, ${
    discordInviteUrl ? "message a league admin on Discord" : "contact a league admin"
  }.`;

  return {
    region,
    name,
    footerNote,
    merchUrl: "https://ggd2l-shop.fourthwall.com/",
    branding: {
      blendMode: europe ? "lighten" : "normal",
      // Full-size master. Only the Discord queue board uses it, as its author
      // icon (Discord resizes it); pages use the right-sized copies below.
      logo: europe ? "/brand/ggd2l-europe-logo.png" : "/brand/ggd2l-logo.png",
      // Header, footer and 404 emblem, exported at 3x the 76px header height
      // so it stays sharp on phones (about 34KB; the masters are 0.3-2.2MB).
      navLogo: europe ? "/brand/ggd2l-europe-nav.png" : "/brand/ggd2l-nav.png",
      navWidth: europe ? 228 : 278,
      navHeight: 228,
      // Browser-tab icons. The US icon is a 1KB SVG.
      icons: europe
        ? [
            { url: "/brand/ggd2l-europe-icon-32.png", sizes: "32x32", type: "image/png" },
            { url: "/brand/ggd2l-europe-icon-48.png", sizes: "48x48", type: "image/png" },
          ]
        : [{ url: "/icon.svg", type: "image/svg+xml" }],
      appleIcon: europe ? "/brand/ggd2l-europe-icon-180.png" : "/brand/ggd2l-icon-180.png",
      // Installed-app (web manifest) icons.
      appIcons: europe
        ? [
            { src: "/brand/ggd2l-europe-icon-192.png", type: "image/png", sizes: "192x192" },
            { src: "/brand/ggd2l-europe-icon-512.png", type: "image/png", sizes: "512x512" },
          ]
        : [
            { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
            { src: "/brand/ggd2l-icon-192.png", type: "image/png", sizes: "192x192" },
            { src: "/apple-icon.png", type: "image/png", sizes: "512x512" },
          ],
      // Link previews: 1200x630, the shape Discord and X use for large cards.
      openGraphImage: europe ? "/brand/ggd2l-europe-og.png" : "/opengraph-image.png",
      twitterImage: europe ? "/brand/ggd2l-europe-og.png" : "/twitter-image.png",
    },
    timeZone,
    discordInviteUrl,
    inhouseLeagueName,
    inhouseLeagueConfigured: Boolean(env.NEXT_PUBLIC_INHOUSE_LEAGUE_NAME?.trim()) || !europe,
    gameServerRegion: europe ? "Europe West" as const : "US East" as const,
    gameServerRegionId: europe ? 3 as const : 2 as const,
    matchSchedule: {
      day,
      time,
      timezone,
      announced,
      label: announced ? `${day} at ${time} ${timezone}` : "Match night to be announced",
    },
  } as const;
}

// Keep every environment lookup static. Next.js inlines these public values
// into browser bundles at build time; process.env[key] would not be inlined.
export const LEAGUE_CONFIG = createLeagueConfig({
  NEXT_PUBLIC_LEAGUE_REGION: process.env.NEXT_PUBLIC_LEAGUE_REGION,
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_DISCORD_INVITE_URL: process.env.NEXT_PUBLIC_DISCORD_INVITE_URL,
  NEXT_PUBLIC_LEAGUE_TIMEZONE: process.env.NEXT_PUBLIC_LEAGUE_TIMEZONE,
  NEXT_PUBLIC_MATCH_DAY: process.env.NEXT_PUBLIC_MATCH_DAY,
  NEXT_PUBLIC_MATCH_TIME: process.env.NEXT_PUBLIC_MATCH_TIME,
  NEXT_PUBLIC_INHOUSE_LEAGUE_NAME: process.env.NEXT_PUBLIC_INHOUSE_LEAGUE_NAME,
});
