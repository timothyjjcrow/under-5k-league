import Link from "next/link";
import { cn } from "@/lib/utils";

export type StatsSection = "leaders" | "meta" | "records" | "compare";

/** Compact cross-navigation for the league's four public statistics views. */
export function StatsNav({
  active,
  seasonId,
}: {
  active: StatsSection;
  /** Archive context is meaningful only on season-scoped Leaders and Meta. */
  seasonId?: string;
}) {
  const query = seasonId
    ? `?${new URLSearchParams({ season: seasonId }).toString()}`
    : "";
  const items: { key: StatsSection; href: string; label: string }[] = [
    { key: "leaders", href: `/leaders${query}`, label: "Leaders" },
    { key: "meta", href: `/meta${query}`, label: "Hero meta" },
    { key: "records", href: "/records", label: "Record book" },
    { key: "compare", href: "/players/compare", label: "Compare players" },
  ];

  return (
    <nav aria-label="Statistics" className="mb-6">
      <div className="flex flex-wrap gap-1 rounded-xl border border-line/70 bg-surface/60 p-1">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            aria-current={item.key === active ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 py-2 text-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 sm:min-h-10 sm:flex-none",
              item.key === active
                ? "bg-accent/15 text-fg"
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

export function StatsDataNotice({
  invalidLines,
  malformedGames,
  unusableGames = 0,
  unknownHeroLines = 0,
  unmappedLines = 0,
  invalidGameMetrics = 0,
}: {
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
    <div className="mb-6 rounded-xl border border-warning/35 bg-warning/10 px-4 py-3 text-sm text-fg">
      <p className="font-medium">Some stored game data needs attention.</p>
      <p className="mt-0.5 text-xs text-muted">
        Valid results are still shown. {details}.{" "}
        {hasReimportableIssue
          ? "Administrators should inspect the affected match, remove the bad import, and import that game again. "
          : ""}
        {unknownHeroLines > 0
          ? "Unknown hero IDs require an update to the bundled hero catalogue."
          : ""}
      </p>
    </div>
  );
}
