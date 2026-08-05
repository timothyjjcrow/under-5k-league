/** Discord ids are unsigned snowflakes; current values are 17–20 digits. */
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const MAX_EXPLICIT_MENTIONS = 100;

export const DISCORD_CONTENT_MAX = 2_000;

export type MentionAllowlist = { roles?: string[]; users?: string[] };

/** Keep only webhook-safe, explicitly bounded mention ids. */
export function normalizeMentionAllowlist(
  value?: MentionAllowlist,
): MentionAllowlist | undefined {
  const ids = (items: string[] | undefined) =>
    [...new Set((items ?? []).map((id) => id.trim()))]
      .filter((id) => DISCORD_SNOWFLAKE.test(id))
      .slice(0, MAX_EXPLICIT_MENTIONS);
  const users = ids(value?.users);
  const roles = ids(value?.roles);
  return users.length || roles.length
    ? {
        ...(users.length ? { users } : {}),
        ...(roles.length ? { roles } : {}),
      }
    : undefined;
}

/**
 * Discord's allowlist only authorizes tokens already present in the content.
 * Materialize absent server-selected ids once, without duplicating formatters
 * that already include a modern, legacy-user, or role mention token.
 */
export function materializeAllowedMentions(
  content: string,
  mentions?: MentionAllowlist,
): string {
  const allowed = normalizeMentionAllowlist(mentions);
  const missing = [
    ...(allowed?.users ?? [])
      .filter(
        (id) =>
          !content.includes(`<@${id}>`) && !content.includes(`<@!${id}>`),
      )
      .map((id) => `<@${id}>`),
    ...(allowed?.roles ?? [])
      .filter((id) => !content.includes(`<@&${id}>`))
      .map((id) => `<@&${id}>`),
  ];
  if (missing.length === 0) return content;
  return `${missing.join(" ")}${content ? ` ${content}` : ""}`;
}

/** Validate the exact content Discord will receive, not only the stored body. */
export function isValidDiscordContent(content: string): boolean {
  return content.trim().length > 0 && content.length <= DISCORD_CONTENT_MAX;
}
