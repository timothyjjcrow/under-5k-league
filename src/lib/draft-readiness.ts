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
