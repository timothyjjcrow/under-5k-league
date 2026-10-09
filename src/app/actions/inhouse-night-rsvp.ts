"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import { setInhouseNightRsvp } from "@/lib/inhouse-night-rsvp-service";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { SIGN_IN_REQUIRED } from "@/lib/sign-in";
import { actionErrorMessage } from "@/lib/user-facing-error";

/**
 * "I'm in" (`going=1`) for the planned inhouse night, from Home's bar or the
 * inhouse page, or taking it back (`going=0`). Any signed-in player with a
 * linked Discord account (the bar and the card send everyone else through the
 * account link first); the form names the night its page showed (`nightId`),
 * so a night that changed meanwhile is refused rather than signed up for.
 */
export async function setInhouseNightRsvpAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: SIGN_IN_REQUIRED };
  }
  const nightId = str(formData, "nightId").trim();
  const going = str(formData, "going") === "1";
  if (!nightId) return { error: "Reload the page and try again." };

  let result: Awaited<ReturnType<typeof setInhouseNightRsvp>>;
  try {
    result = await setInhouseNightRsvp({ userId: user.id, nightId, going });
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "That didn't save. Reload the page and try again.",
        "inhouse-night.rsvp",
      ),
    };
  }

  revalidatePath("/", "layout");
  if (result.outcome === "out" || result.outcome === "already-out") {
    return { message: "Okay, you're off the list for this inhouse night." };
  }
  const when = result.night
    ? ` for ${formatLeagueMatchTime(new Date(result.night.startsAtMs), "full")}`
    : "";
  // Wherever accounts can be linked, everyone who gets in is linked, and the
  // start post pings them; a deployment that can't link says nothing more.
  const ping = result.linked ? " You'll get a Discord ping when it starts." : "";
  return {
    message:
      result.outcome === "already-in"
        ? `You're already in${when}.`
        : `You're in${when}.${ping}`,
  };
}
