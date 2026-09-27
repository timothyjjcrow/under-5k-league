import {
  DRAFT_REMINDER,
  DRAFT_STATUS,
  SEASON_STATUS,
  type DraftStatus,
  type SeasonStatus,
} from "./constants";
import { hasPassed } from "./countdown";

/**
 * The one pre-auction capability shared by the admin panel, /me, and every
 * setup mutation. A season may be moved to the DRAFT chapter before the live
 * auction is started; that waiting-room state is still setup, not a lock.
 */
export function draftSetupOpen(
  seasonStatus: SeasonStatus | string,
  draftStatus: DraftStatus | string | null | undefined,
): boolean {
  const setupPhase =
    seasonStatus === SEASON_STATUS.SIGNUPS ||
    seasonStatus === SEASON_STATUS.DRAFT;
  const auctionNotStarted =
    !draftStatus || draftStatus === DRAFT_STATUS.NOT_STARTED;
  return setupPhase && auctionNotStarted;
}

/** When the draft-night reminder window opens for a scheduled draft. */
export function draftReminderOpensAt(draftAtMs: number): number {
  return draftAtMs - DRAFT_REMINDER.AHEAD_HOURS * 3_600_000;
}

/**
 * Is the draft-night reminder due right now? Setup must still be open (the
 * auction hasn't started, see draftSetupOpen), a time must be scheduled, and
 * that time must be inside the window and still AHEAD: the window closes at
 * draftAt itself. One definition for the reminder service and the automation
 * gate, so the worker wakes exactly when the service would act.
 */
export function draftReminderDue(
  seasonStatus: SeasonStatus | string,
  draftStatus: DraftStatus | string | null | undefined,
  draftAtMs: number | null | undefined,
  nowMs: number,
): boolean {
  if (draftAtMs == null || !draftSetupOpen(seasonStatus, draftStatus)) {
    return false;
  }
  return nowMs >= draftReminderOpensAt(draftAtMs) && nowMs < draftAtMs;
}

/** How long before a scheduled draft night the site starts linking the room. */
export const DRAFT_ROOM_LEAD_HOURS = 2;

/**
 * Is draft night close enough to point people at the draft room before the
 * admin presses Start? The room is a live waiting room that flips to the
 * auction by itself, but outside the Draft phase nothing linked it, so on
 * draft night people waited on the home page and arrived after the first
 * nominations. Signups only: Start moves the season to Draft, where the room
 * is always linked. Open from DRAFT_ROOM_LEAD_HOURS before the scheduled time
 * until that time has passed (hasPassed, the same boundary as the "passed"
 * chip), so a slipped draft night stops advertising the room.
 */
export function draftNightSoon(
  seasonStatus: SeasonStatus | string | null | undefined,
  draftAtMs: number | null | undefined,
  nowMs: number,
): boolean {
  if (seasonStatus !== SEASON_STATUS.SIGNUPS || draftAtMs == null) {
    return false;
  }
  return (
    nowMs >= draftAtMs - DRAFT_ROOM_LEAD_HOURS * 3_600_000 &&
    !hasPassed(draftAtMs, nowMs)
  );
}

/** Captaincy can change after the auction, but never while its turn state is
 * live/paused and never after the season has become immutable history. */
export function captainTransferOpen(
  seasonStatus: SeasonStatus | string,
  draftStatus: DraftStatus | string | null | undefined,
): boolean {
  return (
    seasonStatus !== SEASON_STATUS.COMPLETE &&
    draftStatus !== DRAFT_STATUS.IN_PROGRESS &&
    draftStatus !== DRAFT_STATUS.PAUSED
  );
}

export function draftSetupLockedMessage(
  seasonStatus: SeasonStatus | string,
  draftStatus: DraftStatus | string | null | undefined,
): string {
  if (draftStatus === DRAFT_STATUS.IN_PROGRESS) {
    return "The auction is live — draft setup is locked.";
  }
  if (draftStatus === DRAFT_STATUS.PAUSED) {
    return "The auction is paused, not reset — draft setup is still locked.";
  }
  if (draftStatus === DRAFT_STATUS.COMPLETE) {
    return "The auction is complete — captain setup, order, schedule, and starting budgets are locked.";
  }
  if (seasonStatus === SEASON_STATUS.COMPLETE) {
    return "The season is complete — draft setup is historical and read-only.";
  }
  if (seasonStatus === SEASON_STATUS.REGULAR_SEASON) {
    return "The regular season has begun — draft setup is locked. Use captain handover or Roster moves for operational changes.";
  }
  if (seasonStatus === SEASON_STATUS.PLAYOFFS) {
    return "The playoffs have begun — draft setup is locked. Use captain handover or Roster moves for operational changes.";
  }
  return "Draft setup is not available in the current league state.";
}

export type DraftSeatPlan = {
  captainCount: number;
  poolCount: number;
  openSeats: number;
  shortfall: number;
  overflow: number;
  canStart: boolean;
  blocker: string | null;
};

/** The exact seat arithmetic used by both the admin preflight and startDraft. */
export function draftSeatPlan(
  captainCount: number,
  teamSize: number,
  poolCount: number,
): DraftSeatPlan {
  const safeCaptains = Math.max(0, Math.trunc(captainCount));
  const safeTeamSize = Math.max(1, Math.trunc(teamSize));
  const safePool = Math.max(0, Math.trunc(poolCount));
  const openSeats = safeCaptains * Math.max(0, safeTeamSize - 1);
  const shortfall = Math.max(0, openSeats - safePool);
  const overflow = Math.max(0, safePool - openSeats);
  const blocker =
    safeCaptains < 2
      ? "Designate at least 2 captains before starting the auction."
      : safePool === 0
        ? "At least 1 undrafted full-player signup is required to start the auction."
        : null;
  return {
    captainCount: safeCaptains,
    poolCount: safePool,
    openSeats,
    shortfall,
    overflow,
    canStart: blocker === null,
    blocker,
  };
}

/**
 * Can Start draft run, and if not, why not. One definition for the Captains &
 * draft card on /admin and the Start button in the draft room's waiting room,
 * so the two can never disagree about whether the auction can begin. Seats
 * come from draftSeatPlan (startDraft's own arithmetic); on top of that, Start
 * only accepts captain-only teams, so any non-captain already on a roster
 * blocks it.
 */
export function startDraftCheck(o: {
  captainCount: number;
  teamSize: number;
  poolCount: number;
  /** Non-captain roster rows already on the season's teams. */
  boughtCount: number;
}): { seats: DraftSeatPlan; canStart: boolean; blocker: string | null } {
  const seats = draftSeatPlan(o.captainCount, o.teamSize, o.poolCount);
  const rosterAlreadyBuilt = o.boughtCount > 0;
  const blocker = rosterAlreadyBuilt
    ? `${o.boughtCount} non-captain roster member${o.boughtCount === 1 ? " is" : "s are"} already assigned. Return to the appropriate season phase and use roster tools; Start only accepts captain-only teams.`
    : seats.blocker;
  return { seats, canStart: seats.canStart && !rosterAlreadyBuilt, blocker };
}

/**
 * The Start-draft confirm, before the Discord reachability line (appended by
 * StartDraftControl once its lookup resolves). House rule: a consequential
 * confirm states the real numbers BEFORE the click. Shared by /admin and the
 * draft room so an admin starting from either place reads the same warning.
 *
 * Starting is NOT a one-way door: abortDraft writes the draft back to
 * NOT_STARTED, drops the season to Signups, refunds every purchase and keeps
 * the captains. The team count is final only once a result exists, which is
 * the line abort itself guards on, so the confirm says exactly that.
 */
export function startDraftConfirm(o: {
  captainCount: number;
  minTeams: number;
  teamSize: number;
  seats: Pick<DraftSeatPlan, "openSeats" | "poolCount">;
  draftScheduled: boolean;
  confirmations: {
    ready: number;
    awaiting: number;
    stale: number;
    total: number;
  };
  /** captainMmrWarning(...) for the captains, "" when there is none. */
  mmrWarning: string;
}): string {
  const { openSeats, poolCount } = o.seats;
  const seatNote =
    openSeats === poolCount
      ? ` The pool fits exactly: ${poolCount} players for ${openSeats} open seats.`
      : openSeats > poolCount
        ? ` ${poolCount} players for ${openSeats} open seats — ${openSeats - poolCount} seat${openSeats - poolCount === 1 ? "" : "s"} will go unfilled (standins cover them). Removing a captain would tighten it.`
        : ` ${poolCount} players for only ${openSeats} open seats — ${poolCount - openSeats} player${poolCount - openSeats === 1 ? "" : "s"} will go undrafted. Adding a captain opens ${o.teamSize - 1} more seats.`;
  const c = o.confirmations;
  return (
    `Start the draft with ${o.captainCount} captain${o.captainCount === 1 ? "" : "s"}?` +
    (o.captainCount < o.minTeams
      ? ` That is fewer than this season's ${o.minTeams}-team target.`
      : "") +
    seatNote +
    " Captains are locked once the auction begins — the way back is Abort draft," +
    " which returns every drafted player and refund and keeps the captains, but" +
    " is refused once any result has been recorded." +
    (o.draftScheduled
      ? ` Draft confirmations: ${c.ready} of ${c.total} ready; ${c.awaiting} awaiting${c.stale ? `; ${c.stale} must reconfirm` : ""}. This is a warning only and does not block the draft.`
      : " No draft night is scheduled, so players have not been asked to confirm one.") +
    o.mmrWarning
  );
}

/**
 * The three counts the Start-draft preflight reads, from the season's teams
 * and its ACTIVE PLAYER registrations: one team per captain, the non-captain
 * rows already on rosters, and the pool (signups not on any roster, which is
 * startDraft's own pool). Shared by /admin and the draft room.
 */
export function draftRosterCounts(
  teams: readonly {
    members: readonly { userId: string; isCaptain: boolean }[];
  }[],
  players: readonly { userId: string }[],
): { captainCount: number; boughtCount: number; poolCount: number } {
  const rostered = new Set(teams.flatMap((t) => t.members.map((m) => m.userId)));
  return {
    captainCount: teams.length,
    boughtCount: teams.reduce(
      (n, t) => n + t.members.filter((m) => !m.isCaptain).length,
      0,
    ),
    poolCount: players.filter((p) => !rostered.has(p.userId)).length,
  };
}
