/**
 * Split a label that opens with a decorative emoji ("🏆 Championship
 * contributions", "🎮 Game wins") into the emoji and the words.
 *
 * Screen readers read an emoji's name ("trophy", "crossed swords") before the
 * words, on every heading and link that carries one; `EmojiLead` in ui.tsx
 * uses this to hide the emoji from them while keeping it on screen. Only a
 * LEADING emoji followed by a space is split, so a label like "Bo3" or one
 * with an emoji in the middle comes back unchanged.
 */

// One pictograph with an optional variation selector (U+FE0F) or skin tone,
// joined to more by zero-width joiners (U+200D) for sequences like the
// detective with a gender sign, then the space before the words.
const LEADING_EMOJI =
  /^(\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)\s+(?=\S)/u;

export function splitLeadingEmoji(text: string): {
  emoji: string | null;
  rest: string;
} {
  const match = LEADING_EMOJI.exec(text);
  if (!match) return { emoji: null, rest: text };
  return { emoji: match[1], rest: text.slice(match[0].length) };
}
