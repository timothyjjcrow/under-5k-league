import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, PlayerLink, TeamCrest } from "@/components/ui";
import {
  addScrimGuest,
  autoDetectScrimGames,
  endScrimSeries,
  importScrimGame,
  removeScrimGuest,
} from "@/app/actions/scrims";
import { scrimEndConfirm } from "@/lib/scrim-view";
import { cn } from "@/lib/utils";
import { SCRIM_INPUT_CLASS } from "./scrim-controls";

// The controls for one booked scrim, drawn the same on the scrim's own page
// (/scrims/<id>) and the Captains page (/captains): end a series, add a game
// that didn't record, and each side's lineup with its guests. Which of them a
// viewer gets is `scrimManageView` (scrim-view.ts); the scrim actions re-check
// the captain, the coach and the season before anything is written.

const inputClass = `${SCRIM_INPUT_CLASS} min-w-0 w-full`;

/** "End series at 1–0": either captain calls a live series at its score. */
export function ScrimEndSeriesForm({
  scrimId,
  hostTeamName,
  awayTeamName,
  hostScore,
  awayScore,
}: {
  scrimId: string;
  hostTeamName: string;
  awayTeamName: string;
  hostScore: number;
  awayScore: number;
}) {
  return (
    <ActionForm action={endScrimSeries} hidden={{ scrimId }}>
      <SubmitButton
        variant="secondary"
        size="sm"
        confirm={scrimEndConfirm({
          hostTeamName,
          awayTeamName,
          hostScore,
          awayScore,
        })}
      >
        End series at {hostScore}–{awayScore}
      </SubmitButton>
    </ActionForm>
  );
}

/**
 * The fallback when a game didn't record by itself: by its match ID (a game
 * hosted under another league's ticket is on OpenDota too), or a search of
 * the players' recent public matches. Captains, coaches and admins only.
 */
export function ScrimResultTools({ scrimId }: { scrimId: string }) {
  return (
    // Two columns by the card's own width, so a narrow card stacks them.
    <div className="grid gap-4 pb-4 [grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr))]">
      <ActionForm
        action={importScrimGame}
        hidden={{ scrimId }}
        className="space-y-2 rounded-lg border border-line bg-surface-2/30 p-4"
      >
        <label className="block space-y-1 text-sm font-medium">
          Add a game by its Dota match ID
          <input
            name="dotaMatchRef"
            required
            placeholder="Match ID or OpenDota URL"
            className={`${inputClass} font-normal`}
          />
        </label>
        <p className="text-xs text-muted">
          For a game OpenDota has that didn&apos;t record by itself, such as
          one hosted under another league&apos;s ticket. A lobby with no
          ticket at all never reaches OpenDota.
        </p>
        <SubmitButton variant="secondary" size="sm">
          Add game
        </SubmitButton>
      </ActionForm>
      <ActionForm
        action={autoDetectScrimGames}
        hidden={{ scrimId }}
        className="space-y-2 rounded-lg border border-line bg-surface-2/30 p-4"
      >
        <p className="text-sm font-medium">Search the players&apos; matches</p>
        <p className="text-xs text-muted">
          Looks through both lineups&apos; recent public matches for a game
          with at least 3 of each side in it.
        </p>
        <SubmitButton variant="secondary" size="sm">
          Search for games
        </SubmitButton>
      </ActionForm>
    </div>
  );
}

export type ScrimLineupSide = {
  team: { id: string; name: string; logoUrl: string | null; captainId: string };
  /** The viewer is this side's captain or coach. */
  manages: boolean;
  participants: readonly {
    id: string;
    userId: string | null;
    displayName: string;
    dotaAccountId: number;
    guest: boolean;
  }[];
};

/**
 * Both sides' scrim lineups. A side's captain or coach adds a casual guest
 * (a name and a Dota account, never a league roster change) and removes one,
 * while the scrim can still change.
 */
export function ScrimLineups({
  scrimId,
  sides,
  mutable,
  className,
}: {
  scrimId: string;
  sides: readonly ScrimLineupSide[];
  /** `scrimManageView(...).mutable`. */
  mutable: boolean;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-5 md:grid-cols-2", className)}>
      {sides.map(({ team, manages, participants }) => (
        <section key={team.id} className="min-w-0 space-y-3">
          <div className="flex items-center gap-2">
            <TeamCrest
              seed={team.id}
              name={team.name}
              logoUrl={team.logoUrl}
              size={30}
            />
            <h3 className="min-w-0 truncate font-display font-semibold">
              {team.name}
            </h3>
            <Badge>
              {participants.length}{" "}
              {participants.length === 1 ? "player" : "players"}
            </Badge>
          </div>
          <ul className="divide-y divide-line/60 rounded-lg border border-line/70">
            {participants.map((participant) => (
              <li
                key={participant.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  {participant.userId ? (
                    <PlayerLink
                      userId={participant.userId}
                      className="max-w-full truncate"
                    >
                      {participant.displayName}
                    </PlayerLink>
                  ) : (
                    <span className="block truncate font-medium">
                      {participant.displayName}
                    </span>
                  )}
                  {/* A guest has no profile, so the account they were
                      added with is the only way to tell who they are. */}
                  {participant.guest ? (
                    <p className="font-mono text-[11px] text-muted">
                      Dota {participant.dotaAccountId}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {participant.userId === team.captainId ? (
                    <Badge tone="accent">Captain</Badge>
                  ) : null}
                  {participant.guest ? <Badge tone="info">Guest</Badge> : null}
                  {participant.guest && manages && mutable ? (
                    <ActionForm
                      action={removeScrimGuest}
                      hidden={{ scrimId, participantId: participant.id }}
                    >
                      <SubmitButton
                        size="sm"
                        variant="ghost"
                        confirm={`Remove ${participant.displayName} from this scrim lineup?`}
                      >
                        Remove
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {manages && mutable ? (
            <ActionForm
              action={addScrimGuest}
              hidden={{ scrimId }}
              className="grid gap-2 rounded-lg border border-dashed border-line p-3 sm:grid-cols-2"
            >
              <label className="space-y-1 text-xs text-muted">
                Guest name
                <input
                  name="displayName"
                  required
                  maxLength={60}
                  placeholder="Display name"
                  className={inputClass}
                />
              </label>
              <label className="space-y-1 text-xs text-muted">
                Dota or Steam ID
                <input
                  name="accountRef"
                  required
                  placeholder="ID or profile URL"
                  className={inputClass}
                />
              </label>
              <SubmitButton size="sm" className="sm:col-span-2">
                Add casual guest
              </SubmitButton>
            </ActionForm>
          ) : null}
        </section>
      ))}
    </div>
  );
}
