// Medal approvals' reads and writes (rules: medal-approval.ts). A player over
// the medal line asks once; an admin approves at an MMR, declines, or
// removes the row. Each admin write claims the exact status the admin's list
// showed, so two admins answering at once can't overwrite each other: the
// second is told the request changed. Discord goes from the actions, after
// the commit, best-effort.

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { MEDAL_APPROVAL_STATUS, ROLE } from "./constants";
import { raceHook } from "./race-hook";
import { parseAdminSteamIds } from "./users";
import {
  medalApprovalAskRefusal,
  parseMedalApprovalNote,
  type MedalApprovalFacts,
} from "./medal-approval";
import type { SessionUser } from "./auth";

/** A player's approval row as the rules read it, or null for none. */
export async function loadMedalApproval(
  userId: string,
): Promise<MedalApprovalFacts | null> {
  return prisma.medalApproval.findUnique({
    where: { userId },
    select: { status: true, mmr: true },
  });
}

export type MedalApprovalAskResult =
  | { ok: true; playerName: string; rankTier: number | null; note: string }
  | { ok: false; error: string };

/**
 * The player's "Ask an admin to approve": one PENDING row with their medal
 * and note. Refused when their medal isn't over the line or they already
 * have a row; a duplicate submit that loses the unique key reads the row the
 * winner made and answers from it.
 */
export async function askMedalApproval(
  viewer: SessionUser,
  rawNote: string,
): Promise<MedalApprovalAskResult> {
  const user = await prisma.user.findUnique({
    where: { id: viewer.id },
    select: { name: true, rankTier: true, medalApproval: { select: { status: true } } },
  });
  if (!user) return { ok: false, error: "Sign in again to ask." };
  const refusal = medalApprovalAskRefusal({
    rankTier: user.rankTier,
    existingStatus: user.medalApproval?.status ?? null,
  });
  if (refusal) return { ok: false, error: refusal };
  const note = parseMedalApprovalNote(rawNote);
  await raceHook("medalApproval.ask.beforeWrite");
  try {
    await prisma.medalApproval.create({
      data: {
        userId: viewer.id,
        status: MEDAL_APPROVAL_STATUS.PENDING,
        note,
        rankTier: user.rankTier,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const current = await prisma.medalApproval.findUnique({
        where: { userId: viewer.id },
        select: { status: true },
      });
      return {
        ok: false,
        error:
          medalApprovalAskRefusal({
            rankTier: user.rankTier,
            existingStatus: current?.status ?? MEDAL_APPROVAL_STATUS.PENDING,
          }) ?? "You've already asked.",
      };
    }
    throw error;
  }
  return { ok: true, playerName: user.name, rankTier: user.rankTier, note };
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
  | { ok: true; name: string; discordId: string | null }
  | { ok: false; error: string };

const CHANGED =
  "That request just changed (another admin may have answered it). Reload and look again.";

async function decisionSubject(approvalId: string) {
  return prisma.medalApproval.findUnique({
    where: { id: approvalId },
    select: { user: { select: { name: true, discordId: true } } },
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
  await raceHook("medalApproval.approve.beforeWrite");
  const claimed = await prisma.medalApproval.updateMany({
    where: { id: input.approvalId, status: judgedStatus },
    data: {
      status: MEDAL_APPROVAL_STATUS.APPROVED,
      mmr: input.mmr,
      decidedAt: new Date(),
      decidedById: admin.id,
      decidedByName: admin.name,
    },
  });
  if (claimed.count === 0) return { ok: false, error: CHANGED };
  return { ok: true, name: subject.user.name, discordId: subject.user.discordId };
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
  return { ok: true, name: subject.user.name, discordId: subject.user.discordId };
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
  note: string;
  /** The medal when they asked. */
  askedRankTier: number | null;
  requestedAt: Date;
  mmr: number | null;
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

/** Every request and approval, for /admin's Medal limit approvals section. */
export async function loadMedalApprovalAdminRows(): Promise<MedalApprovalAdminRow[]> {
  const rows = await prisma.medalApproval.findMany({
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    take: 200,
    select: {
      id: true,
      status: true,
      note: true,
      rankTier: true,
      requestedAt: true,
      mmr: true,
      decidedAt: true,
      decidedByName: true,
      user: { select: { id: true, name: true, rankTier: true } },
    },
  });
  return sortMedalApprovalRows(
    rows.map(({ rankTier, ...row }) => ({ ...row, askedRankTier: rankTier })),
  );
}
