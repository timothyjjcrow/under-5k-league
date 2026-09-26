/** How long the bot may stay offline after losing Steam before it exits. */
export const OFFLINE_RESTART_MS = 5 * 60_000;

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
 * an operator, and restarting would just repeat them.
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
