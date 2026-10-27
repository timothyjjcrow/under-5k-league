import {
  Card,
  CardBody,
  CardHeader,
  HeroIcon,
  KDA,
  RankMedal,
} from "@/components/ui";
import { heroById } from "@/lib/heroes";
import {
  pubHeroRows,
  pubScoutCaption,
  scoutingTiles,
  type PubRoleAverages,
  type PubScout,
  type ScoutContext,
  type ScoutTile,
  type ScoutTone,
} from "@/lib/pub-scout";
import { cn } from "@/lib/utils";

/** Heroes in the strip: one row in a wide main column, two in the rail. */
const STRIP_HEROES = 6;
/** Games in a role before its averages are worth a line. */
const ROLE_LINE_MIN_GAMES = 5;

const TONE: Record<
  ScoutTone,
  { tile: string; lead: string; mark: string | null; spoken: string }
> = {
  good: {
    tile: "border-line-soft bg-surface-2/30",
    lead: "text-fg",
    mark: "✓",
    spoken: "Agrees with their signup: ",
  },
  warn: {
    tile: "border-accent/40 bg-accent/5",
    lead: "text-accent",
    mark: "!",
    spoken: "Worth a second look: ",
  },
  info: {
    tile: "border-line-soft bg-surface-2/30",
    lead: "text-fg",
    mark: null,
    spoken: "",
  },
};

/**
 * The pub scouting report captains read before bidding, sized to sit in the
 * profile's rail (two tiles across) and across a new player's main column
 * (one row): a tile per finding from a signup's last 100 public games (role,
 * the level of their games, modes, server, form, early leaves), each tinted
 * when it is worth a second look, then their recent heroes as one strip.
 * Averages by role and how it is all read sit behind "More". Every line comes
 * from the stored snapshot's counts (pub-scout.ts); the page renders the
 * card only when one has enough games.
 */
export function ProfilePubScouting({
  scout,
  context,
  checkedLabel,
}: {
  scout: PubScout;
  context: ScoutContext;
  /** How long ago the snapshot was taken ("3d ago"). */
  checkedLabel: string | null;
}) {
  const tiles = scoutingTiles(scout, context);
  return (
    <Card id="player-scouting" className="min-w-0 scroll-mt-40">
      <CardHeader
        title="Pub scouting"
        subtitle={pubScoutCaption(scout.games, checkedLabel)}
      />
      <CardBody className="space-y-3">
        <ScoutTileGrid tiles={tiles} />
        <PubRecentHeroes scout={scout} />
        <details className="group text-xs text-muted">
          <summary className="cursor-pointer select-none py-1 hover:text-fg">
            More: averages by role, and how this is read
          </summary>
          <div className="mt-2 space-y-2">
            <PubRoleAverageLines scout={scout} />
            <PubScoutingMethod />
          </div>
        </details>
      </CardBody>
    </Card>
  );
}

/**
 * The report's tiles, one finding each, tinted when worth a second look.
 * Auto-fit, never grid-cols-1: two across in the rail, one row on a wide
 * page, however many tiles have enough games. `compact` packs narrower
 * tiles for the draft room. Wherever the tiles sit two across (below 28rem,
 * or 26.5rem for compact ones, where a third column fits) an odd last tile
 * takes the whole row, so give the grid an `@container` ancestor.
 */
export function ScoutTileGrid({
  tiles,
  compact = false,
}: {
  tiles: ScoutTile[];
  compact?: boolean;
}) {
  if (tiles.length === 0) return null;
  return (
    <ul
      className={
        compact
          ? "grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(8.5rem,100%),1fr))]"
          : "grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(9.5rem,100%),1fr))]"
      }
    >
      {tiles.map((tile) => (
        <ScoutTileView key={tile.key} tile={tile} compact={compact} />
      ))}
    </ul>
  );
}

/** Their recent heroes in one strip: games and win rate under each icon,
 *  the KDA in the hover and for screen readers. */
export function PubRecentHeroes({
  scout,
  label = "Recent heroes",
  limit = STRIP_HEROES,
}: {
  scout: PubScout;
  label?: string;
  limit?: number;
}) {
  const heroes = pubHeroRows(scout).slice(0, limit);
  if (heroes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-xs text-muted">
        {label}{" "}
        <span className="whitespace-nowrap">({scout.heroCount} played)</span>
      </span>
      <ul className="flex flex-wrap gap-x-3 gap-y-2">
        {heroes.map((h) => {
          const hero = heroById(h.heroId);
          const name = hero?.name ?? `Hero ${h.heroId}`;
          const winPct = Math.round((h.wins / h.games) * 100);
          const summary = `${name}: ${h.games} games, ${h.wins}–${h.games - h.wins}, ${h.kda} KDA`;
          return (
            <li
              key={h.heroId}
              className="flex items-center gap-1.5"
              title={summary}
            >
              {hero ? <HeroIcon hero={hero} size={24} title={summary} /> : null}
              <span className="sr-only">{summary}</span>
              <span
                aria-hidden
                className="text-xs leading-tight tabular-nums text-muted"
              >
                <span className="font-semibold text-fg">{h.games}g</span>{" "}
                <span
                  className={cn(
                    h.games >= 3 && winPct >= 60 && "text-success",
                    h.games >= 3 && winPct < 40 && "text-danger-soft",
                  )}
                >
                  {winPct}%
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Their averages as a core and as a support, once a role has the games. */
export function PubRoleAverageLines({ scout }: { scout: PubScout }) {
  const roleLines = [
    { label: "As a core", averages: scout.coreAverages },
    { label: "As a support", averages: scout.supportAverages },
  ].filter(
    (r): r is { label: string; averages: PubRoleAverages } =>
      r.averages != null && r.averages.games >= ROLE_LINE_MIN_GAMES,
  );
  if (roleLines.length === 0) return null;
  return (
    <ul className="space-y-1">
      {roleLines.map(({ label, averages }) => (
        <li key={label}>
          <span className="font-medium text-fg">{label}</span> (
          {averages.games} games):{" "}
          <span className="whitespace-nowrap tabular-nums">
            {averages.lastHitsPerMin} last hits a minute
          </span>
          {" · "}
          <span className="whitespace-nowrap tabular-nums">
            {averages.gpm} GPM
          </span>
          {" · "}
          <span className="whitespace-nowrap">
            <KDA
              kills={averages.kills}
              deaths={averages.deaths}
              assists={averages.assists}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** How the report is read, in one paragraph. */
export function PubScoutingMethod() {
  return (
    <p className="leading-relaxed">
      Core at 3.5+ last hits a minute, support under 2.5, in ranked and
      unranked games of 10+ minutes; positions come from the games OpenDota
      analysed. &ldquo;Games at&rdquo; is the average medal of everyone in
      their games. Hover a tile for the full finding.
    </p>
  );
}

function ScoutTileView({
  tile,
  compact = false,
}: {
  tile: ScoutTile;
  compact?: boolean;
}) {
  const tone = TONE[tile.tone];
  return (
    <li
      className={cn(
        // In a narrow column (the rail, a phone) the tiles sit two across,
        // so an odd last tile takes the whole row instead of leaving a hole.
        // Compact tiles fit three across from 26.5rem (3 x 8.5rem + gaps).
        compact
          ? "min-w-0 rounded-lg border px-3 py-2 @max-[26.5rem]:odd:last:col-span-full"
          : "min-w-0 rounded-lg border px-3 py-2 @max-md:odd:last:col-span-full",
        tone.tile,
      )}
      title={tile.title}
    >
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
        <span className="truncate">{tile.label}</span>
        {tone.mark ? (
          <span
            aria-hidden
            className={cn(
              "font-bold",
              tile.tone === "warn" ? "text-accent" : "text-success",
            )}
          >
            {tone.mark}
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          "mt-0.5 flex min-w-0 items-center gap-1.5 font-display text-base font-semibold leading-tight tabular-nums",
          tone.lead,
        )}
      >
        {tile.rankTier ? (
          <RankMedal rankTier={tile.rankTier} size={20} />
        ) : null}
        <span className="truncate">
          {tone.spoken ? <span className="sr-only">{tone.spoken}</span> : null}
          {tile.lead}
        </span>
      </div>
      {tile.note ? (
        // Wraps rather than truncates: a phone has no hover to read the rest.
        <div className="mt-0.5 text-xs leading-snug text-muted [overflow-wrap:anywhere]">
          {tile.note}
        </div>
      ) : null}
    </li>
  );
}
