import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { Badge, TeamCrest } from "@/components/ui";
import { formatMatchTime } from "@/lib/match-time";
import { profileMatchState } from "@/lib/profile-match";
import { matchPhaseLabel, type SlateMatch } from "@/lib/schedule";
import { cn } from "@/lib/utils";

type SpotlightMatch = SlateMatch & {
  homeScore: number;
  awayScore: number;
  homeTeamId: string;
  awayTeamId: string;
  forfeit: boolean;
};

/** A compact, navigable scoreboard shared by team and player overviews. */
export function ProfileMatchSpotlight({
  match,
  teams,
  nowMs,
  teamContext = false,
}: {
  match: SpotlightMatch;
  teams: { id: string; name: string; logoUrl: string | null }[];
  nowMs: number;
  teamContext?: boolean;
}) {
  const state = profileMatchState(match, nowMs);
  const live = match.status === "LIVE";
  const done = match.status === "COMPLETED";
  const scored = live || done;
  const home = teams.find((team) => team.id === match.homeTeamId);
  const away = teams.find((team) => team.id === match.awayTeamId);
  if (!home || !away) return null;

  return (
    <Link
      href={`/matches/${match.id}`}
      className={cn(
        "group block min-w-0 overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-br from-surface-2 to-surface p-4 transition-colors hover:border-info/60 sm:p-5",
        live && "border-danger/50 from-danger/10",
      )}
      aria-label={`${teamContext ? "Team · " : ""}${state}: ${home.name} vs ${away.name}. Open match`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={cn(
            "text-xs font-semibold uppercase tracking-wider",
            live ? "text-danger" : "text-muted",
          )}
        >
          {live ? (
            <span
              aria-hidden
              className="mr-1.5 inline-block size-1.5 rounded-full bg-danger"
            />
          ) : null}
          {teamContext ? "Team · " : ""}
          {state}
        </span>
        <span className="text-xs text-muted">
          {matchPhaseLabel(match.phase, match.week)}
        </span>
      </div>
      <div className="my-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 sm:gap-6">
        {[home, away].map((team, index) => (
          <div
            key={team.id}
            className={cn(
              "flex min-w-0 flex-col items-center gap-2 self-stretch text-center",
              index === 0
                ? "col-start-1 row-start-1"
                : "col-start-3 row-start-1",
            )}
          >
            <TeamCrest
              name={team.name}
              seed={team.id}
              logoUrl={team.logoUrl}
              size={44}
              imageFit="cover"
              className="rounded-xl"
            />
            <span className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">
              {team.name}
            </span>
          </div>
        ))}
        <span
          className={cn(
            "col-start-2 row-start-1 whitespace-nowrap font-display text-3xl font-bold tabular-nums sm:text-4xl",
            !scored && "text-base text-muted sm:text-lg",
          )}
        >
          {scored ? `${match.homeScore} – ${match.awayScore}` : "VS"}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/70 pt-3 text-xs">
        <span className="flex flex-wrap items-center gap-2 text-muted">
          {done && match.forfeit ? <Badge tone="neutral">Forfeit</Badge> : null}
          {match.scheduledAt ? (
            <LocalTime
              ts={match.scheduledAt.getTime()}
              variant="short"
              initial={formatMatchTime(match.scheduledAt, "short")}
            />
          ) : (
            <span>{done ? "Time not recorded" : "Time TBD"}</span>
          )}
        </span>
        <span className="font-medium text-info group-hover:underline">
          Open match →
        </span>
      </div>
    </Link>
  );
}
