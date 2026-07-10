"use client";

import { useState } from "react";
import { Avatar, RankBadge } from "@/components/ui";
import { cn } from "@/lib/utils";

export type FantasyCandidate = {
  userId: string;
  name: string;
  avatar: string | null;
  rankTier: number | null;
  mmr: number;
  teamName: string;
  isCaptain: boolean;
};

/**
 * The fantasy-five picker: checkboxes named "picks" (submitted by the
 * surrounding ActionForm) with a live MMR-budget meter. Selection is capped
 * at `slots`; the cap itself is enforced server-side too.
 */
export function FantasyPicker({
  candidates,
  slots,
  cap,
  initial,
}: {
  candidates: FantasyCandidate[];
  slots: number;
  cap: number;
  initial: string[];
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set(initial));
  const spent = candidates
    .filter((c) => picked.has(c.userId))
    .reduce((s, c) => s + c.mmr, 0);
  const overCap = cap > 0 && spent > cap;
  const full = picked.size >= slots;

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < slots) next.add(id);
      return next;
    });
  };

  const teams = [...new Set(candidates.map((c) => c.teamName))];

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2.5 text-sm",
          overCap ? "border-danger/50 bg-danger/10" : "border-line bg-surface-2/40",
        )}
      >
        <span>
          <b>{picked.size}</b>/{slots} picked
        </span>
        <span className={cn("font-mono tabular-nums", overCap && "text-danger")}>
          {spent.toLocaleString()} / {cap.toLocaleString()} MMR
          {overCap ? " — over the cap!" : ""}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {teams.map((teamName) => (
          <div key={teamName} className="rounded-lg border border-line p-3">
            <div className="mb-2 text-sm font-semibold">{teamName}</div>
            <div className="space-y-1">
              {candidates
                .filter((c) => c.teamName === teamName)
                .map((c) => {
                  const isPicked = picked.has(c.userId);
                  return (
                    <label
                      key={c.userId}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm transition-colors",
                        isPicked
                          ? "border-accent bg-accent/10"
                          : "border-line/60 hover:border-muted/60",
                        !isPicked && full && "opacity-50",
                      )}
                    >
                      <input
                        type="checkbox"
                        name="picks"
                        value={c.userId}
                        checked={isPicked}
                        disabled={!isPicked && full}
                        onChange={() => toggle(c.userId)}
                        className="h-4 w-4 accent-[var(--color-accent)]"
                      />
                      <Avatar name={c.name} src={c.avatar} size={22} />
                      <span className="min-w-0 flex-1 truncate">
                        {c.name}
                        {c.isCaptain ? (
                          <span className="ml-1 text-xs text-accent">C</span>
                        ) : null}
                      </span>
                      <RankBadge rankTier={c.rankTier} />
                      <span className="font-mono text-xs tabular-nums text-muted">
                        {c.mmr}
                      </span>
                    </label>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
