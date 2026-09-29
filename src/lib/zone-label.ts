// A time zone in the words players use: "Berlin time", "Pacific time".
//
// Kept free of imports so league-config can name its own zone with it
// (zoned-time, which also re-exports zoneLabel, imports league-config).

// The US zones have names players already use ("Pacific", "Eastern"); the
// league-config label for the US night is "Pacific" for the same reason.
const US_ZONE_NAMES: Record<string, string> = {
  "America/Los_Angeles": "Pacific",
  "America/Vancouver": "Pacific",
  "America/Denver": "Mountain",
  "America/Edmonton": "Mountain",
  "America/Phoenix": "Arizona",
  "America/Chicago": "Central",
  "America/Winnipeg": "Central",
  "America/New_York": "Eastern",
  "America/Toronto": "Eastern",
  "America/Detroit": "Eastern",
  "America/Anchorage": "Alaska",
  "Pacific/Honolulu": "Hawaii",
};

const REGION_PREFIX =
  /^(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\//;

/**
 * A zone's plain name: "Berlin", "Pacific". A zone with no city in its id
 * ("UTC", "Etc/GMT-1") is named by the id itself.
 */
export function zoneName(timeZone: string): string {
  const known = US_ZONE_NAMES[timeZone];
  if (known) return known;
  if (REGION_PREFIX.test(timeZone)) {
    const city = timeZone.slice(timeZone.lastIndexOf("/") + 1).replace(/_/g, " ");
    if (city) return city;
  }
  return timeZone;
}

/**
 * A zone in plain words: "Berlin time", "Pacific time". A zone with no city
 * in its id ("UTC", "Etc/GMT-1") falls back to the id itself.
 */
export function zoneLabel(timeZone: string): string {
  return `${zoneName(timeZone)} time`;
}
