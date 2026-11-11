"use client";

// The /schedule scoreboards: a team filter, compact completed weeks,
// and visible progress for each round. Fully played past weeks start closed
// (under a team filter too) and show one line of results per series.
// The server page serializes everything (dates preformatted so hydration
// never disagrees on locale); this component only filters and toggles.

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "@/components/app-link";
import { useSearchParams } from "next/navigation";
import { Badge, LinkArrow, TeamCrest, textLink } from "@/components/ui";
import { LocalTime, useLocalTimeText } from "@/components/local-time";
import { WatchLink } from "@/components/watch-link";
import type { LeagueStream, WatchWindow } from "@/lib/broadcast";
import { cn } from "@/lib/utils";
import { MATCH_ANCHOR, matchAnchorPath } from "@/lib/match-anchors";
import {
  scheduleFilterTeamId,
  sharedKickoffTs,
  viewerSeriesFirst,
  weekStartsCollapsed,
} from "@/lib/schedule";
import type { PlayoffPathLine } from "@/components/playoff-outlook";

/** A settled team's playoff status on its next fixture (fixtureStake). */
type SettledStake = { text: string; tone: "success" | "accent" | "neutral" };

export type RsvpSide = {
  confirmed: number;
  out: number;
  /** Expected match-night side size, including any unfilled roster seat. */
  expected: number;
};

export type MatchView = {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  homeName: string;
  awayName: string;
  homeLogoUrl?: string | null;
  awayLogoUrl?: string | null;
  homeScore: number;
  awayScore: number;
  playoffPaths?: {
    home: PlayoffPathLine[];
    away: PlayoffPathLine[];
  };
  /** In place of the paths once nothing can change a side's playoff fate. */
  playoffSettled?: {
    home: SettledStake | null;
    away: SettledStake | null;
  };
  done: boolean;
  /** Ruled/defaulted result — the score was never played; badge it. */
  forfeit: boolean;
  awaitingResult?: boolean;
  /** The viewer captains a side of this overdue fixture and can report it. */
  reportResult?: boolean;
  /** Series in progress — some games imported, not decided (auto-sync makes
   *  "Bo3 at 1–0" a common minutes-fresh state worth showing live). */
  live: boolean;
  homeWin: boolean;
  awayWin: boolean;
  /** Pre-formatted on the server; null when unscheduled. */
  whenFull: string | null;
  whenShort: string | null;
  /** Epoch ms — lets the client re-render times in the viewer's timezone. */
  whenTs: number | null;
  isFinalPhase: boolean;
  /** "Group A" on a group-stage fixture; unset in a one-table season. */
  groupLabel?: string;
  standins: string[];
  rsvp?: { home: RsvpSide; away: RsvpSide };
  /** The league stream on a playoff or final match still to be played
   *  (broadcast.ts); the row's link decides "soon" or "live" in the browser. */
  watch?: { stream: LeagueStream; window: WatchWindow } | null;
  /** Pending reschedule: proposer + epoch so the tooltip renders viewer-local. */
  reschedulePending: {
    by: string;
    ts: number | null;
    /** Server-formatted fallback for the first paint. */
    initial: string | null;
    /** Times on offer in the ready check (`ts` is the earliest). */
    optionCount?: number;
  } | null;
};

export type WeekView = {
  week: number;
  /** Rendered in place of "Week N" (playoff rounds: "Semifinals", "Grand final"). */
  label?: string;
  completed: number;
  total: number;
  isCurrent: boolean;
  /** Every unreported fixture is older than the result-sync window. */
  isOverdue: boolean;
  matches: MatchView[];
  /** Teams sitting out this week (odd team counts rotate a bye). */
  byes: { id: string; name: string }[];
  /** Earliest kickoff of the week (epoch ms) — null when nothing scheduled. */
  nightTs?: number | null;
  /** Server-formatted date-only fallback for the first paint. */
  nightInitial?: string | null;
  /** Before the league's current week — listed newest first under a
   *  small "Earlier weeks" heading (see orderScheduleWeeks). */
  earlier?: boolean;
  /** A finished regular week's wrap page (weekWrapPath), else null. */
  wrapHref?: string | null;
};

export function ScheduleWeeks({
  weeks,
  teams,
  initialTeamId,
  viewerTeamId,
  openThrough,
  heading,
}: {
  weeks: WeekView[];
  /** A team the filter starts on when the URL names none. */
  initialTeamId?: string;
  /** The reader's own team: its series lead each week and are marked. */
  viewerTeamId?: string;
  /** The last week that opens as full cards (see weekStartsCollapsed). */
  openThrough?: number | null;
  teams: { id: string; name: string; logoUrl?: string | null }[];
  /** The section's title, set on one line with the team filter. */
  heading?: ReactNode;
}) {
  const params = useSearchParams();
  const paramTeam = params.get("team");
  // The address's ?team as this tab last saw it, the filter's source of
  // truth. The filter writes it with history.pushState and the select
  // follows at once (waiting on the router, which applies a pushState in a
  // transition, flickered the pick to "All teams" first). Back and Forward
  // over those entries move the address without a new useSearchParams in
  // Next 16.4, so the tab reads them itself (popstate); a router navigation
  // that changes ?team still lands through useSearchParams.
  const [addressTeam, setAddressTeam] = useState(paramTeam);
  const [seenParamTeam, setSeenParamTeam] = useState(paramTeam);
  if (paramTeam !== seenParamTeam) {
    setSeenParamTeam(paramTeam);
    setAddressTeam(paramTeam);
  }
  useEffect(() => {
    const onPopState = () =>
      setAddressTeam(new URLSearchParams(window.location.search).get("team"));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const filterTeam = scheduleFilterTeamId(
    addressTeam,
    initialTeamId,
    teams.map((team) => team.id),
  );
  const setFilterTeam = (team: string | null) => {
    setAddressTeam(team ?? "all");
    const url = new URL(window.location.href);
    url.searchParams.set("team", team ?? "all");
    window.history.pushState(null, "", url.pathname + url.search + url.hash);
  };
  // Per-week collapsed overrides on top of the default rule (past weeks with
  // every result in start collapsed).
  // Separate regular weeks from playoff rounds; both can appear on this page.
  // URL state also restores opened past weeks after visiting a match.
  const weekParam = weeks.some((week) => week.label) ? "rounds" : "weeks";
  const collapsedOverride: Record<number, boolean> = {};
  for (const value of (params.get(weekParam) ?? "").split(",")) {
    if (!/^-?[1-9]\d*$/.test(value)) continue;
    const week = Math.abs(Number(value));
    if (weeks.some((entry) => entry.week === week))
      collapsedOverride[week] = Number(value) < 0;
  }
  const setWeekCollapsed = (week: number, collapsed: boolean) => {
    const overrides = { ...collapsedOverride, [week]: collapsed };
    const url = new URL(window.location.href);
    url.searchParams.set(
      weekParam,
      Object.entries(overrides)
        .map(([number, closed]) => `${closed ? "-" : ""}${number}`)
        .join(","),
    );
    window.history.pushState(null, "", url.pathname + url.search + url.hash);
  };

  const currentWeek = weeks.find((w) => w.isCurrent)?.week;

  const visibleWeeks = useMemo(() => {
    if (!filterTeam)
      return weeks.map((w) => ({
        ...w,
        matches: viewerSeriesFirst(w.matches, viewerTeamId),
      }));
    return (
      weeks
        .map((w) => ({
          ...w,
          matches: w.matches.filter(
            (m) => m.homeTeamId === filterTeam || m.awayTeamId === filterTeam,
          ),
        }))
        // A bye week is part of the team's season — keep it visible.
        .filter(
          (w) =>
            w.matches.length > 0 || w.byes.some((b) => b.id === filterTeam),
        )
    );
  }, [weeks, filterTeam, viewerTeamId]);
  // The reader's team leads the list, named as theirs.
  const viewerTeam = teams.find((team) => team.id === viewerTeamId);

  return (
    <div className="space-y-4">
      {/* The title and the filter share one row (two on a phone) instead of
          a heading over a bordered filter card over the weeks. Each card
          names its status in words, so the dot legend that sat beside the
          filter went. */}
      {heading || teams.length > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {heading}
          {teams.length > 1 ? (
            <label className="flex w-full min-w-0 items-center gap-2 text-sm text-muted sm:w-auto">
              <span className="shrink-0">Show matches for</span>
              <select
                value={filterTeam ?? "all"}
                onChange={(event) =>
                  setFilterTeam(
                    event.target.value === "all" ? null : event.target.value,
                  )
                }
                className="block min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface-2 px-3 text-sm font-medium text-fg sm:w-56 lg:min-h-10"
              >
                <option value="all">All teams</option>
                {viewerTeam ? (
                  <option value={viewerTeam.id}>
                    My team · {viewerTeam.name}
                  </option>
                ) : null}
                {teams
                  .filter((team) => team.id !== viewerTeam?.id)
                  .map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-3">
        {visibleWeeks.map((w, index) => {
          const completed = filterTeam
            ? w.matches.filter((match) => match.done).length
            : w.completed;
          const total = filterTeam ? w.matches.length : w.total;
          // The same collapse rules apply under a team filter: a finished
          // past week is one line of results, not a full card, so a player's
          // own season never buries the standings below it.
          const collapsed =
            collapsedOverride[w.week] ??
            weekStartsCollapsed(
              { week: w.week, completed, total },
              currentWeek,
              openThrough,
            );
          // One kickoff for the whole week is printed once, here; a card
          // then shows a time only when its own differs.
          const sharedTs = sharedKickoffTs(w.matches);
          // Only a heading when something current or upcoming sits above it;
          // a list that is ALL earlier weeks needs no divider.
          const earlierHeading =
            w.earlier && index > 0 && !visibleWeeks[index - 1].earlier;
          const shownByes = filterTeam
            ? w.byes.filter((b) => b.id === filterTeam)
            : w.byes;
          const byeRow =
            shownByes.length > 0 ? (
              <div className="flex items-center gap-2 border-t border-line-soft px-4 py-3 text-xs text-muted first:border-t-0 sm:px-5">
                <span className="rounded bg-surface-2 px-2 py-1 text-xs font-semibold uppercase tracking-wider">
                  Bye
                </span>
                <span>{shownByes.map((b) => b.name).join(", ")}</span>
              </div>
            ) : null;
          return (
            <Fragment key={w.week}>
              {earlierHeading ? (
                <h3 className="pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                  Earlier weeks
                </h3>
              ) : null}
              <div
                // Deep-link target ("/schedule#this-week"); scroll-mt clears
                // the sticky site header.
                id={w.isCurrent ? "this-week" : undefined}
                className={cn(
                  // @container: the week's cards go two and three across by
                  // the week's own width, which is the page's full width on
                  // playoff pages and a column beside the table mid-season.
                  "@container overflow-hidden rounded-xl border bg-surface",
                  w.isCurrent
                    ? "scroll-mt-24 border-accent/50"
                    : "border-line-soft",
                )}
              >
                <h3
                  className={cn(
                    "flex items-center gap-3 px-4 py-3 sm:px-5",
                    w.isCurrent ? "bg-accent/[0.05]" : "bg-surface-2/30",
                  )}
                >
                  <WeekProgress
                    completed={completed}
                    total={total}
                    current={w.isCurrent}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <button
                        type="button"
                        aria-label={w.label ?? `Week ${w.week}`}
                        aria-expanded={!collapsed}
                        onClick={() => setWeekCollapsed(w.week, !collapsed)}
                        className="flex min-h-11 items-center gap-2 rounded text-left text-base font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
                      >
                        <span>{w.label ?? `Week ${w.week}`}</span>
                        <svg
                          aria-hidden
                          viewBox="0 0 16 16"
                          className={cn(
                            "h-4 w-4 text-muted transition-transform",
                            collapsed ? "-rotate-90" : "",
                          )}
                          fill="none"
                        >
                          <path
                            d="m4 6 4 4 4-4"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                      {w.isCurrent ? (
                        <Badge tone="accent">This week</Badge>
                      ) : null}
                      {w.isOverdue ? (
                        <Badge tone="accent">Results overdue</Badge>
                      ) : null}
                      {w.wrapHref ? (
                        <Link
                          href={w.wrapHref}
                          prefetch={false}
                          className={textLink("text-xs font-normal")}
                        >
                          Week {w.week} wrap <LinkArrow />
                        </Link>
                      ) : null}
                    </span>
                    {sharedTs != null && w.matches[0].whenFull ? (
                      <LocalTime
                        ts={sharedTs}
                        variant="full"
                        initial={w.matches[0].whenFull}
                        className="block text-xs font-normal text-muted"
                      />
                    ) : !filterTeam && w.nightTs != null && w.nightInitial ? (
                      <LocalTime
                        ts={w.nightTs}
                        variant="date"
                        initial={w.nightInitial}
                        className="block text-xs font-normal text-muted"
                      />
                    ) : null}
                    <span className="sr-only">
                      {total
                        ? `${completed} of ${total} series complete`
                        : "No fixture · bye week"}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs font-normal text-muted">
                    {/* A filtered bye week has nothing to count: "0 of 0"
                        only buried the one word that matters. */}
                    {total ? (
                      <span
                        className={cn(
                          "block font-mono text-sm tabular-nums",
                          completed === total ? "text-success" : "text-fg",
                        )}
                      >
                        {completed}
                        <span className="text-muted"> of {total}</span>
                      </span>
                    ) : null}
                    {/* "Final" is the grand final's word alone — a round
                        header reading "Grand final · 0 / 1 FINAL" said it twice
                        and meant two different things. */}
                    <span className="mt-0.5 block text-xs uppercase tracking-wider">
                      {total ? "Played" : "Bye"}
                    </span>
                  </span>
                </h3>
                {collapsed ? (
                  // A closed week still says who won: one line per series,
                  // each opening its match. Expanding shows the full cards.
                  w.matches.length > 0 || byeRow ? (
                    <div className="border-t border-line-soft">
                      {w.matches.length > 0 ? (
                        <ul
                          aria-label={`${w.label ?? `Week ${w.week}`} results`}
                          // Lines go two and three across with the week's
                          // width, like its cards: six one-line results in
                          // a 1,200px column were mostly empty row.
                          className={cn(
                            "grid grid-cols-1 gap-px bg-line-soft",
                            w.matches.length > 1 && "@2xl:grid-cols-2",
                            w.matches.length > 2 && "@5xl:grid-cols-3",
                          )}
                        >
                          {w.matches.map((m) => (
                            <li key={m.id} className="min-w-0 bg-surface">
                              <ResultLine
                                match={m}
                                mine={isViewerSeries(m, viewerTeamId)}
                                showWhen={sharedTs == null}
                              />
                            </li>
                          ))}
                          <GridFillers count={w.matches.length} as="li" />
                        </ul>
                      ) : null}
                      {byeRow}
                    </div>
                  ) : null
                ) : (
                  <div className="border-t border-line-soft">
                    <div
                      className={cn(
                        "grid grid-cols-1 gap-px bg-line-soft",
                        w.matches.length > 1 && "@2xl:grid-cols-2",
                        w.matches.length > 2 && "@5xl:grid-cols-3",
                      )}
                    >
                      {w.matches.map((m) => (
                        <MatchRow
                          key={m.id}
                          match={m}
                          mine={isViewerSeries(m, viewerTeamId)}
                          showWhen={sharedTs == null}
                        />
                      ))}
                      <GridFillers count={w.matches.length} />
                    </div>
                    {byeRow}
                  </div>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Surface-coloured blanks for a week's last, part-filled row of cards. The
 * grid draws its hairlines as the gap colour between cards (gap-px over
 * bg-line-soft), so an empty cell showed as a grey block beside an odd
 * card. Two across from @2xl, three from @5xl, as in the grid above.
 */
function GridFillers({
  count,
  as: Tag = "div",
}: {
  count: number;
  as?: "div" | "li";
}) {
  const two = count > 1 ? count % 2 : 0;
  const three = count > 2 ? (3 - (count % 3)) % 3 : 0;
  return Array.from({ length: Math.max(two, three) }, (_, i) => (
    <Tag
      key={i}
      aria-hidden
      className={cn(
        "hidden bg-surface",
        i < two && "@2xl:block",
        i < three ? "@5xl:block" : "@5xl:hidden",
      )}
    />
  ));
}

/** URL flag that keeps the regular-season fold open across a match visit. */
const FOLD_PARAM = "results";

/**
 * Finished history during the playoffs (the regular season, a settled
 * tiebreaker): one section that starts closed, so the bracket and the
 * standings stay within reach instead of sitting either side of every
 * finished result. It opens by itself when the URL shows the reader was
 * already inside it (a team picked or a week opened, for the regular season;
 * a return from one of its matches) or points straight at it, as the home
 * page's "Full schedule" links do.
 */
export function ScheduleFold({
  id,
  title,
  description,
  rememberParam = FOLD_PARAM,
  openOnFilter = true,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  /** URL flag that keeps this fold open across a match visit. */
  rememberParam?: string;
  /** Also open when a team filter or opened week is in the URL. */
  openOnFilter?: boolean;
  children: ReactNode;
}) {
  const params = useSearchParams();
  const [initiallyOpen] = useState(
    () =>
      (openOnFilter && (params.has("team") || params.has("weeks"))) ||
      params.get(rememberParam) === "open",
  );
  const fold = useRef<HTMLDetailsElement>(null);
  // The id names this section ("#fixtures", "#tiebreakers"), so arriving at
  // it (or jumping to it later) opens it. Read after mount: the server never
  // sees the hash.
  useEffect(() => {
    const openIfTargeted = () => {
      if (window.location.hash === `#${id}` && fold.current)
        fold.current.open = true;
    };
    openIfTargeted();
    window.addEventListener("hashchange", openIfTargeted);
    return () => window.removeEventListener("hashchange", openIfTargeted);
  }, [id]);
  return (
    <details
      ref={fold}
      id={id}
      open={initiallyOpen}
      onToggle={(event) => {
        const url = new URL(window.location.href);
        if (event.currentTarget.open)
          url.searchParams.set(rememberParam, "open");
        else url.searchParams.delete(rememberParam);
        window.history.replaceState(
          null,
          "",
          url.pathname + url.search + url.hash,
        );
      }}
      className="group scroll-mt-24 rounded-xl border border-line bg-surface/40 open:bg-surface/60"
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-4 py-3 transition-colors hover:bg-surface-2/50 focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-snug">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted">{description}</p>
          ) : null}
        </div>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-5 w-5 shrink-0 text-muted transition-transform group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="border-t border-line-soft p-3 sm:p-4">{children}</div>
    </details>
  );
}

function WeekProgress({
  completed,
  total,
  current,
}: {
  completed: number;
  total: number;
  current: boolean;
}) {
  const circumference = 2 * Math.PI * 16;
  const ratio = total > 0 ? Math.min(1, completed / total) : 0;
  return (
    <span
      className="relative flex h-11 w-11 shrink-0 items-center justify-center"
      aria-hidden
    >
      <svg
        viewBox="0 0 40 40"
        className={cn(
          "absolute inset-0 h-full w-full -rotate-90",
          ratio === 1 ? "text-success" : current ? "text-accent" : "text-info",
        )}
      >
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="text-line"
        />
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
        />
      </svg>
      {ratio === 1 ? (
        <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-success">
          <path
            d="m3.5 8 3 3 6-6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            current ? "bg-accent" : "bg-line",
          )}
        />
      )}
    </span>
  );
}

function isViewerSeries(m: MatchView, viewerTeamId: string | undefined) {
  return (
    !!viewerTeamId &&
    (m.homeTeamId === viewerTeamId || m.awayTeamId === viewerTeamId)
  );
}

/**
 * One series on one line: a closed week at a glance. A finished week shows
 * who won; a week still to come shows who plays whom (and a kickoff of its
 * own, when the week's header can't state one for everybody).
 */
function ResultLine({
  match: m,
  mine,
  showWhen,
}: {
  match: MatchView;
  mine: boolean;
  showWhen: boolean;
}) {
  const scored = m.done || m.live;
  const name = (winner: boolean) =>
    m.done ? (winner ? "font-semibold text-fg" : "text-muted") : "text-fg";
  return (
    <Link
      href={`/matches/${m.id}`}
      prefetch={false}
      className={cn(
        "grid min-h-11 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-3 px-4 py-2 text-sm transition-colors hover:bg-surface-2/60 sm:px-5",
        mine && "bg-accent/[0.05] shadow-[inset_2px_0_0_var(--color-accent)]",
      )}
    >
      <span
        className={cn("text-right [overflow-wrap:anywhere]", name(m.homeWin))}
      >
        {mine ? <span className="sr-only">Your match: </span> : null}
        {m.homeName}
      </span>{" "}
      <span
        className={cn(
          "whitespace-nowrap text-center font-mono tabular-nums",
          m.live ? "text-danger" : m.done ? "text-fg" : "text-muted",
        )}
      >
        {m.live ? <span className="sr-only">live </span> : null}
        {scored ? `${m.homeScore}–${m.awayScore}` : "vs"}
        {m.done && m.forfeit ? (
          <span
            aria-hidden
            title="Forfeit: this score was ruled, not played"
            className="ml-1 font-sans text-xs font-semibold text-muted"
          >
            F
          </span>
        ) : null}
        {!scored && showWhen && m.whenTs != null && m.whenFull ? (
          <LocalTime
            ts={m.whenTs}
            variant="short"
            initial={m.whenShort ?? m.whenFull}
            className="block font-sans text-[11px] text-muted"
          />
        ) : null}
      </span>{" "}
      <span className={cn("[overflow-wrap:anywhere]", name(m.awayWin))}>
        {m.awayName}
        {m.done && m.forfeit ? (
          <span className="sr-only"> (forfeit)</span>
        ) : null}
      </span>
    </Link>
  );
}

function RsvpBadge({ side }: { side: RsvpSide }) {
  const waiting = Math.max(0, side.expected - side.confirmed - side.out);
  const spoken = `${side.confirmed} of ${side.expected} confirmed${side.out > 0 ? `, ${side.out} unavailable` : ""}${waiting > 0 ? `, ${waiting} waiting` : ""}`;
  return (
    <span
      role="img"
      aria-label={spoken}
      title={spoken}
      // Hidden on phones — the row needs the width for team names; the
      // same RSVP detail lives one tap away on the match page.
      className={cn(
        "hidden whitespace-nowrap font-mono text-[11px] tabular-nums sm:inline",
        side.confirmed >= side.expected && side.out === 0
          ? "text-success"
          : side.out > 0
            ? "text-danger"
            : "text-accent",
      )}
    >
      <span aria-hidden>
        ✓{side.confirmed}/{side.expected}
      </span>
      {side.out > 0 ? (
        <span aria-hidden className="text-danger">
          {" "}
          ✗{side.out}
        </span>
      ) : null}
    </span>
  );
}

function MatchRow({
  match: m,
  mine,
  showWhen,
}: {
  match: MatchView;
  /** The reader's own series: marked, and listed first by the caller. */
  mine: boolean;
  /** False when the week's header already states this kickoff. */
  showWhen: boolean;
}) {
  const fullTime = useLocalTimeText(m.whenTs ?? 0, "full", m.whenFull ?? "");
  const status = m.done
    ? m.forfeit
      ? "Forfeit"
      : "Final score"
    : m.live
      ? "Live"
      : m.reportResult
        ? "Result needed"
        : m.awaitingResult
          ? "Awaiting result"
          : m.whenTs != null
            ? "Upcoming"
            : "Time TBD";
  // Live is danger-soft, the token for danger TEXT on a danger tint
  // (globals.css): plain danger at this 12px size sits at the AA line on
  // the live card's tint and under it once the card is hovered.
  const statusColor = m.live
    ? "text-danger-soft"
    : m.done
      ? "text-success"
      : m.awaitingResult || m.whenTs == null
        ? "text-accent"
        : "text-info";
  const sides = [
    {
      id: m.homeTeamId,
      name: m.homeName,
      logoUrl: m.homeLogoUrl,
      score: m.homeScore,
      winner: m.homeWin,
      rsvp: m.rsvp?.home,
      paths: m.playoffPaths?.home,
      settled: m.playoffSettled?.home,
    },
    {
      id: m.awayTeamId,
      name: m.awayName,
      logoUrl: m.awayLogoUrl,
      score: m.awayScore,
      winner: m.awayWin,
      rsvp: m.rsvp?.away,
      paths: m.playoffPaths?.away,
      settled: m.playoffSettled?.away,
    },
  ];
  // An ordinary upcoming fixture needs no status line: "UPCOMING" on every
  // card of every week was the list's default state said thirty times. The
  // label shows for anything a reader should notice (live, final, awaited,
  // no time yet) and always stays in the card's accessible name.
  const showStatus = status !== "Upcoming";
  const showTop =
    showStatus || mine || m.isFinalPhase || !!m.groupLabel || m.forfeit;
  // The kickoff is the card's own only when the week's header can't state
  // one for everybody (a moved series, a single filtered fixture).
  const ownWhen = showWhen && m.whenFull != null && m.whenTs != null;
  const kickoffUnset = !m.done && m.whenTs == null;
  const showFoot =
    ownWhen ||
    kickoffUnset ||
    !!m.reschedulePending ||
    !!m.reportResult ||
    !!m.watch;
  // The whole card opens the match page: its one link stretches an overlay
  // (::after) across the card, so every tap on the card lands there, and
  // screen readers hear one short, match-specific link per card instead of
  // two team links and an anonymous "details" (team pages stay a tap away
  // from the standings and the match page). The link shows as an arrow
  // beside the teams; "Match page" is its spoken name. A control with its
  // own label, like the reschedule chip, sits above the overlay (relative
  // z-10).
  return (
    <article
      aria-label={`${m.homeName} vs ${m.awayName} · ${status}`}
      className={cn(
        "relative flex min-w-0 flex-col bg-surface transition-colors hover:bg-surface-2/60",
        // The live tint is a background IMAGE over bg-surface. As a second
        // background colour, cn (tailwind-merge) dropped bg-surface and the
        // card showed the grid's gap colour through the translucent tint.
        m.live && "bg-linear-to-b from-danger/[0.04] to-danger/[0.04]",
        mine && !m.live && "bg-linear-to-b from-accent/[0.05] to-accent/[0.05]",
        mine && "shadow-[inset_2px_0_0_var(--color-accent)]",
      )}
    >
      {showTop ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-2.5 sm:px-5">
          {mine ? (
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">
              Your match
            </span>
          ) : null}
          {showStatus ? (
            <span
              role={m.live ? "img" : undefined}
              aria-label={
                m.live
                  ? `Live — series at ${m.homeScore}–${m.awayScore}`
                  : undefined
              }
              title={
                m.forfeit
                  ? "Forfeit — this score was ruled, not played"
                  : undefined
              }
              className={cn(
                "inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em]",
                statusColor,
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "h-1.5 w-1.5 rounded-full bg-current",
                  m.live && "animate-pulse motion-reduce:animate-none",
                )}
              />
              {status}
            </span>
          ) : null}
          {m.isFinalPhase ? (
            <Badge tone="accent" className="ml-auto">
              Grand final
            </Badge>
          ) : null}
          {m.groupLabel ? (
            <span className="ml-auto text-xs text-muted">{m.groupLabel}</span>
          ) : null}
          {m.forfeit ? (
            <span
              className={cn("text-xs text-muted", !m.groupLabel && "ml-auto")}
            >
              Ruled result
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center">
        <div className="min-w-0 flex-1 space-y-1 py-2 pl-3 sm:pl-4">
          {sides.map((side) => (
            <div
              key={side.id}
              className={cn(
                "flex min-w-0 items-start gap-2.5 rounded-lg border border-transparent px-1.5 py-1",
                m.done && side.winner && "border-success/10 bg-success/[0.05]",
              )}
            >
              <TeamCrest
                name={side.name}
                seed={side.id}
                logoUrl={side.logoUrl}
                size={28}
                className="rounded-lg"
              />
              <div className="min-w-0 flex-1">
                <span
                  className={cn(
                    "flex min-h-9 min-w-0 items-center py-1 text-sm [overflow-wrap:anywhere]",
                    m.done
                      ? side.winner
                        ? "font-semibold text-fg"
                        : "text-muted"
                      : "font-medium text-fg",
                  )}
                >
                  {side.name}
                </span>
                {side.settled ? (
                  <p
                    className={cn(
                      "pb-2 text-[11px] font-medium leading-relaxed",
                      side.settled.tone === "success"
                        ? "text-success"
                        : side.settled.tone === "accent"
                          ? "text-accent"
                          : "text-muted",
                    )}
                  >
                    {side.settled.text}
                  </p>
                ) : side.paths && side.paths.length > 0 ? (
                  // The outcomes flow as one wrapping line of pairs instead
                  // of a row each: three rows per side made a two-team card
                  // about 350px tall on a phone.
                  <dl className="flex flex-wrap gap-x-3 gap-y-0.5 pb-2 text-[11px] leading-relaxed">
                    {side.paths.map((path) => (
                      <div key={path.key} className="flex min-w-0 gap-1">
                        <dt className="shrink-0 font-medium text-accent">
                          {path.label}
                        </dt>
                        <dd className="min-w-0 text-muted [overflow-wrap:anywhere]">
                          {path.description}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
              {side.rsvp ? <RsvpBadge side={side.rsvp} /> : null}
              {m.done || m.live ? (
                <span
                  className={cn(
                    "ml-1 w-7 shrink-0 text-center font-display text-2xl tabular-nums",
                    m.live
                      ? "text-danger"
                      : m.done && side.winner
                        ? "text-fg"
                        : "text-muted",
                  )}
                >
                  {side.score}
                </span>
              ) : null}
            </div>
          ))}
        </div>
        <Link
          href={`/matches/${m.id}`}
          prefetch={false}
          className="flex w-10 shrink-0 items-center justify-center self-stretch text-sm text-muted focus-visible:outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-info/60"
        >
          <span className="sr-only">
            Match page: {m.homeName} vs {m.awayName}
          </span>
          <span aria-hidden>→</span>
        </Link>
      </div>
      {showFoot ? (
        <div className="flex flex-wrap items-center gap-x-2 border-t border-line-soft px-4 sm:px-5">
          <span
            className="mr-auto flex min-h-9 items-center text-[11px] text-muted"
            title={m.whenTs != null ? fullTime : undefined}
          >
            {ownWhen ? (
              <LocalTime
                ts={m.whenTs!}
                variant="short"
                initial={m.whenShort ?? m.whenFull!}
              />
            ) : kickoffUnset ? (
              <span className="text-accent">Kickoff not set</span>
            ) : null}
          </span>
          {m.reschedulePending ? (
            <RescheduleChip matchId={m.id} pending={m.reschedulePending} />
          ) : null}
          {m.reportResult ? (
            <Link
              href={matchAnchorPath(m.id, MATCH_ANCHOR.report)}
              className="relative z-10 inline-flex min-h-11 shrink-0 items-center rounded px-1 text-xs font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
            >
              Report result
              <span className="sr-only">
                : {m.homeName} vs {m.awayName}
              </span>
              <span aria-hidden>&nbsp;→</span>
            </Link>
          ) : null}
          {m.watch ? (
            // Above the card's stretched link (relative z-10), like Report
            // result.
            <WatchLink
              stream={m.watch.stream}
              watch={m.watch.window}
              variant="row"
              matchLabel={`${m.homeName} vs ${m.awayName}`}
            />
          ) : null}
        </div>
      ) : null}
      {m.standins.length > 0 ? (
        <div className="space-y-1 border-t border-line-soft px-4 py-2 sm:px-5">
          {m.standins.map((line) => (
            <div
              key={line}
              className="text-xs text-muted [overflow-wrap:anywhere]"
            >
              <span className="mr-1.5 text-info" aria-hidden>
                ↔
              </span>
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/**
 * The ⏳ pending-reschedule chip. Its tooltip carries the proposed time, which
 * must read in the viewer's timezone — the hook reformats the epoch client-side
 * (attributes can't hold a <LocalTime> element).
 */
function RescheduleChip({
  matchId,
  pending,
}: {
  matchId: string;
  pending: NonNullable<MatchView["reschedulePending"]>;
}) {
  const when = useLocalTimeText(
    pending.ts ?? 0,
    "full",
    pending.initial ?? "?",
  );
  const label =
    (pending.optionCount ?? 1) > 1
      ? `${pending.by} offered ${pending.optionCount} new times, the earliest ${pending.ts ? when : "soon"}`
      : `${pending.by} proposes ${pending.ts ? when : "a new time"}`;
  return (
    <Link
      href={`/matches/${matchId}`}
      prefetch={false}
      aria-label={`Time change proposed — ${label}. Open the match page to answer the ready check.`}
      title={`Time change proposed — ${label}`}
      className="relative z-10 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-xs text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
    >
      <span aria-hidden>⏳</span>
    </Link>
  );
}
