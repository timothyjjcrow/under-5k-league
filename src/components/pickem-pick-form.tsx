import Link from "next/link";
import type { ReactNode } from "react";
import { savePrediction } from "@/app/actions/pickem";
import { ActionForm } from "@/components/action-form";
import { PickemSubmitButton } from "@/components/pickem-submit-button";
import { buttonClasses, TeamCrest } from "@/components/ui";
import type { PickemControl } from "@/lib/pickem";
import { cn } from "@/lib/utils";

export type PickemSide = { id: string; name: string; logoUrl: string | null };

/**
 * The two sides of a fixture: two full-width rows until the form itself is
 * 26rem wide, then side by side. A container query, not a viewport
 * breakpoint: the same form sits in a phone-width card, in /pickem's two-up
 * grid and in the wide match preview, and side by side in anything narrower
 * cut the team names to "Roshan's …", the one thing a picker has to read.
 */
function SidePair({ home, away }: { home: ReactNode; away: ReactNode }) {
  return (
    <div className="@container/pick min-w-0">
      <div className="flex flex-col gap-1 @min-[26rem]/pick:flex-row @min-[26rem]/pick:items-stretch @min-[26rem]/pick:gap-2">
        <div className="min-w-0 @min-[26rem]/pick:flex-1">{home}</div>
        <span className="shrink-0 self-center text-[11px] leading-none text-muted @min-[26rem]/pick:text-xs">
          vs
        </span>
        <div className="min-w-0 @min-[26rem]/pick:flex-1">{away}</div>
      </div>
    </div>
  );
}

/**
 * THE pick'em control: both sides of one fixture as a pressed/unpressed pair
 * inside ONE pending form, submitting through savePrediction. /pickem renders
 * it directly and every fixture card renders it through PickemTray below, so
 * the control can't drift between surfaces (and nothing else imports the
 * action; a source guard pins that).
 *
 * Server-safe composition of the two client leaves: ActionForm owns the
 * pending state and the toast, PickemSubmitButton disables itself at the
 * client-clock kickoff. Deciding WHETHER to render it is the caller's job,
 * via pickemControlFor or /pickem's own partition.
 *
 * `signInHref` is for signed-out viewers (only /pickem shows them fixtures):
 * the pair becomes the matchup as text plus ONE sign-in button that comes
 * back here. Two greyed-out team buttons that did nothing on tap read as
 * broken, on the phone a Discord reminder link usually opens.
 *
 * `compact` drops the crests for fixture cards that already show them large
 * right above the buttons.
 */
export function PickemPickForm({
  matchId,
  roundLabel,
  home,
  away,
  pickedTeamId,
  signInHref,
  locksAt,
  compact = false,
}: {
  matchId: string;
  /** The fixture's name, from matchRoundLabel: "Week 3", "Semifinal". */
  roundLabel: string;
  home: PickemSide;
  away: PickemSide;
  pickedTeamId: string | null;
  /** Set for a signed-out viewer: the sign-in link that returns to this page. */
  signInHref?: string;
  /** Epoch milliseconds; null means time TBD and status controls the lock. */
  locksAt: number | null;
  compact?: boolean;
}) {
  const crest = (team: PickemSide) =>
    compact ? null : (
      <TeamCrest
        name={team.name}
        seed={team.id}
        logoUrl={team.logoUrl}
        size={20}
        className="shrink-0 rounded"
      />
    );

  if (signInHref) {
    const label = (team: PickemSide) => (
      <span className="flex min-w-0 items-center justify-center gap-2 text-sm font-medium">
        {crest(team)}
        <span className="min-w-0 [overflow-wrap:anywhere]">{team.name}</span>
      </span>
    );
    return (
      <div className="min-w-0 space-y-2.5">
        <SidePair home={label(home)} away={label(away)} />
        <Link
          href={signInHref}
          className={buttonClasses("secondary", "sm", "w-full")}
        >
          Sign in with Steam to pick
          <span className="sr-only">
            : {roundLabel}, {home.name} versus {away.name}
          </span>
        </Link>
      </div>
    );
  }

  const side = (team: PickemSide) => {
    const mine = pickedTeamId === team.id;
    return (
      <PickemSubmitButton
        selected={mine}
        locksAt={locksAt}
        name="pickedTeamId"
        value={team.id}
      >
        <span className="flex min-w-0 items-center gap-2">
          {crest(team)}
          <span className="min-w-0 leading-tight [overflow-wrap:anywhere]">
            {team.name}
          </span>
          {mine ? (
            <>
              <span aria-hidden>✓</span>
              <span className="sr-only">(your pick)</span>
            </>
          ) : null}
        </span>
      </PickemSubmitButton>
    );
  };
  return (
    <ActionForm
      action={savePrediction}
      hidden={{ matchId }}
      className="min-w-0"
    >
      <fieldset className="min-w-0">
        <legend className="sr-only">
          Pick the winner — {roundLabel}: {home.name} versus {away.name}
        </legend>
        <SidePair home={side(home)} away={side(away)} />
      </fieldset>
    </ActionForm>
  );
}

/**
 * The one-tap pick'em strip a FIXTURE CARD carries outside /pickem: the
 * dashboard's This-week cards and the match preview's Matchup card. It renders
 * whatever pickemControlFor decided, so the caller passes a control only when
 * there is one (signed-out viewers never get here).
 *
 * Open: a small label plus the two-button form. Locked: the viewer's own pick
 * as one quiet line, and deliberately nothing else; the community split is
 * /pickem's locked review, not a second copy on every card.
 */
export function PickemTray({
  control,
  matchId,
  roundLabel,
  home,
  away,
  locksAt,
  className,
}: {
  control: PickemControl;
  matchId: string;
  /** Passed through to PickemPickForm's accessible legend. */
  roundLabel: string;
  home: PickemSide;
  away: PickemSide;
  locksAt: number | null;
  className?: string;
}) {
  if (control.kind === "locked") {
    const picked = control.pickedTeamId === home.id ? home : away;
    return (
      <p className={cn("text-xs text-muted", className)}>
        <span aria-hidden>🔮 </span>Your pick:{" "}
        <span className="font-medium text-fg [overflow-wrap:anywhere]">
          {picked.name}
        </span>{" "}
        · locked
      </p>
    );
  }
  return (
    <div className={cn("min-w-0", className)}>
      <p className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-muted">
        <span className="font-medium uppercase tracking-wider">
          <span aria-hidden>🔮 </span>Pick&apos;em
        </span>
        <span>
          {control.pickedTeamId
            ? "You can change it until kickoff"
            : "Call the winner before kickoff"}
        </span>
      </p>
      <PickemPickForm
        matchId={matchId}
        roundLabel={roundLabel}
        home={home}
        away={away}
        pickedTeamId={control.pickedTeamId}
        locksAt={locksAt}
        compact
      />
    </div>
  );
}
