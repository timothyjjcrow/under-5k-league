import Link from "next/link";
import { setAvailability } from "@/app/actions/availability";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Countdown } from "@/components/countdown";

/**
 * The match-night RSVP banner ("Your next match — … ✓ I'm in / ✗ Can't make
 * it"), shared by the dashboard, /schedule, and match pages so a player can
 * check in wherever they land first.
 */
export function CheckinBanner({
  matchId,
  heading,
  when,
  whenTs,
  myRsvp,
  detailsHref,
}: {
  matchId: string;
  heading: string;
  /** Formatted scheduled time, when known. */
  when?: string | null;
  /** Epoch ms of the scheduled time — drives the live countdown chip. */
  whenTs?: number | null;
  myRsvp: string | null;
  detailsHref?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-info/40 bg-info/10 px-5 py-3.5 text-sm">
      <span className="text-lg leading-none">🗓️</span>
      {/* min-w keeps the copy readable — when space runs out the buttons wrap
          to their own row instead of crushing the text. */}
      <div className="min-w-[14rem] flex-1">
        <div className="font-medium">
          {heading}
          {when ? <span className="text-muted"> · {when}</span> : null}
          {whenTs ? <Countdown targetMs={whenTs} /> : null}
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
        </div>
        <div className="text-muted">
          {myRsvp === "IN"
            ? "You're confirmed ✓ — change it here if plans shift."
            : myRsvp === "OUT"
              ? "You're marked unavailable — a standin can be lined up."
              : "Can you make it? Let your captain know."}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <ActionForm
          action={setAvailability}
          hidden={{ matchId, status: "IN" }}
        >
          <SubmitButton
            variant={myRsvp === "IN" ? "primary" : "secondary"}
            size="sm"
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
            size="sm"
          >
            ✗ Can&apos;t make it
          </SubmitButton>
        </ActionForm>
      </div>
    </div>
  );
}
