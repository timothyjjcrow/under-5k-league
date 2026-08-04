import { prisma } from "./prisma";
import { getSessionUser } from "./auth";

/**
 * Record what an admin did.
 *
 * Nineteen models carry no actor column, and Discord — the de-facto audit
 * trail — announces signups, sales, results and the champion but is SILENT on
 * exactly the destructive half of the panel: nothing announces a schedule
 * regenerate, a team deletion, an aborted draft or a bracket reset. So the one
 * question a worried admin actually asks — "what did I press, and when?" — had
 * no answer anywhere, retroactively or otherwise.
 *
 * Two rules, both deliberate:
 *
 * 1. BEST-EFFORT. A failed log write must never fail the mutation it describes.
 *    A missing line is a smaller problem than a half-applied league change, and
 *    this is called after the write has already committed.
 * 2. Called from ONE helper, never inlined. The log is only worth having if it
 *    is consistent, and a summary hand-rolled at twenty call sites drifts
 *    within a month.
 *
 * The summary should already contain the numbers that made the action
 * destructive ("cleared 43 check-ins"), because the row is the whole record —
 * there is nothing else to join against after the fact.
 */
export async function logAdminAction(opts: {
  /** Stable machine key matching the action's export name. */
  action: string;
  summary: string;
  seasonId?: string | null;
  /** Preserve the actor for break-glass actions that revoke their own cookie. */
  actor?: { id: string; name: string };
}): Promise<void> {
  try {
    // Resolved here rather than threaded through every call site: each of these
    // actions has already passed `requireAdmin()`, so the session IS the actor,
    // and adding a parameter to sixteen signatures is exactly the kind of churn
    // that makes people skip the log on the seventeenth.
    const actor = opts.actor ?? (await getSessionUser());
    await prisma.adminAction.create({
      data: {
        actorId: actor?.id ?? "unknown",
        // Denormalised: the Steam profile sync renames users, and a join would
        // rewrite history to match whatever they are called today.
        actorName: actor?.name || "(unknown)",
        action: opts.action,
        summary: opts.summary.slice(0, 500),
        seasonId: opts.seasonId ?? null,
      },
    });
  } catch {
    // Swallowed on purpose — see rule 1.
  }
}

/** Most recent admin actions, newest first, for the panel's activity card.
 *  `id desc` is the determinism tiebreak: createdAt is timestamp(3) on
 *  Postgres, two quick writes can land in the same millisecond, and a sort on
 *  the tied key alone returns them in arbitrary (usually insert) order — which
 *  flaked CI exactly once. Cuids are time-prefixed with a per-process counter,
 *  so id desc orders same-millisecond rows newest-first correctly. */
export async function recentAdminActions(limit = 40) {
  return prisma.adminAction.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
}
