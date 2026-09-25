import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { recordHistoryAction, type HistoryActor } from "./roster-history";

/** Complete, private receipts before a fixture cascade. The caller owns the
 * transaction and must retain its original claim/serialization protections. */
export async function archiveFixtureHistory(tx: Prisma.TransactionClient, opts: {
  seasonId: string;
  matchIds: string[];
  actor: HistoryActor;
  intent: string;
  action?: string;
  now?: Date;
}): Promise<void> {
  if (opts.matchIds.length === 0) return;
  const fixtures = await tx.match.findMany({
    where: { seasonId: opts.seasonId, id: { in: opts.matchIds } },
    orderBy: [{ week: "asc" }, { id: "asc" }],
    include: {
      games: { orderBy: { id: "asc" }, include: { participants: { orderBy: { sourceLineIndex: "asc" } } } },
      lineups: { orderBy: [{ teamId: "asc" }, { revision: "asc" }], include: { seats: { orderBy: { seatKey: "asc" } } } },
      standins: { orderBy: { id: "asc" } },
      availability: { orderBy: { id: "asc" } },
      predictions: { orderBy: { id: "asc" } },
      reschedules: { orderBy: { id: "asc" } },
      coverRequests: { orderBy: { id: "asc" }, include: {
        volunteers: { orderBy: { id: "asc" } },
        offers: { orderBy: { id: "asc" } },
        decisions: { orderBy: { id: "asc" } },
      } },
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
  });
  const operationId = randomUUID();
  const capturedAt = (opts.now ?? new Date()).toISOString();
  for (const fixture of fixtures) {
    await recordHistoryAction(tx, opts.actor, opts.seasonId,
      opts.action ?? "archiveRemovedFixture",
      `Preserved fixture ${fixture.id} before ${opts.intent}`,
      { operationId, intent: opts.intent, capturedAt, fixture });
  }
}
