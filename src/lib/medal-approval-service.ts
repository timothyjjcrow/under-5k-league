// Medal approvals' reads and writes (rules: medal-approval.ts). A player over
// the medal line, or one the smurf check flags (smurf-check.ts), asks once;
// an admin approves at an MMR, declines, or removes the row. Each admin write
// claims the exact status the admin's list showed, so two admins answering
// at once can't overwrite each other: the second is told the request
// changed. Discord goes from the actions, after the commit, best-effort.

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  APPROVAL_REASON,
  MEDAL_APPROVAL_STATUS,
  ROLE,
  type ApprovalReason,
} from "./constants";
import { raceHook } from "./race-hook";
import { parseAdminSteamIds } from "./users";
import {
  approvalAskPlan,
  approvalReason,
  defaultApprovalMmr,
  parseMedalApprovalNote,
  reasonOnApprove,
  type MedalApprovalFacts,
} from "./medal-approval";
import { parsePubStats } from "./pub-stats";
import { rankTierExactMinMmr } from "./rank";
import {
  parseSmurfSignals,
  serializeSmurfSignals,
  smurfSignalsFromStored,
  smurfSuggestedMmr,
  type SmurfSignal,
} from "./smurf-check";
import type { SessionUser } from "./auth";

/** The approval fields every rule reads (MedalApprovalFacts). */
const APPROVAL_FACTS_SELECT = {
  status: true,
  mmr: true,
  reason: true,
} as const;

/** A player's approval row as the rules read it, or null for none. */
export async function loadMedalApproval(
  userId: string,
): Promise<MedalApprovalFacts | null> {
  return prisma.medalApproval.findUnique({
    where: { userId },
    select: APPROVAL_FACTS_SELECT,
  });
}

export type MedalApprovalAskResult =
  | {
      ok: true;
      playerName: string;
      rankTier: number | null;
      note: string;
      reason: ApprovalReason;
      signals: SmurfSignal[];
    }
  | { ok: false; error: string };

const ALREADY_ASKED =
  "You've already asked. An admin will answer here on the site.";

/**
 * The player's "Ask an admin to approve": one PENDING row with their medal,
 * the reason (a medal over the line first, else the smurf check's findings)
 * and their note. Refused when nothing refuses them or they already have a
 * row; a duplicate submit that loses the unique key reads the row the winner
 * made and answers from it. A smurf check's approval under a medal that has
 * since gone over the line becomes a fresh medal request, claimed on the
 * status the read found, so two tabs can't both turn it.
 */
export async function askMedalApproval(
  viewer: SessionUser,
  rawNote: string,
): Promise<MedalApprovalAskResult> {
  const user = await prisma.user.findUnique({
    where: { id: viewer.id },
    select: {
      name: true,
      rankTier: true,
      pubStats: true,
      medalApproval: { select: { id: true, status: true, reason: true } },
    },
  });
  if (!user) return { ok: false, error: "Sign in again to ask." };
  const signals = smurfSignalsFromStored(user.pubStats, user.rankTier);
  const plan = approvalAskPlan({
    rankTier: user.rankTier,
    signals,
    existing: user.medalApproval,
  });
  if (plan.kind === "refuse") return { ok: false, error: plan.error };
  const note = parseMedalApprovalNote(rawNote);
  const stored = plan.reason === APPROVAL_REASON.SMURF ? signals : [];
  const done = {
    ok: true as const,
    playerName: user.name,
    rankTier: user.rankTier,
    note,
    reason: plan.reason,
    signals: stored,
  };
  await raceHook("medalApproval.ask.beforeWrite");
  if (plan.kind === "convert" && user.medalApproval) {
    // The approval the plan judged, still the one standing: only the ask
    // changes a reason, and only together with the status.
    const turned = await prisma.medalApproval.updateMany({
      where: {
        id: user.medalApproval.id,
        status: MEDAL_APPROVAL_STATUS.APPROVED,
      },
      data: {
        status: MEDAL_APPROVAL_STATUS.PENDING,
        reason: plan.reason,
        signals: "",
        note,
        rankTier: user.rankTier,
        requestedAt: new Date(),
        mmr: null,
        decidedAt: null,
        decidedById: null,
        decidedByName: null,
      },
    });
    if (turned.count === 0) return { ok: false, error: ALREADY_ASKED };
    return done;
  }
  try {
    await prisma.medalApproval.create({
      data: {
        userId: viewer.id,
        status: MEDAL_APPROVAL_STATUS.PENDING,
        note,
        rankTier: user.rankTier,
        reason: plan.reason,
        signals: serializeSmurfSignals(stored),
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const current = await prisma.medalApproval.findUnique({
        where: { userId: viewer.id },
        select: { status: true, reason: true },
      });
      const again = approvalAskPlan({
        rankTier: user.rankTier,
        signals,
        existing: current ?? {
          status: MEDAL_APPROVAL_STATUS.PENDING,
          reason: plan.reason,
        },
      });
      return {
        ok: false,
        error: again.kind === "refuse" ? again.error : ALREADY_ASKED,
      };
    }
    throw error;
  }
  return done;
}

/** The statuses an admin's Approve or Remove may claim (what the list showed). */
function judgedStatusOf(raw: string): string | null {
  return raw === MEDAL_APPROVAL_STATUS.PENDING ||
    raw === MEDAL_APPROVAL_STATUS.APPROVED ||
    raw === MEDAL_APPROVAL_STATUS.DECLINED
    ? raw
    : null;
}

export type MedalApprovalDecision =
  | { ok: true; name: string; discordId: string | null; reason: ApprovalReason }
  | { ok: false; error: string };

const CHANGED =
  "That request just changed (another admin may have answered it). Reload and look again.";

async function decisionSubject(approvalId: string) {
  return prisma.medalApproval.findUnique({
    where: { id: approvalId },
    select: {
      reason: true,
      user: { select: { name: true, discordId: true, rankTier: true } },
    },
  });
}

/**
 * Approve a request at the MMR the admin typed. `judgedStatus` is the status
 * the admin's list showed (PENDING, or DECLINED, which can still be
 * approved), claimed in the WHERE: a request another admin answered since is
 * refused, never overwritten.
 */
export async function approveMedalRequest(
  admin: SessionUser,
  input: { approvalId: string; judgedStatus: string; mmr: number },
): Promise<MedalApprovalDecision> {
  if (admin.role !== ROLE.ADMIN) return { ok: false, error: "Admins only" };
  const judgedStatus = judgedStatusOf(input.judgedStatus);
  if (
    !input.approvalId ||
    (judgedStatus !== MEDAL_APPROVAL_STATUS.PENDING &&
      judgedStatus !== MEDAL_APPROVAL_STATUS.DECLINED)
  ) {
    return { ok: false, error: "Choose a request to approve." };
  }
  const subject = await decisionSubject(input.approvalId);
  if (!subject) return { ok: false, error: "That request no longer exists." };
  // A smurf check's request whose medal has since gone over the line is
  // answered for the medal too (reasonOnApprove), so the approval lets in
  // the player the admin just approved.
  const reason = reasonOnApprove(subject.reason, subject.user.rankTier);
  await raceHook("medalApproval.approve.beforeWrite");
  const claimed = await prisma.medalApproval.updateMany({
    where: { id: input.approvalId, status: judgedStatus },
    data: {
      status: MEDAL_APPROVAL_STATUS.APPROVED,
      mmr: input.mmr,
      reason,
      decidedAt: new Date(),
      decidedById: admin.id,
      decidedByName: admin.name,
    },
  });
  if (claimed.count === 0) return { ok: false, error: CHANGED };
  return {
    ok: true,
    name: subject.user.name,
    discordId: subject.user.discordId,
    reason,
  };
}

/** Decline a PENDING request; one already answered is refused. */
export async function declineMedalRequest(
  admin: SessionUser,
  approvalId: string,
): Promise<MedalApprovalDecision> {
  if (admin.role !== ROLE.ADMIN) return { ok: false, error: "Admins only" };
  if (!approvalId) return { ok: false, error: "Choose a request to decline." };
  const subject = await decisionSubject(approvalId);
  if (!subject) return { ok: false, error: "That request no longer exists." };
  await raceHook("medalApproval.decline.beforeWrite");
  const claimed = await prisma.medalApproval.updateMany({
    where: { id: approvalId, status: MEDAL_APPROVAL_STATUS.PENDING },
    data: {
      status: MEDAL_APPROVAL_STATUS.DECLINED,
      decidedAt: new Date(),
      decidedById: admin.id,
      decidedByName: admin.name,
    },
  });
  if (claimed.count === 0) return { ok: false, error: CHANGED };
  return {
    ok: true,
    name: subject.user.name,
    discordId: subject.user.discordId,
    reason: approvalReason(subject.reason),
  };
}

export type MedalApprovalRemoval =
  | { ok: true; name: string; wasApproved: boolean }
  | { ok: false; error: string };

/**
 * Remove a request or an approval, whichever the admin's list showed. The
 * player is back where they started: their medal is judged again at signup
 * and at every inhouse join, and they may ask again. Nothing they already
 * have (a signup, a queue spot) is touched.
 */
export async function removeMedalApproval(
  admin: SessionUser,
  input: { approvalId: string; judgedStatus: string },
): Promise<MedalApprovalRemoval> {
  if (admin.role !== ROLE.ADMIN) return { ok: false, error: "Admins only" };
  const judgedStatus = judgedStatusOf(input.judgedStatus);
  if (!input.approvalId || !judgedStatus) {
    return { ok: false, error: "Choose a request to remove." };
  }
  const subject = await decisionSubject(input.approvalId);
  if (!subject) return { ok: false, error: "That request no longer exists." };
  await raceHook("medalApproval.remove.beforeWrite");
  const removed = await prisma.medalApproval.deleteMany({
    where: { id: input.approvalId, status: judgedStatus },
  });
  if (removed.count === 0) return { ok: false, error: CHANGED };
  return {
    ok: true,
    name: subject.user.name,
    wasApproved: judgedStatus === MEDAL_APPROVAL_STATUS.APPROVED,
  };
}

/**
 * The Discord accounts of the league's admins, for the bot's direct message
 * when a player asks: the ADMIN_STEAM_IDS allowlist when it is set (the one
 * source of truth, resolveSessionRole), else, in local development only,
 * the stored role. Only linked accounts.
 */
export async function adminDiscordIds(): Promise<string[]> {
  const steamIds = parseAdminSteamIds(process.env.ADMIN_STEAM_IDS);
  if (steamIds.length === 0 && process.env.NODE_ENV === "production") return [];
  const admins = await prisma.user.findMany({
    where:
      steamIds.length > 0
        ? { steamId: { in: steamIds }, discordId: { not: null } }
        : { role: ROLE.ADMIN, discordId: { not: null } },
    orderBy: { id: "asc" },
    select: { discordId: true },
  });
  return admins.flatMap((a) => (a.discordId ? [a.discordId] : []));
}

/** One row of the admin's list: display fields only. */
export type MedalApprovalAdminRow = {
  id: string;
  status: string;
  /** Why they asked: the medal, or the smurf check. */
  reason: ApprovalReason;
  /** The smurf check's findings when they asked ([] for a medal request). */
  signals: SmurfSignal[];
  note: string;
  /** The medal when they asked. */
  askedRankTier: number | null;
  requestedAt: Date;
  mmr: number | null;
  /** The Approve box's starting number (defaultApprovalMmr, or for a smurf
   *  check where their ranked lobbies put them: smurfSuggestedMmr). */
  suggestedMmr: number | null;
  decidedAt: Date | null;
  decidedByName: string | null;
  user: { id: string; name: string; rankTier: number | null };
};

/** Pending first (oldest first), then the answered ones (newest first). */
export function sortMedalApprovalRows<
  T extends { id: string; status: string; requestedAt: Date; decidedAt: Date | null },
>(rows: T[]): T[] {
  const pending = rows
    .filter((r) => r.status === MEDAL_APPROVAL_STATUS.PENDING)
    .sort(
      (a, b) =>
        a.requestedAt.getTime() - b.requestedAt.getTime() || a.id.localeCompare(b.id),
    );
  const answered = rows
    .filter((r) => r.status !== MEDAL_APPROVAL_STATUS.PENDING)
    .sort(
      (a, b) =>
        (b.decidedAt ?? b.requestedAt).getTime() -
          (a.decidedAt ?? a.requestedAt).getTime() || a.id.localeCompare(b.id),
    );
  return [...pending, ...answered];
}

/** Every request and approval, for /admin's Medal limit and smurf checks. */
export async function loadMedalApprovalAdminRows(): Promise<MedalApprovalAdminRow[]> {
  const rows = await prisma.medalApproval.findMany({
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    take: 200,
    select: {
      id: true,
      status: true,
      reason: true,
      signals: true,
      note: true,
      rankTier: true,
      requestedAt: true,
      mmr: true,
      decidedAt: true,
      decidedByName: true,
      user: { select: { id: true, name: true, rankTier: true, pubStats: true } },
    },
  });
  return sortMedalApprovalRows(
    rows.map(({ rankTier, reason: rawReason, signals, user: { pubStats, ...user }, ...row }) => {
      const reason = approvalReason(rawReason);
      const medal = user.rankTier ?? rankTier;
      return {
        ...row,
        reason,
        signals: parseSmurfSignals(signals),
        askedRankTier: rankTier,
        suggestedMmr:
          reason === APPROVAL_REASON.SMURF
            ? smurfSuggestedMmr({
                pub: parsePubStats(pubStats),
                medalFloor: rankTierExactMinMmr(medal),
              })
            : defaultApprovalMmr(medal),
        user,
      };
    }),
  );
}
