"use server";

// A captain edits their own team's name and logo from the team page (admins
// get the same form there, plus the override on /admin). Thin auth/toast
// wrapper around team-identity-service, which holds the integration-tested
// guards; the activity log and the Discord announcement stay here so a webhook
// failure never touches the write.

import { revalidatePath, updateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import { saveTeamIdentity } from "@/lib/team-identity-service";
import { teamIdentitySummary } from "@/lib/team-identity";
import { logAdminAction } from "@/lib/admin-log";
import { sendDiscordMessage, teamIdentityChangedMessage } from "@/lib/discord";
import type { ActionResult } from "@/lib/action-result";

// Team names are embedded in the cached all-games scans (record matchups), so
// a rename expires the shared "games" tag as well as the page shell.
function refreshGames() {
  updateTag("games");
  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/", "layout");
}

export async function editTeamIdentity(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const saved = await saveTeamIdentity({
    editor: { userId: user.id, isAdmin: user.role === "ADMIN" },
    teamId: str(formData, "teamId"),
    name: str(formData, "name"),
    logoUrl: formData.has("logoUrl") ? str(formData, "logoUrl") : undefined,
  });
  if (!saved.ok) return { error: saved.error };
  if (saved.nameChanged || saved.logoChanged) {
    // Captain edits land in the same activity log as admin ones, under the
    // same key, so "who renamed this team?" has one answer.
    await logAdminAction({
      action: "renameTeam",
      summary: teamIdentitySummary(saved),
      seasonId: saved.seasonId,
      actor: { id: user.id, name: user.name },
    });
    await sendDiscordMessage(teamIdentityChangedMessage(saved));
  }
  refreshGames();
  return { message: `Saved ${saved.name}` };
}
