import Link from "next/link";
import {
  profileSeasonNote,
  profileSeasonRecord,
  type ProfileSeasonRow,
} from "@/lib/profile-seasons";
import { cn } from "@/lib/utils";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  TAP_SAFE,
  TeamCrest,
} from "./ui";

/** One row per season and team: where they played, how they joined, their
 *  series record there, and any title. */
export function PlayerSeasons({
  rows,
  teamLogos,
}: {
  rows: ProfileSeasonRow[];
  teamLogos: ReadonlyMap<string, string | null>;
}) {
  if (rows.length === 0) return null;
  const seasons = new Set(rows.map((row) => row.seasonId)).size;
  const titles = new Set(
    rows.filter((row) => row.champion).map((row) => row.seasonId),
  ).size;
  return (
    <Card id="player-seasons">
      <CardHeader
        title="Seasons"
        subtitle={`${seasons} season${seasons === 1 ? "" : "s"}${titles > 0 ? ` · ${titles} title${titles === 1 ? "" : "s"} 🏆` : ""}`}
      />
      <CardBody className="p-0">
        <ul className="divide-y divide-line/60">
          {rows.map((row) => {
            const note = profileSeasonNote(row);
            const record = profileSeasonRecord(row);
            return (
              // gap-y-2: the season and team links both carry TAP_SAFE, whose
              // hit boxes grow 4px each way, so wrapped lines need 8px between
              // them or the boxes overlap.
              <li
                key={row.key}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 text-sm"
              >
                <Link
                  href={`/seasons/${row.seasonId}`}
                  className={cn(
                    "w-24 shrink-0 text-muted hover:text-info",
                    TAP_SAFE,
                  )}
                >
                  {row.seasonName}
                </Link>
                {/* basis-40 below sm: its siblings don't shrink, so without a
                    basis this min-w-0 link would take whatever is left and the
                    team name could collapse to nothing on a phone instead of
                    wrapping the details onto the next line. */}
                {row.teamId ? (
                  <Link
                    href={`/teams/${row.teamId}`}
                    className={cn(
                      "flex min-w-0 flex-1 basis-40 items-center gap-2 hover:text-info sm:basis-auto",
                      TAP_SAFE,
                    )}
                  >
                    <TeamCrest
                      name={row.teamName}
                      seed={row.teamId}
                      logoUrl={teamLogos.get(row.teamId)}
                      size={22}
                      className="shrink-0 rounded-md"
                    />
                    <span className="truncate font-medium">{row.teamName}</span>
                    {row.champion ? (
                      <span title="Won the title">
                        <span aria-hidden>🏆</span>
                        <span className="sr-only">(champions)</span>
                      </span>
                    ) : null}
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1 basis-40 truncate font-medium sm:basis-auto">
                    {row.teamName}
                  </span>
                )}
                {row.role?.kind === "captain" ? (
                  <Badge tone="accent">Captain</Badge>
                ) : null}
                {note ? (
                  <span className="text-xs text-muted">{note}</span>
                ) : null}
                {record ? (
                  <span
                    className="shrink-0 font-mono text-xs tabular-nums"
                    title="Completed series and games they played for this team"
                  >
                    {record}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
