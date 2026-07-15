// Split free text into text/link tokens so news bodies can render URLs as
// real anchors. Pure and unit-tested — the React rendering lives in ui.tsx.

export type MediaKind = "image" | "video";
export type LinkToken = {
  type: "text" | "link" | MediaKind;
  value: string;
};

// http(s) URLs only. Trailing punctuation that usually closes a sentence or
// parenthetical is trimmed off the match so "see https://x.gg/bracket." links
// cleanly. A ')' is kept only when the URL itself contains a '(' (rare, but
// real for wiki links).
const URL_RE = /https?:\/\/[^\s<>]+/g;
const TRAILING = /[.,!?;:)\]'"]+$/;

// A *direct* media file (not an HTML page), matched by its extension so a plain
// link never becomes a broken embed. Extension may be trailed by a ?query or
// #fragment (CDNs append format/tracking hints). Images render in <img>, videos
// (how Giphy/Tenor/Klipy actually serve "GIFs" now) in a muted looping <video>.
const IMAGE_URL_RE = /\.(gif|png|jpe?g|webp|avif)(?:[?#][^\s]*)?$/i;
const VIDEO_URL_RE = /\.(mp4|webm)(?:[?#][^\s]*)?$/i;

/** Direct-media kind of a URL, or null for a non-media link. */
export function mediaKind(url: string): MediaKind | null {
  if (IMAGE_URL_RE.test(url)) return "image";
  if (VIDEO_URL_RE.test(url)) return "video";
  return null;
}

/**
 * Rewrite the URLs people actually paste into embeddable direct-media URLs so a
 * GIF shows up instead of a bare link:
 *  - Giphy share pages (giphy.com/gifs|stickers|embed/<slug>-<ID>) → the direct
 *    media.giphy.com/media/<ID>/giphy.gif (deterministic — the ID is the last
 *    hyphen token).
 *  - Tenor view pages (tenor.com/view/<slug>-gif-<n>) → the same URL + ".gif",
 *    which Tenor 302-redirects to the real media file (browsers follow it).
 *  - Any other direct http:// image/video → upgraded to https:// so it isn't
 *    blocked as mixed content on the https site.
 * Klipy needs nothing here: its only shareable URL is the direct
 * static.klipy.com/…/x.gif (or .mp4/.webp), which already matches mediaKind.
 * Anything unrecognized is returned unchanged (stays a plain link).
 */
export function normalizeMediaUrl(url: string): string {
  const giphy = url.match(
    /^https?:\/\/(?:[a-z0-9-]+\.)?giphy\.com\/(?:gifs|stickers|embed)\/([^/?#]+)/i,
  );
  if (giphy) {
    const seg = giphy[1];
    const id = seg.includes("-") ? seg.slice(seg.lastIndexOf("-") + 1) : seg;
    if (/^[A-Za-z0-9]{5,}$/.test(id)) {
      return `https://media.giphy.com/media/${id}/giphy.gif`;
    }
  }
  const tenor = url.match(
    /^https?:\/\/(?:[a-z0-9-]+\.)?tenor\.com\/view\/([a-z0-9-]+-gif-\d+)\/?$/i,
  );
  if (tenor) return `https://tenor.com/view/${tenor[1]}.gif`;

  // Mixed-content guard: only upgrade links we'd actually embed.
  if (url.startsWith("http://") && mediaKind(url) !== null) {
    return `https://${url.slice("http://".length)}`;
  }
  return url;
}

/** First embeddable media in free text (normalized direct URL + kind), or null.
 *  Lets a caller render the GIF/video on its own — e.g. the dashboard preview
 *  shows it below the clamped text rather than inside it. */
export function firstMedia(
  text: string,
): { value: string; kind: MediaKind } | null {
  for (const t of splitLinks(text)) {
    if (t.type === "image" || t.type === "video") {
      return { value: t.value, kind: t.type };
    }
  }
  return null;
}

/** First embeddable media URL (image or video) in free text, or null — shared
 *  by news rendering and the Discord announcement so both agree, and so the
 *  normalized direct URL (not the original page link) is what gets embedded. */
export function firstMediaUrl(text: string): string | null {
  return firstMedia(text)?.value ?? null;
}

/** Tokenize text into plain-text and http(s)-link runs, in order. */
export function splitLinks(text: string): LinkToken[] {
  const tokens: LinkToken[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    const trimmed = url.match(TRAILING);
    if (trimmed) {
      let cut = trimmed[0];
      // Keep a trailing ')' only when the URL has an unmatched '(' to balance
      // it (real for wiki links like ..._(video_game)); trim the rest — a
      // sentence-closing paren after other punctuation, e.g. "(see …/x)."
      const open = countChar(url, "(");
      let closesOnUrl = countChar(url, ")") - countChar(cut, ")");
      while (cut.startsWith(")") && closesOnUrl < open) {
        cut = cut.slice(1); // this ')' balances an '(' — leave it on the URL
        closesOnUrl++;
      }
      url = url.slice(0, url.length - cut.length);
    }
    if (url.length === 0) continue;
    const start = m.index ?? 0;
    if (start > last) tokens.push({ type: "text", value: text.slice(last, start) });
    // Normalize known share/page URLs to direct media before classifying, so a
    // pasted Giphy/Tenor page link (or an http:// image) embeds instead of
    // rendering as a bare link.
    const value = normalizeMediaUrl(url);
    tokens.push({ type: mediaKind(value) ?? "link", value });
    last = start + url.length;
  }
  if (last < text.length) tokens.push({ type: "text", value: text.slice(last) });
  return tokens;
}

function countChar(s: string, c: string): number {
  let n = 0;
  for (const ch of s) if (ch === c) n++;
  return n;
}
