"use client";

// Interactive single-elimination bracket in the classic tournament shape: two
// wings converge on a center grand final crowned by the trophy. Server pages
// build a serializable BracketRound[] via bracketSkeleton() and pass it down;
// mirrorLayout() splits it into wings, this component draws the connectors
// (TBD slots for rounds that don't exist yet) and lets the viewer select,
// hover, or focus a team to light up its path to the final.

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { TeamCrest } from "@/components/ui";
import { LocalTime } from "@/components/local-time";
import { MATCH_STATUS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  mirrorLayout,
  type BracketMatchView,
  type BracketRound,
  type BracketSide,
} from "@/lib/bracket-view";

type TraceProps = {
  championTeamId: string | null;
  tracedTeam: string | null;
  selectedTeam: string | null;
  onSelect: (teamId: string | null) => void;
  onHover: (teamId: string | null) => void;
  onFocus: (teamId: string | null) => void;
};

export function Bracket({
  rounds,
  championTeamId,
}: {
  rounds: BracketRound[];
  championTeamId: string | null;
}) {
  // Selection persists after a tap/click. Pointer and keyboard previews are
  // tracked separately so leaving one input mode restores the other instead
  // of unexpectedly clearing a deliberate selection.
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [hoveredTeam, setHoveredTeam] = useState<string | null>(null);
  const [focusedTeam, setFocusedTeam] = useState<string | null>(null);
  const tracedTeam = hoveredTeam ?? focusedTeam ?? selectedTeam;
  const cueId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const layout = mirrorLayout(rounds);
  if (!layout) return null;
  const { left, right, final, finalName } = layout;
  // Treat the id as a claim, not proof. Public pages resolve it against the
  // raw bracket first; this client-side boundary repeats the final-series
  // invariant so a stale caller cannot light the trophy or badge a finalist
  // who did not actually win this completed grand final.
  const presentedChampionTeamId =
    championTeamId != null &&
    final?.completed === true &&
    final.winnerTeamId === championTeamId &&
    (final.home?.teamId === championTeamId ||
      final.away?.teamId === championTeamId)
      ? championTeamId
      : null;
  const trace: TraceProps = {
    championTeamId: presentedChampionTeamId,
    tracedTeam,
    selectedTeam,
    onSelect: setSelectedTeam,
    onHover: setHoveredTeam,
    onFocus: (teamId) => {
      setFocusedTeam(teamId);
      // A stationary pointer must not mask the team reached by keyboard tab.
      if (teamId != null) setHoveredTeam(null);
    },
  };

  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label="Playoff bracket"
      aria-describedby={cueId}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const reduceMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        scrollRef.current?.scrollBy({
          left: event.key === "ArrowLeft" ? -240 : 240,
          behavior: reduceMotion ? "auto" : "smooth",
        });
      }}
      className="overflow-x-auto rounded-lg pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    >
      <div className="flex min-w-max items-stretch">
        {left.map((round, c) => (
          <WingColumn
            key={`L${c}`}
            round={round}
            wing="left"
            inner={c === left.length - 1}
            receives={c > 0}
            trace={trace}
          />
        ))}
        <FinalColumn
          final={final}
          finalName={finalName}
          hasWings={left.length > 0}
          trace={trace}
        />
        {[...right].reverse().map((round, idx) => {
          const c = right.length - 1 - idx;
          return (
            <WingColumn
              key={`R${c}`}
              round={round}
              wing="right"
              inner={c === right.length - 1}
              receives={c > 0}
              trace={trace}
            />
          );
        })}
      </div>
      <p id={cueId} className="mt-1 px-4 text-center text-xs text-muted">
        Swipe or scroll sideways to explore every round. Keyboard: focus the
        bracket, then use ← and →. Focus or select a team to trace its run.
      </p>
    </div>
  );
}

/**
 * One wing column. In the left wing feeders flow left→right; in the right
 * wing they flow right→left, so every connector is drawn on the mirrored
 * edge. `inner` columns hold a single slot that lines up with the final's
 * center — a straight stub, no pair vertical.
 */
function WingColumn({
  round,
  wing,
  inner,
  receives,
  trace,
}: {
  round: BracketRound;
  wing: "left" | "right";
  inner: boolean;
  receives: boolean;
  trace: TraceProps;
}) {
  // The edge feeders arrive on / the edge winners leave through.
  const inEdge = wing === "left" ? "left-0" : "right-0";
  const outEdge = wing === "left" ? "right-0" : "left-0";
  const outBorder = wing === "left" ? "border-r" : "border-l";
  return (
    <div className={cn("flex w-48 flex-col sm:w-60", "-ml-px first:ml-0")}>
      <h3
        className={cn(
          "mb-2 h-5 px-4 text-sm font-medium uppercase tracking-wide text-muted",
          wing === "right" && "text-right",
        )}
      >
        {round.name}
      </h3>
      <div className="flex flex-1 flex-col">
        {round.slots.map((m, i) => (
          <div
            key={m?.id ?? `tbd-${wing}-${i}`}
            className="relative flex min-h-[7.5rem] flex-1 items-center px-4 py-2"
          >
            {receives ? (
              <span
                aria-hidden
                className={cn(
                  "absolute top-1/2 w-4 border-t border-line",
                  inEdge,
                )}
              />
            ) : null}
            {m ? (
              <MatchCard match={m} isFinal={false} trace={trace} />
            ) : (
              <TbdCard />
            )}
            <span
              aria-hidden
              className={cn(
                "absolute top-1/2 w-4 border-t border-line",
                outEdge,
              )}
            />
            {!inner ? (
              // Half-height vertical that meets the sibling's half at the pair
              // midpoint — exactly the next match's center.
              <span
                aria-hidden
                className={cn(
                  "absolute border-line",
                  outEdge,
                  outBorder,
                  i % 2 === 0 ? "bottom-0 top-1/2" : "bottom-1/2 top-0",
                )}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The center of the tournament: trophy over the grand final. */
function FinalColumn({
  final,
  finalName,
  hasWings,
  trace,
}: {
  final: BracketMatchView | null;
  finalName: string;
  hasWings: boolean;
  trace: TraceProps;
}) {
  const crowned = trace.championTeamId != null;
  return (
    <div className={cn("flex w-48 flex-col sm:w-60", hasWings && "-ml-px")}>
      <h3 className="mb-2 h-5 px-4 text-center text-sm font-medium uppercase tracking-wide text-muted">
        {finalName}
      </h3>
      <div className="flex flex-1 flex-col">
        {/* Extra headroom so the trophy floats clear of the card even in a
            4-team bracket where every column is only one slot tall. */}
        <div className="relative flex min-h-[13rem] flex-1 items-center px-4 py-2">
          {hasWings ? (
            <>
              <span
                aria-hidden
                className="absolute left-0 top-1/2 w-4 border-t border-line"
              />
              <span
                aria-hidden
                className="absolute right-0 top-1/2 w-4 border-t border-line"
              />
            </>
          ) : null}
          <span
            role="img"
            aria-label={crowned ? "Champion crowned" : "The trophy awaits"}
            title={crowned ? "Champion crowned" : "The trophy awaits"}
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-[calc(50%+3.1rem)] text-center text-4xl transition-all",
              crowned
                ? "drop-shadow-[0_0_14px_rgba(251,191,36,0.45)]"
                : "opacity-40 grayscale",
            )}
          >
            🏆
          </span>
          {final ? (
            <MatchCard match={final} isFinal trace={trace} />
          ) : (
            <TbdCard />
          )}
        </div>
      </div>
    </div>
  );
}

function TbdCard() {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-dashed border-line/80 px-3 py-2">
      <div className="space-y-1 text-sm italic text-muted">
        <div>TBD</div>
        <div>TBD</div>
      </div>
      <div className="pt-1 text-xs text-muted">Winners advance</div>
    </div>
  );
}

function MatchCard({
  match: m,
  isFinal,
  trace,
}: {
  match: BracketMatchView;
  isFinal: boolean;
  trace: TraceProps;
}) {
  const traced =
    trace.tracedTeam != null &&
    (m.home?.teamId === trace.tracedTeam ||
      m.away?.teamId === trace.tracedTeam);
  const live = m.status === MATCH_STATUS.LIVE;
  const homeName = m.home?.name ?? "TBD";
  const awayName = m.away?.name ?? "TBD";
  const matchState = live
    ? `live at ${m.homeScore} to ${m.awayScore}`
    : m.completed
      ? `final at ${m.homeScore} to ${m.awayScore}`
      : m.when
        ? `scheduled for ${m.when}`
        : "details available";
  const matchLinkLabel = `${isFinal ? "Grand final" : "Playoff match"}: ${homeName} versus ${awayName}, ${matchState}, best of ${m.bestOf}. View match details`;
  return (
    <div
      className={cn(
        "min-w-0 flex-1 rounded-lg border bg-surface-2/40 px-2 py-1.5 transition-colors",
        traced ? "border-info/60 bg-info/10" : "border-line",
        isFinal && m.completed && "border-amber-400/50 bg-amber-400/[0.06]",
      )}
    >
      <TeamRow
        side={m.home}
        score={m.homeScore}
        completed={m.completed}
        showScore={m.completed || live}
        won={m.home != null && m.winnerTeamId === m.home.teamId}
        isChampion={
          m.home != null && m.home.teamId === trace.championTeamId && isFinal
        }
        trace={trace}
      />
      <TeamRow
        side={m.away}
        score={m.awayScore}
        completed={m.completed}
        showScore={m.completed || live}
        won={m.away != null && m.winnerTeamId === m.away.teamId}
        isChampion={
          m.away != null && m.away.teamId === trace.championTeamId && isFinal
        }
        trace={trace}
      />
      <Link
        href={`/matches/${m.id}`}
        aria-label={matchLinkLabel}
        className="flex items-center justify-between gap-2 rounded px-1 pt-1 text-xs text-muted hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
      >
        <span className="truncate">
          {live ? (
            <span
              role="status"
              aria-label={`Live series — ${m.homeScore}–${m.awayScore}`}
              className="inline-flex items-center gap-1.5 font-medium text-danger"
            >
              <span aria-hidden className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-danger" />
              </span>
              LIVE
            </span>
          ) : m.completed ? (
            "Box score"
          ) : m.when && m.whenTs != null ? (
            <LocalTime ts={m.whenTs} variant="short" initial={m.when} />
          ) : (
            (m.when ?? "Details")
          )}
        </span>
        <span className="shrink-0">Bo{m.bestOf} →</span>
      </Link>
    </div>
  );
}

function TeamRow({
  side,
  score,
  completed,
  showScore,
  won,
  isChampion,
  trace,
}: {
  side: BracketSide | null;
  score: number;
  completed: boolean;
  showScore: boolean;
  won: boolean;
  isChampion: boolean;
  trace: TraceProps;
}) {
  if (!side) {
    return (
      <div className="flex items-center gap-2 rounded-md px-1 py-1 text-sm italic text-muted">
        <span className="w-4 shrink-0" />
        TBD
      </div>
    );
  }
  const traced = trace.tracedTeam === side.teamId;
  const selected = trace.selectedTeam === side.teamId;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${selected ? "Stop tracing" : "Trace"} ${side.name}${side.seed != null ? `, seed ${side.seed}` : ""}${showScore ? `, score ${score}` : ""}${isChampion ? ", champion" : completed && won ? ", match winner" : ""} through the playoff bracket`}
      title={`Trace ${side.name}'s bracket run`}
      onClick={() => trace.onSelect(selected ? null : side.teamId)}
      onMouseEnter={() => trace.onHover(side.teamId)}
      onMouseLeave={() => trace.onHover(null)}
      onFocus={() => trace.onFocus(side.teamId)}
      onBlur={() => trace.onFocus(null)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60",
        traced && "bg-info/15",
        completed && !won && "text-muted",
      )}
    >
      <span className="w-4 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted">
        {side.seed ?? ""}
      </span>
      <TeamCrest
        name={side.name}
        seed={side.teamId}
        logoUrl={side.logoUrl}
        size={18}
        className="shrink-0 rounded"
      />
      <span className={cn("min-w-0 flex-1 truncate", won && "font-semibold")}>
        {side.name}
      </span>
      {isChampion ? (
        <span aria-label="Champion" role="img" className="shrink-0 text-xs">
          🏆
        </span>
      ) : null}
      {showScore ? (
        <span
          className={cn(
            "shrink-0 font-mono text-xs tabular-nums",
            won && "font-semibold text-fg",
          )}
        >
          {score}
        </span>
      ) : null}
    </button>
  );
}
