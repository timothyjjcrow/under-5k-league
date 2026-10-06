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
  POLL_DAYS,
  POLL_DEFAULT_FROM_HOUR,
  POLL_DEFAULT_TO_HOUR,
  gridSlots,
  gridSummary,
  nextSlotOccurrence,
  parseSlotKey,
  pollResultMarker,
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
import { zoneLabel } from "@/lib/zone-label";
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
  // The grid fills itself: every ticked day, on the hour, between the two
  // hours (every day, noon to 6 PM, unless the admin changed them).
  const hour = (key: string, fallback: number) => {
    const raw = str(formData, key).trim();
    return raw === "" ? fallback : Number(raw);
  };
  const ticked = formData.getAll("day").map(Number);
  const parsed = gridSlots({
    days: formData.has("daysPosted") ? ticked : [...POLL_DAYS],
    fromHour: hour("fromHour", POLL_DEFAULT_FROM_HOUR),
    toHour: hour("toHour", POLL_DEFAULT_TO_HOUR),
  });
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

  const summary = gridSummary(parsed.slots, LEAGUE_LOCALE);
  const zone = zoneLabel(LEAGUE_CONFIG.timeZone);
  const closing = formatLeagueTime(closesAt);
  await logAdminAction({
    action: "createMatchNightPoll",
    summary: `Opened the match-night poll "${outcome.poll.question}": ${summary} ${zone} (${parsed.slots.length} start times), closing ${closing}`,
  });
  // The earliest and latest start on the first day, so Discord can print the
  // hours on each reader's clock.
  const firstDay = parsed.slots.filter((slot) => slot.day === parsed.slots[0].day);
  const nowMs = Date.now();
  // After the commit and best-effort: the poll is open whatever Discord says.
  const posted = announce
    ? await sendDiscordMessage(
        matchNightPollOpenedMessage({
          question: outcome.poll.question,
          summary,
          zone,
          hours: {
            firstMs: nextSlotOccurrence(firstDay[0], nowMs, LEAGUE_CONFIG.timeZone),
            lastMs: nextSlotOccurrence(firstDay.at(-1)!, nowMs, LEAGUE_CONFIG.timeZone),
          },
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
    message: `Poll open on Home: ${summary} ${zone} (${parsed.slots.length} start times), until ${closing}. ${discord}`,
  };
}

export async function closeMatchNightPoll(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const pollId = str(formData, "pollId").trim();
  const outcome = await closePollNow({ pollId });
  if (!outcome.ok) return { error: outcome.error };
  await logAdminAction({
    action: "closeMatchNightPoll",
    summary: `Closed voting on the match-night poll "${outcome.question}" with ${outcome.ballots} vote${outcome.ballots === 1 ? "" : "s"}`,
  });
  refresh();
  // Name the winner in the toast: the card folds the result below its
  // header, and the next steps (use it, announce it) follow from it.
  const closed = await loadPollById(pollId, admin, Date.now());
  const winnerKey = closed?.results?.winner ?? null;
  const winner = winnerKey
    ? (closed?.slots.find((slot) => slot.key === winnerKey) ?? null)
    : null;
  const won = winner
    ? ` ${winner.label} won (${closed?.results?.counts[winner.key] ?? 0} can play).`
    : "";
  return {
    message: `Voting closed with ${outcome.ballots} vote${outcome.ballots === 1 ? "" : "s"}.${won} The result shows on Home for the next week.`,
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
  if (!result?.winner) {
    return { error: "Nobody marked a time they can play, so there's no winner to announce." };
  }
  const winnerSlot = poll.slots.find((slot) => slot.key === result.winner);
  const runnerKey = result.order[1];
  const runnerCount = runnerKey ? result.counts[runnerKey] : 0;
  const marker = pollResultMarker(poll.id, poll.closesAt);
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
      count: result.counts[result.winner],
      voters: result.ballots,
      nextAtMs: winnerSlot
        ? nextSlotOccurrence(winnerSlot, Date.now(), LEAGUE_CONFIG.timeZone)
        : Date.now(),
      runnerUp:
        runnerKey && runnerCount > 0
          ? { label: label(runnerKey), count: runnerCount }
          : null,
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
  // The post is a durable outbox row: if the first delivery attempt failed,
  // the worker sends it, so wake the automation gate now rather than at its
  // next scheduled check (createMatchNightPoll does the same).
  refresh();
  await logAdminAction({
    action: "announceMatchNightPollResult",
    summary: `Announced on Discord that ${winner} won the match-night poll "${poll.question}"`,
  });
  return { message: `Announced on Discord: ${winner} won.` };
}
