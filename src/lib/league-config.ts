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
  const timezone = env.NEXT_PUBLIC_LEAGUE_TIMEZONE?.trim() || (europe ? timeZone : "PST");
  const inhouseLeagueName = env.NEXT_PUBLIC_INHOUSE_LEAGUE_NAME?.trim() ||
    (europe ? "European inhouse league ticket (to be configured)" : "Under 5K In-House League");

  return {
    region,
    name,
    branding: {
      blendMode: europe ? "lighten" : "normal",
      logo: europe ? "/brand/ggd2l-europe-logo.png" : "/brand/ggd2l-logo.png",
      logoWidth: europe ? 1254 : 768,
      logoHeight: europe ? 1254 : 512,
      navLogo: europe ? "/brand/ggd2l-europe-logo.png" : "/brand/ggd2l-logo-nav.png",
      navWidth: europe ? 1254 : 520,
      navHeight: europe ? 1254 : 427,
      icon: europe ? "/brand/ggd2l-europe-logo.png" : "/icon.svg",
      appleIcon: europe ? "/brand/ggd2l-europe-logo.png" : "/apple-icon.png",
      openGraphImage: europe ? "/brand/ggd2l-europe-logo.png" : "/opengraph-image.png",
      twitterImage: europe ? "/brand/ggd2l-europe-logo.png" : "/twitter-image.png",
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
