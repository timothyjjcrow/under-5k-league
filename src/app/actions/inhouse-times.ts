"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import { parseInhouseTimeParam } from "@/lib/inhouse-times";
import { setInhouseTimeRsvp } from "@/lib/inhouse-times-service";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { SIGN_IN_REQUIRED } from "@/lib/sign-in";
import { actionErrorMessage } from "@/lib/user-facing-error";

/**
 * Play later on /inhouse: "I'm in" (`going=1`) on the time the form names
 * (`at`, inhouseTimeParam), or taking it back (`going=0`). The "Post a time"
 * form sends `posting=1` with the time its box picked: posting is saying
 * "I'm in" first, and a time someone already posted just puts the player in
 * on it, which the toast says. Any signed-in player.
 */
export async function setInhouseTimeAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: SIGN_IN_REQUIRED };
  }
  const posting = str(formData, "posting") === "1";
  const going = posting || str(formData, "going") === "1";
  const startsAtMs = parseInhouseTimeParam(str(formData, "at").trim());
  if (startsAtMs === null) {
    return { error: posting ? "Pick a time first." : "Reload the page and try again." };
  }

  let outcome;
  try {
    ({ outcome } = await setInhouseTimeRsvp({ userId: user.id, startsAtMs, going }));
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "That didn't save. Reload the page and try again.",
        "inhouse-times.rsvp",
      ),
    };
  }

  revalidatePath("/", "layout");
  // The league's clock, zone named: the server can't know the player's.
  const when = formatLeagueMatchTime(new Date(startsAtMs), "full");
  switch (outcome) {
    case "posted":
      return { message: `You posted ${when}. Copy its link to share it in Discord.` };
    case "in":
      return {
        message: posting
          ? `${when} was already up, so you're in on it.`
          : `You're in for ${when}.`,
      };
    case "already-in":
      return { message: `You're already in for ${when}.` };
    default:
      return { message: `Okay, you're off ${when}.` };
  }
}
