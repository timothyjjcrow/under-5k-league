"use client";

import { useId, useState } from "react";
import { SubmitButton } from "@/components/action-form";
import {
  standinPickOutcome,
  standinPickerGroups,
  type StandinPickerCover,
  type StandinPickerStandin,
} from "@/lib/standin";
import { cn } from "@/lib/utils";

export type StandinPickerCoverOption = StandinPickerCover & {
  /** The option's text: the player (or the empty seat) and their MMR. */
  label: string;
};

export type StandinPickerStandinOption = StandinPickerStandin & {
  name: string;
  /** "2,100 MMR · 4/5 · no Discord": what the option says after the name. */
  detail: string;
};

const SELECT =
  "h-11 w-full min-w-0 rounded-lg border border-line bg-surface-2/50 px-2 text-sm text-fg sm:h-10";
const LABEL =
  "block text-xs font-semibold uppercase tracking-wide text-muted";

/**
 * The captain's assign form, inside the Standins card's <ActionForm>: who
 * needs cover first, then the standin. Once a seat is chosen the standin list
 * is grouped by what picking each one does (books straight away, or needs the
 * other captain's OK), and the line under it and the button say the same
 * before anything is sent. The rule is `standinPickOutcome`, the server's
 * own, so the form and the toast agree; the server still decides.
 */
export function StandinPicker({
  covers,
  standins,
  preselect,
  otherTeamName,
}: {
  covers: StandinPickerCoverOption[];
  standins: StandinPickerStandinOption[];
  /** The lone uncovered OUT player, chosen for the captain. */
  preselect: string | null;
  /** The team whose captain answers a request. */
  otherTeamName: string;
}) {
  const id = useId();
  const [coverPick, setCoverPick] = useState(preselect ?? "");
  const [standinPick, setStandinPick] = useState("");
  // A refresh can take a choice away (the seat got cover, the standin got
  // booked): fall back to "nothing chosen" instead of submitting it.
  const cover = covers.find((c) => c.value === coverPick) ?? null;
  const standin =
    standins.find((s) => s.userId === standinPick && !s.blocked) ?? null;
  const groups = standinPickerGroups(standins, cover);
  const outcome =
    cover && standin ? standinPickOutcome(standin.mmr, cover) : null;
  const option = (s: StandinPickerStandinOption) => (
    <option key={s.userId} value={s.userId} disabled={!!s.blocked}>
      {s.blocked ? `${s.name} (${s.blocked})` : `${s.name} · ${s.detail}`}
    </option>
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${id}-cover`} className={LABEL}>
            Player they cover
          </label>
          <select
            id={`${id}-cover`}
            name="replacingUserId"
            required
            value={cover?.value ?? ""}
            onChange={(e) => setCoverPick(e.target.value)}
            className={SELECT}
          >
            <option value="" disabled>
              Choose a player…
            </option>
            {covers.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${id}-standin`} className={LABEL}>
            Standin to bring in
          </label>
          <select
            id={`${id}-standin`}
            name="standinUserId"
            required
            value={standin?.userId ?? ""}
            onChange={(e) => setStandinPick(e.target.value)}
            aria-describedby={`${id}-outcome`}
            className={SELECT}
          >
            <option value="" disabled>
              Choose a standin…
            </option>
            {groups.unsorted.map(option)}
            {groups.book.length > 0 ? (
              <optgroup label="Books straight away">
                {groups.book.map(option)}
              </optgroup>
            ) : null}
            {groups.ask.length > 0 ? (
              <optgroup label={`Needs the ${otherTeamName} captain's OK`}>
                {groups.ask.map(option)}
              </optgroup>
            ) : null}
            {groups.blocked.length > 0 ? (
              <optgroup label="Can't be picked">
                {groups.blocked.map(option)}
              </optgroup>
            ) : null}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SubmitButton
          variant={outcome?.kind === "ask" ? "secondary" : "accent"}
          size="sm"
          disabled={!outcome}
        >
          {outcome?.kind === "ask" ? "Ask the other captain" : "Assign standin"}
        </SubmitButton>
        <p
          id={`${id}-outcome`}
          aria-live="polite"
          className={cn(
            "min-w-[12rem] flex-1 text-sm [overflow-wrap:anywhere]",
            outcome ? "text-fg" : "text-muted",
          )}
        >
          {!outcome ? (
            cover ? (
              "Now choose a standin."
            ) : (
              "Choose who needs cover, then a standin."
            )
          ) : outcome.kind === "book" ? (
            <>
              <span aria-hidden>✓ </span>
              Books straight away. {standin!.name} is told on Discord.
            </>
          ) : (
            <>
              <span aria-hidden>⏳ </span>
              Needs the {otherTeamName} captain&apos;s OK first, since{" "}
              {outcome.reason}.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
