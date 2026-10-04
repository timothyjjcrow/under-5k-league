"use client";

import { useState } from "react";
import { castMatchNightBallot } from "@/app/actions/match-night-poll";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { buttonClasses } from "@/components/ui";
import { ordinal, type PollSlotView } from "@/lib/match-night-poll";
import { cn } from "@/lib/utils";
import { SlotFace } from "./slot-face";

const iconButton = buttonClasses(
  "ghost",
  "sm",
  "w-10 shrink-0 px-0 text-base sm:w-8",
);

/**
 * The ranked ballot. Tap a slot to rank it next; reorder with the arrows,
 * drop one with ×. Nothing is saved until "Save my ranking", which posts the
 * whole list at once (castMatchNightBallot), so a half-built ranking never
 * counts. Slots left unranked are the ones the voter can't make.
 *
 * A voter who has already voted sees their saved ranking with "Change my
 * ranking"; the server remounts this component after a save (keyed by the
 * ballot's time), which folds the editor back up.
 */
export function PollBallot({
  pollId,
  slots,
  savedRanking,
}: {
  pollId: string;
  slots: PollSlotView[];
  /** The viewer's saved ranking, or null before they vote. */
  savedRanking: string[] | null;
}) {
  const byKey = new Map(slots.map((slot) => [slot.key, slot]));
  const saved = (savedRanking ?? []).filter((key) => byKey.has(key));
  const [editing, setEditing] = useState(savedRanking === null);
  const [ranking, setRanking] = useState<string[]>(saved);
  const [said, setSaid] = useState("");

  if (!editing && savedRanking !== null) {
    return (
      <div className="rounded-lg border border-success/30 bg-success/[0.06] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-fg">
            <span aria-hidden className="text-success">
              ✓{" "}
            </span>
            Your vote is in
          </p>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={buttonClasses("secondary", "sm")}
          >
            Change my ranking
          </button>
        </div>
        {saved.length > 0 ? (
          <ol aria-label="Your ranking" className="mt-3 flex flex-wrap gap-2">
            {saved.map((key, index) => {
              const slot = byKey.get(key)!;
              return (
                <li
                  key={key}
                  className="inline-flex min-w-0 items-center gap-2 rounded-full border border-line bg-surface-2/70 py-1 pl-1 pr-3 text-sm"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold",
                      index === 0
                        ? "bg-accent text-black"
                        : "bg-surface-3 text-fg",
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className="sr-only">{ordinal(index + 1)}: </span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {slot.dayShort} {slot.time}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted">
            You said none of these slots work for you.
          </p>
        )}
        <p className="mt-3 text-xs text-muted">
          Slots you left off count as ones you can&apos;t make. You can change
          your ranking until voting closes.
        </p>
      </div>
    );
  }

  const unranked = slots.filter((slot) => !ranking.includes(slot.key));
  const nameOf = (key: string) => byKey.get(key)?.label ?? key;

  const add = (key: string) => {
    setRanking((current) => [...current, key]);
    setSaid(`${nameOf(key)} is now your ${ordinal(ranking.length + 1)} choice.`);
  };
  const remove = (key: string) => {
    setRanking((current) => current.filter((k) => k !== key));
    setSaid(`${nameOf(key)} removed from your ranking.`);
  };
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= ranking.length) return;
    const next = [...ranking];
    [next[index], next[to]] = [next[to], next[index]];
    setRanking(next);
    setSaid(`${nameOf(next[to])} is now your ${ordinal(to + 1)} choice.`);
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
            Your ranking
            {ranking.length > 0 ? (
              <span className="ml-2 font-normal normal-case tracking-normal">
                {ranking.length} of {slots.length}
              </span>
            ) : null}
          </h3>
          {ranking.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setRanking([]);
                setSaid("Your ranking is cleared.");
              }}
              className={buttonClasses("ghost", "sm")}
            >
              Clear
            </button>
          ) : null}
        </div>
        {ranking.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-muted">
            Tap the slots below in order, favourite first. Skip any you
            can&apos;t make.
          </p>
        ) : (
          <ol aria-label="Your ranking" className="mt-2 space-y-2">
            {ranking.map((key, index) => {
              const slot = byKey.get(key);
              if (!slot) return null;
              return (
                <li
                  key={key}
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-lg border p-2 pl-2.5",
                    index === 0
                      ? "border-accent/50 bg-accent/[0.08]"
                      : "border-line bg-surface-2/60",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-bold tabular-nums",
                      index === 0
                        ? "bg-accent text-black shadow-[0_0_14px] shadow-accent/40"
                        : "bg-surface-3 text-fg",
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className="sr-only">{ordinal(index + 1)}: </span>
                  <SlotFace
                    slot={slot}
                    tone={index === 0 ? "ranked" : "default"}
                    compact
                    className="flex-1"
                  />
                  <span className="flex shrink-0 items-center">
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${slot.label} up`}
                      className={iconButton}
                    >
                      <span aria-hidden>↑</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === ranking.length - 1}
                      aria-label={`Move ${slot.label} down`}
                      className={iconButton}
                    >
                      <span aria-hidden>↓</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(key)}
                      aria-label={`Remove ${slot.label} from your ranking`}
                      className={iconButton}
                    >
                      <span aria-hidden>✕</span>
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {unranked.length > 0 ? (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
            {ranking.length === 0
              ? "Tap every slot you can make"
              : "Can you make any of these too?"}
          </h3>
          <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {unranked.map((slot) => (
              <li key={slot.key} className="min-w-0">
                <button
                  type="button"
                  onClick={() => add(slot.key)}
                  aria-label={`Rank ${slot.label} as your ${ordinal(ranking.length + 1)} choice`}
                  className="group flex w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-dashed border-line bg-surface/40 p-2 pl-2.5 text-left transition-colors hover:border-accent/60 hover:bg-accent/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg motion-reduce:transition-none"
                >
                  <SlotFace slot={slot} tone="muted" />
                  <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-xs font-medium text-muted transition-colors group-hover:border-accent/60 group-hover:text-accent">
                    <span aria-hidden>+ </span>
                    {ordinal(ranking.length + 1)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ActionForm
        action={castMatchNightBallot}
        hidden={{ pollId }}
        className="flex flex-wrap items-center gap-3 border-t border-line-soft pt-4"
      >
        <input type="hidden" name="ranking" value={JSON.stringify(ranking)} />
        <SubmitButton disabled={ranking.length === 0}>
          {savedRanking === null ? "Save my ranking" : "Save my new ranking"}
        </SubmitButton>
        {ranking.length === 0 ? (
          <SubmitButton variant="ghost" size="sm" name="none" value="1">
            None of these work for me
          </SubmitButton>
        ) : null}
        {savedRanking !== null ? (
          <button
            type="button"
            onClick={() => {
              setRanking(saved);
              setEditing(false);
            }}
            className={buttonClasses("ghost", "sm")}
          >
            Cancel
          </button>
        ) : null}
        <p className="basis-full text-xs text-muted">
          Ranked choice: if your favourite is knocked out, your vote moves to
          your next pick. You can change it until voting closes.
        </p>
      </ActionForm>
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
    </div>
  );
}
