"use server";

// Thin auth/toast wrappers around reschedule-service (which holds the
// integration-tested guards). Discord announcement stays here — a webhook
// failure must never affect the retiming itself.

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import {
  cancelReschedule as cancelInService,
  proposeReschedule as proposeInService,
  respondReschedule as respondInService,
} from "@/lib/reschedule-service";
import { rescheduleMessage, sendDiscordMessage } from "@/lib/discord";
import type { ActionResult } from "@/lib/action-result";

function refresh() {
  revalidatePath("/", "layout");
}

export async function proposeReschedule(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const raw = str(formData, "proposedTime");
  const proposedTime = raw ? new Date(raw) : null;
  if (!proposedTime || Number.isNaN(proposedTime.getTime()))
    return { error: "Pick a valid date & time" };

  try {
    await proposeInService(user.id, str(formData, "matchId"), proposedTime);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't propose" };
  }
  refresh();
  return {
    ok: true,
    message: "Proposed — the other captain can accept it on this page.",
  };
}

export async function respondReschedule(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const accept = str(formData, "response") === "accept";

  let accepted;
  try {
    accepted = await respondInService(
      user.id,
      str(formData, "requestId"),
      accept,
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't respond" };
  }

  if (accepted) {
    await sendDiscordMessage(
      rescheduleMessage({
        homeName: accepted.homeName,
        awayName: accepted.awayName,
        week: accepted.week,
        isPlayoff: accepted.isPlayoff,
        when: accepted.newTime.toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
      }),
    );
  }
  refresh();
  return accepted
    ? { ok: true, message: "Accepted — match retimed for both teams." }
    : { ok: true, message: "Declined — the current time stands." };
}

export async function cancelReschedule(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  try {
    await cancelInService(
      user.id,
      str(formData, "requestId"),
      user.role === "ADMIN",
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't withdraw" };
  }
  refresh();
  return { ok: true, message: "Proposal withdrawn." };
}
