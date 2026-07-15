// League news/announcements: pure ordering + validation, DB-free and tested.
// Posting/pinning/deleting lives in src/app/actions/news.ts.

export const NEWS_LIMITS = {
  TITLE_MAX: 120,
  BODY_MAX: 4000,
} as const;

export type NewsLike = {
  pinned: boolean;
  createdAt: Date | number;
};

function toMs(v: Date | number): number {
  return typeof v === "number" ? v : v.getTime();
}

/** Pinned posts first, newest first within each group. */
export function sortNews<T extends NewsLike>(posts: T[]): T[] {
  return [...posts].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      toMs(b.createdAt) - toMs(a.createdAt),
  );
}

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
export function newsMediaHint(body: string): string | null {
  if (KLIPY_PAGE_RE.test(body)) {
    return "Posted — but a Klipy page link won't show as a GIF (Klipy blocks embedding). On klipy.com, right-click the GIF → “Copy image address” (a static.klipy.com/…​.gif URL) and paste that, or use a Giphy/Tenor link — those embed from the page URL.";
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
