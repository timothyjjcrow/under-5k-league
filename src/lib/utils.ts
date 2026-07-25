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
