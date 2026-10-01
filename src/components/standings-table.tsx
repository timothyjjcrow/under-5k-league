// The league table: rank, team with its playoff status, W-D-L, game
// difference and points, plus the last five results on wider screens. One
// layout for home, /schedule and the season archive. It used to come as a
// "simple" view and a sortable "detailed" one behind a toggle, which worded
// the same badges two ways and hid game difference, the first tiebreak.

import Link from "next/link";
import { Fragment } from "react";
import { EmptyState, FormStrip, TeamCrest } from "@/components/ui";
import { cn } from "@/lib/utils";
import { WIN_STREAK_MIN, type FormResult } from "@/lib/team-matches";
import type { ClinchStatus } from "@/lib/standings";

export type StandingsRowView = {
  teamId: string;
  name: string;
  logoUrl?: string | null;
  /** 1-based league rank in points order. */
  rank: number;
  wins: number;
  draws: number;
  losses: number;
  gameDiff: number;
  points: number;
  form: FormResult[] | null;
  clinch: ClinchStatus;
  /** Places moved vs. before the latest completed week (positive = up). */
  move: number;
  /** Order vs. a neighbour fell to the team-id fallback — a dead heat. */
  idDecided: boolean;
  /** The extra tiebreaker week settled this team's playoff order. */
  tiebreakerResolved?: boolean;
  /** Qualification or seed order is pending a required tiebreaker. */
  tiebreakerPending?: boolean;
  /** The tied group is wholly inside the playoff cut; only its order is open. */
  seedingTiebreakerPending?: boolean;
  /** Quit mid-season — remaining fixtures forfeited, out of seeding. */
  withdrawn: boolean;
  /** One-based playoff seed, or null when below the cut / ineligible. */
  playoffSeed: number | null;
  /** Series won in a row up to the latest result (`seriesWinStreak`); left
   *  out where the table isn't live (`standingsStreaksShown`). */
  streak?: number;
};

/** The scoring and tiebreak order, in the one line under every table. */
export const STANDINGS_RULES =
  "Win 3 points, draw 1, loss 0. Level teams split on game difference, then series wins, then head-to-head.";

export function StandingsTableView({
  rows,
  playoffCut,
  viewerTeamId,
  totalTeams,
  eligibleTeams,
}: {
  rows: StandingsRowView[];
  /** How many top teams make playoffs — draws a "playoff cut" line when set. */
  playoffCut?: number;
  /** The signed-in viewer's team — its row gets a subtle highlight. */
  viewerTeamId?: string | null;
  /**
   * League size before any slicing — "does anyone miss the bracket?" must be
   * judged against the full field, not the rows on screen.
   */
  totalTeams?: number;
  /** Non-withdrawn teams competing for the playoff places. */
  eligibleTeams?: number;
}) {
  if (rows.length === 0) {
    return (
      <div className="p-5">
        <EmptyState title="No standings yet" description="Play some matches!" />
      </div>
    );
  }

  const hasForm = rows.some((r) => r.form !== null);
  const hasSeedProjection =
    playoffCut != null && rows.some((row) => row.playoffSeed != null);
  // Only draw the cut line when some teams actually miss the bracket.
  const hasCut =
    playoffCut != null &&
    playoffCut > 0 &&
    playoffCut < (eligibleTeams ?? totalTeams ?? rows.length);
  const cols = hasForm ? 6 : 5;
  // Points is the last column on phones; with Last 5 beside it from sm up,
  // it hands its right-hand gutter to that column.
  const pointsPad = cn("pl-2 pr-4 @lg:pr-5", hasForm && "@xl:pr-2");

  return (
    // table-fixed + explicit column widths via <colgroup>: the Team column
    // absorbs whatever is left and its name truncates, so long names can't
    // widen the page or stretch a row. Widths
    // MUST live on <col>. A display:none cell drops out of its row, and the
    // cells after it slide onto the wrong <col>. So the one column that
    // hides on phones (Last 5) is the LAST one, with a w-0 <col> there, and
    // every visible cell keeps its own column at every width.
    // Breakpoints are the TABLE's width, not the viewport's (@container):
    // the same table fills Home's main column, a 30rem rail on /schedule and
    // a phone. From 32rem the desktop column widths and one-line rows; Last 5
    // from 36rem.
    <div className="@container">
      <table aria-label="League standings" className="w-full table-fixed text-sm">
        <caption className="caption-bottom border-t border-line-soft px-4 py-3 text-left text-xs leading-relaxed text-muted @lg:px-5">
          {STANDINGS_RULES}
        </caption>
        <colgroup>
          <col className="w-10 @md:w-[4.25rem] @lg:w-[4.5rem]" />
          <col />
          <col className="w-14 @lg:w-20" />
          <col className="w-10 @lg:w-14" />
          <col className={hasForm ? "w-14 @lg:w-16 @xl:w-12" : "w-14 @lg:w-16"} />
          {hasForm ? <col className="w-0 @xl:w-32" /> : null}
        </colgroup>
        <thead>
          <tr className="border-b border-line-soft bg-surface-2/35 text-left text-[10px] uppercase tracking-[0.12em] text-muted">
            <th scope="col" className="py-2.5 pl-4 pr-1 font-medium @lg:pl-5 @lg:pr-2">
              <span aria-hidden>#</span>
              <span className="sr-only">Rank</span>
            </th>
            <th scope="col" className="px-2 py-2.5 font-medium">
              Team
            </th>
            <th scope="col" className="px-1 py-2.5 text-center font-medium @lg:px-2">
              <span aria-hidden>W-D-L</span>
              <span className="sr-only">Series won, drawn and lost</span>
            </th>
            <th scope="col" className="px-1 py-2.5 text-center font-medium @lg:px-2">
              <span aria-hidden>Diff</span>
              <span className="sr-only">Game difference</span>
            </th>
            <th scope="col" className={cn("py-2.5 text-right font-medium", pointsPad)}>
              <span aria-hidden>Pts</span>
              <span className="sr-only">Points</span>
            </th>
            {hasForm ? (
              <th
                scope="col"
                className="hidden py-2.5 pl-2 pr-4 text-center font-medium @xl:table-cell @xl:pr-5"
              >
                Last 5
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isViewer = row.teamId === viewerTeamId;
            const inCut =
              hasCut && !row.tiebreakerPending && row.playoffSeed != null;
            return (
              <Fragment key={row.teamId}>
                <tr
                  className={cn(
                    "border-b border-line-soft transition-colors last:border-0 hover:bg-surface-2/60",
                    isViewer && "bg-info/[0.07]",
                  )}
                >
                  <td className="py-2.5 pl-4 pr-1 @lg:py-2 @lg:pl-5 @lg:pr-2">
                    {/* From 28rem wide the movement sits beside the rank, not
                        under it, so a team that moved keeps a one-line row. */}
                    <span className="flex flex-col @md:flex-row @md:items-baseline @md:gap-1.5">
                      <span
                        className={cn(
                          "block font-display text-lg leading-none tabular-nums",
                          inCut ? "font-medium text-success" : "text-muted",
                        )}
                      >
                        {row.rank}
                      </span>
                      {row.move !== 0 ? (
                        <span
                          role="img"
                          aria-label={`${row.move > 0 ? "up" : "down"} ${Math.abs(row.move)} from last week`}
                          title={`${row.move > 0 ? "Up" : "Down"} ${Math.abs(row.move)} from last week`}
                          className={cn(
                            "mt-1.5 block whitespace-nowrap text-xs font-semibold @md:mt-0",
                            row.move > 0 ? "text-success" : "text-danger",
                          )}
                        >
                          <span aria-hidden>
                            {row.move > 0 ? "▲" : "▼"}
                            {Math.abs(row.move)}
                          </span>
                        </span>
                      ) : null}
                    </span>
                    {hasSeedProjection ? (
                      <span className="sr-only">
                        {row.tiebreakerPending
                          ? ", playoff qualification or seeding pending a tiebreaker match"
                          : row.playoffSeed != null
                            ? `, current playoff seed ${row.playoffSeed}`
                            : row.withdrawn
                              ? ", withdrawn and excluded from playoff seeding"
                              : ", outside the current playoff field"}
                      </span>
                    ) : null}
                  </td>
                  <th scope="row" className="px-2 py-2.5 text-left font-normal @lg:py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <TeamCrest
                        name={row.name}
                        seed={row.teamId}
                        logoUrl={row.logoUrl}
                        size={24}
                        className="shrink-0 rounded-md"
                      />
                      {/* From 28rem wide the status rides beside the name while
                          both fit, and wraps under it when they don't: one
                          line per team on a desktop table instead of two. */}
                      <div className="min-w-0 flex-1 @md:flex @md:flex-wrap @md:items-center @md:gap-x-3">
                        {/* One line, truncated: on a phone the fixed columns
                            leave the name ~90px, and a wrapping name stacked a
                            long team onto five lines. The full name is the
                            link's text, its tooltip and the team page. */}
                        <Link
                          href={`/teams/${row.teamId}`}
                          title={row.name}
                          className="-my-1 inline-flex min-h-8 min-w-6 max-w-full items-center py-1 text-sm font-semibold leading-snug transition-colors hover:text-info"
                        >
                          <span className="truncate">{row.name}</span>
                        </Link>
                        <StatusLine
                          row={row}
                          playoffCut={playoffCut}
                          isViewer={isViewer}
                        />
                      </div>
                    </div>
                  </th>
                  <td className="px-1 py-2.5 text-center font-mono text-xs tabular-nums @lg:px-2 @lg:py-2">
                    <span
                      role="img"
                      aria-label={`${row.wins} won, ${row.draws} drawn, ${row.losses} lost`}
                      className="whitespace-nowrap"
                    >
                      <span aria-hidden>
                        {row.wins}-{row.draws}-{row.losses}
                      </span>
                    </span>
                  </td>
                  <td className="px-1 py-2.5 text-center font-mono text-xs tabular-nums text-muted @lg:px-2 @lg:py-2">
                    {row.gameDiff > 0 ? `+${row.gameDiff}` : row.gameDiff}
                  </td>
                  <td
                    className={cn(
                      "py-2.5 text-right font-display text-xl font-semibold tabular-nums @lg:py-2",
                      pointsPad,
                    )}
                  >
                    {row.points}
                  </td>
                  {hasForm ? (
                    <td className="hidden py-2 pl-2 pr-4 @xl:table-cell @xl:pr-5">
                      <span className="flex justify-center">
                        {row.form?.length ? (
                          <FormStrip form={row.form.slice(0, 5)} size={4} />
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </span>
                    </td>
                  ) : null}
                </tr>
                {hasCut && !row.tiebreakerPending && row.playoffSeed === playoffCut ? (
                  <tr className="bg-success/[0.03]">
                    <td colSpan={cols} className="px-4 py-1.5 @lg:px-5">
                      <div className="flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.15em] text-success/80">
                        <span
                          aria-hidden
                          className="h-px flex-1 border-t border-dashed border-success/35"
                        />
                        Playoff cut · {playoffCut} places
                        <span
                          aria-hidden
                          className="h-px flex-1 border-t border-dashed border-success/35"
                        />
                        <span className="sr-only">
                          . Eligible teams below this line are outside the current
                          playoff field.
                        </span>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A team whose place fell to the team-id fallback: every tiebreak is level.
 * /teams shows the same chip, under the same rule: it gives way to the
 * tiebreaker badge while a tiebreaker match is pending.
 */
export function TiedChip({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Fully tied with a neighbouring team — displayed order is provisional"
      title="Points, game difference, series wins and head-to-head are all level. A tie that affects the playoffs is settled by tiebreaker matches after the regular season."
      className={cn("rounded bg-accent/10 px-1.5 py-0.5 text-accent", className)}
    >
      <span aria-hidden>Tied</span>
    </span>
  );
}

/**
 * A run of series wins, from WIN_STREAK_MIN: "W3 streak", with its meaning
 * spoken. Neutral like "Your team": blue reads as a link here, green is the
 * playoff marks' colour and amber the warnings'.
 */
export function StreakChip({ wins }: { wins: number }) {
  return (
    <span
      role="img"
      aria-label={`Won the last ${wins} series`}
      title={`Won the last ${wins} series in a row`}
      className="whitespace-nowrap rounded bg-surface-3 px-1.5 py-0.5 text-fg"
    >
      <span aria-hidden>W{wins} streak</span>
    </span>
  );
}

/** The line under a team's name: playoff status, then any chips. */
function StatusLine({
  row,
  playoffCut,
  isViewer,
}: {
  row: StandingsRowView;
  playoffCut?: number;
  isViewer: boolean;
}) {
  const status = playoffStatus(row, playoffCut);
  const tied = row.idDecided && !row.tiebreakerPending;
  const streak =
    row.streak != null && row.streak >= WIN_STREAK_MIN ? row.streak : null;
  if (
    !status &&
    !isViewer &&
    !tied &&
    !row.tiebreakerResolved &&
    streak == null
  ) {
    return null;
  }
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium leading-tight @md:my-0.5">
      {status}
      {isViewer ? (
        // Neutral on purpose: blue text reads as a link on this site.
        <span className="rounded bg-surface-3 px-1.5 py-0.5 text-fg">
          Your team
        </span>
      ) : null}
      {tied ? <TiedChip /> : null}
      {row.tiebreakerResolved ? (
        <span
          title="Tiebreaker matches settled this team's playoff place. Regular-season points are unchanged."
          className="rounded bg-surface-3 px-1.5 py-0.5 text-muted"
        >
          Settled by tiebreaker
        </span>
      ) : null}
      {streak != null ? <StreakChip wins={streak} /> : null}
    </div>
  );
}

function playoffStatus(row: StandingsRowView, playoffCut?: number) {
  if (row.withdrawn) {
    return (
      <span
        title="Withdrew from the season. Remaining fixtures were forfeited, and the team can't take a playoff seed."
        className="text-muted"
      >
        Withdrawn
      </span>
    );
  }
  if (row.tiebreakerPending) {
    if (row.seedingTiebreakerPending && row.clinch === "CLINCHED") {
      return (
        <span
          title="Playoff place secured; a tiebreaker decides the seed order"
          className="text-success"
        >
          <span aria-hidden>✓ </span>Qualified · seeding tiebreaker
        </span>
      );
    }
    return (
      <span
        title={
          row.seedingTiebreakerPending
            ? "Playoff seed order needs a tiebreaker"
            : "A tiebreaker match must settle playoff qualification after the regular season"
        }
        className="rounded bg-accent/10 px-1.5 py-0.5 text-accent"
      >
        {row.seedingTiebreakerPending ? "Seeding tiebreaker" : "Tiebreaker pending"}
      </span>
    );
  }
  if (row.clinch === "CLINCHED") {
    return (
      <span title="Playoff place secured" className="text-success">
        <span aria-hidden>✓ </span>Qualified
        {row.playoffSeed != null && row.playoffSeed !== row.rank ? (
          <> · seed {row.playoffSeed}</>
        ) : null}
      </span>
    );
  }
  if (row.clinch === "ELIMINATED") {
    return (
      <span title="Out of playoff contention" className="text-muted">
        <span aria-hidden className="text-danger">
          ✗{" "}
        </span>
        Eliminated
      </span>
    );
  }
  if (playoffCut != null && row.playoffSeed != null) {
    return (
      <span
        title={`Currently in a playoff place as seed ${row.playoffSeed}`}
        className="text-muted"
      >
        Seed {row.playoffSeed}
      </span>
    );
  }
  if (playoffCut != null) {
    return (
      <span title="Currently outside the playoff places" className="text-muted">
        Outside cut
      </span>
    );
  }
  return null;
}
