import { LocalTime } from "@/components/local-time";
import { formatLeagueMatchTime } from "@/lib/match-time";
import {
  playoffStatusText,
  type TeamPlayoffStatus,
} from "@/lib/playoff-status";
import { cn } from "@/lib/utils";

/**
 * A team's place in the playoffs as one line ("Semifinal vs X · Sep 27,
 * 7:00 PM", "Out in the quarterfinal (lost 1–2 to Y)", "Champion"), shared
 * by the /teams cards and the team page header.
 */
export function PlayoffStatusLine({
  status,
  teamName,
  className,
}: {
  status: TeamPlayoffStatus;
  teamName: Map<string, string>;
  className?: string;
}) {
  const text = playoffStatusText(status, (id) => teamName.get(id) ?? "?");
  const live = status.kind === "playing" && status.when === "live";
  const kickoff =
    status.kind === "playing" && status.when === "upcoming"
      ? status.scheduledAt
      : null;
  return (
    <p
      className={cn(
        "text-xs font-medium leading-snug [overflow-wrap:anywhere]",
        status.kind === "champion"
          ? "text-accent"
          : live
            ? "text-danger"
            : status.kind === "playing" || status.kind === "through"
              ? "text-fg"
              : "text-muted",
        className,
      )}
    >
      {live ? (
        <span
          aria-hidden
          className="mr-1.5 inline-block size-1.5 rounded-full bg-danger align-middle"
        />
      ) : null}
      {text}
      {kickoff ? (
        <>
          {" · "}
          <LocalTime
            ts={kickoff.getTime()}
            variant="short"
            initial={formatLeagueMatchTime(kickoff, "short")}
          />
        </>
      ) : null}
    </p>
  );
}
