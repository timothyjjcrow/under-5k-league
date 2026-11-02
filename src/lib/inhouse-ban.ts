// Inhouse bans (Tim, 2026-11-02). Pure: the lengths an admin picks, the
// form's rules, what "active" means, the worker's Discord role decisions and
// the words players and admins see. The writes are inhouse-ban-service.ts;
// the queue joins refuse a banned player inside their own transactions
// (joinQueue, joinDuelQueue), and the requeues skip one.

import { formatLeagueMatchTime } from "./match-time";

const DAY_MS = 86_400_000;

/** What an admin picks. `ms` null is permanent. */
export const INHOUSE_BAN_LENGTHS = [
  { key: "1d", label: "1 day", ms: DAY_MS },
  { key: "3d", label: "3 days", ms: 3 * DAY_MS },
  { key: "1w", label: "1 week", ms: 7 * DAY_MS },
  { key: "2w", label: "2 weeks", ms: 14 * DAY_MS },
  { key: "30d", label: "30 days", ms: 30 * DAY_MS },
  { key: "permanent", label: "Permanent", ms: null },
] as const;

export type InhouseBanLengthKey = (typeof INHOUSE_BAN_LENGTHS)[number]["key"];

/** The length the ban form starts on: Tim's "like a week or so". */
export const INHOUSE_BAN_DEFAULT_LENGTH: InhouseBanLengthKey = "1w";

/** Long enough for a sentence, short enough for one line on the board. */
export const INHOUSE_BAN_REASON_MAX = 200;

/** The worker gives a missing role again at most this often. */
export const INHOUSE_BAN_ROLE_GRANT_RETRY_MS = 30 * 60_000;
/** A removal Discord refused is tried again this often. */
export const INHOUSE_BAN_ROLE_REMOVE_RETRY_MS = 5 * 60_000;

export type InhouseBanInput = {
  userId: string;
  length: InhouseBanLengthKey;
  reason: string;
};

/** A ban as the rules need it. */
export type InhouseBanTimes = {
  endsAt: Date | null;
  liftedAt: Date | null;
};

/** Running now: not lifted, and permanent or ending after `nowMs`. */
export function inhouseBanActive(ban: InhouseBanTimes, nowMs: number): boolean {
  if (ban.liftedAt) return false;
  return ban.endsAt === null || ban.endsAt.getTime() > nowMs;
}

/** When a ban of this length, made at `nowMs`, ends (null = permanent). */
export function inhouseBanEndsAt(length: InhouseBanLengthKey, nowMs: number): Date | null {
  const choice = INHOUSE_BAN_LENGTHS.find((l) => l.key === length);
  if (!choice || choice.ms === null) return null;
  return new Date(nowMs + choice.ms);
}

/** One line, no control characters, at most INHOUSE_BAN_REASON_MAX. */
export function cleanInhouseBanReason(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, INHOUSE_BAN_REASON_MAX)
    .trim();
}

/** Read the ban form: a player, one of the lengths and a reason. */
export function parseInhouseBanForm(
  form: FormData,
): { ok: true; input: InhouseBanInput } | { ok: false; error: string } {
  const userId = form.get("userId");
  if (typeof userId !== "string" || userId.trim() === "") {
    return { ok: false, error: "Choose a player." };
  }
  const length = form.get("length");
  const choice = INHOUSE_BAN_LENGTHS.find((l) => l.key === length);
  if (!choice) return { ok: false, error: "Choose how long the ban lasts." };
  const rawReason = form.get("reason");
  const reason = cleanInhouseBanReason(typeof rawReason === "string" ? rawReason : "");
  if (!reason) {
    return {
      ok: false,
      error: "Write the reason. Players see it on /inhouse and the Discord board.",
    };
  }
  return { ok: true, input: { userId: userId.trim(), length: choice.key, reason } };
}

/** The /inhouse section the bans card sits in, and the board links to. */
export const INHOUSE_BANS_ANCHOR = "inhouse-bans";

/** A running ban as /inhouse, the board and the admin page show it. */
export type InhouseBanView = {
  id: string;
  userId: string;
  name: string;
  avatar: string | null;
  reason: string;
  createdAtMs: number;
  /** Null = permanent. */
  endsAtMs: number | null;
};

/** A stored row with its player's name, as the service reads it. */
export type InhouseBanRow = InhouseBanTimes & {
  id: string;
  userId: string;
  reason: string;
  createdAt: Date;
  user: { name: string; avatar: string | null };
};

/** Does `a` last longer than `b`? Permanent outlasts any end. */
function outlasts(a: number | null, b: number | null): boolean {
  if (a === null) return b !== null;
  if (b === null) return false;
  return a > b;
}

/**
 * The bans running at `nowMs`, one per player (the one that lasts longest,
 * should two admins ever leave two), newest first, by exact keys. The room
 * and the worker both build the board from this, so it must stay a pure
 * function of the rows and the clock.
 */
export function activeInhouseBans(rows: InhouseBanRow[], nowMs: number): InhouseBanView[] {
  const byUser = new Map<string, InhouseBanView>();
  for (const row of rows) {
    if (!inhouseBanActive(row, nowMs)) continue;
    const view: InhouseBanView = {
      id: row.id,
      userId: row.userId,
      name: row.user.name,
      avatar: row.user.avatar,
      reason: row.reason,
      createdAtMs: row.createdAt.getTime(),
      endsAtMs: row.endsAt ? row.endsAt.getTime() : null,
    };
    const held = byUser.get(row.userId);
    if (!held || outlasts(view.endsAtMs, held.endsAtMs)) byUser.set(row.userId, view);
  }
  return [...byUser.values()].sort(
    (a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id),
  );
}

/** "until Sun, Nov 9, 6:00 PM ET" on the league's clock, or "permanently". */
export function inhouseBanUntilText(endsAt: Date | null): string {
  return endsAt ? `until ${formatLeagueMatchTime(endsAt, "full")}` : "permanently";
}

/**
 * What a banned player is told where Join would be, and by a refused join.
 * Server-written, so the time is on the league's clock with its zone named.
 */
export function inhouseBanRefusal(ban: { endsAt: Date | null; reason: string }): string {
  return `You're banned from inhouse games ${inhouseBanUntilText(ban.endsAt)}. Reason: ${ban.reason}`;
}

/** How the bot's role call went, for the admin's toast. */
export type InhouseBanRoleOutcome =
  | "given"
  | "removed"
  | "off" // no ban role set, no bot, or Discord writes are off here
  | "not-linked"
  | "not-in-server"
  | "forbidden"
  | "failed";

/** One sentence about the Discord role, or "" when there is nothing to say. */
export function inhouseBanRoleNote(outcome: InhouseBanRoleOutcome, on: boolean): string {
  switch (outcome) {
    case "given":
      return "They have the Inhouse Banned role in Discord.";
    case "removed":
      return "The Inhouse Banned role is off them in Discord.";
    case "off":
      return on
        ? "No Discord ban role is set, so Discord was left alone."
        : "";
    case "not-linked":
      return on ? "They have no linked Discord, so no role was given." : "";
    case "not-in-server":
      return on
        ? "Their Discord isn't in the server, so no role was given yet: the site tries again every 30 minutes."
        : "";
    case "forbidden":
      return "The bot isn't allowed to change that role: its own role must sit above Inhouse Banned in Server Settings → Roles.";
    case "failed":
      return on
        ? "Discord didn't answer, so the role wasn't given yet: the site tries again shortly."
        : "Discord didn't answer, so the role is still on them: the site tries again in a few minutes.";
  }
}

/** The admin's toast after a ban. */
export function inhouseBanSavedMessage(saved: {
  name: string;
  endsAt: Date | null;
  replaced: boolean;
  leftQueues: boolean;
  liveGame: string | null;
  role: InhouseBanRoleOutcome;
}): string {
  const parts = [
    `${saved.name} is banned from inhouse ${inhouseBanUntilText(saved.endsAt)}.`,
  ];
  if (saved.replaced) parts.push("This replaces their earlier ban.");
  if (saved.leftQueues) parts.push("They're out of the queue.");
  if (saved.liveGame) {
    parts.push(
      `They're still in ${saved.liveGame}: cancel it from the room if they shouldn't play it.`,
    );
  }
  const role = inhouseBanRoleNote(saved.role, true);
  if (role) parts.push(role);
  return parts.join(" ");
}

/** The admin's toast after lifting a ban. */
export function inhouseBanLiftedMessage(name: string, role: InhouseBanRoleOutcome): string {
  const note = inhouseBanRoleNote(role, false);
  return [`${name}'s inhouse ban is lifted: they can queue again.`, note]
    .filter(Boolean)
    .join(" ");
}

/** One summary for the admin log. */
export function inhouseBanLogSummary(saved: {
  name: string;
  endsAt: Date | null;
  reason: string;
}): string {
  return `Banned ${saved.name} from inhouse ${inhouseBanUntilText(saved.endsAt)}: ${saved.reason}`;
}

// ---------------------------------------------------------------------------
// The Discord role. The bot gives the role when a ban is made and takes it
// off when the ban ends or is lifted. Discord has no timed roles, so the end
// is the worker's (syncInhouseBanRoles), and the automation gate wakes it
// from the same rules below.
// ---------------------------------------------------------------------------

/** An unsettled ban, as the worker and the gate read it. */
export type InhouseBanRoleRow = InhouseBanTimes & {
  roleAddedAt: Date | null;
  roleTriedAt: Date | null;
  /** The player's linked Discord account, if any. */
  discordId: string | null;
};

export type InhouseBanRoleStep =
  | { kind: "wait" }
  | { kind: "grant" }
  | { kind: "remove" }
  /** Over, with nothing in Discord to undo: mark it settled. */
  | { kind: "settle" };

/** When the ban stopped running: lifted, or its end passed. */
function endedAtMs(ban: InhouseBanTimes): number {
  return ban.liftedAt?.getTime() ?? ban.endsAt?.getTime() ?? 0;
}

/**
 * What the worker does with one unsettled ban now. `roleOn`: a ban role is
 * set and the bot may write here. `otherActive`: the player has another ban
 * running (it owns the role, so this one only settles).
 */
export function inhouseBanRoleStep(
  row: InhouseBanRoleRow,
  nowMs: number,
  ctx: { roleOn: boolean; otherActive: boolean },
): InhouseBanRoleStep {
  if (inhouseBanActive(row, nowMs)) {
    if (!ctx.roleOn || !row.discordId || row.roleAddedAt) return { kind: "wait" };
    const triedMs = row.roleTriedAt?.getTime() ?? null;
    if (triedMs !== null && triedMs + INHOUSE_BAN_ROLE_GRANT_RETRY_MS > nowMs) {
      return { kind: "wait" };
    }
    return { kind: "grant" };
  }
  // Over. Nothing to take off: no role set or no account, a newer ban that
  // owns the role, or no role call ever made.
  if (!ctx.roleOn || !row.discordId || ctx.otherActive) return { kind: "settle" };
  if (!row.roleAddedAt && !row.roleTriedAt) return { kind: "settle" };
  const triedMs = row.roleTriedAt?.getTime() ?? null;
  // The first try at the end goes at once; a refused one waits its retry.
  if (
    triedMs !== null &&
    triedMs > endedAtMs(row) &&
    triedMs + INHOUSE_BAN_ROLE_REMOVE_RETRY_MS > nowMs
  ) {
    return { kind: "wait" };
  }
  return { kind: "remove" };
}

/**
 * The earliest moment the worker has ban work: a ban's end (the board drops
 * it and the role comes off), a role to give or a removal to retry. Null =
 * none. The automation gate wakes the worker then; keep it in step with
 * inhouseBanRoleStep, whose "wait" answers are exactly the deadlines here.
 */
export function inhouseBanWakeAtMs(
  rows: InhouseBanRoleRow[],
  nowMs: number,
  roleOn: boolean,
): number | null {
  let wake: number | null = null;
  const at = (ms: number) => {
    const clamped = Math.max(nowMs, ms);
    if (wake === null || clamped < wake) wake = clamped;
  };
  for (const row of rows) {
    if (inhouseBanActive(row, nowMs)) {
      if (row.endsAt) at(row.endsAt.getTime() + 1);
      if (roleOn && row.discordId && !row.roleAddedAt) {
        const triedMs = row.roleTriedAt?.getTime() ?? null;
        at(triedMs === null ? nowMs : triedMs + INHOUSE_BAN_ROLE_GRANT_RETRY_MS);
      }
      continue;
    }
    // Over: settles or removes now, unless a refused removal waits its retry.
    const triedMs = row.roleTriedAt?.getTime() ?? null;
    const waiting =
      roleOn &&
      row.discordId !== null &&
      triedMs !== null &&
      triedMs > endedAtMs(row);
    at(waiting ? triedMs + INHOUSE_BAN_ROLE_REMOVE_RETRY_MS : nowMs);
  }
  return wake;
}
