import Link from "next/link";
import type { AppearanceCareer } from "@/lib/appearance-careers";
import type { RosterHistoryRow } from "@/lib/player-roster-history";
import { Card, CardHeader, CardBody, textLink } from "./ui";

type TeamLabel = { id: string; name: string; seasonId: string; seasonName: string };
function HistoryDate({ date }: { date: Date }) {
  return <time dateTime={date.toISOString()} title={date.toISOString()}>{new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date)}</time>;
}

export function PlayerTeamHistory({ appearances, teams, tenures }: {
  appearances: AppearanceCareer[]; teams: TeamLabel[]; tenures: RosterHistoryRow[];
}) {
  const teamOf = new Map(teams.map((team) => [team.id, team]));
  return <div className="space-y-4">
    {appearances.length > 0 ? <Card>
      <CardHeader title="Seasons played" subtitle="Actual recorded games, including substitutes and former teams. Series are counted once when this player appeared." />
      <CardBody className="divide-y divide-line/60 p-0">
        {appearances.map((row) => {
          const team = teamOf.get(row.teamId);
          return <div key={row.teamId} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <Link className={textLink("py-1")} href={`/seasons/${row.seasonId}`}>{team?.seasonName ?? "Season"}</Link>
            <Link className={textLink("min-w-0 flex-1 py-1")} href={`/teams/${row.teamId}`}>{team?.name ?? "Former team"}</Link>
            <span>{row.games} games · {row.wins} map wins</span>
            <span title="Completed series in which this player appeared">{row.seriesWins}–{row.seriesLosses}–{row.seriesDraws} series</span>
            {row.championshipContribution ? <span className="text-accent" title="Recorded an appearance for the champion during this season">🏆 Championship contribution</span> : null}
          </div>;
        })}
      </CardBody>
    </Card> : null}
    {tenures.length > 0 ? <Card>
      <CardHeader title="Roster history" subtitle="Membership dates (UTC) and acquisition facts are separate from games played. Missing older records are not reconstructed." />
      <CardBody className="divide-y divide-line/60 p-0">
        {tenures.map((row) => <div key={row.id} className="space-y-1 px-5 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link href={`/seasons/${row.seasonId}`} className={textLink("py-1")}>{row.seasonName}</Link>
            {row.teamId ? <Link href={`/teams/${row.teamId}`} className={textLink("py-1 font-semibold")}>{row.teamName}</Link> : <strong>{row.teamName}</strong>}
            <span className="text-muted"><HistoryDate date={row.joinedAt} /> → {row.endedAt ? <HistoryDate date={row.endedAt} /> : row.active ? "Current membership" : "End date not recorded"}</span>
          </div>
          <p className="text-xs text-muted">
            {row.acquisitionKind === "AUCTION" ? `Original auction purchase: $${row.price}` :
              row.acquisitionKind === "FREE_AGENT" ? "Free-agent signing" :
              row.acquisitionKind === "CAPTAIN_DESIGNATION" ? "Designated captain at joining" :
              `${row.recorded ? "Price observed at historical capture" : "Current roster price"}: $${row.price}; earlier acquisition details unknown`}
            {row.mmr != null ? ` · ${row.mmr} MMR at joining` : ""}
            {row.provenance === "LEGACY_ROW" ? " · Start from the surviving membership record" : ""}
          </p>
        </div>)}
      </CardBody>
    </Card> : null}
  </div>;
}
