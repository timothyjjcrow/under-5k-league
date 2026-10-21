import { closeRollCall, openRollCall } from "@/app/actions/admin-season";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { CardBody, PlayerLink } from "@/components/ui";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { rollCallCountLine, type RollCallPlayer } from "@/lib/roll-call";
import type { AdminRollCall } from "@/lib/roll-call-service";

/**
 * The Roll call section on /admin: open or close it, the night it asks
 * about, who is in, who isn't, and the stragglers as Discord mentions to
 * paste into a channel.
 */
export function RollCallControls({ rollCall }: { rollCall: AdminRollCall }) {
  const { view } = rollCall;
  const total = view ? view.locked.length + view.waiting.length : 0;
  const hidden = {
    expectedActiveSeasonId: rollCall.seasonId,
    expectedSeasonUpdatedAt: rollCall.seasonUpdatedAt.toISOString(),
  };
  return (
    <CardBody className="space-y-5">
      <div className="space-y-2 text-sm">
        {view ? (
          <p className="text-fg">
            Asks about the season&apos;s match night:{" "}
            <span className="font-semibold">{view.night}</span>. Each player{" "}
            {view.slot
              ? "sees it on their own clock. "
              : "sees it exactly as typed: it doesn't read as one weekday and time on the league's clock, so it can't be converted to each player's clock. Write it like \"Saturdays at 2:00 PM\" and it will be. "}
            Move the night under Season settings and everyone is asked again.
          </p>
        ) : null}
        {rollCall.open && rollCall.openedAtMs ? (
          <p className="text-muted">
            Open since{" "}
            <LocalTime
              ts={rollCall.openedAtMs}
              variant="full"
              initial={formatLeagueMatchTime(new Date(rollCall.openedAtMs), "full")}
            />
            .{" "}
            {rollCall.live
              ? "Home shows it to everyone."
              : `Home is hiding it: ${rollCall.cannotOpen ?? "it can't run right now."}`}
          </p>
        ) : rollCall.cannotOpen ? (
          <p className="text-muted">{rollCall.cannotOpen}</p>
        ) : (
          <p className="text-muted">
            Closed. Open it to put &quot;I&apos;m in&quot; on Home for every
            player signed up for the draft.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {rollCall.open ? (
          <ActionForm action={closeRollCall} hidden={hidden}>
            <SubmitButton
              variant="secondary"
              size="sm"
              confirm={`Close the roll call? Home stops showing it. ${view ? `The ${view.locked.length} ${view.locked.length === 1 ? "answer" : "answers"} so far ${view.locked.length === 1 ? "is" : "are"} kept.` : "Every answer is kept."}`}
            >
              Close the roll call
            </SubmitButton>
          </ActionForm>
        ) : rollCall.cannotOpen ? null : (
          <ActionForm action={openRollCall} hidden={hidden}>
            <SubmitButton
              size="sm"
              confirm={`Open the roll call on Home? ${total} ${total === 1 ? "player" : "players"} signed up for the draft will be asked to lock in.`}
            >
              Open the roll call
            </SubmitButton>
          </ActionForm>
        )}
        {view ? (
          <span className="text-sm tabular-nums text-muted">
            {rollCallCountLine(view.locked.length, total)}
          </span>
        ) : null}
      </div>

      {view && (rollCall.open || view.locked.length > 0) ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <NameList title="Not yet" players={view.waiting} empty="Everyone is in." />
          <NameList title="Locked in" players={view.locked} empty="Nobody yet." />
        </div>
      ) : null}

      {rollCall.open && rollCall.waitingMentions ? (
        <div className="space-y-1.5">
          <label htmlFor="roll-call-mentions" className="text-sm font-medium text-fg">
            Ping the players who haven&apos;t answered
          </label>
          <p className="text-xs text-muted">
            Paste this into a Discord channel: linked players become mentions,
            the rest show their Discord handle or site name.
          </p>
          <textarea
            id="roll-call-mentions"
            readOnly
            rows={3}
            value={rollCall.waitingMentions}
            className="w-full resize-y rounded-md border border-line bg-surface-2/50 p-2 font-mono text-xs text-fg"
          />
        </div>
      ) : null}
    </CardBody>
  );
}

function NameList({
  title,
  players,
  empty,
}: {
  title: string;
  players: RollCallPlayer[];
  empty: string;
}) {
  return (
    <div className="min-w-0">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
        {title} · {players.length}
      </h4>
      {players.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-wrap gap-x-3 gap-y-2 text-sm">
          {players.map((player) => (
            <li key={player.id} className="min-w-0 max-w-full truncate">
              <PlayerLink userId={player.id}>{player.name}</PlayerLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
