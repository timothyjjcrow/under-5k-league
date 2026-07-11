"use client";

// Interactive single-elimination bracket. Server pages build a serializable
// BracketRound[] via bracketSkeleton() and pass it down; this component draws
// the full tree (connector lines, TBD slots for rounds that don't exist yet)
// and lets the viewer tap/hover a team to light up its path to the final.

import { useState } from "react";
import Link from "next/link";
import { TeamCrest } from "@/components/ui";
import { LocalTime } from "@/components/local-time";
import { cn } from "@/lib/utils";
import type {
  BracketMatchView,
  BracketRound,
  BracketSide,
} from "@/lib/bracket-view";

export function Bracket({
  rounds,
  championTeamId,
}: {
  rounds: BracketRound[];
  championTeamId: string | null;
}) {
  // Tap/hover a team anywhere to trace its run through the bracket.
  const [tracedTeam, setTracedTeam] = useState<string | null>(null);
  if (rounds.length === 0) return null;
  const last = rounds.length - 1;

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex min-w-max items-stretch">
        {rounds.map((round, r) => (
          <div
            key={r}
            className={cn("flex w-56 flex-col sm:w-64", r > 0 && "-ml-px")}
          >
            <h3 className="mb-2 h-5 px-4 text-sm font-medium uppercase tracking-wide text-muted">
              {round.name}
            </h3>
            <div className="flex flex-1 flex-col">
              {round.slots.map((m, i) => (
                <div
                  key={m?.id ?? `tbd-${r}-${i}`}
                  className="relative flex min-h-[7rem] flex-1 items-center px-4 py-2"
                >
                  {/* Connector in from the feeder pair (not the first round). */}
                  {r > 0 ? (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1/2 w-4 border-t border-line"
                    />
                  ) : null}
                  {m ? (
                    <MatchCard
                      match={m}
                      isFinal={r === last}
                      championTeamId={championTeamId}
                      tracedTeam={tracedTeam}
                      onTrace={setTracedTeam}
                    />
                  ) : (
                    <TbdCard />
                  )}
                  {/* Connector out toward next round: stub + half-height
                      vertical that meets the sibling's half at the pair
                      midpoint — exactly the next match's center. */}
                  {r < last ? (
                    <>
                      <span
                        aria-hidden
                        className="absolute right-0 top-1/2 w-4 border-t border-line"
                      />
                      <span
                        aria-hidden
                        className={cn(
                          "absolute right-0 border-r border-line",
                          i % 2 === 0 ? "bottom-0 top-1/2" : "bottom-1/2 top-0",
                        )}
                      />
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-1 px-4 text-xs text-muted">
        Tap a team to trace its bracket run.
      </p>
    </div>
  );
}

function TbdCard() {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-dashed border-line/80 px-3 py-2">
      <div className="space-y-1 text-sm italic text-muted/70">
        <div>TBD</div>
        <div>TBD</div>
      </div>
      <div className="pt-1 text-xs text-muted/60">Winners advance</div>
    </div>
  );
}

function MatchCard({
  match: m,
  isFinal,
  championTeamId,
  tracedTeam,
  onTrace,
}: {
  match: BracketMatchView;
  isFinal: boolean;
  championTeamId: string | null;
  tracedTeam: string | null;
  onTrace: (teamId: string | null) => void;
}) {
  const traced =
    tracedTeam != null &&
    (m.home?.teamId === tracedTeam || m.away?.teamId === tracedTeam);
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
        won={m.home != null && m.winnerTeamId === m.home.teamId}
        isChampion={m.home != null && m.home.teamId === championTeamId && isFinal}
        tracedTeam={tracedTeam}
        onTrace={onTrace}
      />
      <TeamRow
        side={m.away}
        score={m.awayScore}
        completed={m.completed}
        won={m.away != null && m.winnerTeamId === m.away.teamId}
        isChampion={m.away != null && m.away.teamId === championTeamId && isFinal}
        tracedTeam={tracedTeam}
        onTrace={onTrace}
      />
      <Link
        href={`/matches/${m.id}`}
        className="flex items-center justify-between gap-2 px-1 pt-1 text-xs text-muted hover:text-info"
      >
        <span className="truncate">
          {m.completed ? (
            "Box score"
          ) : m.when && m.whenTs != null ? (
            <LocalTime ts={m.whenTs} variant="short" initial={m.when} />
          ) : (
            m.when ?? "Details"
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
  won,
  isChampion,
  tracedTeam,
  onTrace,
}: {
  side: BracketSide | null;
  score: number;
  completed: boolean;
  won: boolean;
  isChampion: boolean;
  tracedTeam: string | null;
  onTrace: (teamId: string | null) => void;
}) {
  if (!side) {
    return (
      <div className="flex items-center gap-2 rounded-md px-1 py-1 text-sm italic text-muted/70">
        <span className="w-4 shrink-0" />
        TBD
      </div>
    );
  }
  const traced = tracedTeam === side.teamId;
  return (
    <button
      type="button"
      aria-pressed={traced}
      title={`Trace ${side.name}'s bracket run`}
      onClick={() => onTrace(traced ? null : side.teamId)}
      onMouseEnter={() => onTrace(side.teamId)}
      onMouseLeave={() => onTrace(null)}
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
      {completed ? (
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
