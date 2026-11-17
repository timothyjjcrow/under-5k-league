"use server";

// A standin's "I can play" and its undo (standin-offer-service holds the
// checks). Thin: auth, the service, then the one Discord post an offer can
// send, after the write and best-effort. Booking an offer is the captain's
// own action (captainAssignStandin), not this file.

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import { SIGN_IN_REQUIRED } from "@/lib/sign-in";
import { sendStandinOfferPost } from "@/lib/standin-offer-post";
import {
  offerToStandIn,
  withdrawStandinOffer,
} from "@/lib/standin-offer-service";
import type { ActionResult } from "@/lib/action-result";

/** Say "I can play" for one side of a match that needs a standin. */
export async function offerToStandInAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: SIGN_IN_REQUIRED };
  }
  const res = await offerToStandIn({
    matchId: str(formData, "matchId"),
    teamId: str(formData, "teamId"),
    userId: user.id,
  });
  if (!res.ok) return { error: res.error };
  // That side's captain is told when the offer is news (the first one, then
  // at most once a window): sendStandinOfferPost, after the write.
  await sendStandinOfferPost(res);
  revalidatePath("/", "layout");
  return { message: res.message };
}

/** Take an "I can play" back. */
export async function withdrawStandinOfferAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: SIGN_IN_REQUIRED };
  }
  const res = await withdrawStandinOffer({
    matchId: str(formData, "matchId"),
    teamId: str(formData, "teamId"),
    userId: user.id,
  });
  revalidatePath("/", "layout");
  return { message: res.message };
}
