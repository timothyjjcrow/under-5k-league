import { HeroList } from "@/components/ui";
import { PubHeroStrip } from "@/components/player-pool";
import {
  PubRecentHeroes,
  PubRoleAverageLines,
  PubScoutingMethod,
  ScoutTileGrid,
} from "@/components/profile-pub-scouting";
import {
  DRAFT_SCOUT_NOTHING_ON_FILE,
  draftCardView,
  type DraftScout,
} from "@/lib/draft-scout";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { pubHeroTitle } from "@/lib/player-pool";
import { cn } from "@/lib/utils";

/**
 * A player's scouting in the draft room: on the block (`lot`, under the bid
 * controls) and under a pool row (`pool`). Presentational only, with no
 * state, fetch or links: the lot slot keeps its Discord tag, Profile and
 * Dotabuff links beside it, and the pool row keeps its ↗. What shows, and in
 * what words, is `draftCardView`'s call (src/lib/draft-scout.ts).
 *
 * Order: league and pub record (or "Nothing on file yet…"), the pub
 * scouting tiles, recent pub heroes beside their favorite heroes (never
 * merged: one is what they play, the other what they say), the about text,
 * then every finding in full behind "More scouting", which is the only way
 * to read a tile's finding on a phone.
 */
export function DraftPlayerCard({
  variant,
  name,
  id,
  player,
  scout,
  live,
  nowMs,
}: {
  variant: "lot" | "pool";
  name: string;
  /** The pool card's id, for its row's aria-controls. */
  id?: string;
  /** The live tick row: MMR, medal and roles set the tiles' context. */
  player: { mmr: number; rankTier: number | null; roles: string };
  scout: DraftScout | undefined;
  /** The nominee's favorites and about text from the tick. */
  live?: { favoriteHeroes: string; about: string };
  /** The server's clock (`state.now`). */
  nowMs: number;
}) {
  const view = draftCardView({
    player,
    scout,
    live,
    league: LEAGUE_CONFIG.region,
    nowMs,
  });
  const lot = variant === "lot";
  const empty =
    view.record.length === 0 &&
    view.tiles.length === 0 &&
    view.heroes === null &&
    !view.favoriteHeroes &&
    !view.about &&
    !view.nothingOnFile;
  if (empty) return null;

  return (
    <div
      id={id}
      role="group"
      aria-label={`Scouting: ${name}`}
      className={cn(
        "@container min-w-0 space-y-3",
        !lot &&
          "mb-2 mt-1 rounded-md border border-line-soft bg-surface-2/30 p-3 text-sm",
      )}
    >
      {/* In the record's place: what is missing is said first. */}
      {view.nothingOnFile ? (
        <p className="text-xs text-muted">{DRAFT_SCOUT_NOTHING_ON_FILE}</p>
      ) : null}
      {view.record.length > 0 ? (
        <ul
          aria-label="League and pub record"
          className={cn(
            "flex flex-wrap gap-x-4 gap-y-1 tabular-nums",
            lot ? "text-sm" : "text-xs",
          )}
        >
          {view.record.map((token) => (
            <li
              key={token.key}
              title={token.title}
              className={cn(
                "min-w-0 [overflow-wrap:anywhere]",
                token.warn && "text-accent",
              )}
            >
              {token.text}
            </li>
          ))}
        </ul>
      ) : null}

      {view.caption ? (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            <span className="font-medium text-fg">Pub scouting</span> ·{" "}
            {view.caption}
          </p>
          <ScoutTileGrid tiles={view.tiles} compact />
        </div>
      ) : null}

      {view.heroes || view.favoriteHeroes ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {view.heroes?.kind === "recent" ? (
            <PubRecentHeroes
              scout={view.heroes.scout}
              label="Recent pubs"
              limit={lot ? 6 : 4}
            />
          ) : view.heroes?.kind === "mostPlayed" ? (
            <span className="text-xs text-muted">
              <PubHeroStrip
                label="Most played (pubs)"
                heroes={view.heroes.heroes}
                titleOf={pubHeroTitle}
              />
            </span>
          ) : null}
          {view.favoriteHeroes ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">Favorite heroes</span>
              <HeroList value={view.favoriteHeroes} size={lot ? 26 : 22} />
            </div>
          ) : null}
        </div>
      ) : null}

      {view.about ? (
        // Clamped: the profile has the whole text.
        <p
          className={cn(
            "[overflow-wrap:anywhere]",
            lot ? "line-clamp-3" : "line-clamp-2",
          )}
        >
          <span className="text-muted">About this player:</span> {view.about}
        </p>
      ) : null}

      {view.findings.length > 0 ? (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer select-none py-1 hover:text-fg">
            More scouting: every finding in full, averages by role
          </summary>
          <div className="mt-2 space-y-2">
            <ul className="list-disc space-y-1 pl-4 [overflow-wrap:anywhere]">
              {view.findings.map((finding) => (
                <li key={finding}>{finding}</li>
              ))}
            </ul>
            {view.moreScout ? (
              <PubRoleAverageLines scout={view.moreScout} />
            ) : null}
            <PubScoutingMethod />
          </div>
        </details>
      ) : null}
    </div>
  );
}
