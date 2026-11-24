import Link from "@/components/app-link";
import { prisma } from "@/lib/prisma";
import { AUTO_SYNC } from "@/lib/constants";
import {
  AUTO_CHECK_BACKED_OFF_SCANS,
  autoCheckStatus,
} from "@/lib/result-sync";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { loadLeagueFeedWaiting } from "@/lib/league-feed-wait-service";
import { leagueFeedWaitText } from "@/lib/league-feed-wait";
import { AutoCheckLine } from "@/components/admin-match-tools";
import { Badge, Card, CardBody, CardHeader, PlayerLink } from "@/components/ui";
import type { Season } from "@/components/admin/season-admin-data";

/**
 * Auto-sync health: the automation trains everyone to stop pressing import
 * buttons, so its state must be visible — a match parked in exponential
 * backoff (private match data, forfeit) is otherwise indistinguishable from
 * "no games yet". Reads the same window/claim fields the service writes.
 */
export async function AutoSyncHealth({ season }: { season: Season }) {
  if (season.status !== "REGULAR_SEASON" && season.status !== "PLAYOFFS") {
    return null;
  }
  // async SERVER component: it renders once per request, so there is no
  // re-render for Date.now() to be non-idempotent across. The rule is written
  // for client components.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const [inWindow, leagueSyncAt, cursor, setAside, privatePlayers, feedWaiting] =
    await Promise.all([
      prisma.match.findMany({
        where: {
          seasonId: season.id,
          status: { not: "COMPLETED" },
          scheduledAt: {
            gte: new Date(now - AUTO_SYNC.WINDOW_HOURS * 3600_000),
            lte: new Date(now - AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF * 60_000),
          },
        },
        orderBy: { scheduledAt: "asc" },
        include: {
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
        },
      }),
      getSetting(SETTING_KEYS.LEAGUE_AUTO_SYNC_AT),
      getSetting(SETTING_KEYS.RESULT_CHANGED_AT),
      // League-feed games the last classification set aside: no fixture they
      // fit, or an extra game past a decided series. Only syncLeagueGames
      // records these reasons, and every pass reconsiders them. (The old
      // leagueSyncSkip Setting is read-only legacy; nothing writes it.)
      season.dotaLeagueId
        ? prisma.importCandidate.count({
            where: {
              seasonId: season.id,
              status: "IGNORED",
              reason: { startsWith: "NO_ELIGIBLE_FIXTURE" },
            },
          })
        : Promise.resolve(0),
      // WHO the roster scans can't see — OpenDota flagged their match data
      // private. This is the admin's only mid-season surface for it (the
      // signup-pool badge lives on a card that retires after the draft).
      prisma.user.findMany({
        where: {
          fhUnavailable: true,
          registrations: {
            some: { seasonId: season.id, status: "ACTIVE" },
          },
        },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      // Feed games automatic feed imports are waiting on (fail closed).
      season.dotaLeagueId
        ? loadLeagueFeedWaiting(season.id)
        : Promise.resolve([]),
    ]);
  const ts = (iso: string | null) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const cursorTs = ts(cursor);
  const leagueTs = ts(leagueSyncAt);

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Automatic result sync"
        subtitle={
          season.dotaLeagueId
            ? `The league feed checks first about every ${Math.round(AUTO_SYNC.LEAGUE_INTERVAL_SECONDS / 60)} minutes; linked player accounts recover unfinished fixtures that used an old or incorrect ticket.`
            : "What the OpenDota watcher is doing right now — nobody should need the manual buttons unless something here looks stuck."
        }
      />
      <CardBody className="space-y-3">
        {feedWaiting.length > 0 ? (
          <p className="text-sm text-danger">
            {leagueFeedWaitText(feedWaiting)}
          </p>
        ) : null}
        {inWindow.length === 0 ? (
          <p className="text-sm text-muted">
            No matches in their detection window — the sync sleeps until{" "}
            {AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF} minutes after the next
            kickoff.
          </p>
        ) : (
          <ul className="space-y-2">
            {inWindow.map((m) => {
              const check = autoCheckStatus(m, season, now);
              const backedOff =
                m.autoSyncAttempts >= AUTO_CHECK_BACKED_OFF_SCANS;
              return (
                <li
                  key={m.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface-2/40 p-3 text-sm"
                >
                  <Link
                    href={`/matches/${m.id}`}
                    className="min-w-0 flex-1 basis-48 truncate font-medium hover:text-info"
                  >
                    {m.homeTeam.name} vs {m.awayTeam.name}
                  </Link>
                  {m.status === "LIVE" ? (
                    <Badge tone="accent">
                      Game {m.homeScore + m.awayScore} recorded · series{" "}
                      {m.homeScore}–{m.awayScore}
                    </Badge>
                  ) : null}
                  {m.autoSyncedAt ? (
                    <span className="text-xs text-muted">
                      player accounts scanned{" "}
                      <LocalTime
                        ts={m.autoSyncedAt.getTime()}
                        variant="short"
                        initial={formatLeagueMatchTime(m.autoSyncedAt, "short")}
                      />
                      {" · "}
                      {m.autoSyncAttempts} empty scan
                      {m.autoSyncAttempts === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  {check ? (
                    <AutoCheckLine check={check} className="w-full" />
                  ) : null}
                  {backedOff ? (
                    <Badge tone="danger">
                      player recovery backed off — check account links or import
                      the Dota match id
                    </Badge>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {privatePlayers.length > 0 ? (
          <p className="text-xs text-danger">
            {season.dotaLeagueId
              ? "Player-account recovery is limited for these private profiles (league-ticket games are unaffected): "
              : "Private match data (roster scans can't see their games): "}
            {privatePlayers.map((p, i) => (
              <span key={p.id}>
                {i > 0 ? ", " : ""}
                <PlayerLink userId={p.id} className="underline">
                  {p.name}
                </PlayerLink>
              </span>
            ))}
          </p>
        ) : null}
        <p className="text-xs text-muted">
          Last result landed:{" "}
          {cursorTs ? (
            <LocalTime
              ts={cursorTs}
              variant="full"
              initial={formatLeagueMatchTime(new Date(cursorTs), "full")}
            />
          ) : (
            "never"
          )}
          {season.dotaLeagueId ? (
            <>
              {" · League feed last checked: "}
              {leagueTs ? (
                <LocalTime
                  ts={leagueTs}
                  variant="short"
                  initial={formatLeagueMatchTime(new Date(leagueTs), "short")}
                />
              ) : (
                "never"
              )}
              {` · ${setAside} league game${setAside === 1 ? "" : "s"} set aside (no matching fixture, or an extra game)`}
            </>
          ) : null}
        </p>
      </CardBody>
    </Card>
  );
}
