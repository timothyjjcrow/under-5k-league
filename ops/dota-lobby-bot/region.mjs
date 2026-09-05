/** Pinned dota2-user ServerRegion: USEast=2, Europe (EU West)=3. */
export function gameServerRegion(value = "2") {
  if (value !== "2" && value !== "3")
    throw new Error("DOTA_GAME_SERVER_REGION must be 2 (US East) or 3 (Europe West).");
  return Number(value);
}
