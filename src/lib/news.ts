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

type DecidedFinal = { scheduledAt: Date | null; completedAt: Date | null };
type DecidedGame = { startTime: number; durationSecs: number };

/**
 * When a season's grand final was decided, the line between last season's
 * pinned news ("Grand final this Sunday") and what was pinned after it
 * ("Signups for next season are open"), which unpinNewsBeforeFinal keeps.
 *
 * The played games are the best clock: the end of the latest one, on Valve's
 * clock, which nobody edits later. A final with no imported game (a forfeit,
 * private match data) falls back to when its result was stored, then to its
 * kickoff. Null when nothing dates it, and then nothing is unpinned.
 */
export function finalDecidedAt(
  final: DecidedFinal,
  games: readonly DecidedGame[],
): Date | null {
  const ends = games
    .filter((game) => Number.isSafeInteger(game.startTime) && game.startTime > 0)
    .map(
      (game) =>
        (game.startTime +
          (Number.isSafeInteger(game.durationSecs)
            ? Math.max(0, game.durationSecs)
            : 0)) *
        1000,
    );
  if (ends.length > 0) return new Date(Math.max(...ends));
  return final.completedAt ?? final.scheduledAt ?? null;
}

const UNPINNED_NAMED = 3;

/**
 * The line Create season adds to its success message when it unpinned last
 * season's posts, naming them so an evergreen one (the rules) can be pinned
 * again in one click. Null when nothing was unpinned.
 */
export function unpinnedNewsNote(titles: readonly string[]): string | null {
  if (titles.length === 0) return null;
  const quoted = titles.slice(0, UNPINNED_NAMED).map((title) => `“${title}”`);
  const more = titles.length - quoted.length;
  const named =
    more > 0
      ? `${quoted.join(", ")} and ${more} more`
      : quoted.length === 1
        ? quoted[0]
        : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  return titles.length === 1
    ? `Unpinned last season's news: ${named}. Pin it again under League news if it still matters.`
    : `Unpinned last season's news: ${named}. Pin any of them again under League news if they still matter.`;
}
