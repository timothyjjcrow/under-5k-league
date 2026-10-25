// The standin MMR rule applied to a permanent signing (Tim's call,
// 2026-10-25): an admin signing a free agent onto a short team is held to
// STANDIN_MMR_ALLOWANCE above the player the signing replaces, and going over
// takes the admin's explicit "Sign over the 100-MMR rule". Pure: the rows come
// from free-agent-rule-service.ts.

import {
  coverBaselineMmr,
  standinMmrLabel,
  standinNeedsApproval,
  STANDIN_MMR_ALLOWANCE,
} from "./standin";

/** The sign form's checkbox: its field name and its label, word for word. */
export const FREE_AGENT_OVER_RULE_FIELD = "overMmrRule";
export const FREE_AGENT_OVER_RULE_LABEL = `Sign over the ${STANDIN_MMR_ALLOWANCE}-MMR rule`;

const MMR_NUMBER = new Intl.NumberFormat("en-US");

/**
 * The `RosterTenure.endReason` releasePlayer closes a seat with, the only
 * departure a signing replaces (`admin-roster.ts`, source-guarded).
 */
export const RELEASE_END_REASON = "RELEASE";
/** The `acquisitionKind` signFreeAgent opens a seat with, the only refill. */
export const FREE_AGENT_ACQUISITION = "FREE_AGENT";

/** One RosterTenure row on the team this season, as the pairing reads it. */
export type TenureFacts = {
  id: string;
  userId: string | null;
  /** The player's name for the copy. */
  name: string;
  joinedAt: Date;
  /**
   * When a command ended the seat. A legacy reconciliation records no exact
   * end (null), so it can't be placed in the order and never counts.
   */
  endedAt: Date | null;
  /** Why the seat ended (`closeRosterTenure`'s reason); null while open. */
  endReason: string | null;
  /** How the seat was filled: AUCTION, CAPTAIN_DESIGNATION, FREE_AGENT, … */
  acquisitionKind: string;
  /** Their MMR when they joined; null or 0 = not recorded. */
  acquisitionMmr: number | null;
};

/**
 * The departure a signing now would refill: the newest release no later
 * free-agent signing has refilled yet, or null when every released seat has
 * been filled again.
 *
 * Only a release (`RELEASE_END_REASON`) is a departure and only a free-agent
 * signing (`FREE_AGENT_ACQUISITION`) a refill. Both happen only once the
 * auction is done, so the draft's own churn never counts: an undone lot
 * (DRAFT_UNDO), an aborted auction (DRAFT_ABORT) or a pre-draft captain change
 * (PRE_DRAFT_*) leaves no departure, and a team short from the draft is judged
 * by its lowest MMR, never by a player it no longer bought.
 *
 * Seats pair last in, first out: a release opens a seat, and each later
 * signing fills the newest seat still open before it. At the same instant a
 * departure comes first (one command freed the seat and filled it); a
 * tenure's own start always precedes its own end; ids break any other tie.
 */
export function unrefilledDeparture(
  tenures: readonly TenureFacts[],
): TenureFacts | null {
  type Event = { at: number; out: boolean; tenure: TenureFacts };
  const events: Event[] = [];
  for (const tenure of tenures) {
    if (tenure.acquisitionKind === FREE_AGENT_ACQUISITION) {
      events.push({ at: tenure.joinedAt.getTime(), out: false, tenure });
    }
    if (tenure.endedAt && tenure.endReason === RELEASE_END_REASON) {
      events.push({ at: tenure.endedAt.getTime(), out: true, tenure });
    }
  }
  events.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    if (a.tenure.id === b.tenure.id) return a.out ? 1 : -1;
    if (a.out !== b.out) return a.out ? -1 : 1;
    return a.tenure.id < b.tenure.id ? -1 : a.tenure.id > b.tenure.id ? 1 : 0;
  });
  const open: TenureFacts[] = [];
  for (const event of events) {
    if (event.out) open.push(event.tenure);
    else open.pop();
  }
  return open.length > 0 ? open[open.length - 1] : null;
}

/**
 * Who a signing onto the team is judged against: the player it replaces, or,
 * when no departure is waiting to be refilled, the team's lowest signup MMR
 * (the standin rule's yardstick for an empty seat). `mmr` null = unknown.
 */
export type FreeAgentBaseline =
  | { kind: "replaced"; name: string; mmr: number | null }
  | { kind: "lowest"; teamName: string; mmr: number | null };

export function freeAgentBaseline(opts: {
  teamName: string;
  tenures: readonly TenureFacts[];
  rosterUserIds: readonly string[];
  /** This season's signup MMR by userId (0 = unknown). */
  signupMmr: ReadonlyMap<string, number>;
}): FreeAgentBaseline {
  const departed = unrefilledDeparture(opts.tenures);
  if (departed) {
    // The MMR they were signed or bought at, else their signup MMR now.
    const recorded =
      departed.acquisitionMmr && departed.acquisitionMmr > 0
        ? departed.acquisitionMmr
        : departed.userId
          ? (opts.signupMmr.get(departed.userId) ?? 0)
          : 0;
    return {
      kind: "replaced",
      name: departed.name,
      mmr: coverBaselineMmr({ replacedMmr: recorded }),
    };
  }
  return {
    kind: "lowest",
    teamName: opts.teamName,
    mmr: coverBaselineMmr({
      rosterMmrs: opts.rosterUserIds.map((id) => opts.signupMmr.get(id) ?? 0),
    }),
  };
}

/**
 * Over the rule: more than STANDIN_MMR_ALLOWANCE above the baseline, or an
 * MMR on either side the site doesn't know (`standinNeedsApproval`).
 */
export function freeAgentOverRule(
  freeAgentMmr: number,
  baseline: FreeAgentBaseline,
): boolean {
  return standinNeedsApproval(freeAgentMmr, baseline.mmr);
}

const known = (mmr: number | null): mmr is number => mmr !== null && mmr > 0;

/**
 * The refusal when the box is unticked: both MMRs and the gap, or whose MMR
 * is unknown, and the checkbox that signs anyway, by its label.
 */
export function freeAgentRuleRefusal(opts: {
  playerName: string;
  freeAgentMmr: number;
  baseline: FreeAgentBaseline;
}): string {
  const { playerName, freeAgentMmr, baseline } = opts;
  const rule = `the ${STANDIN_MMR_ALLOWANCE}-MMR rule`;
  const against =
    baseline.kind === "replaced"
      ? `${baseline.name} (${standinMmrLabel(baseline.mmr)}), the player they'd replace`
      : known(baseline.mmr)
        ? `${baseline.teamName}'s lowest MMR (${MMR_NUMBER.format(baseline.mmr)})`
        : `${baseline.teamName}, where nobody has a known MMR`;
  let why: string;
  if (!known(freeAgentMmr)) {
    why = `${playerName}'s MMR is unknown, so ${rule} can't clear them against ${against}.`;
  } else if (!known(baseline.mmr)) {
    why =
      baseline.kind === "replaced"
        ? `${baseline.name}'s MMR is unknown, so ${rule} can't clear ${playerName} (${standinMmrLabel(freeAgentMmr)}) as the player who replaces them.`
        : `Nobody on ${baseline.teamName} has a known MMR, so ${rule} can't clear ${playerName} (${standinMmrLabel(freeAgentMmr)}).`;
  } else {
    why = `${playerName} (${standinMmrLabel(freeAgentMmr)}) is ${MMR_NUMBER.format(
      freeAgentMmr - baseline.mmr,
    )} above ${against}.`;
  }
  return `${why} Tick “${FREE_AGENT_OVER_RULE_LABEL}” to sign them anyway.`;
}

/**
 * The record of a signing over the rule, for the toast, the admin log and
 * the Discord post alike: "Signed over the 100-MMR rule: 4,500 MMR,
 * replacing Bob's 2,000." `escape` wraps each player or team name (the
 * Discord post passes escapeDiscordText).
 */
export function freeAgentOverRuleNote(
  opts: { freeAgentMmr: number; baseline: FreeAgentBaseline },
  escape: (text: string) => string = (text) => text,
): string {
  const { freeAgentMmr, baseline } = opts;
  const against =
    baseline.kind === "replaced"
      ? known(baseline.mmr)
        ? `replacing ${escape(baseline.name)}'s ${MMR_NUMBER.format(baseline.mmr)}`
        : `replacing ${escape(baseline.name)}, whose MMR is unknown`
      : known(baseline.mmr)
        ? `against ${escape(baseline.teamName)}'s lowest MMR of ${MMR_NUMBER.format(baseline.mmr)}`
        : `with no known MMR on ${escape(baseline.teamName)} to compare`;
  return `Signed over the ${STANDIN_MMR_ALLOWANCE}-MMR rule: ${standinMmrLabel(freeAgentMmr)}, ${against}.`;
}

/**
 * The sign form's team option suffix, so the admin sees the yardstick before
 * submitting: "replaces Bob, 2,000 MMR" or "lowest 2,100 MMR".
 */
export function freeAgentSeatLabel(baseline: FreeAgentBaseline): string {
  return baseline.kind === "replaced"
    ? `replaces ${baseline.name}, ${standinMmrLabel(baseline.mmr)}`
    : known(baseline.mmr)
      ? `lowest ${standinMmrLabel(baseline.mmr)}`
      : "lowest MMR unknown";
}
