// What the scrim pages tell captains to do. Pure: plain values in, copy out.

import { SCRIM_STATUS } from "./constants";
import {
  SCRIM_DETECT_WINDOW_AFTER_MS,
  SCRIM_PAST_GRACE_MS,
} from "./scrim-window";

export type ScrimJoinCheck =
  | { canJoin: true; teamName: string }
  | { canJoin: false; reason: string; signIn?: true };

/**
 * Whether the viewer can claim this OPEN scrim time, and if not, why — the
 * open scrim's own page shows the Join button or this one line, so a captain
 * never stares at a page with no control and no explanation. It mirrors
 * joinScrim's refusals in the order a viewer can do something about them;
 * the service still re-checks everything inside its transaction. Null when
 * the scrim is not OPEN (there is nothing to claim).
 */
export function scrimJoinCheck(m: {
  status: string;
  seasonOpen: boolean;
  signedIn: boolean;
  /** The viewer's own team in this season, when they captain one. */
  viewerTeam: { id: string; name: string; withdrawn: boolean } | null;
  hostTeamId: string;
  hostWithdrawn: boolean;
  scheduledAtMs: number;
  nowMs: number;
  /** "the A vs B scrim on …" or "a league match": what the viewer's team
   *  already has within four hours of this time, when it has one. */
  viewerTeamClash?: string | null;
}): ScrimJoinCheck | null {
  if (m.status !== SCRIM_STATUS.OPEN) return null;
  const no = (reason: string): ScrimJoinCheck => ({ canJoin: false, reason });
  if (!m.seasonOpen) {
    return no("This season is over, so its scrim times can't be claimed.");
  }
  if (m.scheduledAtMs < m.nowMs - SCRIM_PAST_GRACE_MS) {
    return no("This time has passed, so it can't be claimed.");
  }
  if (m.hostWithdrawn) {
    return no("The team that posted this time has withdrawn from the league.");
  }
  if (!m.signedIn) {
    return {
      canJoin: false,
      reason: "Sign in as a team captain to claim this time.",
      signIn: true,
    };
  }
  if (!m.viewerTeam) {
    return no("Only a team captain can claim a scrim time.");
  }
  if (m.viewerTeam.id === m.hostTeamId) {
    return no(
      "This is your team's time. A captain from another team can claim it.",
    );
  }
  if (m.viewerTeam.withdrawn) {
    return no("Your team has withdrawn, so it can't book scrims.");
  }
  if (m.viewerTeamClash) {
    return no(
      `${m.viewerTeam.name} already has ${m.viewerTeamClash} within four hours of this time.`,
    );
  }
  return { canJoin: true, teamName: m.viewerTeam.name };
}

/**
 * The claiming captain's toast: booked, who hosts, where the lobby's details
 * are (the scrim page shows both teams its name, password and settings), and
 * which OPEN times the booking withdrew — theirs and the posting team's —
 * because nothing else on the page says so.
 */
export function scrimBookedToast(m: {
  hostTeamName: string;
  hostCaptainName: string;
  ownWithdrawn: number;
  hostWithdrawn: number;
}): string {
  const times = (count: number) =>
    count === 1 ? "open time" : `${count} other open times`;
  const parts = [
    `Scrim booked. ${m.hostCaptainName} (${m.hostTeamName}) hosts; the lobby's name, password and settings are on the scrim page.`,
  ];
  if (m.ownWithdrawn > 0) {
    parts.push(
      m.ownWithdrawn === 1
        ? "Your other open time within four hours of it was withdrawn."
        : `Your ${times(m.ownWithdrawn)} within four hours of it were withdrawn.`,
    );
  }
  if (m.hostWithdrawn > 0) {
    parts.push(
      m.hostWithdrawn === 1
        ? `${m.hostTeamName}'s other open time within four hours of it was withdrawn.`
        : `${m.hostTeamName}'s ${times(m.hostWithdrawn)} within four hours of it were withdrawn.`,
    );
  }
  return parts.join(" ");
}

/**
 * Bookings that start before this moment and still have no games are "Not
 * played": 36 hours after kickoff — the end of the window a scrim game can be
 * matched to — they leave "Booked" and join the history. Display only: the
 * row stays SCHEDULED, so a captain who did play can still add the game by
 * match ID (the import judges the game's own start time, not today's date).
 */
export function scrimNotPlayedCutoff(nowMs: number): Date {
  return new Date(nowMs - SCRIM_DETECT_WINDOW_AFTER_MS);
}

export function isScrimNotPlayed(
  status: string,
  scheduledAtMs: number,
  nowMs: number,
): boolean {
  return (
    status === SCRIM_STATUS.SCHEDULED &&
    scheduledAtMs < scrimNotPlayedCutoff(nowMs).getTime()
  );
}

type ScrimScore = {
  hostTeamName: string;
  awayTeamName: string;
  hostScore: number;
  awayScore: number;
};

function scrimEndOutcome(m: ScrimScore) {
  const score = `${m.hostScore}–${m.awayScore}`;
  if (m.hostScore === m.awayScore) return { score, winner: null };
  return {
    score,
    winner: m.hostScore > m.awayScore ? m.hostTeamName : m.awayTeamName,
  };
}

/** The confirm on "End series": what the current score makes final. */
export function scrimEndConfirm(m: ScrimScore): string {
  const { score, winner } = scrimEndOutcome(m);
  return winner
    ? `End this series at ${score}? ${winner} win it, and no more games can be added.`
    : `End this series level at ${score}, with no winner? No more games can be added.`;
}

/** The toast after a series is ended at its current score. */
export function scrimEndedMessage(m: ScrimScore): string {
  const { score, winner } = scrimEndOutcome(m);
  return winner
    ? `Series ended at ${score}. ${winner} win it.`
    : `Series ended level at ${score}, with no winner.`;
}

/** Who the viewer is to one scrim, as the page and the Captains page read it. */
export type ScrimViewerFacts = {
  isAdmin: boolean;
  captainsHost: boolean;
  captainsAway: boolean;
  coachesHost: boolean;
  coachesAway: boolean;
  /** A rostered player on either side. */
  rostered: boolean;
};

export type ScrimManageView = {
  role: "host-captain" | "away-captain" | "member" | "other";
  /** Captain or coach of that side: its guests are theirs to add and remove. */
  managesHost: boolean;
  managesAway: boolean;
  /** Claimed and still to play (not listed as "Not played"). */
  booked: boolean;
  /** Lineups can still change. */
  mutable: boolean;
  showCancel: boolean;
  canEndSeries: boolean;
  /** "Add a game by its match ID" and "Search the players' matches". */
  showResultTools: boolean;
  /** Tools sit under "Game missing?" while games still record by themselves. */
  foldTools: boolean;
  /** Both teams, their coaches and admins get the lobby's password. */
  seesPassword: boolean;
};

/**
 * Which of a scrim's controls this viewer gets: one rule for the scrim's own
 * page and the Captains page, so the two can't disagree. It mirrors the
 * scrim services' refusals (captains cancel and end a series; captains and
 * coaches manage guests and results; a live scrim can't be cancelled; a
 * finished season takes no changes), and the services re-check all of it.
 */
export function scrimManageView(m: {
  status: string;
  hasOpponent: boolean;
  /** The active season isn't complete. */
  seasonOpen: boolean;
  /** `isScrimNotPlayed` for this scrim. */
  notPlayed: boolean;
  /** The season has a league ticket, so games record by themselves. */
  hasTicket: boolean;
  kickoffPassed: boolean;
  /** Null for a signed-out visitor. */
  viewer: ScrimViewerFacts | null;
}): ScrimManageView {
  const v = m.viewer;
  const live = m.status === SCRIM_STATUS.LIVE;
  const scheduled = m.status === SCRIM_STATUS.SCHEDULED;
  const managesHost = !!v && (v.captainsHost || v.coachesHost);
  const managesAway =
    !!v && m.hasOpponent && (v.captainsAway || v.coachesAway);
  const captainsAway = !!v && m.hasOpponent && v.captainsAway;
  const role = !v
    ? "other"
    : v.captainsHost
      ? "host-captain"
      : captainsAway
        ? "away-captain"
        : v.rostered || v.coachesHost || (m.hasOpponent && v.coachesAway)
          ? "member"
          : "other";
  const isAdmin = !!v && v.isAdmin;
  const canCancel = !!v && (isAdmin || v.captainsHost || captainsAway);
  const mutable =
    live || (m.seasonOpen && (m.status === SCRIM_STATUS.OPEN || scheduled));
  return {
    role,
    managesHost,
    managesAway,
    booked: m.hasOpponent && !m.notPlayed && (scheduled || live),
    mutable,
    showCancel: canCancel && mutable && !live,
    canEndSeries: canCancel && live && m.hasOpponent,
    showResultTools:
      m.hasOpponent &&
      (isAdmin || managesHost || managesAway) &&
      (live || (scheduled && (isAdmin || m.seasonOpen))),
    foldTools: m.hasTicket && !m.notPlayed && (!m.kickoffPassed || live),
    seesPassword: role !== "other" || isAdmin,
  };
}
