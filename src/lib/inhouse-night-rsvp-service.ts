// "I'm in" on the site for the planned inhouse night (rules:
// inhouse-night.ts). One InhouseNightRsvp row per player for the night.
// Discord's Interested button can't be pressed from here (Discord lets
// members mark only themselves), so the site keeps its own list, and Home
// and /inhouse add the two up (inhouseNightHeadcount).
//
// Rivals: an admin's save or cancel is the only other writer of the night,
// and it can land between a player's check that the night is current and the
// insert. The worst it leaves is a row for a night that is gone: every read
// filters by the current night's id, and planning the next night or
// cancelling prunes the rows of any other night (inhouse-night-service.ts).
// Two taps by one player meet at the primary key, and the second reads as
// already in.

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { UserFacingError } from "./user-facing-error";
import { guildEventInterested } from "./discord-roles";
import {
  currentInhouseNight,
  inhouseNightHeadcount,
  inhouseNightRsvpOpen,
  type InhouseNight,
  type InhouseNightHeadcount,
} from "./inhouse-night";
import { readInhouseNight } from "./inhouse-night-service";

/** A player who said "I'm in", for the page: display fields only. */
export type InhouseNightRsvpPlayer = { id: string; name: string; avatar: string | null };

export type InhouseNightRsvps = {
  /** First to say so first. */
  players: InhouseNightRsvpPlayer[];
  /** One per player, their linked Discord id or null. Server-side only: it
   *  feeds the headcount and must never reach a client component. */
  discordIds: (string | null)[];
};

/** Everyone who said "I'm in" for this night, first to say so first. */
export async function readInhouseNightRsvps(nightId: string): Promise<InhouseNightRsvps> {
  const rows = await prisma.inhouseNightRsvp.findMany({
    where: { nightId },
    orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
    select: {
      user: { select: { id: true, name: true, avatar: true, discordId: true } },
    },
  });
  return {
    players: rows.map(({ user }) => ({ id: user.id, name: user.name, avatar: user.avatar })),
    discordIds: rows.map(({ user }) => user.discordId),
  };
}

/**
 * Who's coming (inhouseNightHeadcount): the site's list plus the Discord
 * event's Interested members, read live and reused for a couple of minutes
 * (guildEventInterested). Every place that shows the count asks here.
 */
export async function inhouseNightHeadcountFor(
  night: InhouseNight,
  siteDiscordIds: (string | null)[],
): Promise<InhouseNightHeadcount> {
  const discordIds = night.discordEventId
    ? await guildEventInterested(night.discordEventId)
    : [];
  return inhouseNightHeadcount(siteDiscordIds, discordIds);
}

export type InhouseNightRsvpOutcome = "in" | "already-in" | "out" | "already-out";

export type InhouseNightRsvpResult = {
  outcome: InhouseNightRsvpOutcome;
  /** The night it was for (null for a take-back of a night no longer shown). */
  night: InhouseNight | null;
  /** Whether the player has a linked Discord account (the start post pings
   *  only linked players). */
  linked: boolean;
};

/**
 * Say "I'm in" for the night on the page (`going`), or take it back. Saying
 * so needs the night the page showed to still be the planned one and not yet
 * started; taking it back always works, even for a night that has changed.
 */
export async function setInhouseNightRsvp(input: {
  userId: string;
  nightId: string;
  going: boolean;
  nowMs?: number;
}): Promise<InhouseNightRsvpResult> {
  const nowMs = input.nowMs ?? Date.now();
  const { night: stored } = await readInhouseNight();
  const night = currentInhouseNight(stored, nowMs);
  const shown = night?.id === input.nightId ? night : null;

  if (!input.going) {
    const removed = await prisma.inhouseNightRsvp.deleteMany({
      where: { nightId: input.nightId, userId: input.userId },
    });
    return {
      outcome: removed.count > 0 ? "out" : "already-out",
      night: shown,
      linked: await isLinked(input.userId),
    };
  }

  if (!shown) {
    throw new UserFacingError(
      "That inhouse night has changed or is over. Reload the page to see the current one.",
    );
  }
  if (!inhouseNightRsvpOpen(shown, nowMs)) {
    throw new UserFacingError(
      "The inhouse night has started: join the queue on the inhouse page instead.",
    );
  }
  let outcome: InhouseNightRsvpOutcome = "in";
  try {
    await prisma.inhouseNightRsvp.create({
      data: { nightId: shown.id, userId: input.userId },
    });
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    ) {
      throw error;
    }
    outcome = "already-in";
  }
  return { outcome, night: shown, linked: await isLinked(input.userId) };
}

async function isLinked(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { discordId: true },
  });
  return !!user?.discordId;
}
