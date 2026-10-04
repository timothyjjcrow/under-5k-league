import Link from "next/link";
import type { ChampionFinalLine } from "@/lib/champion-moment";
import type { SeriesRecordCounts } from "@/lib/team-matches";
import { rosterOrder } from "@/lib/team-roster";
import { cn } from "@/lib/utils";
import { SeriesRecord } from "./series-record";
import { Avatar, Badge, PlayerLink, TeamCrest } from "./ui";

type RosterMember = {
  id: string;
  userId: string;
  isCaptain: boolean;
  price: number;
  user: { name: string; avatar: string | null };
};

/**
 * The crowned season as a gold banner: the champion's crest and trophy,
 * "{season} Champion", the final's score, the regular-season record and the
 * winning roster. Home renders it under the hero once a season is complete,
 * and the champion's own team page renders it under its header.
 *
 * Crowned state only: callers pass the champion the shared resolver
 * (resolveChampionPresentation) stood behind, and keep their own "needs
 * review" state. Server-safe.
 *
 * The label and the team link stay siblings under one parent, and the
 * beaten finalist is named but never linked there: the postseason e2e reads
 * the champion's name as the one /teams/ link beside the label.
 */
export function ChampionMoment({
  seasonName,
  team,
  final,
  opponentName,
  record,
  roster,
  linkTeam = true,
  className,
}: {
  seasonName: string;
  team: { id: string; name: string; logoUrl: string | null };
  /** championFinalLine's result; null for a legacy archive with no bracket. */
  final: ChampionFinalLine | null;
  /** The beaten finalist's name. */
  opponentName: string | null;
  /** Their regular-season record and points; null when there is none. */
  record: (SeriesRecordCounts & { points: number }) | null;
  /** The winning roster as chips; omit where the page already lists it. */
  roster?: readonly RosterMember[];
  /** Link the team's name (false on the team's own page). */
  linkTeam?: boolean;
  className?: string;
}) {
  const players = roster ? rosterOrder(roster) : [];
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[var(--radius)] border border-amber-400/50 bg-gradient-to-br from-amber-400/20 via-surface to-surface shadow-lg",
        className,
      )}
    >
      {/* A gold rule along the top edge and a glow behind the crest. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-amber-400/0 via-amber-400/80 to-amber-400/0"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-48 w-48 -translate-x-1/2 -translate-y-1/3 rounded-full bg-amber-400/25 blur-3xl sm:left-6 sm:translate-x-0"
      />
      <div className="relative flex flex-col items-center gap-4 px-5 py-6 text-center sm:flex-row sm:items-center sm:gap-6 sm:px-6 sm:text-left">
        <div className="relative shrink-0">
          <TeamCrest
            name={team.name}
            seed={team.id}
            logoUrl={team.logoUrl}
            size={88}
            className="rounded-2xl shadow-lg ring-2 ring-amber-400/60"
          />
          <span
            aria-hidden
            className="absolute -bottom-2.5 -right-2.5 grid h-10 w-10 place-items-center rounded-full border border-amber-400/50 bg-surface text-xl shadow-md"
          >
            🏆
          </span>
        </div>
        <div className="flex min-w-0 flex-col items-center gap-1.5 sm:items-start">
          <div className="max-w-full text-xs font-semibold uppercase tracking-[0.2em] text-amber-300 [overflow-wrap:anywhere]">
            {seasonName} Champion
          </div>
          <div className="max-w-full font-display text-3xl font-bold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">
            {linkTeam ? (
              <Link href={`/teams/${team.id}`} className="hover:text-info">
                {team.name}
              </Link>
            ) : (
              team.name
            )}
          </div>
          {final || record ? (
            <p className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-sm text-muted sm:justify-start">
              {final ? (
                <span>
                  Won the grand final{" "}
                  <span className="font-medium text-fg">{final.score}</span>
                  {opponentName ? ` over ${opponentName}` : ""}
                  {final.forfeit ? " by forfeit" : ""}
                </span>
              ) : null}
              {/* Phones stack the two lines, so the dot would dangle. */}
              {final && record ? (
                <span aria-hidden className="hidden text-line sm:inline">
                  •
                </span>
              ) : null}
              {record ? (
                <span>
                  <span className="font-medium text-fg">
                    <SeriesRecord record={record} />
                  </span>{" "}
                  regular season · {record.points}{" "}
                  {record.points === 1 ? "pt" : "pts"}
                </span>
              ) : null}
            </p>
          ) : null}
          {players.length > 0 ? (
            // my-0 on the chips: the py-0.5 orphans TAP_SAFE's -my-1 through
            // twMerge, so the chip reserves 8px less than it occupies (see
            // teams/page.tsx for the measurement). The winning five's chips
            // wrap on every phone.
            <div className="mt-1 flex max-w-full flex-wrap justify-center gap-1.5 sm:justify-start">
              {players.map((m) => (
                <PlayerLink
                  key={m.id}
                  userId={m.userId}
                  className="my-0 flex min-w-6 max-w-full items-center gap-1.5 rounded-full border border-amber-400/30 bg-surface-2/60 py-0.5 pl-0.5 pr-2.5 text-xs hover:border-amber-400/60 hover:no-underline"
                >
                  <Avatar name={m.user.name} src={m.user.avatar} size={20} />
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {m.user.name}
                  </span>
                  {m.isCaptain ? (
                    <Badge tone="accent" className="px-1.5 py-0" title="Captain">
                      <span aria-hidden>C</span>
                      <span className="sr-only">Captain</span>
                    </Badge>
                  ) : null}
                </PlayerLink>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The same moment as a slim strip, for the champion's own team page: its
 * header right above already carries the crest, the name and the roster's
 * own card follows, so the strip adds what the header doesn't say: the
 * season they won and how the final went. Server-safe.
 */
export function ChampionStrip({
  seasonName,
  final,
  opponentName,
  className,
}: {
  seasonName: string;
  final: ChampionFinalLine | null;
  opponentName: string | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[var(--radius)] border border-amber-400/50 bg-gradient-to-r from-amber-400/20 via-surface to-surface px-4 py-3",
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-amber-400/0 via-amber-400/80 to-amber-400/0"
      />
      <div className="relative flex items-center gap-3">
        <span
          aria-hidden
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-amber-400/50 bg-surface text-xl shadow-md"
        >
          🏆
        </span>
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300 [overflow-wrap:anywhere]">
            {seasonName} Champion
          </div>
          {final ? (
            <p className="mt-0.5 text-sm text-muted [overflow-wrap:anywhere]">
              Won the grand final{" "}
              <span className="font-medium text-fg">{final.score}</span>
              {opponentName ? ` over ${opponentName}` : ""}
              {final.forfeit ? " by forfeit" : ""}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
