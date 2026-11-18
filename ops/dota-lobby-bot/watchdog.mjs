/** How long the bot may stay offline after losing Steam before it exits. */
export const OFFLINE_RESTART_MS = 5 * 60_000;

/**
 * How long a process that has never been online may go without a Steam
 * session before it exits. Longer than a slow sign-in through Steam's weekly
 * maintenance (2026-11-10: about 9 minutes from start to signed in), so one
 * of those is never cut short.
 */
export const SIGN_IN_RESTART_MS = 15 * 60_000;

/**
 * steam-user's autoRelogin can stall silently: the process stays up, keeps its
 * relay socket, and reports `online: false` forever, and because nothing
 * crashed the supervisor (launchd KeepAlive / systemd Restart=on-failure)
 * never restarts it. The check answers "exit now?" so a fresh process gets a
 * fresh Steam connection.
 *
 * It arms only after this process has been online once, so a bad saved session
 * or a Game Coordinator outage at startup costs at most one restart rather than
 * a login attempt every few minutes. A deliberate stop (wrong account, session
 * could not be saved, account playing elsewhere) never triggers it: those need
 * an operator, and restarting would just repeat them. Before the first
 * connection, signInWatchdog (below) covers a Steam sign-in that never comes.
 */
export function offlineWatchdog({ limitMs = OFFLINE_RESTART_MS, now = Date.now } = {}) {
  let everOnline = false;
  let offlineSince = null;
  return function shouldExit({ online, stopped }) {
    if (online) {
      everOnline = true;
      offlineSince = null;
      return false;
    }
    if (stopped || !everOnline) {
      offlineSince = null;
      return false;
    }
    const t = now();
    offlineSince ??= t;
    return t - offlineSince >= limitMs;
  };
}

/**
 * The startup half of the watchdog: a process that has never been online
 * exits once it has gone `limitMs` without a Steam session, counted from its
 * start or from its last Steam drop. On 2026-11-17 a process started during
 * Steam's maintenance and steam-user's own connect retries stopped with no
 * event at all: no sign-in, no error, no disconnect. offlineWatchdog never
 * arms before the first connection, so it sat offline for 14.6 hours.
 *
 * It answers only for a missing Steam session. Signed in to Steam and waiting
 * for the Game Coordinator never exits (a GC outage at startup is Valve's, and
 * a fresh login would not end it). Once the process has been online it never
 * answers again: offlineWatchdog owns that. Never after a deliberate stop, and
 * never once steam-user has reported an error or asked for a Steam Guard code
 * (`needsOperator`, latched for the life of the process): a refused session or
 * a missing code needs an operator, and a restart would only repeat it.
 */
export function signInWatchdog({ limitMs = SIGN_IN_RESTART_MS, now = Date.now } = {}) {
  let everOnline = false;
  let operatorNeeded = false;
  let waitingSince = now();
  return function shouldExit({ online, signedIn, stopped, needsOperator }) {
    if (online) everOnline = true;
    if (needsOperator) operatorNeeded = true;
    if (everOnline || operatorNeeded || stopped || signedIn) {
      waitingSince = null;
      return false;
    }
    const t = now();
    waitingSince ??= t;
    return t - waitingSince >= limitMs;
  };
}
