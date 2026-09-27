"use client";

import { useContext, useState } from "react";
import { Avatar, RankBadge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { PendingContext, SubmitButton } from "@/components/action-form";
import { DOTA_ROLES } from "@/lib/roles";
import {
  DEFAULT_FANTASY_PICKER_ORDER,
  FANTASY_PICKER_ORDERS,
  fantasyPickerStatus,
  formatFantasyMmr,
  isFantasyPickerOrder,
  orderFantasyCandidates,
  type FantasyPickerOrder,
} from "@/lib/fantasy-picker";

export type FantasyCandidate = {
  userId: string;
  name: string;
  avatar: string | null;
  rankTier: number | null;
  mmr: number;
  /** True when a missing MMR is priced at the known-pool average. */
  mmrEstimated: boolean;
  teamName: string;
  isCaptain: boolean;
  /** Registration preferences are for browsing, not for scoring. */
  roles: string[];
  /** Released picks remain visible until removed. */
  released: boolean;
};

/**
 * A browsable player pool and live five; the server also validates every pick.
 * The count, salary and Save button ride in a bar that sticks to the bottom of
 * the screen while the picker is in view: on a phone the pool runs thousands
 * of pixels, and a manager scrolled deep into it could see neither how much
 * cap was left nor the button that saves.
 */
export function FantasyPicker({
  candidates,
  slots,
  cap,
  initial,
  saveVerb,
}: {
  candidates: FantasyCandidate[];
  slots: number;
  cap: number;
  initial: string[];
  /** The button reads "Save fantasy five" or "Update fantasy five". */
  saveVerb: "Save" | "Update";
}) {
  const pending = useContext(PendingContext);
  const [picked, setPicked] = useState<Set<string>>(new Set(initial));
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [team, setTeam] = useState("");
  const [sort, setSort] = useState<FantasyPickerOrder>(
    DEFAULT_FANTASY_PICKER_ORDER,
  );
  const candidateById = new Map(candidates.map((c) => [c.userId, c]));
  const chosen = [...picked]
    .map((id) => candidateById.get(id))
    .filter((c): c is FantasyCandidate => Boolean(c));
  const spent = chosen.reduce((sum, c) => sum + c.mmr, 0);
  const hasReleased = chosen.some((c) => c.released);
  const full = picked.size >= slots;
  const { canSave, overCap, salary, hint } = fantasyPickerStatus({
    picked: picked.size,
    slots,
    spent,
    cap,
    hasReleased,
  });

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < slots) next.add(id);
      return next;
    });
  };

  const teams = [...new Set(candidates.filter((c) => !c.released).map((c) => c.teamName))]
    .sort((a, b) => a.localeCompare(b));
  const query = search.trim().toLowerCase();
  const visible = orderFantasyCandidates(
    candidates.filter((c) =>
      (!query || `${c.name} ${c.teamName}`.toLowerCase().includes(query)) &&
      (!role || c.roles.includes(role)) &&
      (!team || c.teamName === team),
    ),
    sort,
  );

  return (
    <div className="space-y-6">
      {/* Filtered cards can unmount; selected form values must stay present. */}
      {[...picked].map((id) => (
        <input key={id} type="hidden" name="picks" value={id} />
      ))}
      <section aria-label="Your fantasy lineup" className="rounded-xl border border-accent/35 bg-accent/[0.055] p-4 sm:p-5">
        <h3 className="font-display text-lg font-semibold">Your five</h3>
        <p className="mt-1 text-xs text-muted">Pick five drafted players under the MMR cap. Each one earns impact points in every league game they play.</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: slots }, (_, index) => {
            const c = chosen[index];
            return c ? (
              <div key={c.userId} className={cn("flex min-w-0 items-center gap-2 rounded-lg border bg-surface p-2", c.released ? "border-danger/50" : "border-line")}>
                <span className="w-4 shrink-0 text-center text-xs text-muted">{index + 1}</span>
                <Avatar name={c.name} src={c.avatar} size={27} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold">{c.name}</span>
                  <span className="block truncate text-[11px] text-muted">{c.released ? "Released — remove" : c.mmr > 0 ? `${formatFantasyMmr(c.mmr)} MMR` : "Unrated"}</span>
                </span>
                <button type="button" disabled={pending} onClick={() => toggle(c.userId)} aria-label={`Remove ${c.name}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">×</button>
              </div>
            ) : (
              <div key={index} className="flex h-12 items-center gap-2 rounded-lg border border-dashed border-line px-3 text-xs text-muted"><span className="w-4 text-center">{index + 1}</span> Open slot</div>
            );
          })}
        </div>
        {cap > 0 ? null : <p className="mt-3 text-xs text-muted">No roster ratings are available, so this season has no salary cap.</p>}
        {hasReleased ? <p className="mt-3 text-xs font-medium text-danger">A released player is in your saved five. Remove them before saving.</p> : null}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="font-display text-lg font-semibold">Find your players</h3>
            <p className="mt-1 text-xs text-muted">{sort === "priceHigh" ? "Most expensive first, so you can fit your stars, then fill the rest under the cap. " : ""}Position filters use player preferences; points follow each game&apos;s stats.</p>
          </div>
          <span className="text-xs tabular-nums text-muted">{visible.length} of {candidates.length} players</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
          <label className="text-xs font-medium text-muted">Search
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Player or team" className="mt-1 h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg placeholder:text-muted/70 focus:outline-none focus:ring-2 focus:ring-accent/60" />
          </label>
          <label className="text-xs font-medium text-muted">Position
            <select value={role} onChange={(e) => setRole(e.target.value)} className="mt-1 h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/60">
              <option value="">Any position</option>
              {DOTA_ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-muted">Team
            <select value={team} onChange={(e) => setTeam(e.target.value)} className="mt-1 h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/60">
              <option value="">Any team</option>
              {teams.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-muted">Order
            <select value={sort} onChange={(e) => { if (isFantasyPickerOrder(e.target.value)) setSort(e.target.value); }} className="mt-1 h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/60">
              {FANTASY_PICKER_ORDERS.map((order) => <option key={order.key} value={order.key}>{order.label}</option>)}
            </select>
          </label>
        </div>
        <fieldset disabled={pending} className="min-w-0 disabled:opacity-70">
          <legend className="sr-only">Drafted player pool</legend>
          {visible.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((c) => {
                const selected = picked.has(c.userId);
                const disabled = !selected && (full || c.released);
                return (
                  <label key={c.userId} className={cn("flex min-w-0 cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors", selected ? "border-accent/70 bg-accent/[0.085]" : "border-line bg-surface hover:border-muted/60 hover:bg-surface-2/35", disabled && "cursor-not-allowed opacity-55", c.released && "border-danger/40")}>
                    <input type="checkbox" checked={selected} disabled={disabled} onChange={() => toggle(c.userId)} ref={(el) => { if (el) el.checked = selected; }} className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]" />
                    <Avatar name={c.name} src={c.avatar} size={34} />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-semibold"><span className="min-w-0 truncate">{c.name}</span>{c.isCaptain ? <span title="Captain" className="rounded bg-accent/15 px-1 text-[10px] font-bold text-accent">C</span> : null}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted">{c.released ? "Released · remove from lineup" : c.teamName}</span>
                      <span className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted"><RankBadge rankTier={c.rankTier} />{c.roles.length ? c.roles.map((key) => <span key={key} className="rounded border border-line bg-surface-2/60 px-1.5 py-0.5">Pos {key}</span>) : <span>Position not listed</span>}</span>
                    </span>
                    <span className="shrink-0 text-right font-mono text-xs font-semibold tabular-nums" title={c.mmrEstimated ? "Estimated from drafted pool average" : undefined}>{c.mmr > 0 ? formatFantasyMmr(c.mmr) : "—"}{c.mmrEstimated ? <span className="block text-[10px] font-normal text-muted">est.</span> : null}</span>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-line bg-surface/50 px-4 py-8 text-center text-sm text-muted">No players match these filters. <button type="button" onClick={() => { setSearch(""); setRole(""); setTeam(""); }} className="font-medium text-info underline-offset-2 hover:underline">Clear filters</button></div>
          )}
        </fieldset>
      </section>
      {/* Sticks above the phone dock (--mobile-dock-height is 0 on desktop)
          and stops at the end of the picker, where it sits in place. */}
      <div className="sticky bottom-[calc(var(--mobile-dock-height)+0.75rem)] z-20 rounded-xl border border-accent/35 bg-surface/95 p-3 shadow-lg shadow-black/30 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold tabular-nums">
              <span className={cn("whitespace-nowrap", canSave && "text-success")}>
                {picked.size} / {slots}
                <span className="sr-only"> players picked</span>
              </span>
              <span aria-hidden className="text-muted"> · </span>
              <span className={cn("whitespace-nowrap", overCap && "text-danger")}>{salary}</span>
            </p>
            <p aria-live="polite" className="mt-0.5 text-xs text-muted">{hint}</p>
          </div>
          {/* Phones show the verb alone; the name is always the full label. */}
          <SubmitButton variant="accent" disabled={!canSave} className="shrink-0">
            <span>
              {saveVerb}
              <span className="sr-only sm:not-sr-only"> fantasy five</span>
            </span>
          </SubmitButton>
        </div>
        {cap > 0 ? (
          <div role="progressbar" aria-label="Salary used" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={Math.min(spent, cap)} aria-valuetext={salary} className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className={cn("h-full rounded-full transition-[width] motion-reduce:transition-none", overCap ? "bg-danger" : "bg-accent")} style={{ width: `${Math.min(100, (spent / cap) * 100)}%` }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
