import {
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  type DraftStatus,
  type SeasonStatus,
} from "./constants";
import { draftSetupOpen } from "./draft-setup";

export const DRAFT_READINESS = {
  READY: "READY",
  AWAITING: "AWAITING",
  STALE: "STALE",
} as const;

export type DraftReadiness =
  (typeof DRAFT_READINESS)[keyof typeof DRAFT_READINESS];

type DraftConfirmation = {
  draftConfirmedRevision: number | null | undefined;
  draftConfirmedAt: Date | null | undefined;
};

/**
 * A draft confirmation is valid only for the exact schedule revision the
 * player acknowledged. `draftConfirmedAt` is part of the proof: a nullable
 * revision alone could make untouched legacy rows look ready at revision 0.
 */
export function draftReadiness(
  registration: DraftConfirmation,
  currentRevision: number,
): DraftReadiness {
  if (!registration.draftConfirmedAt) return DRAFT_READINESS.AWAITING;
  return registration.draftConfirmedRevision === currentRevision
    ? DRAFT_READINESS.READY
    : DRAFT_READINESS.STALE;
}

/**
 * The confirmation a player still owes for the season's current draft time:
 * AWAITING (never confirmed) or STALE (the time moved since), or null when
 * there is nothing to ask. Only an active full-player signup confirms, only
 * while a draft time is set, and only while setup is open (the same window
 * confirmDraftReadiness accepts), so a button built from this never offers a
 * confirmation the action would refuse.
 */
export function owedDraftConfirmation({
  seasonStatus,
  draftStatus,
  draftAt,
  draftRevision,
  registration,
}: {
  seasonStatus: SeasonStatus | string;
  draftStatus: DraftStatus | string | null | undefined;
  draftAt: Date | null;
  draftRevision: number;
  registration:
    | (DraftConfirmation & { status: string; type: string })
    | null
    | undefined;
}): typeof DRAFT_READINESS.AWAITING | typeof DRAFT_READINESS.STALE | null {
  if (
    !draftAt ||
    !registration ||
    registration.status !== REGISTRATION_STATUS.ACTIVE ||
    registration.type !== REGISTRATION_TYPE.PLAYER ||
    !draftSetupOpen(seasonStatus, draftStatus)
  ) {
    return null;
  }
  const readiness = draftReadiness(registration, draftRevision);
  return readiness === DRAFT_READINESS.READY ? null : readiness;
}

export function draftReadinessCounts(
  registrations: DraftConfirmation[],
  currentRevision: number,
) {
  let ready = 0;
  let awaiting = 0;
  let stale = 0;
  for (const registration of registrations) {
    switch (draftReadiness(registration, currentRevision)) {
      case DRAFT_READINESS.READY:
        ready++;
        break;
      case DRAFT_READINESS.STALE:
        stale++;
        break;
      default:
        awaiting++;
    }
  }
  return { ready, awaiting, stale, total: registrations.length };
}

/** The draft schedule a page showed: its revision and time, as posted back. */
export type SeenDraftSchedule = { revision: number; atMs: number };

/**
 * Read the draft revision and time a form carried back in hidden fields.
 * Both are untrusted browser values: anything that is not a whole,
 * non-negative revision and a positive epoch is refused (null), never
 * coerced into a schedule the player did not see.
 */
export function parseSeenDraftSchedule(
  revisionRaw: string,
  draftAtRaw: string,
): SeenDraftSchedule | null {
  const revisionText = revisionRaw.trim();
  const atText = draftAtRaw.trim();
  if (!/^\d+$/.test(revisionText) || !/^\d+$/.test(atText)) return null;
  const revision = Number(revisionText);
  const atMs = Number(atText);
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return null;
  return { revision, atMs };
}

/**
 * Is the schedule the player saw still the season's current one? Both the
 * revision and the time must match: the revision alone would accept a time
 * moved away and back, the time alone a stale tab from before that move.
 */
export function seenScheduleIsCurrent(
  seen: SeenDraftSchedule,
  season: { draftRevision: number; draftAt: Date | null },
): boolean {
  return (
    !!season.draftAt &&
    season.draftRevision === seen.revision &&
    season.draftAt.getTime() === seen.atMs
  );
}
