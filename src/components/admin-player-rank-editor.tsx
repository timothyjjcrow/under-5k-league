"use client";

import { useState } from "react";
import { setPlayerRank } from "@/app/actions/admin";
import { RANK_MEDALS, rankMedalName } from "@/lib/rank";
import { ActionForm, SubmitButton } from "./action-form";
import { RankMedal } from "./ui";

const MEDAL_OPTIONS = [0, ...RANK_MEDALS.slice(1, 8).flatMap((_, index) =>
  [1, 2, 3, 4, 5].map((stars) => (index + 1) * 10 + stars)), 80];

export function AdminPlayerRankEditor({
  registrationId, name, mmr, rankTier, rankTierManual, mmrLocked = false,
}: {
  registrationId: string;
  name: string;
  mmr: number;
  rankTier: number | null;
  rankTierManual: boolean;
  mmrLocked?: boolean;
}) {
  const [mode, setMode] = useState(rankTierManual ? "manual" : "automatic");
  const [medal, setMedal] = useState(String(rankTier ?? 0));
  const fieldClass = "h-9 w-full rounded-md border border-line bg-surface-2 px-2 text-sm";

  return (
    <details className="mt-2" data-player-rank-editor={registrationId}>
      <summary className="cursor-pointer text-xs text-muted hover:text-fg">
        Edit medal &amp; MMR{rankTierManual ? " · Manual medal" : ""}
      </summary>
      <ActionForm
        action={setPlayerRank}
        className="mt-2 space-y-3 rounded-lg bg-surface-2/40 p-3"
        hidden={{
          registrationId,
          expectedMmr: String(mmr),
          expectedRankTier: String(rankTier ?? 0),
          expectedRankTierManual: rankTierManual ? "1" : "0",
        }}
      >
        <p className="text-sm font-medium text-fg">{name}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="min-w-0 space-y-1 text-xs text-muted">
            <span>Season MMR</span>
            <input
              name="mmr" type="number" min={0} max={12000} step={1} required
              defaultValue={mmr} readOnly={mmrLocked}
              aria-label={`MMR for ${name}`} className={fieldClass}
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
              {MEDAL_OPTIONS.map((value) => (
                <option key={value} value={value}>{rankMedalName(value)}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-muted">
          MMR applies to this season. The medal appears across the site.
          {mode === "manual"
            ? " Manual medals stay in place when OpenDota refreshes."
            : rankTierManual
              ? " Saving will fetch the current OpenDota medal and remove the manual correction."
              : " Choose Manual correction to set a medal yourself."}
        </p>
        {mmrLocked ? (
          <p className="text-xs text-muted">MMR is locked while the auction is live or paused. Medal corrections are still available.</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton variant="secondary" size="sm">Save medal &amp; MMR</SubmitButton>
          {mode === "manual" ? <RankMedal rankTier={Number(medal)} size={24} showLabel /> : null}
        </div>
      </ActionForm>
    </details>
  );
}
