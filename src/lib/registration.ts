import {
  DRAFT_STATUS,
  HARD_MMR_CEILING,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
  type RegistrationType,
} from "./constants";
import { rankMedalName, rankTierExactMinMmr } from "./rank";

/**
 * The season's soft MMR limit as players read it: none (0) when it is set at
 * or above the hard ceiling, which already refuses everyone over it, so a
 * soft limit there flags nobody. With Season 2's limit at 5,000, How it works
 * printed "Players up to 5,000 MMR can join … Above 5,000 MMR, an admin looks
 * over your signup", contradicting itself.
 */
export function effectiveSoftMmrLimit(maxMmr: number): number {
  return maxMmr > 0 && maxMmr < HARD_MMR_CEILING ? maxMmr : 0;
}

export type RegistrationGateInput = {
  season: { maxMmr: number; status: string };
  type: RegistrationType;
  /**
   * The RAW claimed MMR — never the medal-clamped value. The clamp snaps
   * implausible claims DOWN to a medal floor (always under the ceiling), so
   * gating the clamped number would let any medaled player through by
   * overstating: the bigger the lie, the more acceptable it becomes.
   */
  mmr: number;
  /** OpenDota medal, when known — a 5K+ medal is ineligible whatever they type. */
  rankTier?: number | null;
  /** Whether the user already has a registration for this season. */
  hasExisting: boolean;
  /** The existing registration's type, when there is one. */
  existingType?: RegistrationType | null;
  /**
   * The existing registration's STATUS, when there is one. `ACTIVE` is the
   * league's own record that this player has already been admitted — the
   * medal rule turns off for them and only for them. Absent/undefined means
   * "judge this as an admission", the safe default every existing caller gets.
   */
  existingStatus?: string | null;
  /**
   * `mmr` is the signup's own stored number, kept rather than entered
   * (`keepsStoredMmr`: the post-draft lock, or a form that sent no MMR). The
   * typed-MMR ceiling judges what a player sets, so it doesn't judge this:
   * an admin who set a number over it made that call, and "you entered …"
   * would name a number the player never typed. Every other rule still
   * applies. Absent means entered, as every other caller has it.
   */
  mmrKept?: boolean;
};

export type WithdrawGateInput = {
  /** The registration's current status string. */
  status: string;
  /** Does this user captain a team this season? */
  isCaptain: boolean;
  /** Is this user on a roster this season? */
  isRostered: boolean;
  /** Is this user the lot currently under the hammer in a live auction? */
  isOnTheBlock?: boolean;
  /**
   * Standin assignments this user holds on UNPLAYED matches. A withdrawal that
   * leaves these behind is invisible: nothing downstream re-checks registration
   * status, so `matchNightRoster` keeps swapping the covered player out for a
   * standin who has left the league — the team shows as covered right up to
   * kickoff, and the ex-standin's own /me stops listing the match (it filters on
   * ACTIVE), so they get no reminder either.
   */
  pendingAssignments?: number;
  /**
   * Who is reading the refusal. "admin" (the default — byte-identical to the
   * original strings) speaks about the player in the third person and names
   * admin controls; "self" speaks TO the player and only prescribes actions
   * they can actually take. The pendingAssignments branch is why this exists:
   * a standin pressing Withdraw on /me was told "They're standing in … remove
   * that assignment first" — third person, no match named, and pointing at a
   * control only the covered team's captain or an admin has.
   */
  audience?: "admin" | "self";
};

/**
 * A completed season is historical data, not another late-signup window.
 * Profile/Discord details remain editable on /me, but the season-specific
 * registration (including its MMR and questionnaire) is frozen for everyone.
 * Keep this rule shared by the action and the page so a replayed Server Action
 * and the visible UI cannot disagree about the phase lock.
 */
export function registrationSeasonClosedError(
  seasonStatus: string,
): string | null {
  return seasonStatus === SEASON_STATUS.COMPLETE
    ? "This season is complete — signups and signup edits are closed."
    : null;
}

/**
 * Once the season's auction is done, a player's own signup MMR is fixed. It
 * priced them in the draft, and from then on it is what the standin MMR rule
 * measures cover by (`coverBaselineMmr`): a standin who lowered their number,
 * or a rostered player who raised theirs, could step round the other
 * captain's say. saveRegistration keeps the stored number on an EXISTING
 * signup (any type or status, so withdrawing and rejoining is no way round
 * it) and says so; a NEW signup still sets its own, and admins correct it
 * from the admin panel. /me renders the box disabled from the same rule.
 * Locked from DRAFT with the auction COMPLETE onward; before that (signups,
 * draft setup) it stays editable, and a live auction is the separate
 * PLAYER-only freeze in saveRegistration.
 */
export function mmrSelfEditLocked(
  seasonStatus: string,
  draftStatus: string | null | undefined,
): boolean {
  if (seasonStatus === SEASON_STATUS.DRAFT) {
    return draftStatus === DRAFT_STATUS.COMPLETE;
  }
  return (
    seasonStatus === SEASON_STATUS.REGULAR_SEASON ||
    seasonStatus === SEASON_STATUS.PLAYOFFS ||
    seasonStatus === SEASON_STATUS.COMPLETE
  );
}

/**
 * Whether saveRegistration stores an existing signup's own MMR instead of
 * the box: while mmrSelfEditLocked holds, whatever was typed, and in every
 * phase when the form sent no `mmr` field at all. A disabled box submits
 * nothing, so a /me tab left open while the lock came and went (the draft
 * completed, then an admin aborted it) posts no field, and reading that as
 * a cleared box stored 0, or the medal's floor, without a word. A blank box
 * DOES send the field (""): that is the player clearing it, judged as typed.
 * A new signup never keeps anything; it has nothing stored.
 */
export function keepsStoredMmr(input: {
  hasExisting: boolean;
  locked: boolean;
  mmrSubmitted: boolean;
}): boolean {
  return input.hasExisting && (input.locked || !input.mmrSubmitted);
}

/** Under /me's disabled MMR box while mmrSelfEditLocked holds. */
export const MMR_SELF_EDIT_LOCKED_HINT =
  "Locked after the draft — ask a league admin to change it.";

const mmrDigits = new Intl.NumberFormat("en-US");

/** The toast's note when a locked MMR edit was kept (never a silent rewrite). */
export function mmrLockedAfterDraftNote(storedMmr: number): string {
  const kept =
    storedMmr > 0 ? `kept ${mmrDigits.format(storedMmr)}` : "it stays unknown";
  return ` · MMR is locked after the draft — ${kept}. Ask a league admin to change it.`;
}

/**
 * The draft-night freeze in words: a full player's MMR stays put while the
 * auction runs (live or paused). It promises no edit window afterwards, since
 * the post-draft lock (mmrSelfEditLocked) follows straight on. The same
 * sentence under /me's box (mmrPreviewLine) and in saveRegistration's toast.
 */
export function mmrFrozenDuringDraftLine(storedMmr: number): string {
  const listed =
    storedMmr > 0 ? `${mmrDigits.format(storedMmr)} MMR` : "an unknown MMR";
  return `The draft is running, so you stay listed at ${listed}. After the draft only a league admin can change it.`;
}

/**
 * Whether a signup can be withdrawn (by the player or an admin). Rostered
 * players and captains must be released/replaced first — withdrawing them
 * would silently orphan a team. Returns an error message, or null when OK.
 */
export function withdrawGateError({
  status,
  isCaptain,
  isRostered,
  isOnTheBlock,
  pendingAssignments = 0,
  audience = "admin",
}: WithdrawGateInput): string | null {
  const self = audience === "self";
  if (status !== "ACTIVE") return "This signup isn't active.";
  // The admin path checked this inline; the SELF path didn't, so a player
  // could withdraw while captains were actively bidding on them — every draft
  // room rendered a headless auction and the expiring lot was voided.
  if (isOnTheBlock) {
    return self
      ? "You're on the auction block right now — wait for the lot to settle."
      : "They're on the auction block right now — wait for the lot to settle.";
  }
  if (isCaptain) {
    return self
      ? "You captain a team — an admin has to hand it over before you can leave."
      : "They captain a team — replace the captain first.";
  }
  if (isRostered) {
    return self
      ? "You're on a roster — an admin has to release you from the team first."
      : "They're on a roster — release them from the team first.";
  }
  // Refuse rather than auto-cancelling: the captain who arranged the cover is
  // the one who needs to know the seat is open again, and silently deleting the
  // assignment would take that news away from them. Same rule and wording family
  // as promoteGateError, which already blocks on this.
  if (pendingAssignments > 0) {
    return self
      ? "You're booked to stand in for an unplayed match — ask that team's captain or an admin to remove the assignment, then withdraw."
      : "They're standing in for an unplayed match — remove that assignment first.";
  }
  return null;
}

/** Why a signup row has no "remove": a short note, and what to do instead. */
export type SignupRemovalBlocker = { note: string; fix: string };

/**
 * Which signups the admin lists must NOT offer "remove" on, and what to show
 * in its place. It mirrors the two `withdrawGateError` refusals a whole
 * season's rows can hit (rostered, then owing cover on an unplayed match, in
 * the gate's order) from data the admin page already loads, so a button is
 * never rendered where the server can only refuse it. Mid-season that was
 * every drafted player's row. The server gate stays authoritative; this only
 * decides what to render.
 */
export function signupRemovalBlockers({
  teams,
  assignments,
  matches,
}: {
  teams: ReadonlyArray<{
    name: string;
    members: ReadonlyArray<{ userId: string }>;
  }>;
  assignments: ReadonlyArray<{ standinUserId: string; matchId: string }>;
  matches: ReadonlyArray<{ id: string; status: string }>;
}): Map<string, SignupRemovalBlocker> {
  const blockers = new Map<string, SignupRemovalBlocker>();
  for (const team of teams) {
    for (const member of team.members) {
      blockers.set(member.userId, {
        note: `on ${team.name}`,
        fix: "Release them from the team in Roster moves first, then remove the signup.",
      });
    }
  }
  // pendingCoverWhere: a booking on any match of the season not COMPLETED.
  const statusOf = new Map(matches.map((match) => [match.id, match.status]));
  for (const assignment of assignments) {
    if (blockers.has(assignment.standinUserId)) continue;
    if (statusOf.get(assignment.matchId) === MATCH_STATUS.COMPLETED) continue;
    blockers.set(assignment.standinUserId, {
      note: "covering a match",
      fix: "They're standing in for an unplayed match. Remove that assignment first, then the signup.",
    });
  }
  return blockers;
}

/**
 * Enforce signup rules: the hard MMR ceiling, and that PLAYER registrations
 * only *begin* during SIGNUPS. The soft limit (`season.maxMmr`) does NOT block
 * signup — players above it join and are reviewed before the draft; only the
 * `HARD_MMR_CEILING` (no 5K+/Immortals) is a firm reject. Standins may sign up
 * during the draft, regular season and playoffs, when emergency cover is still
 * useful. COMPLETE freezes the season record for every registration type. An
 * existing registrant may update before then, but a standin can't upgrade
 * themselves to a full player once signups have closed (that would sneak past
 * the closed-signups rule).
 *
 * The two ceiling rules are asymmetric ON PURPOSE. The TYPED MMR is re-judged
 * on every submit — it is a number the player controls, so the ceiling has to
 * hold each time they set it (a stored number the save keeps instead,
 * `mmrKept`, is not one they set). The MEDAL rule runs only at ADMISSION, because
 * it judges a value synced behind their back that an admin has already been
 * shown and chosen to keep (see the medal branch below).
 *
 * Returns an error message, or null when allowed.
 */
export function registrationGate({
  season,
  type,
  mmr,
  rankTier,
  hasExisting,
  existingType,
  existingStatus,
  mmrKept = false,
}: RegistrationGateInput): string | null {
  const seasonClosed = registrationSeasonClosedError(season.status);
  if (seasonClosed) return seasonClosed;
  // The soft limit (season.maxMmr) is a review threshold, not a block — only
  // the hard ceiling turns anyone away (keeps out 5K+ players and Immortals).
  // A kept stored number isn't a claim (see mmrKept), so it isn't judged.
  if (!mmrKept && mmr > HARD_MMR_CEILING) {
    return `This league doesn't take players over ${HARD_MMR_CEILING} MMR — you entered ${mmr}.`;
  }
  // The medal alone can prove ineligibility — but only at ADMISSION. A Divine
  // 3+/Immortal medal means 5K+ MMR whatever number is typed (its EXACT band
  // floor is over the ceiling — no padding here, padding is for validating
  // claims), so a NEW signup sandbagging a low claim under a high medal is
  // refused right here.
  //
  // It must NOT re-judge someone the league has already admitted. The medal is
  // a fact synced behind the player's back (the hourly player data refresh, or
  // the admin's "Refresh player data now"), that sync is
  // deliberately WARN-ONLY — who plays is the operator's call — and a player
  // admitted while their rankTier was null holds no lever over it. Judging it
  // on every submit turned the admin's decision to KEEP them into a silent
  // lockout: no role/hero/statement edit, no flip to standin, ever again,
  // refused by a medal nobody had objected to. Removing them from the pool is
  // withdrawSignup's job, not a form that quietly stops saving.
  //
  // ACTIVE is the exemption, not `hasExisting`: WITHDRAWN and REMOVED rows are
  // re-entries into the pool, i.e. fresh admissions, and are judged as such.
  const admitted =
    hasExisting && existingStatus === REGISTRATION_STATUS.ACTIVE;
  if (!admitted && medalProvesIneligible(rankTier)) {
    return `This league doesn't take players over ${HARD_MMR_CEILING} MMR — your ${rankMedalName(rankTier)} medal puts you above it.`;
  }
  const wasPlayer = hasExisting && existingType === REGISTRATION_TYPE.PLAYER;
  if (
    type === REGISTRATION_TYPE.PLAYER &&
    !wasPlayer &&
    season.status !== SEASON_STATUS.SIGNUPS
  ) {
    return "Player signups are closed for this season";
  }
  return null;
}

/**
 * Does a medal we only learned about LATER prove an already-stored signup
 * ineligible? Same medal-floor rule `registrationGate` applies at signup — but
 * that gate only runs when the player submits, and a stored MMR is treated as
 * league-approved (an unchanged resubmit is never re-judged, so an admin's
 * setRegistrationMmr correction survives). So a player who signs up before
 * linking a Dota account — or while OpenDota is unreachable — is admitted with
 * `rankTier: null`, and when a later player data refresh fills in a Divine
 * 3+/Immortal medal, nothing re-checks: they stay ACTIVE, over the ceiling.
 *
 * This is the detector for that gap. It never removes anyone — who plays is the
 * operator's call — it just lets the sync say "these N need a look".
 */
export function medalProvesIneligible(rankTier: number | null | undefined): boolean {
  const medalFloor = rankTierExactMinMmr(rankTier);
  return medalFloor != null && medalFloor > HARD_MMR_CEILING;
}

export type PromoteGateInput = {
  seasonStatus: string;
  /** Draft row status, or null when no draft row exists yet. */
  draftStatus: string | null;
  registrationStatus: string;
  registrationType: string;
  /** Standin assignments on this season's UNPLAYED matches. */
  pendingAssignments: number;
};

/**
 * Why an admin can't promote this standin to a full player (null = can).
 * The mid-season roster refill path: registrationGate closes self-serve
 * PLAYER signups after SIGNUPS, so late joiners file as standins and an
 * admin upgrades them here before signing them via the free-agent form.
 */
export function promoteGateError(i: PromoteGateInput): string | null {
  if (i.seasonStatus === "SIGNUPS") {
    return "Signups are open — they can just switch to Player on their own profile.";
  }
  if (i.seasonStatus === "COMPLETE") return "The season is over.";
  // Live auction: the pool is ACTIVE PLAYER registrations, so promoting
  // mid-run would inject them into the running draft. Pre-start (they'll be
  // auctioned normally) and post-draft (free-agent top-up) are both fine.
  if (
    i.seasonStatus === "DRAFT" &&
    (i.draftStatus === "IN_PROGRESS" || i.draftStatus === "PAUSED")
  ) {
    return "The draft is live — promote before it starts or after it completes.";
  }
  if (i.registrationStatus !== "ACTIVE") return "This signup isn't active.";
  if (i.registrationType !== "STANDIN") return "They're already a full player.";
  if (i.pendingAssignments > 0) {
    return "They're assigned as a standin for an unplayed match — remove that assignment first.";
  }
  return null;
}
