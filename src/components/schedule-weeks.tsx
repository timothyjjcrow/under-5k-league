"use client";

// The /schedule regular-season list, made browsable: team filter chips,
// fully-played past weeks collapsed to one line, current week highlighted.
// The server page serializes everything (dates preformatted so hydration
// never disagrees on locale); this component only filters and toggles.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Card, CardBody, TeamCrest } from "@/components/ui";
import { LocalTime, useLocalTimeText } from "@/components/local-time";
import { cn } from "@/lib/utils";

export type RsvpSide = { confirmed: number; out: number };

export type MatchView = {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  done: boolean;
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
}: {
  weeks: WeekView[];
  teams: { id: string; name: string }[];
}) {
  const [filterTeam, setFilterTeam] = useState<string | null>(null);
  // Per-week collapsed overrides on top of the default rule (past weeks with
  // every result in start collapsed).
  const [collapsedOverride, setCollapsedOverride] = useState<
    Record<number, boolean>
  >({});

  const currentWeek = weeks.find((w) => w.isCurrent)?.week;
  const defaultCollapsed = (w: WeekView) =>
    w.total > 0 &&
    w.completed === w.total &&
    (currentWeek == null || w.week < currentWeek);

  const visibleWeeks = useMemo(() => {
    if (!filterTeam) return weeks;
    return weeks
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
      );
  }, [weeks, filterTeam]);

  return (
    <div className="space-y-4">
      {teams.length > 2 ? (
        <div
          className="flex gap-2 overflow-x-auto pb-1"
          role="group"
          aria-label="Filter matches by team"
        >
          <FilterChip
            active={filterTeam === null}
            onClick={() => setFilterTeam(null)}
          >
            All teams
          </FilterChip>
          {teams.map((t) => (
            <FilterChip
              key={t.id}
              active={filterTeam === t.id}
              onClick={() => setFilterTeam(filterTeam === t.id ? null : t.id)}
            >
              <TeamCrest
                name={t.name}
                seed={t.id}
                size={16}
                className="shrink-0 rounded"
              />
              <span className="max-w-[9rem] truncate">{t.name}</span>
            </FilterChip>
          ))}
        </div>
      ) : null}

      <div className="space-y-5">
        {visibleWeeks.map((w) => {
          const incomplete = w.completed < w.total;
          // A team filter means the reader is scanning one team's season —
          // collapsing weeks would just hide what they asked for.
          const collapsed = filterTeam
            ? false
            : collapsedOverride[w.week] ?? defaultCollapsed(w);
          const canToggle = !filterTeam;
          return (
            <div
              key={w.week}
              // Deep-link target ("/schedule#this-week"); scroll-mt clears
              // the sticky site header.
              id={w.isCurrent ? "this-week" : undefined}
              className={w.isCurrent ? "scroll-mt-20" : undefined}
            >
              <h3 className="mb-2 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
                {canToggle ? (
                  <button
                    type="button"
                    aria-expanded={!collapsed}
                    onClick={() =>
                      setCollapsedOverride((prev) => ({
                        ...prev,
                        [w.week]: !collapsed,
                      }))
                    }
                    className="flex items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "text-[10px] transition-transform",
                        collapsed ? "" : "rotate-90",
                      )}
                    >
                      ▶
                    </span>
                    <span className={w.isCurrent ? "text-fg" : undefined}>
                      {w.label ?? `Week ${w.week}`}
                    </span>
                  </button>
                ) : (
                  <span className={w.isCurrent ? "text-fg" : undefined}>
                    {w.label ?? `Week ${w.week}`}
                  </span>
                )}
                {w.nightTs != null && w.nightInitial ? (
                  <LocalTime
                    ts={w.nightTs}
                    variant="date"
                    initial={w.nightInitial}
                    className="normal-case tracking-normal text-muted"
                  />
                ) : null}
                {w.isCurrent ? <Badge tone="accent">This week</Badge> : null}
                <span className={incomplete ? "text-accent" : "text-success"}>
                  {w.completed}/{w.total} results in
                </span>
              </h3>
              {collapsed ? null : (
                <Card className={w.isCurrent ? "border-accent/40" : undefined}>
                  <CardBody className="divide-y divide-line/60 p-0">
                    {w.matches.map((m) => (
                      <MatchRow key={m.id} match={m} />
                    ))}
                    {w.byes.length > 0 &&
                    (!filterTeam ||
                      w.byes.some((b) => b.id === filterTeam)) ? (
                      <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted sm:px-5">
                        <span aria-hidden>😴</span>
                        <span>
                          On bye:{" "}
                          {(filterTeam
                            ? w.byes.filter((b) => b.id === filterTeam)
                            : w.byes
                          )
                            .map((b) => b.name)
                            .join(", ")}
                        </span>
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60",
        active
          ? "border-info/60 bg-info/15 text-fg"
          : "border-line text-muted hover:border-muted/60 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function RsvpBadge({ side }: { side: RsvpSide }) {
  if (side.confirmed === 0 && side.out === 0) return null;
  const spoken = `${side.confirmed} confirmed${side.out > 0 ? `, ${side.out} unavailable` : ""}`;
  return (
    <span
      role="img"
      aria-label={spoken}
      title={spoken}
      // Hidden on phones — the row needs the width for team names; the
      // same RSVP detail lives one tap away on the match page.
      className="hidden whitespace-nowrap font-mono text-[11px] tabular-nums text-muted sm:inline"
    >
      <span aria-hidden className="text-success">
        ✓{side.confirmed}
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
  return (
    <div className="transition-colors hover:bg-surface-2/30">
      <div className="flex items-center gap-2 px-4 py-2.5 sm:gap-3 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 text-sm">
          {m.rsvp ? <RsvpBadge side={m.rsvp.home} /> : null}
          <Link
            href={`/teams/${m.homeTeamId}`}
            className={cn(
              "truncate hover:text-info",
              m.done && (m.homeWin ? "font-semibold text-fg" : "text-muted"),
            )}
          >
            {m.homeName}
          </Link>
          <TeamCrest
            name={m.homeName}
            seed={m.homeTeamId}
            size={24}
            className="rounded-lg"
          />
        </div>
        <div className="shrink-0 text-center">
          {m.done ? (
            <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-sm tabular-nums">
              <span
                className={m.homeWin ? "font-semibold text-fg" : "text-muted"}
              >
                {m.homeScore}
              </span>
              <span className="px-1 text-muted">–</span>
              <span
                className={m.awayWin ? "font-semibold text-fg" : "text-muted"}
              >
                {m.awayScore}
              </span>
            </span>
          ) : m.whenFull && m.whenTs != null ? (
            <span className="whitespace-nowrap text-xs text-muted">
              <LocalTime
                ts={m.whenTs}
                variant="full"
                initial={m.whenFull}
                className="hidden sm:inline"
              />
              <LocalTime
                ts={m.whenTs}
                variant="short"
                initial={m.whenShort ?? m.whenFull}
                className="sm:hidden"
              />
            </span>
          ) : (
            <span className="text-xs text-muted">vs</span>
          )}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <TeamCrest
            name={m.awayName}
            seed={m.awayTeamId}
            size={24}
            className="rounded-lg"
          />
          <Link
            href={`/teams/${m.awayTeamId}`}
            className={cn(
              "truncate hover:text-info",
              m.done && (m.awayWin ? "font-semibold text-fg" : "text-muted"),
            )}
          >
            {m.awayName}
          </Link>
          {m.rsvp ? <RsvpBadge side={m.rsvp.away} /> : null}
        </div>
        {m.reschedulePending ? (
          <RescheduleChip matchId={m.id} pending={m.reschedulePending} />
        ) : null}
        {m.isFinalPhase ? (
          <Badge tone="accent" className="shrink-0">
            Final
          </Badge>
        ) : null}
        <Link
          href={`/matches/${m.id}`}
          className="shrink-0 text-xs text-muted hover:text-info"
        >
          details →
        </Link>
      </div>
      {m.standins.length > 0 ? (
        <div className="space-y-0.5 border-t border-line/40 px-5 py-2">
          {m.standins.map((line) => (
            <div key={line} className="text-xs text-muted">
              🔁 {line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
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
      className="shrink-0 rounded text-xs text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
    >
      <span aria-hidden>⏳</span>
    </Link>
  );
}
