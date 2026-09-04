"use client";

// The /schedule scoreboards: a team filter, compact completed weeks,
// and visible progress for each round. Fully played past weeks start closed.
// The server page serializes everything (dates preformatted so hydration
// never disagrees on locale); this component only filters and toggles.

import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Badge, TeamCrest } from "@/components/ui";
import { LocalTime, useLocalTimeText } from "@/components/local-time";
import { cn } from "@/lib/utils";

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
  done: boolean;
  /** Ruled/defaulted result — the score was never played; badge it. */
  forfeit: boolean;
  awaitingResult?: boolean;
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
  standins: string[];
  rsvp?: { home: RsvpSide; away: RsvpSide };
  /** Pending reschedule: proposer + epoch so the tooltip renders viewer-local. */
  reschedulePending: {
    by: string;
    ts: number | null;
    /** Server-formatted fallback for the first paint. */
    initial: string | null;
  } | null;
};

export type WeekView = {
  week: number;
  /** Rendered in place of "Week N" (playoff rounds: "Semifinals", "Final"). */
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
};

export function ScheduleWeeks({
  weeks,
  teams,
  initialTeamId,
}: {
  weeks: WeekView[];
  initialTeamId?: string;
  teams: { id: string; name: string; logoUrl?: string | null }[];
}) {
  const params = useSearchParams();
  const requestedTeam = params.get("team");
  const candidate = requestedTeam === null ? initialTeamId : requestedTeam;
  const filterTeam = teams.some((team) => team.id === candidate)
    ? candidate!
    : null;
  const setFilterTeam = (team: string | null) => {
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
  const defaultCollapsed = (w: WeekView) =>
    w.total > 0 &&
    w.completed === w.total &&
    (currentWeek == null || w.week < currentWeek);

  const visibleWeeks = useMemo(() => {
    if (!filterTeam) return weeks;
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
  }, [weeks, filterTeam]);

  return (
    <div className="space-y-6">
      {teams.length > 1 ? (
        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3 sm:px-5">
          <label className="min-w-0 flex-1 basis-56 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted sm:max-w-sm">
            Show matches for
            <select
              value={filterTeam ?? "all"}
              onChange={(event) =>
                setFilterTeam(
                  event.target.value === "all" ? null : event.target.value,
                )
              }
              className="mt-1.5 block min-h-11 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm font-medium normal-case tracking-normal text-fg"
            >
              <option value="all">All teams</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
          {filterTeam ? (
            <button
              type="button"
              onClick={() => setFilterTeam(null)}
              aria-pressed={!filterTeam}
              className="min-h-11 rounded-lg border border-line px-4 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg"
            >
              All teams
            </button>
          ) : null}
          <div
            className="hidden min-h-11 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted sm:ml-auto sm:flex"
            aria-label="Match status legend"
          >
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-1.5 w-1.5 rounded-full bg-success"
                aria-hidden
              />
              Final
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-1.5 w-1.5 rounded-full bg-danger"
                aria-hidden
              />
              Live
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-info" aria-hidden />
              Upcoming
            </span>
          </div>
          {filterTeam ? (
            <p className="w-full text-xs text-muted">
              Team fixtures · League standings below
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-5">
        {visibleWeeks.map((w) => {
          const completed = filterTeam
            ? w.matches.filter((match) => match.done).length
            : w.completed;
          const total = filterTeam ? w.matches.length : w.total;
          // A team filter means the reader is scanning one team's season —
          // collapsing weeks would just hide what they asked for.
          const collapsed = filterTeam
            ? false
            : (collapsedOverride[w.week] ?? defaultCollapsed(w));
          const canToggle = !filterTeam;
          return (
            <div
              key={w.week}
              // Deep-link target ("/schedule#this-week"); scroll-mt clears
              // the sticky site header.
              id={w.isCurrent ? "this-week" : undefined}
              className={cn(
                "overflow-hidden rounded-xl border bg-surface",
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
                    {canToggle ? (
                      <button
                        type="button"
                        aria-label={w.label ?? `Week ${w.week}`}
                        aria-expanded={!collapsed}
                        onClick={() => setWeekCollapsed(w.week, !collapsed)}
                        className="flex min-h-11 items-center gap-2 rounded text-base font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
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
                    ) : (
                      <span className="inline-flex min-h-11 items-center text-base font-semibold text-fg">
                        {w.label ?? `Week ${w.week}`}
                      </span>
                    )}
                    {w.isCurrent ? (
                      <Badge tone="accent">This week</Badge>
                    ) : null}
                    {w.isOverdue ? (
                      <Badge tone="accent">Results overdue</Badge>
                    ) : null}
                  </span>
                  {!filterTeam && w.nightTs != null && w.nightInitial ? (
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
                  <span
                    className={cn(
                      "block font-mono text-sm tabular-nums",
                      completed === total && total > 0
                        ? "text-success"
                        : "text-fg",
                    )}
                  >
                    {completed}
                    <span className="text-muted"> / {total}</span>
                  </span>
                  <span className="mt-0.5 block text-[10px] uppercase tracking-wider">
                    {total ? "Final" : "Bye"}
                  </span>
                </span>
              </h3>
              {collapsed ? null : (
                <div className="border-t border-line-soft">
                  <div
                    className={cn(
                      "grid grid-cols-1 gap-px bg-line-soft",
                      w.matches.length > 1 && "lg:grid-cols-2",
                      w.matches.length > 2 && "xl:grid-cols-3",
                    )}
                  >
                    {w.matches.map((m) => (
                      <MatchRow key={m.id} match={m} />
                    ))}
                  </div>
                  {w.byes.length > 0 &&
                  (!filterTeam || w.byes.some((b) => b.id === filterTeam)) ? (
                    <div className="flex items-center gap-2 border-t border-line-soft px-4 py-3 text-xs text-muted sm:px-5">
                      <span className="rounded bg-surface-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider">
                        Bye
                      </span>
                      <span>
                        {(filterTeam
                          ? w.byes.filter((b) => b.id === filterTeam)
                          : w.byes
                        )
                          .map((b) => b.name)
                          .join(", ")}
                      </span>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
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

function MatchRow({ match: m }: { match: MatchView }) {
  const fullTime = useLocalTimeText(m.whenTs ?? 0, "full", m.whenFull ?? "");
  const status = m.done
    ? m.forfeit
      ? "Forfeit"
      : "Final"
    : m.live
      ? "Live"
      : m.awaitingResult
        ? "Awaiting result"
        : m.whenTs != null
          ? "Upcoming"
          : "Time TBD";
  const statusColor = m.live
    ? "text-danger"
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
    },
    {
      id: m.awayTeamId,
      name: m.awayName,
      logoUrl: m.awayLogoUrl,
      score: m.awayScore,
      winner: m.awayWin,
      rsvp: m.rsvp?.away,
    },
  ];
  return (
    <article
      aria-label={`${m.homeName} vs ${m.awayName} · ${status}`}
      className={cn(
        "flex min-w-0 flex-col bg-surface transition-colors hover:bg-surface-2/60",
        m.live && "bg-danger/[0.04]",
      )}
    >
      <div className="flex min-h-11 flex-wrap items-center gap-2 px-4 pt-2 sm:px-5">
        <span
          role={m.live ? "img" : undefined}
          aria-label={
            m.live
              ? `Live — series at ${m.homeScore}–${m.awayScore}`
              : undefined
          }
          title={
            m.forfeit ? "Forfeit — this score was ruled, not played" : undefined
          }
          className={cn(
            "inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
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
        {m.isFinalPhase ? (
          <Badge tone="accent" className="ml-auto">
            Final
          </Badge>
        ) : null}
        {m.forfeit ? (
          <span className="ml-auto text-[10px] text-muted">Ruled result</span>
        ) : null}
      </div>
      <div className="space-y-1 px-3 pb-3 pt-1 sm:px-4">
        {sides.map((side) => (
          <div
            key={side.id}
            className={cn(
              "flex min-w-0 items-center gap-2.5 rounded-lg border border-transparent px-1.5",
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
            <Link
              href={`/teams/${side.id}`}
              className={cn(
                "flex min-h-11 min-w-0 flex-1 items-center py-2 text-sm [overflow-wrap:anywhere] hover:text-info",
                m.done
                  ? side.winner
                    ? "font-semibold text-fg"
                    : "text-muted"
                  : "font-medium text-fg",
              )}
            >
              {side.name}
            </Link>
            {side.rsvp ? <RsvpBadge side={side.rsvp} /> : null}
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
              {m.done || m.live ? (
                side.score
              ) : (
                <span className="text-base text-line">—</span>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-2 border-t border-line-soft px-4 sm:px-5">
        <span
          className="mr-auto text-[11px] text-muted"
          title={m.whenTs != null ? fullTime : undefined}
        >
          {m.whenFull && m.whenTs != null ? (
            <LocalTime
              ts={m.whenTs}
              variant="short"
              initial={m.whenShort ?? m.whenFull}
            />
          ) : m.done ? (
            "Series complete"
          ) : (
            <span className="text-accent">Kickoff not set</span>
          )}
        </span>
        {m.reschedulePending ? (
          <RescheduleChip matchId={m.id} pending={m.reschedulePending} />
        ) : null}
        <Link
          href={`/matches/${m.id}`}
          className="inline-flex min-h-11 shrink-0 items-center justify-end pl-2 text-xs font-semibold text-info hover:underline"
        >
          details →
        </Link>
      </div>
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
  const label = `${pending.by} proposes ${pending.ts ? when : "a new time"}`;
  return (
    <Link
      href={`/matches/${matchId}`}
      aria-label={`Time change proposed — ${label}. Open the match page to respond.`}
      title={`Time change proposed — ${label}`}
      className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-xs text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
    >
      <span aria-hidden>⏳</span>
    </Link>
  );
}
