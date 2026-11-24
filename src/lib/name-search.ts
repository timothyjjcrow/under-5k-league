/**
 * Whether a name matches what an admin typed into a list's search box:
 * every word, anywhere in the name, in any case. An empty query matches
 * everyone, so clearing the box shows the whole list again.
 */
export function nameMatchesQuery(name: string | null | undefined, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = (name ?? "").toLowerCase();
  return words.every((word) => haystack.includes(word));
}
