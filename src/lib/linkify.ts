// Split free text into text/link tokens so news bodies can render URLs as
// real anchors. Pure and unit-tested — the React rendering lives in ui.tsx.

export type LinkToken = { type: "text" | "link"; value: string };

// http(s) URLs only. Trailing punctuation that usually closes a sentence or
// parenthetical is trimmed off the match so "see https://x.gg/bracket." links
// cleanly. A ')' is kept only when the URL itself contains a '(' (rare, but
// real for wiki links).
const URL_RE = /https?:\/\/[^\s<>]+/g;
const TRAILING = /[.,!?;:)\]'"]+$/;

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
    tokens.push({ type: "link", value: url });
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
