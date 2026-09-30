// The Share button on match, team and player pages (share-button.tsx): which
// way it shares and what it shares. Pure, so the choice is tested without a
// browser.

/**
 * Phones get the system share sheet (Discord, WhatsApp and the rest are in
 * it); a mouse copies the link, since a desktop share sheet rarely offers the
 * app someone wants to paste into. A browser without the share sheet copies.
 */
export function shareMethod(browser: {
  canShare: boolean;
  coarsePointer: boolean;
}): "sheet" | "copy" {
  return browser.canShare && browser.coarsePointer ? "sheet" : "copy";
}

/**
 * The page's own address on the host the viewer is on (a preview deploy, a
 * custom domain and localhost each share themselves), with no query or hash:
 * the link unfurls into the page's own preview.
 */
export function shareUrl(origin: string, path: string): string {
  const url = new URL(origin);
  url.pathname = new URL(path, url).pathname;
  return url.href;
}

/** Closing the share sheet without picking an app rejects with AbortError. */
export function shareCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}
