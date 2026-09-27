import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes, resolving conflicts (last wins). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

// Small words a team monogram skips: "Sisters of the Veil" is SV, not SO.
const MONOGRAM_SKIP = new Set([
  "a", "an", "and", "at", "by", "for", "from", "in", "n", "of", "on", "or",
  "the", "to", "vs",
]);
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const POSSESSIVE = /['’]s$/i;

/**
 * Two letters for a team's generated crest. Small words are skipped, and a
 * default "<captain>'s Team" name uses the captain's name alone, so a new
 * league's crests don't all end in T: "Zai's Team" is ZA, "Zed's Team" ZE.
 * A single remaining word gives its first two letters ("Navi" is NA).
 */
export function teamInitials(name: string): string {
  const raw = name.split(/\s+/).filter(Boolean);
  const words: string[] = [];
  raw.forEach((word, index) => {
    const letters = Array.from(word.replace(POSSESSIVE, ""))
      .filter((ch) => LETTER_OR_DIGIT.test(ch))
      .join("");
    const lower = letters.toLowerCase();
    // The trailing "Team" of "<name>'s Team" names nobody.
    const defaultSuffix =
      lower === "team" &&
      index === raw.length - 1 &&
      index > 0 &&
      POSSESSIVE.test(raw[index - 1]);
    if (letters && !defaultSuffix && !MONOGRAM_SKIP.has(lower))
      words.push(letters);
  });
  if (words.length === 0) return initials(name);
  const picked =
    words.length === 1
      ? Array.from(words[0]).slice(0, 2)
      : [Array.from(words[0])[0], Array.from(words[1])[0]];
  return picked.join("").toUpperCase();
}

/** Compact net-worth/gold formatting, e.g. 12500 -> "12.5k", null -> "—". */
export function formatNetWorth(n: number | null | undefined): string {
  if (n == null) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/**
 * Does this free-text field have anything worth rendering?
 *
 * Player statements and captain notes are optional, and every surface used a
 * plain truthiness check — which a whitespace-only value passes, producing an
 * empty pair of smart quotes under a "NOTE FOR CAPTAINS" heading. Saves are
 * trimmed now, but rows stored before that (or edited straight in the DB)
 * still need the render side to cope.
 */
export function hasText(value: string | null | undefined): boolean {
  return !!value && value.trim().length > 0;
}
