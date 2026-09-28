import Link from "next/link";
import { setAvailability } from "@/app/actions/availability";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Countdown } from "@/components/countdown";
import { DiscordTag } from "@/components/discord-tag";
import { LocalTime } from "@/components/local-time";
import { LinkArrow, textLink } from "@/components/ui";
import {
  checkinCountsText,
  checkinPrompt,
  sideNeedsCover,
  standinSeatText,
  type CheckinSideView,
} from "@/lib/checkin-side";
import { cn } from "@/lib/utils";

/**
 * The match-night RSVP banner ("Your next match — … ✓ I'm in / ✗ Can't make
 * it"), shared by the dashboard, /schedule, and match pages so a player can
 * check in wherever they land first. With a `side` it also says who the
 * viewer is here (captain, standin or player) and how many of their side have
 * answered; captains and admins get the names behind that count.
 */
export function CheckinBanner({
  matchId,
  scheduleRevision,
  remainingGames = false,
  heading,
  eyebrow,
  when,
  whenTs,
  myRsvp,
  viewerIsCaptain = false,
  side = null,
  detailsHref,
  variant = "strip",
}: {
  matchId: string;
  scheduleRevision: number;
  remainingGames?: boolean;
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
  /** The viewer captains a side in this match: nobody to "let know" above them. */
  viewerIsCaptain?: boolean;
  /**
   * The viewer's side (lib/checkin-side-service's loadCheckinSide): their
   * role, the side's count, and names only when the loader allowed them.
   * Without it the banner reads as it always has.
   */
  side?: CheckinSideView | null;
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
  const prompt = checkinPrompt({
    myRsvp,
    remainingGames,
    role: side?.role ?? (viewerIsCaptain ? "captain" : "player"),
    teamName: side?.teamName,
    captainName: side?.captainName,
  });
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
        {side?.role === "standin" ? (
          // A standin may not know the side they turn up for: the seat, the
          // team, and who to tell.
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-2 gap-y-1 [overflow-wrap:anywhere]",
              panel ? "mt-1 text-xs" : "mt-0.5",
            )}
          >
            <span>
              {standinSeatText(side.teamName, side.standinFor ?? null)}
              {side.captainName ? ` Captain: ${side.captainName}` : null}
            </span>
            {side.captainContact ? (
              <DiscordTag
                name={side.captainContact.discordName}
                verified={!!side.captainContact.discordId}
              />
            ) : null}
          </div>
        ) : null}
        <div className={panel ? "mt-1 text-xs text-muted" : "text-muted"}>
          {prompt}
        </div>
      </div>
      <div
        className={
          panel
            ? "mt-3 grid grid-cols-2 gap-2 [&_button]:w-full [&_form]:min-w-0"
            : "grid w-full min-w-0 grid-cols-1 gap-2 [&_button]:w-full sm:flex sm:w-auto sm:shrink-0 sm:[&_button]:w-auto"
        }
      >
        <ActionForm action={setAvailability} hidden={{ matchId, status: "IN", expectedScheduleRevision: String(scheduleRevision) }}>
          <SubmitButton
            variant={myRsvp === "IN" ? "primary" : "secondary"}
            size={panel ? "md" : "sm"}
          >
            {remainingGames ? "✓ Ready for the next game" : "✓ I'm in"}
          </SubmitButton>
        </ActionForm>
        <ActionForm
          action={setAvailability}
          hidden={{ matchId, status: "OUT", expectedScheduleRevision: String(scheduleRevision) }}
        >
          <SubmitButton
            variant={myRsvp === "OUT" ? "primary" : "secondary"}
            size={panel ? "md" : "sm"}
          >
            ✗ Can&apos;t make it
          </SubmitButton>
        </ActionForm>
      </div>
      {side ? (
        <SideSummary
          side={side}
          matchId={matchId}
          remainingGames={remainingGames}
          className={panel ? "mt-3" : "basis-full"}
        />
      ) : null}
    </div>
  );
}

/**
 * The viewer's side under the buttons: the count for every participant, and
 * for captains and admins the names behind it. Display only: a captain's
 * cover link jumps to the match page's Captain tools, where the Standins card
 * they already use lives.
 */
function SideSummary({
  side,
  matchId,
  remainingGames,
  className,
}: {
  side: CheckinSideView;
  matchId: string;
  remainingGames: boolean;
  className?: string;
}) {
  const { names } = side;
  const rows = names
    ? [
        { label: remainingGames ? "Ready" : "In", tone: "text-success", list: names.in },
        { label: "Out", tone: "text-danger-soft", list: names.out },
        {
          label: "Covered",
          tone: "text-muted",
          list: names.covered.map((c) => `${c.name} by ${c.by}`),
        },
        { label: "No reply", tone: "text-accent", list: names.noReply },
      ].filter((row) => row.list.length > 0)
    : [];
  return (
    <div className={cn("border-t border-info/20 pt-2 text-xs", className)}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="[overflow-wrap:anywhere]">
          <span className="font-medium">Your side:</span>{" "}
          <span className="text-muted">
            {checkinCountsText(side.counts, remainingGames)}
          </span>
        </span>
        {side.role === "captain" && sideNeedsCover(side.counts) ? (
          <Link
            href={`/matches/${matchId}#match-tools`}
            className={textLink("whitespace-nowrap")}
          >
            Line up cover <LinkArrow />
          </Link>
        ) : null}
      </p>
      {rows.length > 0 ? (
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className={cn("font-medium", row.tone)}>{row.label}</dt>
              <dd className="text-muted [overflow-wrap:anywhere]">
                {row.list.join(", ")}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
