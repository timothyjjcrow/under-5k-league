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
