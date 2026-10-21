"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import { answerRollCall, takeBackRollCall } from "@/lib/roll-call-service";
import { SIGN_IN_REQUIRED } from "@/lib/sign-in";
import { actionErrorMessage } from "@/lib/user-facing-error";

/**
 * "I'm in" on Home's roll call: the player can play the season's match night
 * every week and will play for whichever team drafts them. The form names
 * the night its card showed (`night`), so a night that moved meanwhile is
 * refused rather than agreed to.
 */
export async function answerRollCallAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: SIGN_IN_REQUIRED };
  }
  const seenNight = str(formData, "night").trim();
  if (!seenNight) return { error: "Reload the page and try again." };

  let result: Awaited<ReturnType<typeof answerRollCall>>;
  try {
    result = await answerRollCall({ userId: user.id, seenNight });
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "That didn't save. Reload the page and try again.",
        "roll-call.answer",
      ),
    };
  }
  revalidatePath("/", "layout");
  if (result.outcome === "already-in") {
    return { message: "You're already in." };
  }
  return {
    message:
      result.outcome === "renewed"
        ? `You're in for the new match night: ${result.night}.`
        : `You're in. Match night is ${result.night}. See you on the first one.`,
  };
}

/** Take back an "I'm in" from Home's roll call. */
export async function takeBackRollCallAction(
  _prev: ActionResult,
  _formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: SIGN_IN_REQUIRED };
  }
  let result: Awaited<ReturnType<typeof takeBackRollCall>>;
  try {
    result = await takeBackRollCall({ userId: user.id });
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "That didn't save. Reload the page and try again.",
        "roll-call.take-back",
      ),
    };
  }
  revalidatePath("/", "layout");
  return {
    message:
      result.outcome === "out"
        ? "Okay, you're off the roll call. If you can't play the season, withdraw your signup on My account so nobody drafts you."
        : "You weren't on the roll call.",
  };
}
