/** Pinned dota2-user ServerRegion: USEast=2, Europe (EU West)=3. */
export function gameServerRegion(value = "2") {
  if (value !== "2" && value !== "3")
    throw new Error("DOTA_GAME_SERVER_REGION must be 2 (US East) or 3 (Europe West).");
  return Number(value);
}

/** Sharing is an explicit opt-in; omitted configuration keeps one region. */
export function gameServerRegions(value, fallback) {
  if (value === undefined) return [gameServerRegion(fallback)];
  if (typeof value !== "string" || !/^[23](?:,[23])?$/.test(value))
    throw new Error("DOTA_GAME_SERVER_REGIONS must be 2, 3, or 2,3 without spaces.");
  const regions = value.split(",").map(Number);
  if (new Set(regions).size !== regions.length)
    throw new Error("DOTA_GAME_SERVER_REGIONS must not repeat a region.");
  return regions;
}
