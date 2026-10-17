/** The two leagues on the self-hosted box (ggd2l-1). No credentials belong here.
 * Regions and their order match LEAGUE_TARGETS, whose generic release gates
 * (requireMaintenanceEvidence, promotePair) this release reuses unchanged:
 * US is promoted first, then Europe. Slot ports are the box layout's
 * (ops/selfhost: ggd2l-<lg>@a and @b behind Caddy on 127.0.0.1). */
export const BOX_TARGETS = Object.freeze([
  Object.freeze({ region: "us", origin: "https://us.ggd2l.com", slots: Object.freeze({ a: 3001, b: 3002 }) }),
  Object.freeze({ region: "eu", origin: "https://eu.ggd2l.com", slots: Object.freeze({ a: 3011, b: 3012 }) }),
]);

/** The release id the box agent mints for a build: `<lg>-<UTC stamp>-<sha12>`. */
export const RELEASE_ID = /^(us|eu)-\d{8}T\d{6}Z-[0-9a-f]{12}$/;

/** True when `id` is a release of `target` built from `sha`. */
export function releaseIdMatches(target, id, sha) {
  const match = RELEASE_ID.exec(String(id ?? ""));
  return Boolean(match) && match[1] === target.region && id.endsWith(`-${sha.slice(0, 12)}`);
}
