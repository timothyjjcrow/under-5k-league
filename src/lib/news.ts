// League news/announcements: pure validation, DB-free and tested. Pages order
// posts in the query (pinned, then newest, then id). Posting/pinning/deleting
// lives in src/app/actions/news.ts.

export const NEWS_LIMITS = {
  TITLE_MAX: 120,
  BODY_MAX: 4000,
} as const;

// Klipy (unlike Giphy/Tenor) exposes no embeddable page URL: its pages sit
// behind Cloudflare (403 to any server fetch) and its media is content-addressed
// by hash, so a klipy.com/gifs/… link can't be resolved to a GIF. Its *direct*
// media URL (static.klipy.com/…​.gif — right-click "Copy image address") does
// embed. `static.klipy.com` isn't matched (path is /ii/…, not /gifs/…).
const KLIPY_PAGE_RE =
  /https?:\/\/(?:www\.)?klipy\.com\/(?:gifs|stickers|clips)\//i;

/**
 * A non-blocking heads-up for a body whose media link won't embed, or null when
 * nothing needs saying. Surfaced in the post-success toast so the admin learns
 * how to fix it instead of silently getting a bare link.
 */
export function newsMediaHint(
  body: string,
  done: "Posted" | "Saved" = "Posted",
): string | null {
  if (KLIPY_PAGE_RE.test(body)) {
    return `${done} — but a Klipy page link won't show as a GIF (Klipy blocks embedding). On klipy.com, right-click the GIF → “Copy image address” (a static.klipy.com/…​.gif URL) and paste that, or use a Giphy/Tenor link — those embed from the page URL.`;
  }
  return null;
}

/** Validation shared by the action; returns an error string or null when ok. */
export function newsPostError(title: string, body: string): string | null {
  if (!title.trim()) return "Give the post a title.";
  if (title.trim().length > NEWS_LIMITS.TITLE_MAX)
    return `Keep the title under ${NEWS_LIMITS.TITLE_MAX} characters.`;
  if (!body.trim()) return "Write something in the post body.";
  if (body.trim().length > NEWS_LIMITS.BODY_MAX)
    return `Keep the body under ${NEWS_LIMITS.BODY_MAX} characters.`;
  return null;
}

/**
 * NewsPost.discordMessageId holds one of three things: null (the post has no
 * Discord copy), a Discord message id (the copy an edit rewrites and a delete
 * removes), or a "posting:<ms>" mark while a post to Discord is in flight.
 * Requests claim the column with a compare-and-set before they call Discord,
 * so a double-click or two admins can't post the same announcement twice.
 */
const NEWS_DISCORD_POSTING_PREFIX = "posting:";

/**
 * A mark older than this belongs to a request that died mid-post (Discord
 * answers in seconds and the post times out at 5s). Discord may still have
 * the message, so the admin is told to check the channel before posting again.
 */
export const NEWS_DISCORD_POST_STALE_MS = 60_000;

export function newsDiscordPostingMark(nowMs: number): string {
  return `${NEWS_DISCORD_POSTING_PREFIX}${nowMs}`;
}

export type NewsDiscordCopy =
  | { state: "none" }
  | { state: "posted"; messageId: string }
  | { state: "posting"; interrupted: boolean };

/** What the stored column says about a post's Discord copy. */
export function newsDiscordCopy(
  stored: string | null,
  nowMs: number,
): NewsDiscordCopy {
  if (!stored) return { state: "none" };
  if (/^\d{1,25}$/.test(stored)) return { state: "posted", messageId: stored };
  if (stored.startsWith(NEWS_DISCORD_POSTING_PREFIX)) {
    const at = Number(stored.slice(NEWS_DISCORD_POSTING_PREFIX.length));
    if (Number.isFinite(at)) {
      return {
        state: "posting",
        interrupted: nowMs - at > NEWS_DISCORD_POST_STALE_MS,
      };
    }
  }
  // Anything else can't be edited or removed; treat it as no copy.
  return { state: "none" };
}
