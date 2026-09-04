/** Only public league lists can supply a remembered return destination. */
export function isLeagueList(pathname: string): boolean {
  return (
    ["/players", "/teams", "/schedule"].includes(pathname) ||
    /^\/seasons\/[^/]+$/.test(pathname)
  );
}

export function isLeagueDetail(pathname: string): boolean {
  return (
    /^\/(players|teams|matches)\/[^/]+$/.test(pathname) &&
    pathname !== "/players/compare"
  );
}

export type NavigationContext = {
  href: string;
  scrollY: number;
  anchorHref: string;
  anchorIndex: number;
  anchorTop: number;
};

/** Session storage is optional and untrusted; never turn it into an open URL. */
export function parseNavigationContext(
  raw: string | null,
  fallbackHref: string,
): NavigationContext | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as NavigationContext;
    if (typeof value.href !== "string" || !value.href.startsWith("/"))
      return null;
    const base = "https://league.invalid";
    const url = new URL(value.href, base);
    const fallback = new URL(fallbackHref, base);
    if (
      url.origin !== base ||
      !isLeagueList(url.pathname) ||
      url.pathname !== fallback.pathname
    )
      return null;
    if (
      ![value.scrollY, value.anchorIndex, value.anchorTop].every(
        Number.isFinite,
      ) ||
      value.scrollY < 0 ||
      value.anchorIndex < 0 ||
      !Number.isInteger(value.anchorIndex) ||
      typeof value.anchorHref !== "string" ||
      !value.anchorHref.startsWith("/")
    )
      return null;
    const anchor = new URL(value.anchorHref, base);
    if (anchor.origin !== base || !isLeagueDetail(anchor.pathname)) return null;
    return { ...value, href: url.pathname + url.search + url.hash };
  } catch {
    return null;
  }
}

export const navigationContextKey = (pathname: string) =>
  `league-return:${pathname}`;

export const SAVE_LIST_CONTEXT_EVENT = "league-save-list-context";
