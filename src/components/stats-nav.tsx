import Link from "next/link";
import { cn } from "@/lib/utils";
import { getSessionUser } from "@/lib/auth";
import { getPublicLeagueContent } from "@/lib/public-navigation";
import { getActiveSeason } from "@/lib/season";
import { seasonStatsListed } from "@/lib/site-nav";
import { LinkArrow, textLink } from "@/components/ui";

export type StatsSection = "leaders" | "meta" | "records" | "compare";

/**
 * Compact cross-navigation for the league's four public statistics views.
 * All four fill from imported games, so before the league's first game the
 * bar is left out: it only linked one empty page to three more. Leaders and
 * Hero meta open on the active season, so they wait for it to reach the
 * regular season, by the menus' own rule (seasonStatsListed in
 * src/lib/site-nav.ts). Two exceptions: a selected past season (`seasonId`)
 * has boards to show, and the page being viewed always keeps its tab.
 */
export async function StatsNav({
  active,
  seasonId,
}: {
  active: StatsSection;
  /** Keep a selected season when moving between the season-scoped boards. */
  seasonId?: string;
}) {
  const [{ hasGames }, season] = await Promise.all([
    getPublicLeagueContent(null),
    getActiveSeason(),
  ]);
  if (!hasGames) return null;
  const seasonBoards =
    seasonId !== undefined ||
    seasonStatsListed({ phase: season?.status ?? null, hasGames });
  const query = seasonId
    ? `?${new URLSearchParams({ season: seasonId }).toString()}`
    : "";
  const items = (
    [
      { key: "leaders", href: `/leaders${query}`, label: "Leaders", seasonBoard: true },
      { key: "meta", href: `/meta${query}`, label: "Hero meta", seasonBoard: true },
      { key: "records", href: `/records${query}`, label: "Record book", seasonBoard: false },
      { key: "compare", href: "/players/compare", label: "Compare players", seasonBoard: false },
    ] satisfies { key: StatsSection; href: string; label: string; seasonBoard: boolean }[]
  ).filter((item) => !item.seasonBoard || seasonBoards || item.key === active);

  return (
    <nav aria-label="Statistics" className="mb-6">
      {/* One row at every width: on a phone the four tabs share it and a
          long label ("Compare players") takes two short lines, where a 2x2
          grid spent a second 44px row on the same four links. */}
      <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl border border-line bg-surface p-1 sm:flex sm:flex-wrap">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            aria-current={item.key === active ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 min-w-0 flex-1 items-center justify-center rounded-lg px-1.5 py-1 text-center text-[13px] font-medium leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 sm:min-h-10 sm:flex-none sm:px-3 sm:py-2 sm:text-sm",
              item.key === active
                ? "bg-surface-3 text-fg shadow-sm ring-1 ring-inset ring-accent/50"
                : "text-muted hover:bg-surface-2/70 hover:text-fg",
            )}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

type StatsDataNoticeProps = Parameters<typeof StatsDataNoticeBody>[0];

/**
 * Players see that some games are still being processed; the repair steps
 * (remove, re-import, update the hero catalogue) are admin work, so only
 * admins see them, with a link to the data-quality page.
 */
export async function StatsDataNotice(
  props: Omit<StatsDataNoticeProps, "isAdmin">,
) {
  const viewer = await getSessionUser();
  return <StatsDataNoticeBody {...props} isAdmin={viewer?.role === "ADMIN"} />;
}

export function StatsDataNoticeBody({
  isAdmin = false,
  invalidLines,
  malformedGames,
  unusableGames = 0,
  unknownHeroLines = 0,
  unmappedLines = 0,
  invalidGameMetrics = 0,
}: {
  isAdmin?: boolean;
  invalidLines: number;
  malformedGames: number;
  /** Valid JSON that is empty, partial, or violates 5v5 uniqueness. */
  unusableGames?: number;
  /** Complete lines whose hero is absent from the bundled Dota catalog. */
  unknownHeroLines?: number;
  /** Structurally valid lines that are not linked to a league user. */
  unmappedLines?: number;
  /** Games with an unsafe duration or kill score in stored columns. */
  invalidGameMetrics?: number;
}) {
  if (
    invalidLines === 0 &&
    malformedGames === 0 &&
    unusableGames === 0 &&
    unknownHeroLines === 0 &&
    unmappedLines === 0 &&
    invalidGameMetrics === 0
  )
    return null;
  if (!isAdmin) {
    return (
      <p className="mb-6 rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-sm text-muted">
        {/* Nothing re-checks these on its own: they stay out of the stats
            until an admin repairs or re-imports them, so the copy must not
            promise a delay that clears itself. */}
        Some imported games are incomplete, so a few stats are missing until
        an admin fixes them.
      </p>
    );
  }
  const details = [
    malformedGames > 0
      ? `${malformedGames} game${malformedGames === 1 ? " has" : "s have"} unreadable player data`
      : null,
    invalidLines > 0
      ? `${invalidLines} invalid player line${invalidLines === 1 ? "" : "s"}`
      : null,
    unusableGames > 0
      ? `${unusableGames} incomplete or duplicated 5v5 box score${unusableGames === 1 ? "" : "s"}`
      : null,
    unknownHeroLines > 0
      ? `${unknownHeroLines} player line${unknownHeroLines === 1 ? " uses" : "s use"} an unknown hero id`
      : null,
    unmappedLines > 0
      ? `${unmappedLines} player line${unmappedLines === 1 ? " is" : "s are"} not linked to a league account`
      : null,
    invalidGameMetrics > 0
      ? `${invalidGameMetrics} game${invalidGameMetrics === 1 ? " has" : "s have"} an unsafe duration or kill score`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const hasReimportableIssue =
    invalidLines > 0 ||
    malformedGames > 0 ||
    unusableGames > 0 ||
    unmappedLines > 0 ||
    invalidGameMetrics > 0;
  return (
    <div className="mb-6 rounded-xl border border-accent/35 bg-accent/10 px-4 py-3 text-sm text-fg">
      <p className="font-medium">Some stored game data needs attention.</p>
      <p className="mt-0.5 text-xs text-muted">
        Valid results are still shown. {details}.{" "}
        {hasReimportableIssue
          ? "Administrators should inspect the affected match, remove the bad import, and import that game again. "
          : ""}
        {unknownHeroLines > 0
          ? "Unknown hero IDs require an update to the bundled hero catalogue. "
          : ""}
        <Link href="/admin/data-quality" className={textLink("text-xs")}>
          Open data quality <LinkArrow />
        </Link>
      </p>
      <p className="mt-1 text-xs text-muted">Only admins see these details.</p>
    </div>
  );
}
