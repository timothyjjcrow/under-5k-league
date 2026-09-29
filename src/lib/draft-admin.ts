import { DEFAULTS, DRAFT_STATUS, SEASON_STATUS } from "./constants";

// The admin's live-draft controls, shared by the draft room's admin bar and the
// Captains & draft card on /admin. Both surfaces offer the same Pause / Resume /
// Void / Undo actions, and their confirm texts had drifted apart: the room's
// Undo only named the sale, while /admin warned that undoing a FINISHED
// auction puts every captain back on a live nomination clock. One definition
// here, so the two can never disagree about what a click does.

/** Which admin buttons the draft room shows. Only buttons that work now. */
export type DraftToolbarControls = {
  pause: boolean;
  resume: boolean;
  voidLot: boolean;
  undo: boolean;
};

/**
 * The room's admin bar, by state:
 * - live lot: Pause
 * - live, between lots: Pause and Undo
 * - paused with a lot open: Resume and Void lot (Undo needs no open lot, so
 *   the lot has to be voided or sold first)
 * - paused between lots: Resume and Undo
 * - finished auction, season still in the Draft phase: Undo
 * Undo also needs a sale to undo. Returns null when there is no bar at all:
 * before the auction starts, or once the season has left the Draft phase
 * (undoLastSale refuses there; roster moves take over).
 */
export function draftToolbarControls(s: {
  seasonStatus: string;
  status: string;
  lotLive: boolean;
  hasSale: boolean;
}): DraftToolbarControls | null {
  if (s.seasonStatus !== SEASON_STATUS.DRAFT) return null;
  const live = s.status === DRAFT_STATUS.IN_PROGRESS;
  const paused = s.status === DRAFT_STATUS.PAUSED;
  const complete = s.status === DRAFT_STATUS.COMPLETE;
  if (!live && !paused && !complete) return null;
  return {
    pause: live,
    resume: paused,
    voidLot: paused && s.lotLive,
    undo: !s.lotLive && s.hasSale,
  };
}

/** True when the bar would have at least one button to show. */
export function hasToolbarControl(c: DraftToolbarControls | null): boolean {
  return !!c && (c.pause || c.resume || c.voidLot || c.undo);
}

/** The sale an Undo reverts, when the caller knows it. */
export type UndoSale = { name: string; teamName: string; price: number };

/**
 * The Undo confirm. Undoing from a FINISHED auction is the case that needs the
 * warning: undoLastSale writes the draft back to live with a fresh nomination
 * clock, and if the buyer doesn't nominate in time the draft auto-nominates
 * for them, so one click on a screen that says "the draft is complete" puts
 * every captain back in a running auction. It ends the way any auction does
 * (the resolvers complete it once the seats are filled or the pool runs dry);
 * there is no finish button to point at. From a live or paused draft the
 * status doesn't change (a paused draft stays paused).
 */
export function undoSaleConfirm(o: {
  draftComplete: boolean;
  sale: UndoSale | null;
}): string {
  const what = o.sale
    ? `the most recent sale (${o.sale.name} → ${o.sale.teamName}, $${o.sale.price})`
    : "the most recent auction sale";
  const buyer = o.sale ? o.sale.teamName : "The buying team";
  const effect = `The player goes back to the pool, and ${buyer} gets the money back and nominates next.`;
  return o.draftComplete
    ? `Undo ${what}? This reopens the finished auction with a live ${DEFAULTS.NOMINATION_TIMER_SECONDS}-second nomination clock. ${effect} If nobody nominates in time, the draft picks a player for them. The draft completes again on its own when the open seats are filled or the pool runs out.`
    : `Undo ${what}? ${effect}`;
}

/** The Void-lot confirm (the auction must be paused with a lot open). */
export function voidLotConfirm(o: {
  playerName: string | null;
  nominatorName: string | null;
}): string {
  const lot = o.playerName
    ? `the paused lot for ${o.playerName}`
    : "the paused lot";
  const turn = o.nominatorName
    ? `${o.nominatorName} keeps the nomination turn`
    : "the same team keeps the nomination turn";
  return `Void ${lot}? Every bid on it is discarded, no sale is recorded, and ${turn}.`;
}

/**
 * "Refresh player data now" on /admin and the hourly automatic refresh
 * rewrite the medals, names and avatars the captains are reading in the room,
 * so both stay off while an auction is live or paused. They come back once it
 * is finished (or before it starts).
 */
export function profileSyncAllowed(
  draftStatus: string | null | undefined,
): boolean {
  return (
    draftStatus !== DRAFT_STATUS.IN_PROGRESS &&
    draftStatus !== DRAFT_STATUS.PAUSED
  );
}
