"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { describeTimes, parseSlotKey } from "@/lib/match-night-poll";
import { castBallot } from "@/lib/match-night-poll-service";
import { SIGN_IN_REQUIRED } from "@/lib/sign-in";
import { actionErrorMessage } from "@/lib/user-facing-error";
import { zoneLabel } from "@/lib/zone-label";
import { LEAGUE_LOCALE } from "@/lib/zoned-time";

/**
 * Save the signed-in voter's availability in a match-night poll: every start
 * time they could play, as many as they like. Only players signed up for the
 * season may vote (castBallot checks), once per poll, and they can change it
 * until voting closes. The form posts the times as a JSON list of slot keys,
 * or `none=1` for "None of these work for me".
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
  let availability: unknown = [];
  if (!none) {
    try {
      availability = JSON.parse(str(formData, "availability"));
    } catch {
      availability = null;
    }
    if (!Array.isArray(availability)) {
      return { error: "Your times didn't come through. Reload and try again." };
    }
    if (availability.length === 0) {
      return {
        error:
          "Tap every time you could play, or choose None of these work for me.",
      };
    }
  }

  let outcome: Awaited<ReturnType<typeof castBallot>>;
  try {
    outcome = await castBallot({ pollId, userId: user.id, availability });
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
  if (outcome.availability.length === 0) {
    return {
      message:
        "Saved: none of these times work for you. You can change it until voting closes.",
    };
  }
  const picked = outcome.availability
    .map(parseSlotKey)
    .filter((slot) => slot !== null);
  const ranges = describeTimes(picked, LEAGUE_LOCALE);
  const shown =
    ranges.length > 4
      ? `${ranges.slice(0, 4).join(", ")} and ${ranges.length - 4} more`
      : ranges.join(", ");
  // Never silently rewrite what was submitted: say when times were left off.
  const dropped =
    outcome.dropped > 0
      ? ` ${outcome.dropped} time${outcome.dropped === 1 ? " isn't" : "s aren't"} in this poll and ${outcome.dropped === 1 ? "was" : "were"} left off.`
      : "";
  const count = outcome.availability.length;
  return {
    message: `Saved ${count} time${count === 1 ? "" : "s"}: ${shown} (${zoneLabel(LEAGUE_CONFIG.timeZone)}).${dropped}`,
  };
}
