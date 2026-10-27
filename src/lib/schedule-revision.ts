import { createHash } from "node:crypto";

/**
 * Content-addressed claim for the regular-season fixtures a schedule form
 * showed: "none" before a schedule exists, else a digest of the fixture ids.
 * Generate, Regenerate and Swap teams post it, and the rebuild recomputes it
 * inside its Serializable transaction, so a tab opened before another admin
 * generated (or rebuilt) the schedule can't replace that schedule behind a
 * confirm written for the one it saw. Every rebuild writes new ids, so even a
 * same-layout regenerate changes it. Safe in a hidden field: it is not an
 * authorization token.
 */
export function regularScheduleRevision(fixtureIds: readonly string[]): string {
  if (fixtureIds.length === 0) return "none";
  return createHash("sha256")
    .update([...fixtureIds].sort().join("\n"))
    .digest("hex")
    .slice(0, 32);
}
