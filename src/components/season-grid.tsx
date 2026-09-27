import Link from "next/link";
import { TeamCrest } from "@/components/ui";
import { crossTable, type CrossCell, type CrossMatch } from "@/lib/cross-table";
import { cn } from "@/lib/utils";

/**
 * The league's one results grid ("who's played who"), used on Schedule and
 * the season page: teams in standings order, each cell that meeting's result
 * from the ROW team's side (running score while live, F on a ruled result),
 * linking to the match. Wide by nature, so the table scrolls inside its own
 * box; on phones the row labels shrink to rank and crest so more opponent
 * columns fit beside them. The caller supplies the frame (a disclosure on
 * Schedule, a card on the season page).
 */
export function SeasonGrid({
  teamIds,
  teamName,
  teamLogoUrl,
  matches,
}: {
  /** Row and column order: the standings. */
  teamIds: string[];
  teamName: Map<string, string>;
  teamLogoUrl: Map<string, string | null>;
  matches: CrossMatch[];
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
          "flex min-h-12 min-w-14 flex-col items-center justify-center gap-0.5 rounded-lg border border-transparent px-2 py-2 font-mono text-xs tabular-nums transition-colors hover:border-fg/40",
          cell.result === "W" &&
            "bg-success/15 text-success hover:bg-success/25",
          cell.result === "L" &&
            "bg-danger/10 text-danger-soft hover:bg-danger/20",
          cell.result === "D" && "bg-accent/15 text-accent hover:bg-accent/25",
          cell.live && "border-danger/50 bg-danger/10 text-danger-soft",
          !cell.played && !cell.live && "text-muted hover:text-info",
        )}
      >
        <span className="text-[10px] font-semibold uppercase">
          {cell.played
            ? `${cell.result}${cell.forfeit ? " · F" : ""}`
            : cell.live
              ? "Live"
              : `W${cell.week}`}
        </span>
        <span>{cell.score ?? "vs"}</span>
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
            Head-to-head results. Each row shows that team&apos;s results
            against the team in each column: W win, D draw, L loss, F
            forfeit, with the row team&apos;s games first.
          </caption>
          <thead>
            <tr>
              <th className="sticky left-0 z-10 border-b border-line bg-surface px-3 py-2 sm:px-4" />
              {teamIds.map((colId) => (
                <th
                  key={colId}
                  scope="col"
                  className="border-b border-line px-1.5 py-2 text-center"
                >
                  <Link
                    href={`/teams/${colId}`}
                    title={teamName.get(colId) ?? "?"}
                    className="inline-flex min-h-11 min-w-6 flex-col items-center justify-center gap-1 py-1 -my-1"
                  >
                    <TeamCrest
                      name={teamName.get(colId) ?? "?"}
                      seed={colId}
                      logoUrl={teamLogoUrl.get(colId)}
                      size={22}
                      className="rounded"
                    />
                    <span className="max-w-20 whitespace-normal text-xs font-medium [overflow-wrap:anywhere] sm:max-w-28">
                      {teamName.get(colId)}
                    </span>
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
                  className="sticky left-0 z-10 border-b border-line/60 bg-surface px-3 py-1.5 text-left font-normal sm:px-4"
                >
                  <Link
                    href={`/teams/${rowId}`}
                    title={teamName.get(rowId) ?? "?"}
                    className="flex min-h-11 min-w-0 max-w-[11rem] items-center gap-2 py-1 -my-1 hover:text-info"
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
                        name every crest); the name stays for screen
                        readers. */}
                    <span className="sr-only sm:not-sr-only sm:min-w-0 sm:whitespace-normal sm:text-xs sm:[overflow-wrap:anywhere]">
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
                        className="border-b border-line/60 bg-surface-2/60 px-1.5 py-1.5"
                      />
                    );
                  }
                  const meetings = table.cells.get(rowId)!.get(colId)!;
                  return (
                    <td
                      key={colId}
                      className="border-b border-line/60 px-1.5 py-1.5 text-center align-middle"
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
