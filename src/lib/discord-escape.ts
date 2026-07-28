// Neutralising Discord markdown in text the LEAGUE didn't write.
//
// Player names are Steam personas — chosen by the player, changed at will, and
// interpolated straight into ~20 announcement formatters. Discord renders
// markdown in webhook and bot messages, and unlike user-typed messages it does
// NOT suppress masked links there: a persona of `[free mmr](https://evil.test)`
// arrives in the channel as a live link that reads like the league posted it.
//
// This lived only in inhouse-board.ts for a long time, because the board is
// PINNED and the damage would be permanent. That reasoning was right about the
// board and wrong about everything else — a result announcement is scrolled
// past by the same people, and a link in it is just as clickable.
//
// NOT applied to admin-authored text (news posts, season names): an admin
// writing **bold** in a news post means it, and newsMessage deliberately emits
// a bare media URL so Discord embeds the GIF.

/**
 * Escape Discord markdown in untrusted text. Pure — unit-tested.
 *
 * NEWLINES ARE STRIPPED FIRST, before truncation, and that ordering is
 * load-bearing wherever the output is one item per line (the board's slot
 * rack, the week reminder's fixture list): a name containing a newline would
 * otherwise forge extra rows and make the message lie about its own count.
 *
 * Escaping `<`/`>` also stops a name forging a fake `<t:…>` timestamp or a
 * `<@id>` that LOOKS like a mention — `allowed_mentions: {parse: []}` already
 * stops one resolving, but not from looking real.
 *
 * @param maxLen truncate to this many characters (adding an ellipsis). Only
 *   for fixed-height surfaces; announcements pass nothing, because silently
 *   clipping a team name in a result post is worse than a long line.
 */
export function escapeDiscordText(raw: string, maxLen?: number): string {
  const flat = raw.replace(/[\r\n\t]+/g, " ").trim();
  const trimmed =
    maxLen != null && flat.length > maxLen
      ? `${flat.slice(0, maxLen - 1)}…`
      : flat;
  return (
    trimmed
      .replace(/[\\*_~`|<>[\]()@#-]/g, (c) => `\\${c}`)
      // Escaping brackets kills `[label](evil)`, but Discord ALSO auto-links a
      // BARE url, and none of the characters that make one (`:` `/` `.`) can be
      // escaped without mangling ordinary names. A zero-width space after the
      // scheme breaks the match while leaving the text visually identical — so
      // a persona of "evil.test/free-mmr" can't become a live link.
      .replace(/(https?):\/\//gi, "$1:​//")
      .replace(/\bwww\./gi, "www​.")
  );
}
