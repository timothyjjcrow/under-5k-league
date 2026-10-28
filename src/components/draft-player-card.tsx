import { HeroList, RankMedal, textLink } from "@/components/ui";
import { PubHeroStrip } from "@/components/player-pool";
import {
  PubRecentHeroes,
  PubRoleAverageLines,
  PubScoutingMethod,
  SCOUT_TONE,
  ScoutTileGrid,
} from "@/components/profile-pub-scouting";
import {
  DRAFT_CARD_HEROES,
  DRAFT_SCOUT_NOTHING_ON_FILE,
  DRAFT_SCOUT_TOGGLE,
  draftCardView,
  type DraftScout,
} from "@/lib/draft-scout";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { pubHeroTitle } from "@/lib/player-pool";
import { pubHeroRows } from "@/lib/pub-scout";
import { cn } from "@/lib/utils";

/**
 * A player's scouting in the draft room: on the block (`lot`, under the bid
 * controls) and under a pool row (`pool`). Presentational only, with no
 * state, fetch or links: the lot slot keeps its Discord tag, Profile and
 * Dotabuff links beside it, and the pool row keeps its ↗. What shows, and in
 * what words, is `draftCardView`'s call (src/lib/draft-scout.ts).
 *
 * Compact by default, so the pool stays on a phone's first screen: one
 * strip of label-over-value segments (`segments`: last season, inhouse, pub
 * win rate, role, the level of their games, and any other read worth a
 * second look), a row of small recent pub heroes beside their favorite
 * heroes (never merged: one is what they play, the other what they say)
 * and one line of the about text. "Full scouting" shows the record line,
 * the profile's tiles, more heroes and about text, and every finding
 * behind "More scouting", the only way to read one on a phone. The room
 * owns the choice (one per viewer, kept in their browser) and passes it in.
 */
export function DraftPlayerCard({
  variant,
  name,
  id,
  player,
  scout,
  live,
  nowMs,
  full,
  onFullChange,
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
  /** The full card, or the compact one (the room's per-viewer choice). */
  full: boolean;
  onFullChange: (next: boolean) => void;
}) {
  const view = draftCardView({
    player,
    scout,
    live,
    league: LEAGUE_CONFIG.region,
    nowMs,
  });
  const lot = variant === "lot";
  const showFull = full && view.hasMore;
  const heroLimit = DRAFT_CARD_HEROES[variant][showFull ? "full" : "compact"];
  const compactHeroes =
    view.heroes?.kind === "recent"
      ? pubHeroRows(view.heroes.scout).slice(0, heroLimit)
      : view.heroes?.kind === "mostPlayed"
        ? view.heroes.heroes.slice(0, heroLimit)
        : [];
  const toggle = view.hasMore ? (
    <button
      type="button"
      onClick={() => onFullChange(!full)}
      aria-expanded={full}
      className={textLink("text-xs")}
    >
      {full ? DRAFT_SCOUT_TOGGLE.less : DRAFT_SCOUT_TOGGLE.more}
    </button>
  ) : null;
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
        "@container min-w-0",
        showFull ? "space-y-3" : "space-y-2",
        !lot &&
          "mb-2 mt-1 rounded-md border border-line-soft bg-surface-2/30 p-3 text-sm",
      )}
    >
      {/* In the record's place: what is missing is said first. */}
      {view.nothingOnFile ? (
        <p className="text-xs text-muted">{DRAFT_SCOUT_NOTHING_ON_FILE}</p>
      ) : null}
      {showFull && view.record.length > 0 ? (
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

      {showFull && view.caption ? (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            <span className="font-medium text-fg">Pub scouting</span> ·{" "}
            {view.caption}
          </p>
          <ScoutTileGrid tiles={view.tiles} compact />
        </div>
      ) : null}

      {showFull ? (
        <>
          {view.heroes || view.favoriteHeroes ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              {view.heroes?.kind === "recent" ? (
                <PubRecentHeroes
                  scout={view.heroes.scout}
                  label="Recent pubs"
                  limit={heroLimit}
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
              <span className="text-muted">About this player:</span>{" "}
              {view.about}
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
          {toggle}
        </>
      ) : (
        <>
          {/* One strip of label-over-value segments, each as wide as its
              words, then the hero icons and the toggle beside it while the
              row has room: the facts sit together instead of spanning the
              card in lines. On a phone the strip wraps into full rows. */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {view.segments.length > 0 ? (
              <ul
                aria-label="Scouting at a glance"
                className="flex w-fit max-w-full flex-wrap gap-px overflow-hidden rounded-lg border border-line bg-line"
              >
                {view.segments.map((seg) => (
                  <li
                    key={seg.key}
                    title={seg.title}
                    className="min-w-0 grow bg-surface px-3 py-1.5"
                  >
                    <span className="flex items-center gap-1 whitespace-nowrap text-[10px] font-medium uppercase tracking-wide text-muted">
                      {seg.label}
                      {SCOUT_TONE[seg.tone].mark ? (
                        <span
                          aria-hidden
                          className={
                            seg.tone === "warn" ? "text-accent" : "text-success"
                          }
                        >
                          {SCOUT_TONE[seg.tone].mark}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "flex min-w-0 items-center gap-1 text-sm font-semibold tabular-nums",
                        SCOUT_TONE[seg.tone].lead,
                      )}
                    >
                      {seg.rankTier ? (
                        <RankMedal rankTier={seg.rankTier} size={16} />
                      ) : null}
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {SCOUT_TONE[seg.tone].spoken ? (
                          <span className="sr-only">
                            {SCOUT_TONE[seg.tone].spoken}
                          </span>
                        ) : null}
                        {seg.value}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {compactHeroes.length > 0 || view.favoriteHeroes ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                {compactHeroes.length > 0 ? (
                  <PubHeroStrip
                    label={
                      view.heroes?.kind === "recent"
                        ? "Recent pubs"
                        : "Most played (pubs)"
                    }
                    heroes={compactHeroes}
                    titleOf={pubHeroTitle}
                  />
                ) : null}
                {view.favoriteHeroes ? (
                  <span className="flex items-center gap-1">
                    <span>Favorites</span>
                    <HeroList value={view.favoriteHeroes} size={18} />
                  </span>
                ) : null}
              </div>
            ) : null}
            {toggle ? <span className="ml-auto">{toggle}</span> : null}
          </div>
          {view.about ? (
            <p className="line-clamp-1 [overflow-wrap:anywhere]">
              <span className="text-muted">About:</span> {view.about}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
