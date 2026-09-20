import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { TeamCrest } from "@/components/ui";
import { formatMatchTime } from "@/lib/match-time";
import { cn } from "@/lib/utils";
import { TIEBREAKER_SUMMARY } from "@/lib/tiebreaker-format";
import type {
  TiebreakerBracketMatchView,
  TiebreakerBracketSide,
  TiebreakerBracketTeam,
  TiebreakerBracketView,
} from "./tiebreaker-bracket-view";

const statusLabels = {
  waiting: "Pending",
  scheduled: "Scheduled",
  live: "Live",
  complete: "Final result",
  conditional: "If needed",
  "not-needed": "Not needed",
};

const gameRoutes: Record<number, string> = {
  1: "Winner → Game 2 · Loser → Game 3",
  2: "Winner → Game 4 · Loser → Game 3",
  3: "Winner → Game 4 · Loser finishes 3rd",
  4: "Decides 1st and 2nd, unless Game 5 is needed",
  5: "Winner finishes 1st · Loser finishes 2nd",
};

function BracketSide({ side, score, winner }: {
  side: TiebreakerBracketSide;
  score: number | null;
  winner: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 rounded-md px-2 py-2.5", winner && "bg-success/10")}>
      {side.teamId ? (
        <TeamCrest name={side.name} seed={side.teamId} logoUrl={side.logoUrl} size={28} />
      ) : (
        <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-dashed border-line text-muted">?</span>
      )}
      <div className="min-w-0 flex-1">
        <p className={cn("break-words text-sm leading-snug", side.teamId ? "font-medium text-fg" : "text-muted", winner && "text-success")}>{side.name}</p>
        {side.teamId && side.source ? <p className="mt-0.5 text-[11px] text-muted">{side.source}</p> : null}
      </div>
      {score != null ? <span className={cn("font-mono text-sm font-semibold", winner && "text-success")}>{score}</span> : null}
    </div>
  );
}

function BracketGame({ game, doubleElimination, admin }: { game: TiebreakerBracketMatchView; doubleElimination: boolean; admin: boolean }) {
  return (
    <article
      data-testid="tiebreaker-game"
      data-game={game.number}
      data-status={game.status}
      aria-label={`${game.bestOf === 1 ? "Game" : "Series"} ${game.number}: ${game.title}`}
      className={cn(
        "relative z-10 min-w-0 overflow-hidden rounded-xl border bg-surface shadow-sm",
        game.status === "live" ? "border-danger/60" : game.status === "scheduled" ? "border-accent/60" : "border-line",
        (game.status === "conditional" || game.status === "not-needed") && "border-dashed",
        game.status === "not-needed" && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-1 border-b border-line-soft px-3 py-2.5">
        <h4 className="text-xs font-semibold uppercase tracking-wider">{`${game.bestOf === 1 ? "Game" : "Series"} ${game.number}`}</h4>
        <span className={cn("text-[10px] font-semibold uppercase tracking-wide", game.status === "live" ? "text-danger" : game.status === "scheduled" ? "text-accent" : "text-muted")}>
          {admin && game.status === "waiting" ? "Not created yet" : statusLabels[game.status]}
        </span>
      </div>
      <div className="p-2">
        <p className="px-2 pt-1 text-xs text-muted">{game.title} · BO{game.bestOf}</p>
        <BracketSide side={game.home} score={game.homeScore} winner={game.winnerTeamId != null && game.winnerTeamId === game.home.teamId} />
        <div className="mx-2 border-t border-line-soft" />
        <BracketSide side={game.away} score={game.awayScore} winner={game.winnerTeamId != null && game.winnerTeamId === game.away.teamId} />
      </div>
      <div className="space-y-2 border-t border-line-soft px-3 py-3 text-xs">
        {game.scheduledAt ? (
          <p className="text-fg"><LocalTime ts={game.scheduledAt.getTime()} variant="full" initial={formatMatchTime(game.scheduledAt, "full")} /></p>
        ) : null}
        {game.condition ? <p className="leading-relaxed text-muted">{game.condition}</p> : null}
        {doubleElimination && game.status !== "not-needed" ? <p className="leading-relaxed text-muted">{gameRoutes[game.number]}</p> : null}
        {game.matchId ? admin ? (
          <a className="inline-block py-1 font-medium text-info hover:underline" href={`#admin-tiebreaker-match-${game.matchId}`}>Manage {game.bestOf === 1 ? "game" : "series"} →</a>
        ) : <Link className="inline-block py-1 font-medium text-info hover:underline" href={`/matches/${game.matchId}`}>Match details →</Link> : null}
      </div>
    </article>
  );
}

/** A complete, read-only bracket, including games whose teams are not known yet. */
export function TiebreakerBracket({ bracket, teams, postseasonStarted, admin = false }: {
  bracket: TiebreakerBracketView;
  teams: TiebreakerBracketTeam[];
  postseasonStarted: boolean;
  admin?: boolean;
}) {
  if (bracket.format === "BO1_SINGLE_ELIMINATION") {
    return <SingleEliminationBracket bracket={bracket} teams={teams} admin={admin} />;
  }
  const doubleElimination = bracket.format === "BO1_DOUBLE_ELIMINATION";
  const names = new Map(teams.map((team) => [team.id, team]));
  const spots = bracket.placements.filter((place) => place.qualifies);
  const completed = bracket.matches.filter((game) => game.status === "complete").length;
  const reset = doubleElimination ? bracket.matches[4] : null;
  const total = reset?.status === "conditional" ? "4–5" : reset?.status === "not-needed" ? "4" : String(bracket.matches.length);
  const positions = [
    "xl:col-start-1 xl:row-start-1",
    "xl:col-start-2 xl:row-start-1",
    "xl:col-start-2 xl:row-start-2",
    "xl:col-start-3 xl:row-start-1 xl:row-span-2 xl:self-center",
    "xl:col-start-4 xl:row-start-1 xl:row-span-2 xl:self-center",
  ];

  return (
    <div data-testid="tiebreaker-bracket" data-format={bracket.format} className="min-w-0 overflow-hidden rounded-2xl border border-line bg-surface/40">
      <div className="space-y-4 border-b border-line p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-accent">
              {bracket.week != null ? `Tiebreaker week ${bracket.week}` : "Before playoffs"}
              {bracket.round > 1 ? ` · Round ${bracket.round}` : ""}
            </p>
            <h3 className="font-display text-xl font-semibold">{doubleElimination ? "Three-team tiebreaker" : bracket.teamIds.length === 2 ? "Two-team tiebreaker" : "Round-robin tiebreaker"}</h3>
            <p className="mt-1 text-sm text-muted">{doubleElimination ? "4–5 games · Every game best of 1" : `${bracket.matches.length === 1 ? "One series" : `${bracket.matches.length} series`} · Best of 3`}</p>
          </div>
          <p className="rounded-full border border-line px-3 py-1.5 text-xs tabular-nums text-muted">{completed} of {total} {doubleElimination ? "games" : "series"} complete</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <p className="font-medium">{spots.length === bracket.teamIds.length ? "All teams qualified · Playing for seeds" : spots.length === 1 ? "Winner qualifies for playoffs" : `Top ${spots.length} qualify for playoffs`}</p>
          {bracket.openingAt ? <p className="text-muted">Starts <LocalTime ts={bracket.openingAt.getTime()} variant="full" initial={formatMatchTime(bracket.openingAt, "full")} /> · your local time</p> : <p className="text-muted">Match day to be announced</p>}
        </div>
        <ul data-testid="tiebreaker-teams" aria-label="Teams in this tiebreaker" className="flex flex-wrap gap-2">
          {bracket.teamIds.map((id) => {
            const team = names.get(id);
            const bye = id === bracket.byeTeamId;
            return (
              <li key={id} data-team-id={id} className={cn("flex min-w-0 max-w-full items-center gap-2 rounded-lg border px-3 py-2", bye ? "border-accent/35 bg-accent/5" : "border-line-soft bg-surface")}>
                <TeamCrest name={team?.name ?? "Unknown team"} seed={id} logoUrl={team?.logoUrl} size={26} />
                <div className="min-w-0">
                  <span className="block break-words text-xs font-medium">{team?.name ?? "Unknown team"}</span>
                  {bye ? <span className="block text-[11px] text-accent">Opening bye → Game 2</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="p-4 sm:p-5">
        {doubleElimination ? <p className="mb-5 text-xs leading-relaxed text-muted">Play in game order, all in one tiebreaker week. Two losses end a team’s run. Later match times appear as results are confirmed.</p> : null}
        <div className={cn("relative grid gap-4", doubleElimination ? "xl:grid-cols-4 xl:grid-rows-2 xl:gap-x-8 xl:gap-y-10" : "sm:grid-cols-2 lg:grid-cols-3")}>
          {doubleElimination ? (
            <svg aria-hidden="true" viewBox="0 0 1000 520" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 hidden h-full w-full xl:block" fill="none" strokeWidth="1.5">
              <path d="M110 130 H370 M370 130 H615 V260 H650 M370 390 H615 V260 M650 260 H880" className="stroke-accent/60" vectorEffect="non-scaling-stroke" />
              <path d="M110 130 V390 H370 M370 130 V390" className="stroke-muted/50" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
            </svg>
          ) : null}
          {bracket.matches.map((game, index) => (
            <div key={game.key} className={cn("min-w-0", doubleElimination && positions[index])}>
              <BracketGame game={game} doubleElimination={doubleElimination} admin={admin} />
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3 border-t border-line p-4 sm:p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">Where teams finish</p>
        <ol data-testid="tiebreaker-placements" className="grid gap-2 sm:grid-cols-3">
          {bracket.placements.map((place) => (
            <li key={place.place} data-place={place.place} className="flex items-center gap-3 rounded-lg border border-line-soft bg-surface px-3 py-2.5">
              <span className="font-display text-lg text-muted">{place.place === 1 ? "1st" : place.place === 2 ? "2nd" : place.place === 3 ? "3rd" : `${place.place}th`}</span>
              <div className="min-w-0">
                <p className="break-words text-xs font-medium">{place.name ?? "To be decided"}</p>
                <p className={cn("mt-0.5 text-xs", place.qualifies ? "text-success" : "text-muted")}>{place.qualifies ? `Playoff seed ${place.seed}` : "Out of playoffs"}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="text-xs leading-relaxed text-muted">{bracket.status === "resolved" ? "This tiebreaker is complete. " : ""}{postseasonStarted ? "" : "Playoffs follow in the next league week once all tiebreakers are settled. "}Regular-season points stay the same.</p>
      </div>
    </div>
  );
}

function SingleEliminationBracket({ bracket, teams, admin }: {
  bracket: TiebreakerBracketView; teams: TiebreakerBracketTeam[]; admin: boolean;
}) {
  const names = new Map(teams.map((team) => [team.id, team.name]));
  const plan = bracket.singlePlan;
  const qualifies = (bracket.qualifyingPlaces ?? 0) < bracket.teamIds.length;
  const complete = bracket.matches.filter((game) => game.status === "complete").length;
  return (
    <div data-testid="tiebreaker-bracket" data-format={bracket.format} className="min-w-0 space-y-5 rounded-2xl border border-line bg-surface/40 p-4 sm:p-5">
      <div className="space-y-2">
        <h3 className="font-display text-xl font-semibold">Tiebreaker weekend</h3>
        <p className="text-sm text-accent">{TIEBREAKER_SUMMARY}</p>
        <p className="text-sm font-medium">{qualifies ? `${bracket.qualifyingPlaces} playoff place${bracket.qualifyingPlaces === 1 ? "" : "s"} available` : "All teams qualified · Playing for seeds"}</p>
        {bracket.openingAt ? <p className="text-xs text-muted">Starts <LocalTime ts={bracket.openingAt.getTime()} variant="full" initial={formatMatchTime(bracket.openingAt, "full")} /> · your local time</p> : <p className="text-xs text-muted">Opening time to be announced</p>}
        <p className="text-xs text-muted">Games run in parallel. Your next game starts when both opponents are ready.</p>
      </div>
      {!plan ? <div className="space-y-2 text-sm">
        <p>The draw will appear when an administrator schedules the weekend.</p>
        <p className="text-muted">{bracket.teamIds.map((id) => names.get(id) ?? "Unknown team").join(" · ")}</p>
      </div> : <>
        <p className="text-xs text-muted">{complete} of {bracket.matches.length} games complete</p>
        {plan.brackets.map((tree, index) => <section key={index} aria-label={`Qualifying bracket ${index + 1}`} className="space-y-3">
          <h4 className="text-sm font-semibold">Bracket {index + 1}{qualifies && plan.brackets.length <= plan.places ? " · One playoff place" : ""}</h4>
          {tree.byes.length ? <p data-testid="tiebreaker-byes" className="text-xs text-accent">
            {tree.byes.map((id) => names.get(id)).join(", ")}: {tree.teamIds.length === 1 && qualifies && plan.brackets.length <= plan.places ? "bye into playoffs" : "opening bye"}.
          </p> : null}
          <div className="grid gap-4 lg:grid-cols-3">
            {[...new Set(tree.games.map((g) => g.stage))].map((stage) => <div key={stage} className="flex min-w-0 flex-col gap-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Round {stage}</p>
              <div className="flex flex-1 flex-col justify-around gap-4">{bracket.matches.filter((game) => game.bracket === index && game.stage === stage).map((game) =>
                <BracketGame key={game.key} game={game} doubleElimination={false} admin={admin} />)}
              </div>
            </div>)}
          </div>
        </section>)}
        <details className="rounded-lg border border-line-soft p-3 text-xs text-muted">
          <summary className="cursor-pointer font-medium text-fg">Published draw &amp; final order</summary>
          <p className="mt-3">Bracket winners rank first, followed by teams that reached later rounds. Equal finishes use this draw order. Byes and places across brackets use the same draw; resetting cannot redraw it.</p>
          {qualifies && plan.brackets.length > plan.places ? <p className="mt-2 text-accent">There are more brackets than playoff places. The highest teams in the published draw among the bracket winners qualify. No fourth game is played.</p> : null}
          <ol className="mt-3 list-inside list-decimal space-y-1" data-testid="tiebreaker-draw">{plan.draw.map((id) => <li key={id}>{names.get(id) ?? "Unknown team"}</li>)}</ol>
        </details>
        {bracket.status === "resolved" ? <ol data-testid="tiebreaker-placements" className="grid gap-2 sm:grid-cols-2">
          {bracket.placements.map((place) => <li key={place.place} className="rounded-lg border border-line-soft p-3 text-sm">
            {place.name} <span className="text-xs text-muted">· {place.qualifies ? `Playoff seed ${place.seed}` : "Out of playoffs"}</span>
          </li>)}
        </ol> : null}
      </>}
      <p className="text-xs text-muted">Regular-season points stay the same. Playoffs start after the tiebreakers are complete.</p>
    </div>
  );
}
