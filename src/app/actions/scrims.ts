"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { clampInt, localDate, str } from "@/lib/form";
import { parseAccountId } from "@/lib/dota";
import type { ActionResult } from "@/lib/action-result";
import { actionErrorMessage } from "@/lib/user-facing-error";
import {
  addScrimGuest as addGuestInService,
  addTeamCoach as addCoachInService,
  cancelScrim as cancelInService,
  createScrim as createInService,
  joinScrim as joinInService,
  removeScrimGuest as removeGuestInService,
  removeTeamCoach as removeCoachInService,
} from "@/lib/scrim-service";
import {
  autoDetectScrimGames as detectInService,
  importScrimGame as importInService,
  removeScrimGame as removeGameInService,
} from "@/lib/scrim-result-service";

function refreshScrims(scrimId?: string) {
  revalidatePath("/scrims");
  if (scrimId) revalidatePath(`/scrims/${scrimId}`);
}

async function currentUser(): Promise<
  | { ok: true; user: Awaited<ReturnType<typeof requireUser>> }
  | { ok: false; result: ActionResult }
> {
  try {
    return { ok: true, user: await requireUser() };
  } catch {
    return { ok: false, result: { error: "Sign in required" } };
  }
}

export async function createScrim(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await currentUser();
  if (!auth.ok) return auth.result;
  const scheduledAt = localDate(formData, "scheduledAt", "scheduledAtTs");
  if (!scheduledAt) return { error: "Pick a valid date and time" };
  const bestOf = clampInt(formData, "bestOf", 1, 1, 5);
  try {
    await createInService(auth.user.id, scheduledAt, bestOf);
    refreshScrims();
    return {
      ok: true,
      message: "Scrim availability posted — another captain can claim it.",
    };
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "Couldn't post that scrim — try again",
        "scrim.create",
      ),
    };
  }
}

export async function joinScrim(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await currentUser();
  if (!auth.ok) return auth.result;
  const scrimId = str(formData, "scrimId");
  try {
    await joinInService(auth.user.id, scrimId);
    refreshScrims(scrimId);
    return { ok: true, message: "Scrim booked for both teams." };
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "Couldn't join that scrim — reload and try again",
        "scrim.join",
      ),
    };
  }
}

export async function cancelScrim(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await currentUser();
  if (!auth.ok) return auth.result;
  const scrimId = str(formData, "scrimId");
  try {
    await cancelInService(
      auth.user.id,
      auth.user.role === "ADMIN",
      scrimId,
    );
    refreshScrims(scrimId);
    return { ok: true, message: "Scrim cancelled." };
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "Couldn't cancel that scrim — reload and try again",
        "scrim.cancel",
      ),
    };
  }
}

export async function addScrimGuest(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await currentUser();
  if (!auth.ok) return auth.result;
  const scrimId = str(formData, "scrimId");
  const accountId = parseAccountId(str(formData, "accountRef"));
  if (accountId == null) {
    return { error: "Enter a valid Dota account ID, SteamID64, or profile URL" };
  }
  try {
    await addGuestInService(
      auth.user.id,
      auth.user.role === "ADMIN",
      scrimId,
      str(formData, "displayName"),
      accountId,
    );
    refreshScrims(scrimId);
    return {
      ok: true,
      message: "Guest added to this scrim only — no league signup required.",
    };
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "Couldn't add that guest — try again",
        "scrim.guest-add",
      ),
    };
  }
}

export async function removeScrimGuest(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await currentUser();
  if (!auth.ok) return auth.result;
  const scrimId = str(formData, "scrimId");
  try {
    await removeGuestInService(
      auth.user.id,
      auth.user.role === "ADMIN",
      str(formData, "participantId"),
    );
    refreshScrims(scrimId);
    return { ok: true, message: "Guest removed from this scrim." };
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "Couldn't remove that guest — reload and try again",
        "scrim.guest-remove",
      ),
    };
  }
}

export async function addTeamCoach(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await currentUser();
  if (!auth.ok) return auth.result;
  try {
    await addCoachInService(
      auth.user.id,
      auth.user.role === "ADMIN",
      str(formData, "coachRef"),
      str(formData, "teamId") || undefined,
    );
    refreshScrims();
    return { ok: true, message: "Coach added to the team." };
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "Couldn't add that coach — try again",
        "scrim.coach-add",
      ),
    };
  }
}

export async function removeTeamCoach(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await currentUser();
  if (!auth.ok) return auth.result;
  try {
    await removeCoachInService(
      auth.user.id,
      auth.user.role === "ADMIN",
      str(formData, "staffId"),
    );
    refreshScrims();
    return { ok: true, message: "Coach access removed." };
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "Couldn't remove that coach — reload and try again",
        "scrim.coach-remove",
      ),
    };
  }
}

export async function importScrimGame(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await currentUser();
  if (!auth.ok) return auth.result;
  const scrimId = str(formData, "scrimId");
  try {
    const result = await importInService(
      { id: auth.user.id, role: auth.user.role },
      scrimId,
      str(formData, "dotaMatchRef"),
    );
    if (!result.ok) return { error: result.error };
    refreshScrims(scrimId);
    return { ok: true, message: result.message };
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "Couldn't record that scrim game — try again",
        "scrim.import",
      ),
    };
  }
}

export async function autoDetectScrimGames(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await currentUser();
  if (!auth.ok) return auth.result;
  const scrimId = str(formData, "scrimId");
  try {
    const result = await detectInService(
      { id: auth.user.id, role: auth.user.role },
      scrimId,
    );
    if (!result.ok) return { error: result.error };
    refreshScrims(scrimId);
    return { ok: true, message: result.message };
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "Couldn't scan for that scrim — try again",
        "scrim.auto-detect",
      ),
    };
  }
}

export async function removeScrimGame(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await currentUser();
  if (!auth.ok) return auth.result;
  if (auth.user.role !== "ADMIN") return { error: "Not authorized" };
  const scrimId = str(formData, "scrimId");
  try {
    const result = await removeGameInService(
      { id: auth.user.id, role: auth.user.role },
      scrimId,
      str(formData, "scrimGameId"),
    );
    if (!result.ok) return { error: result.error };
    refreshScrims(scrimId);
    return { ok: true, message: result.message };
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "Couldn't remove that scrim game — try again",
        "scrim.game-remove",
      ),
    };
  }
}
