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
import {
  rescheduleMessage,
  rescheduleProposedMessage,
  sendDiscordMessage,
} from "@/lib/discord";
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
  // Prefer the epoch the browser computed (LocalDatetimeField) — the raw
  // datetime-local string is timezone-less and would be parsed in the
  // SERVER's zone (UTC in prod), shifting the proposal by the captain's
  // whole UTC offset.
  const ts = Number(str(formData, "proposedTs"));
  const raw = str(formData, "proposedTime");
  const proposedTime =
    Number.isFinite(ts) && ts > 0 ? new Date(ts) : raw ? new Date(raw) : null;
  if (!proposedTime || Number.isNaN(proposedTime.getTime()))
    return { error: "Pick a valid date & time" };

  let proposed;
  try {
    proposed = await proposeInService(
      user.id,
      str(formData, "matchId"),
      proposedTime,
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't propose" };
  }
  // A proposal demands the OTHER captain's response — tell the channel
  // instead of hoping they wander onto the match page. Best-effort.
  await sendDiscordMessage(
    rescheduleProposedMessage({
      homeName: proposed.homeName,
      awayName: proposed.awayName,
      week: proposed.week,
      isPlayoff: proposed.isPlayoff,
      proposerName: user.name,
      whenMs: proposed.proposedTime.getTime(),
    }),
  );
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
        whenMs: accepted.newTime.getTime(),
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
