"use server";

// Admin controls for the match-night poll (the Match night poll section on
// /admin). The poll belongs to no season, so none of these write a season;
// turning the winner into the season's match-night text reuses the existing
// setMatchSchedule action from the same card.

import type { ActionResult } from "@/lib/action-result";
import { logAdminAction } from "@/lib/admin-log";
import {
  matchNightPollOpenedMessage,
  matchNightPollResultMessage,
  sendDiscordMessage,
} from "@/lib/discord";
import { bool, localDate, str } from "@/lib/form";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import {
  DEFAULT_POLL_QUESTION,
  parseSlotKey,
  parseSlotRows,
  slotLabel,
} from "@/lib/match-night-poll";
import {
  closePollNow,
  createPoll,
  deletePoll,
  loadPollById,
  setPollClosesAt,
} from "@/lib/match-night-poll-service";
import { prisma } from "@/lib/prisma";
import { isUniqueViolation } from "@/lib/prisma-errors";
import { actionErrorMessage } from "@/lib/user-facing-error";
import { LEAGUE_LOCALE, formatLeagueTime } from "@/lib/zoned-time";
import { adminOrError, refresh } from "./admin-shared";

const label = (key: string) => {
  const slot = parseSlotKey(key);
  return slot ? slotLabel(slot, LEAGUE_CONFIG.timeZone, LEAGUE_LOCALE) : key;
};

export async function createMatchNightPoll(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const parsed = parseSlotRows(
    formData.getAll("slotDay").map(String),
    formData.getAll("slotTime").map(String),
  );
  if ("error" in parsed) return parsed;
  const closesAt = localDate(formData, "closesAt", "closesAtTs");
  if (!closesAt) return { error: "Pick when voting closes." };
  const question = str(formData, "question").trim() || DEFAULT_POLL_QUESTION;
  const announce = bool(formData, "announce");

  let outcome: Awaited<ReturnType<typeof createPoll>>;
  try {
    outcome = await createPoll({
      question,
      slots: parsed.slots,
      closesAt,
      createdById: admin.id,
    });
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "The poll couldn't be opened. Reload and try again.",
        "admin-poll.create",
      ),
    };
  }
  if (!outcome.ok) return { error: outcome.error };

  const labels = parsed.slots.map((slot) =>
    slotLabel(slot, LEAGUE_CONFIG.timeZone, LEAGUE_LOCALE),
  );
  const closing = formatLeagueTime(closesAt);
  await logAdminAction({
    action: "createMatchNightPoll",
    summary: `Opened the match-night poll "${outcome.poll.question}" with ${labels.length} slots (${labels.join("; ")}), closing ${closing}`,
  });
  // After the commit and best-effort: the poll is open whatever Discord says.
  const posted = announce
    ? await sendDiscordMessage(
        matchNightPollOpenedMessage({
          question: outcome.poll.question,
          slots: labels,
          closesAtMs: closesAt.getTime(),
        }),
      )
    : false;
  refresh();
  const discord = !announce
    ? "It wasn't posted to Discord."
    : posted
      ? "It's announced on Discord."
      : "It couldn't be posted to Discord. Check the league webhook under Discord.";
  return {
    message: `Poll open on Home with ${labels.length} slots until ${closing}. ${discord}`,
  };
}

export async function closeMatchNightPoll(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const outcome = await closePollNow({ pollId: str(formData, "pollId").trim() });
  if (!outcome.ok) return { error: outcome.error };
  await logAdminAction({
    action: "closeMatchNightPoll",
    summary: `Closed voting on the match-night poll "${outcome.question}" with ${outcome.ballots} vote${outcome.ballots === 1 ? "" : "s"}`,
  });
  refresh();
  return {
    message: `Voting closed with ${outcome.ballots} vote${outcome.ballots === 1 ? "" : "s"}. The result shows on Home for the next week.`,
  };
}

/** Extend, shorten or reopen: one closing-time box serves all three. */
export async function setMatchNightPollClosing(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const closesAt = localDate(formData, "closesAt", "closesAtTs");
  if (!closesAt) return { error: "Pick when voting closes." };
  let outcome: Awaited<ReturnType<typeof setPollClosesAt>>;
  try {
    outcome = await setPollClosesAt({
      pollId: str(formData, "pollId").trim(),
      closesAt,
    });
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "The closing time couldn't be saved. Reload and try again.",
        "admin-poll.closing",
      ),
    };
  }
  if (!outcome.ok) return { error: outcome.error };
  const closing = formatLeagueTime(closesAt);
  await logAdminAction({
    action: "setMatchNightPollClosing",
    summary: outcome.reopened
      ? `Reopened the match-night poll "${outcome.question}" until ${closing}`
      : `Moved the match-night poll "${outcome.question}" to close ${closing}`,
  });
  refresh();
  return {
    message: outcome.reopened
      ? `Voting reopened until ${closing}. Every earlier vote still counts.`
      : `Voting now closes ${closing}.`,
  };
}

export async function deleteMatchNightPoll(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const outcome = await deletePoll(
    str(formData, "pollId").trim(),
    str(formData, "confirmationName"),
  );
  if (!outcome.ok) return { error: outcome.error };
  await logAdminAction({
    action: "deleteMatchNightPoll",
    summary: `Deleted the match-night poll "${outcome.question}" and its ${outcome.ballots} vote${outcome.ballots === 1 ? "" : "s"}`,
  });
  refresh();
  return {
    message: `Deleted the poll and its ${outcome.ballots} vote${outcome.ballots === 1 ? "" : "s"}.`,
  };
}

/**
 * Post a closed poll's winner to the league channel. Once per result: a
 * Setting row keyed by the poll and its closing time is claimed first, so a
 * double click posts once, while a poll that is reopened and closes again
 * can announce its new result.
 */
export async function announceMatchNightPollResult(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const poll = await loadPollById(str(formData, "pollId").trim(), admin, Date.now());
  if (!poll) return { error: "This poll no longer exists." };
  if (poll.open) return { error: "Voting is still open. Close it first." };
  const result = poll.results;
  const final = result?.rounds.at(-1);
  if (!result?.winner || !final) {
    return { error: "Nobody ranked a slot, so there's no winner to announce." };
  }
  const marker = `matchNightPollResult:${poll.id}:${poll.closesAt}`;
  try {
    await prisma.setting.create({ data: { key: marker, value: "sending" } });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { error: "This result was already announced on Discord." };
    }
    throw error;
  }
  const winner = label(result.winner);
  const posted = await sendDiscordMessage(
    matchNightPollResultMessage({
      question: poll.question,
      winner,
      votes: final.tallies.find((t) => t.key === result.winner)?.votes ?? 0,
      counted: result.ballots - final.exhausted,
      rounds: result.rounds.length,
    }),
  );
  if (!posted) {
    // Free the claim so the admin can try again once the webhook works.
    await prisma.setting.deleteMany({ where: { key: marker, value: "sending" } });
    return {
      error: "The result couldn't be posted to Discord. Check the league webhook under Discord.",
    };
  }
  await prisma.setting.updateMany({
    where: { key: marker },
    data: { value: "sent" },
  });
  await logAdminAction({
    action: "announceMatchNightPollResult",
    summary: `Announced on Discord that ${winner} won the match-night poll "${poll.question}"`,
  });
  return { message: `Announced on Discord: ${winner} won.` };
}
