"use server";

// Thin auth/toast wrappers around reschedule-service (which holds the
// integration-tested guards). Discord announcement stays here — a webhook
// failure must never affect the retiming itself.

import { revalidatePath, updateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { getSessionUser, requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import {
  cancelReschedule as cancelInService,
  lockInReschedule as lockInService,
  proposeReschedule as proposeInService,
  respondReschedule as respondInService,
  voteReschedule as voteInService,
  type AcceptedReschedule,
} from "@/lib/reschedule-service";
import { loadReadyCheckViewById } from "@/lib/reschedule-ready-check-service";
import {
  READY_CHECK_ROSTER_PING_SECONDS,
  readyCheckRosterPingKey,
  type ReadyCheckView,
} from "@/lib/reschedule-ready-check";
import { claimThrottle } from "@/lib/settings";
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
  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/", "layout");
}

/** An epoch-ms form value, or null when it isn't one. */
function epoch(raw: FormDataEntryValue | null): Date | null {
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw.trim())) return null;
  const ms = Number(raw);
  return Number.isSafeInteger(ms) && ms > 0 ? new Date(ms) : null;
}

/**
 * Announce a locked-in time and build the toast for whoever locked it.
 * `lockedByName` is the captain who locked it early; null when the last
 * ready-check answer moved it.
 */
async function announceLock(
  outcome: AcceptedReschedule,
  actorId: string,
  lockedByName: string | null,
): Promise<string> {
  const rc = outcome.readyCheck;
  await sendDiscordMessage(
    rescheduleMessage({
      homeName: outcome.homeName,
      awayName: outcome.awayName,
      week: outcome.week,
      isPlayoff: outcome.isPlayoff,
      isTiebreaker: outcome.isTiebreaker,
      roundLabel: outcome.roundLabel,
      whenMs: outcome.newTime.getTime(),
      clearedRsvps: outcome.clearedRsvps,
      matchId: outcome.matchId,
      readyCheck: {
        everyoneIn: rc.everyoneIn,
        ready: rc.ready,
        seats: rc.seats,
        lockedByName: rc.everyoneIn ? null : lockedByName,
        outNames: rc.outNames,
        awaitingCount: rc.awaitingUserIds.length,
      },
    }),
    // The proposer asked and has been waiting; the booked standins'
    // personally-mentioned assignment message quoted the OLD kickoff; and
    // whoever never answered still owes a check-in for the new night. Never
    // the person who just acted.
    await mentionUsers(
      [
        outcome.notifyUserId,
        ...outcome.standinUserIds,
        ...rc.awaitingUserIds,
      ].filter((id) => id !== actorId),
    ),
  );
  return (
    (rc.everyoneIn
      ? "Everyone's in — match moved for both teams."
      : "Locked in — match moved for both teams.") +
    (rc.outNames.length
      ? ` ${rc.outNames.join(", ")} can't make it — they're checked in as out, so book cover if you need it.`
      : "") +
    // Name a standin the move has just double-booked. The captain who
    // accepted is the one who arranged that cover, so they are the right
    // person to hear it — and until now nothing anywhere said it.
    (outcome.standinClashes.length
      ? ` ⚠ Standin clash: ${outcome.standinClashes.join("; ")} — remove one of those assignments.`
      : "")
  );
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
  // The ready check posts one `optionTs` per time on offer. The single-time
  // form posted the epoch the browser computed (LocalDatetimeField) — the raw
  // datetime-local string is timezone-less and would be parsed in the
  // SERVER's zone (UTC in prod), shifting the proposal by the captain's
  // whole UTC offset.
  const options = formData.getAll("optionTs").map(epoch);
  if (options.some((t) => t === null))
    return { error: "Pick a valid date & time" };
  if (options.length === 0) {
    // Never the raw `proposedTime` string: CLAUDE.md's time rule, and no
    // form posts it any more.
    const single = epoch(formData.get("proposedTs"));
    if (!single) return { error: "Pick at least one time" };
    options.push(single);
  }

  let proposed;
  try {
    proposed = await proposeInService(
      user.id,
      str(formData, "matchId"),
      options as Date[],
      { note: str(formData, "note") },
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
  // A ready check needs an answer from everyone in the match, so the post
  // mentions them: the other captain first, then both rosters. Best-effort.
  // Only the first proposal of a kickoff in READY_CHECK_ROSTER_PING_SECONDS
  // rings the rosters; a re-proposal pings the other captain alone (players
  // still see the open check on Home and the match page). A store failure
  // pings everyone: one extra ping beats a check nobody heard about.
  let rosterPing = true;
  try {
    rosterPing = await claimThrottle(
      readyCheckRosterPingKey(proposed.matchId, proposed.scheduleRevision),
      READY_CHECK_ROSTER_PING_SECONDS,
      Date.now(),
    );
  } catch {
    rosterPing = true;
  }
  await sendDiscordMessage(
    rescheduleProposedMessage({
      homeName: proposed.homeName,
      awayName: proposed.awayName,
      week: proposed.week,
      isPlayoff: proposed.isPlayoff,
      isTiebreaker: proposed.isTiebreaker,
      roundLabel: proposed.roundLabel,
      proposerName: user.name,
      whenMs: proposed.proposedTime.getTime(),
      matchId: proposed.matchId,
      optionsMs: proposed.options.map((t) => t.getTime()),
      note: proposed.note,
    }),
    await mentionUsers(
      rosterPing
        ? [proposed.notifyUserId, ...proposed.readyCheckUserIds]
        : [proposed.notifyUserId],
    ),
  );
  refresh();
  return {
    ok: true,
    message:
      "Ready check sent — both teams can answer on this page, and it moves once everyone's in.",
  };
}

/** A ready-check answer's result: the fresh card, or the move it made. */
export type ReadyCheckActionResult = NonNullable<ActionResult> & {
  view?: ReadyCheckView | null;
  /** The answer completed the ready check and moved the match. */
  locked?: { timeMs: number };
};

/**
 * Answer the ready check for one option. Called from the card directly (not
 * a form), so it takes plain values and returns the fresh card state; every
 * value is still untrusted input.
 */
export async function voteReschedule(input: {
  matchId: string;
  requestId: string;
  timeMs: number;
  ready: boolean;
}): Promise<ReadyCheckActionResult> {
  const user = await getSessionUser();
  if (!user) return { error: "Sign in required" };
  if (
    !input ||
    typeof input.matchId !== "string" ||
    typeof input.requestId !== "string" ||
    typeof input.ready !== "boolean" ||
    !Number.isSafeInteger(input.timeMs) ||
    input.timeMs <= 0
  )
    return { error: "That answer didn't make sense — reload and try again" };

  let outcome;
  try {
    outcome = await voteInService(
      user.id,
      input.requestId,
      new Date(input.timeMs),
      input.ready,
      { onAcceptedCommit: () => updateTag(AUTOMATION_GATE_TAG) },
    );
  } catch (e) {
    return {
      error: actionErrorMessage(
        e,
        "Couldn't save your answer — try again",
        "reschedule.vote",
      ),
    };
  }
  if (outcome.locked) {
    const message = await announceLock(outcome.locked, user.id, null);
    refresh();
    return {
      ok: true,
      message,
      locked: { timeMs: outcome.locked.newTime.getTime() },
    };
  }
  return {
    ok: true,
    // Everyone was in but the time stopped fitting: say why nothing moved.
    ...(outcome.lockBlocked
      ? {
          message: `Everyone's in, but the match can't move there: ${outcome.lockBlocked}`,
        }
      : {}),
    view: await loadReadyCheckViewById(input.matchId, user, Date.now()),
  };
}

/** A captain locks in a time the other captain has said yes to. */
export async function lockInReschedule(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const time = epoch(formData.get("optionTs"));
  if (!time) return { error: "Pick which time to lock in" };
  let outcome;
  try {
    outcome = await lockInService(user.id, str(formData, "requestId"), time, {
      onAcceptedCommit: () => updateTag(AUTOMATION_GATE_TAG),
    });
  } catch (e) {
    return {
      error: actionErrorMessage(
        e,
        "Couldn't lock it in — try again",
        "reschedule.lock",
      ),
    };
  }
  const message = await announceLock(outcome, user.id, user.name);
  refresh();
  return { ok: true, message };
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
  const optionTime = epoch(formData.get("optionTs")) ?? undefined;

  let outcome;
  try {
    outcome = await respondInService(
      user.id,
      str(formData, "requestId"),
      accept,
      { optionTime, onAcceptedCommit: () => updateTag(AUTOMATION_GATE_TAG) },
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

  // The response service may have committed a new kickoff before the
  // best-effort Discord audience reads below. Queue gate expiry immediately
  // so those follow-ups cannot suppress the scheduler refresh.
  updateTag(AUTOMATION_GATE_TAG);

  if (outcome.accepted) {
    const message = await announceLock(outcome, user.id, user.name);
    refresh();
    return { ok: true, message };
  }
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
      isTiebreaker: outcome.isTiebreaker,
      roundLabel: outcome.roundLabel,
      declinerName: user.name,
      whenMs: outcome.proposedTime.getTime(),
      optionCount: outcome.optionTimes.length,
      matchId: outcome.matchId,
    }),
    await mentionUsers([outcome.notifyUserId]),
  );
  refresh();
  return {
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
