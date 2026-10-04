"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { parseSlotKey, slotLabel } from "@/lib/match-night-poll";
import { castBallot } from "@/lib/match-night-poll-service";
import { SIGN_IN_REQUIRED } from "@/lib/sign-in";
import { actionErrorMessage } from "@/lib/user-facing-error";
import { LEAGUE_LOCALE } from "@/lib/zoned-time";

/**
 * Save the signed-in voter's ranking in a match-night poll. Any signed-in
 * account may vote, once per poll, and recast until voting closes. The form
 * posts the ranking as a JSON list of slot keys, best first, or `none=1` for
 * "None of these work for me".
 */
export async function castMatchNightBallot(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: SIGN_IN_REQUIRED };
  }
  const pollId = str(formData, "pollId").trim();
  const none = str(formData, "none") === "1";
  let ranking: unknown = [];
  if (!none) {
    try {
      ranking = JSON.parse(str(formData, "ranking"));
    } catch {
      ranking = null;
    }
    if (!Array.isArray(ranking)) {
      return { error: "Your ranking didn't come through. Reload and try again." };
    }
    if (ranking.length === 0) {
      return {
        error:
          "Tap the slots you can make, best first, or choose None of these work for me.",
      };
    }
  }

  let outcome: Awaited<ReturnType<typeof castBallot>>;
  try {
    outcome = await castBallot({ pollId, userId: user.id, ranking });
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "Your vote couldn't be saved. Reload and try again.",
        "match-night-poll.cast",
      ),
    };
  }
  if (!outcome.ok) return { error: outcome.error };

  revalidatePath("/");
  if (outcome.ranking.length === 0) {
    return {
      message:
        "Saved: none of these slots work for you. You can change it until voting closes.",
    };
  }
  const first = parseSlotKey(outcome.ranking[0]);
  const top = first
    ? slotLabel(first, LEAGUE_CONFIG.timeZone, LEAGUE_LOCALE)
    : "your first choice";
  // Never silently rewrite what was submitted: say when slots were left off.
  const dropped =
    outcome.dropped > 0
      ? ` ${outcome.dropped} slot${outcome.dropped === 1 ? " isn't" : "s aren't"} in this poll and ${outcome.dropped === 1 ? "was" : "were"} left off.`
      : "";
  return {
    message: `Vote saved: ${outcome.ranking.length} slot${outcome.ranking.length === 1 ? "" : "s"} ranked, ${top} first.${dropped}`,
  };
}
