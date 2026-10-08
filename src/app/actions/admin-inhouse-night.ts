"use server";

// Admin controls for the inhouse night (/admin's Inhouse night card). The
// night belongs to no season, like inhouse itself. Each save names the night
// the admin's page showed, and the Discord side (the server event and the
// channel post) runs after the save commits, best-effort: the toast says what
// happened there, and a Discord failure never undoes the save.

import type { ActionResult } from "@/lib/action-result";
import { logAdminAction } from "@/lib/admin-log";
import { localDate, str } from "@/lib/form";
import {
  clearInhouseNight,
  publishInhouseNight,
  saveInhouseNight,
  withdrawInhouseNight,
  type InhouseNightExpectation,
  type InhouseNightPublication,
} from "@/lib/inhouse-night-service";
import { actionErrorMessage } from "@/lib/user-facing-error";
import { formatLeagueTime } from "@/lib/zoned-time";
import { adminOrError, refresh } from "./admin-shared";

/** The night the form's page showed (hidden fields), or none. */
function expectation(formData: FormData): InhouseNightExpectation {
  const id = str(formData, "expectedNightId").trim();
  const revision = Number(str(formData, "expectedNightRevision"));
  return id && Number.isSafeInteger(revision) ? { id, revision } : null;
}

/** What happened on Discord, in the toast's words. */
function discordNote(publication: InhouseNightPublication): string {
  const post =
    publication.posted === true
      ? "Posted in the inhouse channel."
      : publication.posted === false
        ? "The inhouse channel post didn't go out: check the inhouse webhooks under Discord notifications."
        : "";
  const event = {
    created: "Added to the server's Discord events.",
    updated: "The Discord event is updated.",
    unchanged: "",
    unconfigured: "",
    forbidden:
      "No Discord event: the bot needs the Create Events permission (the bot checklist under Discord notifications).",
    failed: "The Discord event couldn't be saved; Discord didn't answer.",
  }[publication.event];
  return [post, event].filter(Boolean).join(" ");
}

export async function setInhouseNight(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const startsAt = localDate(formData, "startsAt", "startsAtTs");
  if (!startsAt) return { error: "Pick when the inhouse night starts." };

  let save: Awaited<ReturnType<typeof saveInhouseNight>>;
  try {
    save = await saveInhouseNight({
      startsAtMs: startsAt.getTime(),
      note: str(formData, "note"),
      expected: expectation(formData),
    });
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "The inhouse night couldn't be saved. Reload and try again.",
        "admin-inhouse-night.save",
      ),
    };
  }
  const when = formatLeagueTime(new Date(save.night.startsAtMs));
  if (save.change === "unchanged") {
    return { message: `Nothing changed: the inhouse night is still ${when}.` };
  }
  await logAdminAction({
    action: "setInhouseNight",
    summary:
      save.change === "new"
        ? `Set an inhouse night for ${when}`
        : save.change === "moved"
          ? `Moved the inhouse night to ${when}`
          : `Changed the inhouse night's note (${when})`,
  });
  // After the commit and best-effort: the night is saved whatever Discord says.
  const publication = await publishInhouseNight(save);
  refresh();
  const lead =
    save.change === "new"
      ? `Inhouse night set for ${when}: Home and the inhouse page show it.`
      : save.change === "moved"
        ? `Inhouse night moved to ${when}.`
        : `Note saved for the inhouse night on ${when}.`;
  return { message: [lead, discordNote(publication)].filter(Boolean).join(" ") };
}

export async function cancelInhouseNight(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  let cleared: Awaited<ReturnType<typeof clearInhouseNight>>;
  try {
    cleared = await clearInhouseNight({ expected: expectation(formData) });
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "The inhouse night couldn't be cancelled. Reload and try again.",
        "admin-inhouse-night.clear",
      ),
    };
  }
  if (!cleared) return { message: "There's no inhouse night to cancel." };
  const when = formatLeagueTime(new Date(cleared.startsAtMs));
  await logAdminAction({
    action: "cancelInhouseNight",
    summary: `Cancelled the inhouse night on ${when}`,
  });
  const withdrawn = await withdrawInhouseNight(cleared);
  refresh();
  const parts = [`Inhouse night on ${when} cancelled: Home and the inhouse page no longer show it.`];
  if (withdrawn.posted === true) parts.push("The inhouse channel is told it's off.");
  if (withdrawn.posted === false) {
    parts.push("The inhouse channel post didn't go out: check the inhouse webhooks under Discord notifications.");
  }
  if (withdrawn.event === "deleted") parts.push("The Discord event is deleted.");
  if (withdrawn.event === "forbidden" || withdrawn.event === "failed") {
    parts.push("Delete the Discord event by hand: the bot couldn't.");
  }
  return { message: parts.join(" ") };
}
