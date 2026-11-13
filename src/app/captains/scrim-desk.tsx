import Link from "@/components/app-link";
import { LocalTime } from "@/components/local-time";
import {
  ScrimCancelButton,
  ScrimJoinButton,
  ScrimPostForm,
} from "@/components/scrims/scrim-controls";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LinkArrow,
  textLink,
} from "@/components/ui";
import type { SessionUser } from "@/lib/auth";
import { CAPTAINS_ANCHOR, captainsHref } from "@/lib/captains";
import { SCRIM_STATUS } from "@/lib/constants";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { prisma } from "@/lib/prisma";
import { scrimJoinCheck, scrimNotPlayedCutoff } from "@/lib/scrim-view";
import { cn } from "@/lib/utils";
import { ScrimManager } from "./scrim-manager";

function When({ date }: { date: Date }) {
  return (
    <LocalTime
      ts={date.getTime()}
      variant="short"
      initial={formatLeagueMatchTime(date, "short")}
    />
  );
}

/**
 * The captain's scrims, with the scrim pages' own controls: post a time,
 * cancel one of the team's scrims, claim another team's open time, and for a
 * booked scrim everything its own page offers a captain (`<ScrimManager>`:
 * lobby setup, guests, results, ending the series). One booked scrim is open
 * at a time (`?scrim=`; the next one by default). The lists follow /scrims (a
 * booking still without games 36h after kickoff has gone to its history as
 * "Not played"), Join follows `scrimJoinCheck` and Cancel the scrim page's
 * rule (either captain, not once it is live); the scrim actions re-check all
 * of it.
 */
export async function ScrimDesk({
  seasonId,
  team,
  viewer,
  seasonOpen,
  leagueId,
  nowMs,
  matchId,
  requestedScrimId,
}: {
  seasonId: string;
  team: { id: string; name: string; withdrawn: boolean };
  viewer: SessionUser;
  /** The active season isn't complete (scrims post and claim). */
  seasonOpen: boolean;
  /** The season's Valve league ticket (`Season.dotaLeagueId`), if any. */
  leagueId: string | null;
  nowMs: number;
  /** The fixture open above, kept in this card's links. */
  matchId: string | null;
  /** `?scrim=`: the booked scrim to manage; the next one when it isn't one. */
  requestedScrimId: string | null;
}) {
  const hasLeagueTicket = !!leagueId;
  const now = new Date(nowMs);
  const upcoming = {
    OR: [
      { status: SCRIM_STATUS.LIVE },
      {
        status: SCRIM_STATUS.SCHEDULED,
        scheduledAt: { gte: scrimNotPlayedCutoff(nowMs) },
      },
      { status: SCRIM_STATUS.OPEN, scheduledAt: { gte: now } },
    ],
  };
  const [mine, others] = await Promise.all([
    prisma.scrim.findMany({
      where: {
        seasonId,
        AND: [
          upcoming,
          { OR: [{ hostTeamId: team.id }, { opponentTeamId: team.id }] },
        ],
      },
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        status: true,
        bestOf: true,
        scheduledAt: true,
        hostTeamId: true,
        hostScore: true,
        awayScore: true,
        hostTeam: { select: { name: true } },
        opponentTeam: { select: { name: true } },
      },
    }),
    prisma.scrim.findMany({
      where: {
        seasonId,
        status: SCRIM_STATUS.OPEN,
        scheduledAt: { gte: now },
        hostTeamId: { not: team.id },
      },
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
      take: 8,
      select: {
        id: true,
        status: true,
        bestOf: true,
        scheduledAt: true,
        hostTeamId: true,
        hostTeam: { select: { name: true, withdrawn: true } },
      },
    }),
  ]);
  // The scrims with something to manage: claimed, not yet final.
  const booked = mine.filter((s) => s.status !== SCRIM_STATUS.OPEN);
  const managed =
    booked.find((s) => s.id === requestedScrimId) ?? booked[0] ?? null;
  return (
    <div id={CAPTAINS_ANCHOR.scrims} className="scroll-mt-24 space-y-4">
      <Card>
        <CardHeader
          headingLevel={2}
          title="Scrims"
          subtitle="Practice outside the league table: post a time, or claim another team's."
          action={
            <Link href="/scrims" className={textLink("text-sm")}>
              All scrims <LinkArrow />
            </Link>
          }
        />
        <CardBody className="space-y-5">
          {seasonOpen && !team.withdrawn ? <ScrimPostForm /> : null}
          <div className="grid grid-cols-1 items-start gap-x-8 gap-y-5 lg:grid-cols-2">
            <div className="min-w-0">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                Your scrims
              </h3>
              {mine.length === 0 ? (
                <EmptyState
                  inline
                  title="Nothing booked"
                  description="Post a time above, or claim one below."
                />
              ) : (
                <ul aria-label="Your scrims" className="divide-y divide-line-soft text-sm">
                  {mine.map((s) => {
                    const other =
                      s.hostTeamId === team.id
                        ? (s.opponentTeam?.name ?? null)
                        : s.hostTeam.name;
                    const canCancel = seasonOpen && s.status !== SCRIM_STATUS.LIVE;
                    const booked = s.status !== SCRIM_STATUS.OPEN;
                    const open = managed?.id === s.id;
                    return (
                      <li
                        key={s.id}
                        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2"
                      >
                        <span className="min-w-0 flex-1 basis-48">
                          <Link
                            href={`/scrims/${s.id}`}
                            className={textLink("font-medium [overflow-wrap:anywhere]")}
                          >
                            {other ? `vs ${other}` : "Your open time"}
                          </Link>
                          <span className="block text-xs text-muted">
                            <When date={s.scheduledAt} /> · Best of {s.bestOf}
                            {other
                              ? s.hostTeamId === team.id
                                ? " · you host"
                                : ` · ${s.hostTeam.name} hosts`
                              : ""}
                          </span>
                        </span>
                        {s.status === SCRIM_STATUS.LIVE ? (
                          <Badge tone="accent">
                            Live · {s.hostScore}–{s.awayScore}
                          </Badge>
                        ) : s.status === SCRIM_STATUS.OPEN ? (
                          <Badge>Waiting for a team</Badge>
                        ) : (
                          <Badge tone="info">Booked</Badge>
                        )}
                        {booked ? (
                          // Its lobby, guests and results open on this page.
                          <Link
                            href={captainsHref(
                              { match: matchId, scrim: s.id },
                              CAPTAINS_ANCHOR.scrimDesk,
                            )}
                            aria-current={open ? "true" : undefined}
                            className={cn(
                              textLink("text-sm"),
                              open && "font-semibold",
                            )}
                          >
                            {open ? "Open below" : "Manage"}{" "}
                            <span aria-hidden>{open ? "↓" : "→"}</span>
                          </Link>
                        ) : null}
                        {canCancel ? (
                          <ScrimCancelButton scrimId={s.id} booked={booked} />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {mine.some((s) => s.status !== SCRIM_STATUS.OPEN) ? (
                <p className="mt-2 text-xs text-muted">
                  {hasLeagueTicket
                    ? "Host with this season's league ticket set in the lobby, or the games won't record. Lobby setup below has the ticket, name and password."
                    : "This season has no league ticket yet, so scrim games won't record. Lobby setup below has the lobby's name and password."}
                </p>
              ) : null}
            </div>
            <div className="min-w-0">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                Open times from other teams
              </h3>
              {others.length === 0 ? (
                <p className="text-sm text-muted">No other team has a time open.</p>
              ) : (
                <ul
                  aria-label="Open times from other teams"
                  className="divide-y divide-line-soft text-sm"
                >
                  {others.map((s) => {
                    const canJoin =
                      scrimJoinCheck({
                        status: s.status,
                        seasonOpen,
                        signedIn: true,
                        viewerTeam: team,
                        hostTeamId: s.hostTeamId,
                        hostWithdrawn: s.hostTeam.withdrawn,
                        scheduledAtMs: s.scheduledAt.getTime(),
                        nowMs,
                      })?.canJoin === true;
                    return (
                      <li
                        key={s.id}
                        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2"
                      >
                        <span className="min-w-0 flex-1 basis-48">
                          <Link
                            href={`/scrims/${s.id}`}
                            className={textLink("font-medium [overflow-wrap:anywhere]")}
                          >
                            {s.hostTeam.name}
                          </Link>
                          <span className="block text-xs text-muted">
                            <When date={s.scheduledAt} /> · Best of {s.bestOf}
                          </span>
                        </span>
                        {canJoin ? <ScrimJoinButton scrimId={s.id} /> : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </CardBody>
      </Card>
      {managed ? (
        <ScrimManager
          scrimId={managed.id}
          teamId={team.id}
          viewer={viewer}
          seasonOpen={seasonOpen}
          leagueId={leagueId}
          nowMs={nowMs}
        />
      ) : null}
    </div>
  );
}
