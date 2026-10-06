// Last season's players who haven't signed up for this one, and the post an
// admin pastes into Discord to bring them back. Pure and prisma-free: the
// copy button is a "use client" component (the ChaseCopy rule), so the
// database read lives in returning-players-service.ts.

import { pasteSafeName } from "./discord-reach";

export type ReturningPlayer = { name: string; discordId: string | null };

export type ReturningPlayers = {
  /** The latest earlier season, as players knew it. */
  previousSeasonName: string;
  /** Its signups, removed ones aside. */
  previous: number;
  /** Of them, signed up (active) for this season. */
  back: number;
  /** Of them, with no signup this season at all. Anyone who withdrew or was
   *  removed this season made their own choice, so they are left alone. */
  notBack: ReturningPlayer[];
};

/** Discord's message limit, less room for the "and N more" tail. */
const MESSAGE_BUDGET = 2000 - 24;
const DISCORD_ID = /^\d{17,20}$/;

/**
 * The returning-player reminder: the season's progress, that last season's
 * answers carry over (the one-tap rejoin card on /me), and everyone not back
 * yet: a mention for each player with Discord linked (the ping is the point,
 * and it's the admin's paste that sends it) and a name for the rest. Packed
 * under Discord's 2,000 characters with "and N more". Null when everyone is
 * back.
 */
export function returningReminderMessage(
  players: ReturningPlayers,
  opts: { seasonName: string; signedUp: number; signupUrl: string },
): string | null {
  if (players.notBack.length === 0) return null;
  const head = [
    `📣 **${pasteSafeName(opts.seasonName)} signups are open**: ${opts.signedUp} player${opts.signedUp === 1 ? "" : "s"} in so far, and every few more is another team.`,
    `Played in ${pasteSafeName(players.previousSeasonName)}? Your roles, heroes and MMR carry over, so rejoining is one tap: <${opts.signupUrl}>`,
  ].join("\n");
  const tags = players.notBack.map((player) =>
    player.discordId && DISCORD_ID.test(player.discordId)
      ? `<@${player.discordId}>`
      : pasteSafeName(player.name),
  );
  let line = "";
  let shown = 0;
  for (const tag of tags) {
    const next = line ? `${line}, ${tag}` : tag;
    if (head.length + 1 + next.length > MESSAGE_BUDGET) break;
    line = next;
    shown += 1;
  }
  const more = tags.length - shown;
  return `${head}\n${line}${more > 0 ? ` and ${more} more` : ""}`;
}
