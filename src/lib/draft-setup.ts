import {
  DRAFT_STATUS,
  SEASON_STATUS,
  type DraftStatus,
  type SeasonStatus,
} from "./constants";

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
