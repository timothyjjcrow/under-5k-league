// Pure read-capability policy for personal league data. Keep these decisions
// centralized so a new page cannot accidentally equate "has a session" with
// "may see every player's contact/attendance details".

export type VisibilityViewer = {
  id: string;
  role: string;
} | null;

/** Whether this viewer may browse contact details for the league directory. */
export function canViewLeagueDirectoryContact(
  viewer: VisibilityViewer,
  viewerHasActiveRegistration: boolean,
): boolean {
  return (
    !!viewer &&
    (viewer.role === "ADMIN" || viewerHasActiveRegistration)
  );
}

/** Discord contact is available to the subject, admins, and active registrants. */
export function canViewLeagueContact(
  viewer: VisibilityViewer,
  subjectUserId: string,
  viewerHasActiveRegistration: boolean,
): boolean {
  return (
    !!viewer &&
    (viewer.id === subjectUserId ||
      canViewLeagueDirectoryContact(viewer, viewerHasActiveRegistration))
  );
}

/** Named IN/OUT answers are operational data for the two captains and admins. */
export function canViewNamedMatchAvailability(
  viewer: VisibilityViewer,
  homeCaptainId: string,
  awayCaptainId: string,
): boolean {
  return (
    !!viewer &&
    (viewer.role === "ADMIN" ||
      viewer.id === homeCaptainId ||
      viewer.id === awayCaptainId)
  );
}

/** Anonymous visitors do not need team readiness counts; league participants do. */
export function canViewAvailabilitySummary(
  viewer: VisibilityViewer,
  viewerIsActiveParticipant: boolean,
): boolean {
  return !!viewer && (viewer.role === "ADMIN" || viewerIsActiveParticipant);
}

/**
 * Registration is the normal signup proof; a current roster/captain row is
 * independently authoritative after the draft. Legacy imports and repaired
 * seasons can lack the former while the player is still expected to RSVP.
 */
export function hasActiveLeagueParticipation(
  hasActiveRegistration: boolean,
  hasCurrentTeamRole: boolean,
): boolean {
  return hasActiveRegistration || hasCurrentTeamRole;
}
