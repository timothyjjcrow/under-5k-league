"use client";

import { useEffect, useState } from "react";
import { ActionForm, SubmitButton } from "./action-form";
import { TeamCrest } from "./ui";
import type { ActionResult } from "@/lib/action-result";
import { normalizeTeamLogoUrl, TEAM_LOGO_URL_MAX_LENGTH } from "@/lib/team-logo";
import {
  TEAM_NAME_MAX_LENGTH,
  logoPreviewNote,
  normalizeTeamName,
  type LogoImageState,
} from "@/lib/team-identity";

/** The typed value once typing pauses, so the preview doesn't fetch every
 *  half-typed link (a pasted link settles at once). */
function useSettled(value: string, delayMs = 400): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/** Whether a logo link actually loads as an image, so the preview can say so.
 *  The crest itself hides a broken image silently (initials show through). */
function useImageState(src: string | null): LogoImageState | null {
  const [result, setResult] = useState<{ src: string; ok: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!src) return;
    let live = true;
    const image = new Image();
    image.referrerPolicy = "no-referrer";
    image.onload = () => {
      if (live) setResult({ src, ok: true });
    };
    image.onerror = () => {
      if (live) setResult({ src, ok: false });
    };
    image.src = src;
    return () => {
      live = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [src]);
  if (!src) return null;
  if (result?.src !== src) return "loading";
  return result.ok ? "loaded" : "failed";
}

/**
 * Name + logo for one team, with a live crest preview. The same form serves
 * the captain on their team page and the admin on the team page or /admin;
 * the server applies the same checks to all of them.
 */
export function TeamIdentityForm({
  action,
  teamId,
  name,
  logoUrl,
  hidden,
  note,
}: {
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  teamId: string;
  name: string;
  logoUrl: string | null;
  /** Extra hidden fields, e.g. the season /admin was rendered for. */
  hidden?: Record<string, string>;
  /** An optional line under the fields (e.g. that jerseys stay linked). */
  note?: string;
}) {
  const [draftName, setDraftName] = useState(name);
  const [draftLogo, setDraftLogo] = useState(logoUrl ?? "");
  // Save is checked against what was typed; the preview follows once typing
  // settles.
  const logo = normalizeTeamLogoUrl(draftLogo);
  const settledLogo = normalizeTeamLogoUrl(useSettled(draftLogo));
  const previewUrl = "logoUrl" in settledLogo ? settledLogo.logoUrl : null;
  const image = useImageState(previewUrl);
  const preview = logoPreviewNote(
    logo,
    "logoUrl" in logo && logo.logoUrl === previewUrl ? image : "loading",
  );
  const previewName = normalizeTeamName(draftName) || name;
  const inputClass =
    "h-11 w-full min-w-0 rounded-md border border-line bg-surface-2/50 px-2.5 text-sm sm:h-9";

  return (
    <ActionForm
      action={action}
      // What this form was showing, so a save from a tab opened before
      // someone else's edit is refused instead of reverting that edit.
      hidden={{
        teamId,
        expectedName: name,
        expectedLogoUrl: logoUrl ?? "",
        ...hidden,
      }}
      className="grid max-w-md grid-cols-1 gap-3"
    >
      <div className="flex min-w-0 items-start gap-3">
        <TeamCrest
          name={previewName}
          seed={teamId}
          logoUrl={previewUrl}
          size={56}
          imageFit="cover"
          className="mt-5 rounded-xl"
        />
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-2">
          <label className="grid min-w-0 gap-1 text-xs font-medium text-muted">
            Name
            <input
              name="name"
              type="text"
              required
              maxLength={TEAM_NAME_MAX_LENGTH}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              aria-label={`Name for ${name}`}
              className={inputClass}
            />
          </label>
          <label className="grid min-w-0 gap-1 text-xs font-medium text-muted">
            Logo URL
            <input
              name="logoUrl"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={TEAM_LOGO_URL_MAX_LENGTH}
              value={draftLogo}
              onChange={(event) => setDraftLogo(event.target.value)}
              placeholder="https://…/logo.png"
              aria-label={`Logo URL for ${name}`}
              aria-describedby={`team-logo-note-${teamId}`}
              className={inputClass}
            />
          </label>
        </div>
      </div>
      <p
        id={`team-logo-note-${teamId}`}
        aria-live="polite"
        className={
          preview.tone === "danger" ? "text-xs text-danger" : "text-xs text-muted"
        }
      >
        {preview.text}
      </p>
      {note ? <p className="text-xs text-muted">{note}</p> : null}
      <SubmitButton
        variant="secondary"
        size="sm"
        className="justify-self-start"
        disabled={"error" in logo || !normalizeTeamName(draftName)}
      >
        Save team
      </SubmitButton>
    </ActionForm>
  );
}
