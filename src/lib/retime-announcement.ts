// Discord notice for an admin retime (Set time, or the week mover). Runs after
// the retime has committed and never throws: a Discord or read failure must
// not turn a successful schedule change into an error toast.

import { prisma } from "@/lib/prisma";
import { MATCH_PHASE } from "./constants";
import { adminRetimeMessage, sendDiscordMessage } from "./discord";
import { mentionUsers } from "./discord-mentions";
import { isPlayoffPhase } from "./league-lifecycle";

export async function announceAdminRetime(
  matchIds: string[],
  clearedRsvps: number,
): Promise<boolean> {
  if (matchIds.length === 0) return false;
  try {
    const matches = await prisma.match.findMany({
      where: { id: { in: matchIds } },
      orderBy: [{ scheduledAt: "asc" }, { week: "asc" }, { id: "asc" }],
      select: {
        id: true,
        week: true,
        phase: true,
        scheduledAt: true,
        homeTeam: { select: { name: true, captainId: true } },
        awayTeam: { select: { name: true, captainId: true } },
        standins: { select: { standinUserId: true } },
      },
    });
    if (matches.length === 0) return false;
    const content = adminRetimeMessage({
      clearedRsvps,
      moves: matches.map((match) => ({
        matchId: match.id,
        homeName: match.homeTeam.name,
        awayName: match.awayTeam.name,
        week: match.week,
        isPlayoff: isPlayoffPhase(match.phase),
        isTiebreaker: match.phase === MATCH_PHASE.TIEBREAKER,
        whenMs: match.scheduledAt?.getTime() ?? null,
      })),
    });
    // Both captains of every moved fixture, plus anyone booked to stand in:
    // their assignment message quoted the old kickoff.
    const mentions = await mentionUsers(
      matches.flatMap((match) => [
        match.homeTeam.captainId,
        match.awayTeam.captainId,
        ...match.standins.map((s) => s.standinUserId),
      ]),
    );
    return await sendDiscordMessage(content, mentions);
  } catch {
    return false;
  }
}
