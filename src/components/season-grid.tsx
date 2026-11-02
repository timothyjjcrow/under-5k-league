import Link from "@/components/app-link";
import { TeamCrest } from "@/components/ui";
import { crossTable, type CrossCell, type CrossMatch } from "@/lib/cross-table";
import { cn } from "@/lib/utils";

/**
 * The league's one results grid ("who's played who"), used on Schedule and
 * the season page: teams in standings order, each cell that meeting's result
 * from the ROW team's side (running score while live, F on a ruled result),
 * linking to the match. Compact on purpose: the rows carry the names, the
 * columns only crest and rank (the name stays for screen readers and on
 * hover), so a group of six fits half of Schedule's desktop width with no
 * scrolling. A wider table still scrolls inside its own box; on phones the
 * row labels shrink to rank and crest and a cell drops its W/L letter (the
 * row team's score comes first, so the score already says it). The caller
 * supplies the frame (a tab of Schedule's standings, a card on the season
 * page).
 */
export function SeasonGrid({
  teamIds,
  teamName,
  teamLogoUrl,
  matches,
  groupTitle,
}: {
  /** Row and column order: the standings. */
  teamIds: string[];
  teamName: Map<string, string>;
  teamLogoUrl: Map<string, string | null>;
  matches: CrossMatch[];
  /** "Group A" in a group season, so each group's grid has its own name. */
  groupTitle?: string;
}) {
  const table = crossTable(teamIds, matches);
  const rankOf = new Map(teamIds.map((id, i) => [id, i + 1]));

  const cellChip = (rowId: string, cell: CrossCell) => {
    const rowName = teamName.get(rowId) ?? "?";
    const label = cell.played
      ? `${rowName} ${
          cell.result === "W" ? "won" : cell.result === "L" ? "lost" : "drew"
        } ${cell.score}${cell.forfeit ? " by forfeit" : ""} in week ${cell.week}`
      : cell.live
        ? `${rowName} ${cell.score} in week ${cell.week}, series in progress`
        : `Week ${cell.week}, not played yet`;
    return (
      <Link
        key={cell.matchId}
        href={`/matches/${cell.matchId}`}
        prefetch={false}
        aria-label={label}
        title={label}
        className={cn(
          // One line ("W 2–0"), not a letter stacked over the score: the
          // stacked chip made every row 60px.
          "flex h-9 min-w-9 items-center justify-center gap-1 whitespace-nowrap rounded-md border border-transparent px-1 font-mono text-xs tabular-nums transition-colors hover:border-fg/40 sm:h-8 sm:min-w-12 sm:px-1.5",
          cell.result === "W" &&
            "bg-success/15 text-success hover:bg-success/25",
          cell.result === "L" &&
            "bg-danger/10 text-danger-soft hover:bg-danger/20",
          cell.result === "D" && "bg-accent/15 text-accent hover:bg-accent/25",
          cell.live && "border-danger/50 bg-danger/10 text-danger-soft",
          !cell.played && !cell.live && "text-muted hover:text-info",
        )}
      >
        {cell.played ? (
          <span className="hidden font-semibold uppercase sm:inline">
            {`${cell.result}${cell.forfeit ? " · F" : ""}`}
          </span>
        ) : cell.live ? (
          <span className="hidden font-semibold uppercase sm:inline">Live</span>
        ) : null}
        {/* A phone keeps the forfeit mark the hidden letter carried. */}
        {cell.played && cell.forfeit ? (
          <span className="font-semibold sm:hidden">F</span>
        ) : null}
        {/* "wk 5", never "W5": W already means a win in the next cell. */}
        <span>{cell.score ?? `wk ${cell.week}`}</span>
      </Link>
    );
  };

  return (
    // overflow-hidden on the box around the scroller is load-bearing: Chrome
    // otherwise adds the table's full width to the page's scroll area,
    // giving every phone a horizontal page scroll (caught by the mid-season
    // mobile e2e). The opaque surface matches the sticky row labels.
    <div className="min-w-0 overflow-hidden rounded-lg bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
          <caption className="sr-only">
            {groupTitle ? `${groupTitle} head-to-head results.` : "Head-to-head results."}{" "}
            Each row shows that team&apos;s results
            against the team in each column: W win, D draw, L loss, F
            forfeit, with the row team&apos;s games first.
          </caption>
          <thead>
            <tr>
              <th className="sticky left-0 z-10 border-b border-line bg-surface px-1.5 py-2 sm:px-3" />
              {teamIds.map((colId) => (
                <th
                  key={colId}
                  scope="col"
                  className="border-b border-line px-0.5 py-1.5 text-center sm:px-1"
                >
                  <Link
                    href={`/teams/${colId}`}
                    title={teamName.get(colId) ?? "?"}
                    className="inline-flex min-h-11 min-w-9 flex-col items-center justify-center gap-0.5 rounded-md hover:bg-surface-2/60"
                  >
                    <TeamCrest
                      name={teamName.get(colId) ?? "?"}
                      seed={colId}
                      logoUrl={teamLogoUrl.get(colId)}
                      size={22}
                      className="rounded"
                    />
                    <span className="sr-only">{teamName.get(colId)}</span>
                    <span
                      aria-hidden
                      className="font-mono text-[10px] tabular-nums text-muted"
                    >
                      #{rankOf.get(colId)}
                    </span>
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {teamIds.map((rowId) => (
              <tr key={rowId}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-line/60 bg-surface px-1.5 py-1 text-left font-normal sm:px-3"
                >
                  <Link
                    href={`/teams/${rowId}`}
                    title={teamName.get(rowId) ?? "?"}
                    className="flex min-h-9 min-w-0 items-center gap-1 py-1 -my-1 hover:text-info sm:gap-2"
                  >
                    <span className="w-4 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted">
                      {rankOf.get(rowId)}
                    </span>
                    <TeamCrest
                      name={teamName.get(rowId) ?? "?"}
                      seed={rowId}
                      logoUrl={teamLogoUrl.get(rowId)}
                      size={20}
                      className="shrink-0 rounded"
                    />
                    {/* Phones: rank and crest only (the column headers
                        carry the same crest and rank); the name stays for
                        screen readers. From sm one line, cut short with
                        the full name on hover. */}
                    <span className="sr-only sm:not-sr-only sm:block sm:max-w-[8.5rem] sm:truncate sm:text-xs">
                      {teamName.get(rowId) ?? "?"}
                    </span>
                  </Link>
                </th>
                {teamIds.map((colId) => {
                  if (colId === rowId) {
                    return (
                      // Stays in the accessibility tree (empty, not
                      // aria-hidden) so screen readers keep every row's
                      // column mapping aligned with the header row.
                      <td
                        key={colId}
                        className="border-b border-line/60 bg-surface-2/60 px-0.5 py-1 sm:px-1"
                      />
                    );
                  }
                  const meetings = table.cells.get(rowId)!.get(colId)!;
                  return (
                    <td
                      key={colId}
                      className="border-b border-line/60 px-0.5 py-1 text-center align-middle sm:px-1"
                    >
                      {meetings.length === 0 ? (
                        <span
                          role="img"
                          aria-label="No meeting scheduled"
                          className="text-xs text-muted"
                        >
                          <span aria-hidden>—</span>
                        </span>
                      ) : (
                        <span className="inline-flex flex-col gap-0.5">
                          {meetings.map((cell) => cellChip(rowId, cell))}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The narrowest box (rem) that shows a grid of `teams` columns whole on a
 * desktop: the row label plus one cell per team. Schedule sets two groups'
 * grids side by side only when both fit (auto-fit tracks of this width).
 */
export function seasonGridWidthRem(teams: number): number {
  return 13.5 + teams * 3.5;
}

/** One line under the grids, so the colours and "wk 5" read without hovering. */
export function SeasonGridKey({ className }: { className?: string }) {
  return (
    <p className={cn("text-xs leading-relaxed text-muted", className)}>
      Read across: each row is that team&apos;s results, its score first.{" "}
      <span className="text-success">Green</span> won,{" "}
      <span className="text-danger-soft">red</span> lost,{" "}
      <span className="text-accent">amber</span> drew; F is a forfeit and
      &ldquo;wk 5&rdquo; a series still to play. Each cell opens its match.
    </p>
  );
}
