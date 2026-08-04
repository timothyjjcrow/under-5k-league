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
  rescheduleDeclinedMessage,
  rescheduleMessage,
  rescheduleProposedMessage,
  sendDiscordMessage,
} from "@/lib/discord";
import { mentionUsers } from "@/lib/discord-mentions";
import type { ActionResult } from "@/lib/action-result";
import { actionErrorMessage } from "@/lib/user-facing-error";

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
    return {
      error: actionErrorMessage(
        e,
        "Couldn't propose — try again",
        "reschedule.propose",
      ),
    };
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
    // Addressed to the opposing captain — the message literally asks them to
    // respond, so it should reach them rather than wait to be noticed.
    await mentionUsers([proposed.notifyUserId]),
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

  let outcome;
  try {
    outcome = await respondInService(
      user.id,
      str(formData, "requestId"),
      accept,
    );
  } catch (e) {
    return {
      error: actionErrorMessage(
        e,
        "Couldn't respond — try again",
        "reschedule.respond",
      ),
    };
  }

  if (outcome.accepted) {
    await sendDiscordMessage(
      rescheduleMessage({
        homeName: outcome.homeName,
        awayName: outcome.awayName,
        week: outcome.week,
        isPlayoff: outcome.isPlayoff,
        whenMs: outcome.newTime.getTime(),
        clearedRsvps: outcome.clearedRsvps,
      }),
      // The proposer asked and has been waiting — and the booked standins'
      // personally-mentioned assignment message quoted the OLD kickoff, so
      // this is the one send that can correct them with the new one.
      await mentionUsers([outcome.notifyUserId, ...outcome.standinUserIds]),
    );
  } else {
    // A DECLINE is the answer to a question this channel already announced.
    // It used to send nothing at all: the service returned null and the
    // `if (accepted)` above skipped every send, so the proposer waited on an
    // answer that had already been given. Same audience as the acceptance —
    // the proposer alone; nobody else can act on it.
    await sendDiscordMessage(
      rescheduleDeclinedMessage({
        homeName: outcome.homeName,
        awayName: outcome.awayName,
        week: outcome.week,
        isPlayoff: outcome.isPlayoff,
        declinerName: user.name,
        whenMs: outcome.proposedTime.getTime(),
      }),
      await mentionUsers([outcome.notifyUserId]),
    );
  }
  refresh();
  return outcome.accepted
    ? {
        ok: true,
        // Name a standin the move has just double-booked. The captain who
        // accepted is the one who arranged that cover, so they are the right
        // person to hear it — and until now nothing anywhere said it.
        message:
          "Accepted — match retimed for both teams." +
          (outcome.standinClashes.length
            ? ` ⚠ Standin clash: ${outcome.standinClashes.join("; ")} — remove one of those assignments.`
            : ""),
      }
    : {
        ok: true,
        message: "Declined — the current time stands, and the proposer was told.",
      };
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
    return {
      error: actionErrorMessage(
        e,
        "Couldn't withdraw — try again",
        "reschedule.cancel",
      ),
    };
  }
  refresh();
  return { ok: true, message: "Proposal withdrawn." };
}
