import Link from "next/link";
import { setAvailability } from "@/app/actions/availability";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Countdown } from "@/components/countdown";
import { LocalTime } from "@/components/local-time";

/**
 * The match-night RSVP banner ("Your next match — … ✓ I'm in / ✗ Can't make
 * it"), shared by the dashboard, /schedule, and match pages so a player can
 * check in wherever they land first.
 */
export function CheckinBanner({
  matchId,
  heading,
  eyebrow,
  when,
  whenTs,
  myRsvp,
  detailsHref,
  variant = "strip",
}: {
  matchId: string;
  heading: string;
  /**
   * A short kicker above the heading — lets the `panel` variant carry "Your
   * next match" as a label so the heading itself can be just the fixture,
   * instead of one long run of label + fixture + time in a narrow column.
   */
  eyebrow?: string;
  /** Formatted scheduled time, when known. */
  when?: string | null;
  /** Epoch ms of the scheduled time — drives the live countdown chip. */
  whenTs?: number | null;
  myRsvp: string | null;
  detailsHref?: string;
  /**
   * `strip` (the default, and byte-for-byte what /schedule and /matches/[id]
   * already render) is a wide low-profile bar. `panel` stacks into a narrow
   * column with full-width buttons — for the dashboard hero, where this is the
   * one thing on the page the player is actually meant to do, and where a
   * horizontal bar would have to crush either the copy or the buttons.
   */
  variant?: "strip" | "panel";
}) {
  const panel = variant === "panel";
  return (
    <div
      className={
        panel
          ? "rounded-[var(--radius)] border border-info/40 bg-info/10 px-4 py-3.5 text-sm"
          : "flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-info/40 bg-info/10 px-5 py-3.5 text-sm"
      }
    >
      {panel ? (
        // The glyph rides the kicker in `panel`. On its own it would be a
        // block-level row of one emoji above the copy, which is what the first
        // cut of this looked like.
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-info">
          <span aria-hidden>🗓️</span>
          {eyebrow ?? "Match check-in"}
        </div>
      ) : (
        <span className="text-lg leading-none">🗓️</span>
      )}
      {/* min-w keeps the copy readable — when space runs out the buttons wrap
          to their own row instead of crushing the text. */}
      <div className={panel ? "mt-1.5 min-w-0" : "min-w-[14rem] flex-1"}>
        <div className={panel ? "font-medium leading-snug" : "font-medium"}>
          {heading}
          {/* In `panel` the kickoff, countdown and details link get their own
              line below the fixture — inline they turned a narrow column into
              one unreadable run of name + date + countdown + link. */}
          {panel ? null : (
            <>
              {when ? (
                <span className="text-muted">
                  {" · "}
                  {whenTs ? (
                    <LocalTime ts={whenTs} variant="full" initial={when} />
                  ) : (
                    when
                  )}
                </span>
              ) : null}
              {whenTs ? (
                <Countdown targetMs={whenTs} passedLabel="kickoff passed" />
              ) : null}
              {detailsHref ? (
                <>
                  {" "}
                  <Link
                    href={detailsHref}
                    className="whitespace-nowrap text-xs text-info hover:underline"
                  >
                    details →
                  </Link>
                </>
              ) : null}
            </>
          )}
        </div>
        {panel ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            {when ? (
              <span>
                {whenTs ? (
                  <LocalTime ts={whenTs} variant="full" initial={when} />
                ) : (
                  when
                )}
              </span>
            ) : null}
            {whenTs ? (
              <Countdown targetMs={whenTs} passedLabel="kickoff passed" />
            ) : null}
            {detailsHref ? (
              <Link
                href={detailsHref}
                className="whitespace-nowrap rounded text-info hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                details →
              </Link>
            ) : null}
          </div>
        ) : null}
        <div className={panel ? "mt-1 text-xs text-muted" : "text-muted"}>
          {myRsvp === "IN"
            ? "You're confirmed ✓ — change it here if plans shift."
            : myRsvp === "OUT"
              ? "You're marked unavailable — a standin can be lined up."
              : "Can you make it? Let your captain know."}
        </div>
      </div>
      <div
        className={
          panel
            ? "mt-3 grid grid-cols-2 gap-2 [&_button]:w-full [&_form]:min-w-0"
            : "flex shrink-0 gap-2"
        }
      >
        <ActionForm action={setAvailability} hidden={{ matchId, status: "IN" }}>
          <SubmitButton
            variant={myRsvp === "IN" ? "primary" : "secondary"}
            size={panel ? "md" : "sm"}
          >
            ✓ I&apos;m in
          </SubmitButton>
        </ActionForm>
        <ActionForm
          action={setAvailability}
          hidden={{ matchId, status: "OUT" }}
        >
          <SubmitButton
            variant={myRsvp === "OUT" ? "primary" : "secondary"}
            size={panel ? "md" : "sm"}
          >
            ✗ Can&apos;t make it
          </SubmitButton>
        </ActionForm>
      </div>
    </div>
  );
}
