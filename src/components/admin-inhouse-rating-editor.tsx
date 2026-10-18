"use client";

import { useState } from "react";
import { setInhouseRating } from "@/app/actions/inhouse-admin";
import { INHOUSE_ADMIN_MMR_MAX } from "@/lib/inhouse-mmr-cap";
import { EDITABLE_RANK_TIERS, rankMedalName } from "@/lib/rank";
import { ActionForm, SubmitButton } from "./action-form";
import { RankMedal } from "./ui";

/**
 * An admin's inhouse MMR and medal for one player, signed up for the league
 * or not (/admin/inhouse-players, setInhouseRating). The hidden snapshot is
 * what the editor was drawn with, so a save over a newer change is refused.
 * Render it with a key of those values, so a save remounts it fresh.
 */
export function AdminInhouseRatingEditor({
  userId,
  name,
  adminMmr,
  rankTier,
  rankTierManual,
}: {
  userId: string;
  name: string;
  /** User.inhouseMmr, null = none. */
  adminMmr: number | null;
  rankTier: number | null;
  rankTierManual: boolean;
}) {
  const [mode, setMode] = useState(rankTierManual ? "manual" : "automatic");
  const [medal, setMedal] = useState(String(rankTier ?? 0));
  const fieldClass = "h-9 w-full rounded-md border border-line bg-surface-2 px-2 text-sm";

  return (
    <details className="mt-2" data-inhouse-rating-editor={userId}>
      <summary className="cursor-pointer text-xs text-muted hover:text-fg">
        Edit medal &amp; MMR
      </summary>
      <ActionForm
        action={setInhouseRating}
        className="mt-2 space-y-3 rounded-lg bg-surface-2/40 p-3"
        hidden={{
          userId,
          expectedMmr: adminMmr === null ? "" : String(adminMmr),
          expectedRankTier: String(rankTier ?? 0),
          expectedRankTierManual: rankTierManual ? "1" : "0",
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="min-w-0 space-y-1 text-xs text-muted">
            <span>Inhouse MMR</span>
            <input
              name="mmr" type="number" min={1} max={INHOUSE_ADMIN_MMR_MAX} step={1}
              inputMode="numeric" defaultValue={adminMmr ?? ""} placeholder="Not set"
              aria-label={`Inhouse MMR for ${name}`} className={fieldClass}
            />
          </label>
          <label className="min-w-0 space-y-1 text-xs text-muted">
            <span>Medal source</span>
            <select name="medalMode" value={mode} onChange={(event) => setMode(event.target.value)}
              aria-label={`Medal source for ${name}`} className={fieldClass}>
              <option value="automatic">OpenDota</option>
              <option value="manual">Manual correction</option>
            </select>
          </label>
          <label className="min-w-0 space-y-1 text-xs text-muted">
            <span>Medal &amp; stars</span>
            <select name="rankTier" value={medal} onChange={(event) => setMedal(event.target.value)}
              disabled={mode !== "manual"} aria-label={`Medal for ${name}`} className={fieldClass}>
              {EDITABLE_RANK_TIERS.map((value) => (
                <option key={value} value={value}>{rankMedalName(value)}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-muted">
          Every inhouse join uses this MMR, over their league signup&apos;s and
          anything they type; leave it blank to go back to those. Saving puts it
          on their queue spot too. The medal appears across the site.
          {mode === "manual"
            ? " Manual medals stay in place when OpenDota refreshes."
            : rankTierManual
              ? " Saving will fetch the current OpenDota medal and remove the manual correction."
              : " Choose Manual correction to set a medal yourself."}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton variant="secondary" size="sm">Save medal &amp; MMR</SubmitButton>
          {mode === "manual" ? <RankMedal rankTier={Number(medal)} size={24} showLabel /> : null}
        </div>
      </ActionForm>
    </details>
  );
}
