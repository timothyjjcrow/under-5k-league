// Public deployment identity, shared by the production gate and EU bootstrap.
// No credential values are ever included in validation errors.
const US_ORIGIN = "https://ggd2l.vercel.app";
const US_INVITE = "H7PJ4VxUGh";

export function validateLeagueDeploymentEnv(env) {
  const errors = [];
  const region = env.NEXT_PUBLIC_LEAGUE_REGION ?? "us";
  if (region !== "us" && region !== "eu") {
    return ["NEXT_PUBLIC_LEAGUE_REGION must be exactly us or eu"];
  }
  if (region !== "eu") return errors;

  if (env.NEXT_PUBLIC_APP_NAME !== "GGD2L Europe") {
    errors.push("Europe requires NEXT_PUBLIC_APP_NAME=GGD2L Europe");
  }
  const zone = env.NEXT_PUBLIC_LEAGUE_TIMEZONE ?? "";
  try {
    if (!zone.startsWith("Europe/")) throw new Error("not Europe");
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
  } catch {
    errors.push("Europe requires a valid Europe/* NEXT_PUBLIC_LEAGUE_TIMEZONE");
  }
  for (const key of ["APP_URL", "NEXT_PUBLIC_SITE_URL"]) {
    try {
      if (new URL(env[key]).origin === US_ORIGIN) {
        errors.push(`${key} must use the Europe site, not the US origin`);
      }
    } catch {
      // The general production validator reports malformed origins.
    }
  }
  const invite = env.NEXT_PUBLIC_DISCORD_INVITE_URL ?? "";
  if (invite) {
    try {
      const url = new URL(invite);
      const code = url.hostname === "discord.gg"
        ? url.pathname.slice(1)
        : url.hostname === "discord.com" && url.pathname.startsWith("/invite/")
          ? url.pathname.slice(8)
          : "";
      if (
        url.protocol !== "https:" || url.username || url.password || url.port ||
        url.search || url.hash || !/^[A-Za-z0-9-]+$/.test(code) || code === US_INVITE
      ) throw new Error("invalid invite");
    } catch {
      errors.push("NEXT_PUBLIC_DISCORD_INVITE_URL must be a Europe Discord invite or empty");
    }
  }
  const day = env.NEXT_PUBLIC_MATCH_DAY?.trim() ?? "";
  const time = env.NEXT_PUBLIC_MATCH_TIME?.trim() ?? "";
  if (Boolean(day) !== Boolean(time)) {
    errors.push("Set NEXT_PUBLIC_MATCH_DAY and NEXT_PUBLIC_MATCH_TIME together, or leave both empty until announced");
  }
  return errors;
}
