/** Match the relay's strict public health schema; never include process config. */
export function lobbyHealth(controller, steamId) {
  return {
    online: controller.online,
    steamId: steamId ?? null,
    activeKey: controller.data.active ?? null,
    lobbyId: controller.lobby?.lobbyId ?? null,
    gameMode: controller.lobby?.gameMode ?? null,
    serverRegion: controller.lobby?.serverRegion ?? null,
    leagueId: controller.lobby?.leagueid ?? null,
  };
}
