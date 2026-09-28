// Helpers shared by the admin action modules (admin-season.ts,
// admin-captains-draft.ts, admin-roster.ts, admin-schedule-results.ts and
// admin-discord.ts).
//
// Deliberately NOT a "use server" module: every export of one becomes a
// Server Action anyone can call, and nothing here checks who is asking. The
// error classes are shared so an `instanceof` check matches the class the
// transaction threw, whichever module threw it. They are thrown from inside a
// `$transaction` callback when a precondition checked OUTSIDE it has since
// stopped holding: they must be throws, never returns, because a resolved
// callback COMMITS.

import { revalidatePath, updateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";

export class ActiveSeasonChangedError extends Error {}

export class ResultsLandedError extends Error {}

export class DraftAlreadyStartedError extends Error {}

export class DraftSetupLockedError extends Error {}

export class CaptainStateChangedError extends Error {}

export class ResultWriteError extends Error {}

export function refresh() {
  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/", "layout");
}

// Game imports/edits also invalidate the cached all-games stat scans
// (src/lib/cached-queries.ts, tagged "games") so leaders / meta / records /
// hall-of-fame / player profiles reflect the change immediately instead of
// after the 60s TTL. revalidatePath alone does NOT clear unstable_cache tags.
export function refreshGames() {
  // Server Actions need read-your-own-writes semantics: updateTag expires the
  // entry immediately, while revalidateTag(..., "max") would deliberately
  // serve the first reader stale data and refresh in the background.
  updateTag("games");
  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/", "layout");
}
