"use client";

// The /me "Away dates" card: pick the day you leave and the day you're back,
// see which of your fixtures that covers, and mark yourself out for all of
// them in one save.
//
// The two dates become epochs HERE, in the browser. A raw "2026-10-05" read on
// the UTC production host is a different midnight from the one the player
// meant (the LocalDatetimeField rule, for a date-only input), so the action
// only ever sees `awayFromTs` / `awayBackTs`.

import { useEffect, useId, useRef, useState } from "react";
import { ActionForm, SubmitButton } from "./action-form";
import { LocalTime } from "./local-time";
import { Badge, Card, CardBody, CardHeader } from "./ui";
import { markAwayDates } from "@/app/actions/availability";
import { AVAILABILITY } from "@/lib/availability";
import { cn } from "@/lib/utils";
import {
  awayRangeProblem,
  fixturesInAwayRange,
  localDayStartMs,
  seenFixturesField,
  type AwayCardFixture,
} from "@/lib/away-range";

export type AwayDatesFixture = AwayCardFixture & {
  /** Server-formatted kickoff, the LocalTime hydration fallback. */
  whenLabel: string;
};

const FIELD =
  "h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60";

const plural = (n: number) => (n === 1 ? "fixture" : "fixtures");

export function AwayDatesCard({
  seasonId,
  fixtures,
}: {
  seasonId: string;
  fixtures: AwayDatesFixture[];
}) {
  const fromId = useId();
  const backId = useId();
  const backHintId = useId();
  const fromRef = useRef<HTMLInputElement>(null);
  const [fromValue, setFromValue] = useState("");
  const [backValue, setBackValue] = useState("");

  // ActionForm resets the form after a successful save. The date inputs are
  // uncontrolled, so the preview has to follow them back to empty.
  useEffect(() => {
    const form = fromRef.current?.form;
    if (!form) return;
    const onReset = () => {
      setFromValue("");
      setBackValue("");
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);

  const fromMs = fromValue ? localDayStartMs(fromValue) : null;
  const backMs = backValue ? localDayStartMs(backValue) : null;
  const touched = fromValue !== "" || backValue !== "";
  const problem = touched ? awayRangeProblem(fromMs, backMs) : null;
  const range =
    touched && !problem && fromMs != null && backMs != null
      ? { fromMs, backMs }
      : null;
  const covered = fixturesInAwayRange(fixtures, range);
  const coveredIds = new Set(covered.map((f) => f.matchId));
  const alreadyOut = covered.filter((f) => f.rsvp === AVAILABILITY.OUT).length;
  const toMark = covered.length - alreadyOut;

  let preview: string | null = null;
  if (problem) preview = problem;
  else if (range && covered.length === 0) {
    preview = "None of your fixtures fall between those dates.";
  } else if (range && toMark === 0) {
    preview =
      covered.length === 1
        ? "You're already out for that fixture."
        : "You're already out for all of those.";
  } else if (range) {
    preview = `That covers ${covered.length} ${plural(covered.length)}${alreadyOut ? `, ${alreadyOut} already out` : ""}.`;
  }

  return (
    <Card id="profile-away" className="scroll-mt-24">
      <CardHeader
        headingLevel={2}
        title="Away dates"
        subtitle="Going to miss a few match nights? Pick your dates and we'll mark you out for every fixture in between, with one message to your captain."
      />
      <CardBody>
        <ActionForm
          action={markAwayDates}
          hidden={{
            expectedSeasonId: seasonId,
            seen: seenFixturesField(fixtures),
          }}
          className="space-y-4"
        >
          <input type="hidden" name="awayFromTs" value={fromMs ?? ""} />
          <input type="hidden" name="awayBackTs" value={backMs ?? ""} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor={fromId} className="mb-1.5 block text-sm font-medium">
                Away from
              </label>
              <input
                ref={fromRef}
                id={fromId}
                name="awayFrom"
                type="date"
                required
                onChange={(e) => setFromValue(e.currentTarget.value)}
                className={FIELD}
              />
            </div>
            <div className="min-w-0">
              <label htmlFor={backId} className="mb-1.5 block text-sm font-medium">
                Back on
              </label>
              <input
                id={backId}
                name="awayBack"
                type="date"
                required
                min={fromValue || undefined}
                aria-describedby={backHintId}
                onChange={(e) => setBackValue(e.currentTarget.value)}
                className={FIELD}
              />
              <p id={backHintId} className="mt-1 text-xs text-muted">
                Match nights on the day you&apos;re back are not included.
              </p>
            </div>
          </div>

          <p
            role="status"
            aria-live="polite"
            className={cn(
              "text-sm",
              problem ? "text-danger" : "text-muted",
              !preview && "sr-only",
            )}
          >
            {preview ?? ""}
          </p>

          <ul className="space-y-2" aria-label="Your upcoming fixtures">
            {fixtures.map((f) => {
              const inRange = coveredIds.has(f.matchId);
              const out = f.rsvp === AVAILABILITY.OUT;
              return (
                <li
                  key={f.matchId}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm",
                    inRange
                      ? "border-danger/40 bg-danger/10"
                      : "border-line bg-surface-2/40",
                  )}
                >
                  <div className="min-w-0">
                    <p className="font-medium [overflow-wrap:anywhere]">
                      {f.label}
                    </p>
                    <p className="text-xs text-muted">
                      <LocalTime
                        ts={f.kickoffMs}
                        variant="short"
                        initial={f.whenLabel}
                      />
                      {f.standin ? " · as a standin" : ""}
                    </p>
                  </div>
                  {out ? (
                    <Badge tone="danger" className="shrink-0">
                      Out
                    </Badge>
                  ) : inRange ? (
                    <Badge tone="accent" className="shrink-0">
                      Will be out
                    </Badge>
                  ) : f.rsvp === AVAILABILITY.IN ? (
                    <Badge tone="success" className="shrink-0">
                      In
                    </Badge>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <SubmitButton disabled={!range || toMark === 0}>
              {toMark > 0
                ? `Mark me out for ${toMark} ${plural(toMark)}`
                : "Mark me out"}
            </SubmitButton>
            <p className="min-w-0 flex-1 basis-48 text-xs text-muted">
              Changed your mind about one? Check in on that match as usual.
            </p>
          </div>
        </ActionForm>
      </CardBody>
    </Card>
  );
}
