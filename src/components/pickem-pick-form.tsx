import { savePrediction } from "@/app/actions/pickem";
import { ActionForm } from "@/components/action-form";
import { PickemSubmitButton } from "@/components/pickem-submit-button";
import { TeamCrest } from "@/components/ui";
import type { PickemControl } from "@/lib/pickem";
import { cn } from "@/lib/utils";

export type PickemSide = { id: string; name: string; logoUrl: string | null };

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
 * `compact` drops the crests for fixture cards that already show them large
 * right above the buttons.
 */
export function PickemPickForm({
  matchId,
  week,
  home,
  away,
  pickedTeamId,
  canSubmit,
  locksAt,
  compact = false,
}: {
  matchId: string;
  week: number;
  home: PickemSide;
  away: PickemSide;
  pickedTeamId: string | null;
  canSubmit: boolean;
  /** Epoch milliseconds; null means time TBD and status controls the lock. */
  locksAt: number | null;
  compact?: boolean;
}) {
  const side = (team: PickemSide) => {
    const mine = pickedTeamId === team.id;
    return (
      <PickemSubmitButton
        selected={mine}
        canSubmit={canSubmit}
        locksAt={locksAt}
        name="pickedTeamId"
        value={team.id}
      >
        <span className="flex min-w-0 items-center gap-2">
          {compact ? null : (
            <TeamCrest
              name={team.name}
              seed={team.id}
              logoUrl={team.logoUrl}
              size={20}
              className="rounded"
            />
          )}
          <span className="truncate">{team.name}</span>
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
          Pick the winner of Week {week}: {home.name} versus {away.name}
        </legend>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">{side(home)}</div>
          <span className="shrink-0 text-xs text-muted">vs</span>
          <div className="min-w-0 flex-1">{side(away)}</div>
        </div>
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
  week,
  home,
  away,
  locksAt,
  className,
}: {
  control: PickemControl;
  matchId: string;
  week: number;
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
        week={week}
        home={home}
        away={away}
        pickedTeamId={control.pickedTeamId}
        canSubmit
        locksAt={locksAt}
        compact
      />
    </div>
  );
}
