// The resync's transport: cycle the Game Coordinator session in-process.
// steam-user's gamesPlayed([]) makes dota2-user drop its GC session (an "app
// quit", which emits no disconnect), and gamesPlayed([570]) "launches" Dota
// again: dota2-user sends a ClientHello with no cache versions, so the GC
// answers with a complete ClientWelcome that resends every cache the account
// holds. server.mjs's welcome handler replays it into the controller
// (welcoming, snapshots, welcomed), which is what frees a phantom claim.
//
// It sends no lobby command. If no welcome comes within welcomeMs, noWelcome()
// runs: server.mjs exits non-zero so launchd (KeepAlive) or systemd
// (Restart=on-failure) starts a fresh process, whose welcome settles it, as
// the restart on 2026-10-18 did. Never after a deliberate Steam stop (wrong
// account, unsaved session, the account playing elsewhere): those need an
// operator, and a restart would only repeat them (watchdog.mjs's rule).
export const RESYNC_RELAUNCH_MS = 2000;
export const RESYNC_WELCOME_MS = 30_000;
const DOTA = 570;

export function gcResync({
  user,
  noWelcome,
  stopped = () => false,
  relaunchMs = RESYNC_RELAUNCH_MS,
  welcomeMs = RESYNC_WELCOME_MS,
}) {
  let deadline;
  return {
    start() {
      // Armed before anything that could throw.
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        deadline = undefined;
        if (!stopped()) noWelcome();
      }, welcomeMs);
      user.gamesPlayed([]);
      setTimeout(() => {
        if (!stopped()) user.gamesPlayed([DOTA], false);
      }, relaunchMs);
    },
    /** Every GC welcome ends a resync's countdown. */
    welcomed() {
      clearTimeout(deadline);
      deadline = undefined;
    },
  };
}
