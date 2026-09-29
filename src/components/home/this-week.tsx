import type { Match } from "@prisma/client";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { PickemTray } from "@/components/pickem-pick-form";
import { PlayoffOutlook } from "@/components/playoff-outlook";
import {
  Card,
  CardBody,
  CardHeader,
  LinkArrow,
  TeamCrest,
  textLink,
} from "@/components/ui";
import {
  expectedSideSize,
  matchNightRoster,
  teamAvailability,
} from "@/lib/availability";
import { pickemControlFor } from "@/lib/pickem";
import { prisma } from "@/lib/prisma";
import type { SeasonSnapshot } from "@/lib/queries";
import type { ScenarioReport } from "@/lib/scenarios";
import {
  focusSlate,
  matchRoundLabel,
  playoffTotalRounds,
} from "@/lib/schedule";
import { cn } from "@/lib/utils";
import { fmtWhen } from "./when";

/**
 * The matches everyone cares about right now — this week's slate during the
 * regular season, the open round during playoffs — with per-team check-in
 * counts and a stakes chip when the scenario engine says a game is dramatic.
 */
export async function ThisWeek({
  season,
  matches,
  teams,
  teamName,
  teamLogoUrl,
  report,
  showCheckins,
  myPicks,
  pickemPlayable,
}: {
  season: SeasonSnapshot["season"];
  matches: Match[];
  teams: SeasonSnapshot["teams"];
  teamName: Map<string, string>;
  teamLogoUrl: Map<string, string | null>;
  report: ScenarioReport | null;
  showCheckins: boolean;
  /** The viewer's picks on the slate, from SeasonView's one query; null when
   * signed out, which is what keeps the pick tray off the page for them. */
  myPicks: Map<string, string> | null;
  /** Active season with post-auction side games open (/pickem's canPlay). */
  pickemPlayable: boolean;
}) {
  // Same helper the "Coming up" card partitions against — see focusSlate.
  const { slate: focus, title } = focusSlate(season.status, matches);
  if (focus.length === 0) return null;
  const playoffRounds = playoffTotalRounds(matches);

  const [avail, standinRows] = await Promise.all([
    showCheckins
      ? prisma.matchAvailability.findMany({
          where: { matchId: { in: focus.map((m) => m.id) } },
          select: { matchId: true, userId: true, status: true, scheduleRevision: true },
        })
      : Promise.resolve([]),
    showCheckins
      ? prisma.standinAssignment.findMany({
          where: { matchId: { in: focus.map((m) => m.id) } },
          select: {
            matchId: true,
            teamId: true,
            standinUserId: true,
            replacingUserId: true,
          },
        })
      : Promise.resolve([]),
  ]);
  const rosterOf = new Map(
    teams.map((t) => [t.id, t.members.map((m) => m.userId)]),
  );
  const checkins = (matchId: string, teamId: string) => {
    if (!showCheckins) return null;
    // Standin-aware, same helper as /schedule — a covered player's absence
    // isn't a gap, and the standin's own RSVP is the one that counts.
    const roster = matchNightRoster(
      rosterOf.get(teamId) ?? [],
      standinRows.filter((a) => a.matchId === matchId && a.teamId === teamId),
    );
    if (roster.length === 0) return null;
    const a = teamAvailability(
      roster,
      avail.filter((r) => r.matchId === matchId && r.scheduleRevision === focus.find((m) => m.id === matchId)?.scheduleRevision),
    );
    // Out of the SEASON's side size, not the roster we happen to have — a
    // 4-of-5 team used to render "4/4" in success green.
    return {
      confirmed: a.confirmed,
      size: expectedSideSize(season.teamSize, roster.length),
      short: Math.max(0, season.teamSize - roster.length),
    };
  };

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title={title}
        action={
          <Link href="/schedule#fixtures" className={textLink("text-sm")}>
            Full schedule <LinkArrow />
          </Link>
        }
      />
      {/* auto-fit, not sm:grid-cols-2: a league plays an ODD number of matches
          per week whenever it has a bye, and a fixed two-up left a permanently
          empty cell next to the last fixture. items-start: a LIVE card has no
          pick tray, and stretched to its neighbours' height it was mostly a
          blank block under the score. */}
      <CardBody className="grid items-start gap-3 p-3 [grid-template-columns:repeat(auto-fit,minmax(min(17rem,100%),1fr))] sm:p-4">
        {focus.map((m) => {
          const pick = pickemControlFor(m, {
            signedIn: myPicks != null,
            canPlay: pickemPlayable,
            pickedTeamId: myPicks?.get(m.id),
          });
          const pickSide = (teamId: string) => ({
            id: teamId,
            name: teamName.get(teamId) ?? "?",
            logoUrl: teamLogoUrl.get(teamId) ?? null,
          });
          // The card is a wrapper, not the link itself: the pick tray holds a
          // <form>, and interactive content inside an <a> is invalid HTML (a
          // tap on a pick button would also be a tap on the link). The link
          // keeps everything it held before, so a signed-out viewer, who never
          // gets a tray, sees the card exactly as it was.
          return (
            <div
              key={m.id}
              className={cn(
                "relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-gradient-to-br from-surface-2/70 to-surface text-sm transition-colors has-[>a:hover]:border-info/60",
                m.status === "LIVE" ? "border-danger/45" : "border-line",
              )}
            >
              <Link
                href={`/matches/${m.id}`}
                className="group/match flex min-w-0 flex-1 flex-col rounded-xl p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
              >
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted">
                  <span className="uppercase tracking-wider">
                    {matchRoundLabel(m, playoffRounds, { bestOf: true })}
                  </span>
                  {m.status === "LIVE" ? (
                    <span
                      role="img"
                      aria-label={`Live — series at ${m.homeScore}–${m.awayScore}`}
                      className="inline-flex items-center gap-1.5 rounded-md bg-danger/10 px-1.5 py-0.5 font-mono text-xs tabular-nums text-danger-soft"
                    >
                      <span aria-hidden className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75 motion-reduce:animate-none" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-danger" />
                      </span>
                      <span aria-hidden>LIVE</span>
                    </span>
                  ) : m.scheduledAt ? (
                    <LocalTime
                      ts={m.scheduledAt.getTime()}
                      variant="full"
                      initial={fmtWhen(m.scheduledAt) ?? ""}
                    />
                  ) : (
                    <span>Kickoff time not set</span>
                  )}
                </div>
                <div className="my-4 flex-1 space-y-3">
                  {[m.homeTeamId, m.awayTeamId].map((teamId) => {
                    const c = checkins(m.id, teamId);
                    const scenario = report?.teams.get(teamId);
                    // The outlook sits UNDER the row, not inside the name's
                    // column: in there the ~110px Win/Draw/Loss block made the
                    // crest and check-in count centre on the whole block,
                    // beside "Win Qualify" instead of the team name.
                    const outlook =
                      scenario && scenario.nextMatchId === m.id ? scenario : null;
                    return (
                      <div key={teamId} className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <TeamCrest
                            name={teamName.get(teamId) ?? "?"}
                            seed={teamId}
                            logoUrl={teamLogoUrl.get(teamId)}
                            size={34}
                            className="shrink-0 rounded-lg"
                          />
                          <p className="min-w-0 flex-1 font-semibold leading-snug [overflow-wrap:anywhere]">
                            {teamName.get(teamId) ?? "?"}
                          </p>
                          {c ? (
                            <span
                              role="img"
                              aria-label={
                                c.short
                                  ? `${c.confirmed} of ${c.size} checked in — ${c.short} seat(s) unfilled`
                                  : `${c.confirmed} of ${c.size} checked in`
                              }
                              className={cn(
                                "shrink-0 text-xs tabular-nums",
                                c.confirmed === c.size
                                  ? "text-success"
                                  : c.short
                                    ? "text-danger"
                                    : "text-muted",
                              )}
                              title={
                                c.short
                                  ? `${c.confirmed} of ${c.size} checked in — ${c.short} roster seat(s) unfilled`
                                  : `${c.confirmed} of ${c.size} checked in`
                              }
                            >
                              <span
                                aria-hidden
                                className="flex flex-col items-end gap-1"
                              >
                                <span className="flex gap-0.5">
                                  {Array.from(
                                    { length: Math.min(c.size, 10) },
                                    (_, index) => (
                                      <i
                                        key={index}
                                        className={cn(
                                          "h-1.5 w-1.5 rounded-full",
                                          index < c.confirmed
                                            ? "bg-success"
                                            : "bg-line",
                                        )}
                                      />
                                    ),
                                  )}
                                </span>
                                <span>
                                  {c.confirmed}/{c.size}
                                </span>
                              </span>
                            </span>
                          ) : null}
                          {m.status === "LIVE" ? (
                            <span
                              aria-hidden
                              className="ml-1 font-display text-3xl tabular-nums text-fg"
                            >
                              {teamId === m.homeTeamId ? m.homeScore : m.awayScore}
                            </span>
                          ) : null}
                        </div>
                        {outlook ? (
                          // Indented by the crest (34px) plus the gap, so it
                          // lines up under the team name.
                          <div className="mt-1 pl-[2.625rem]">
                            <PlayoffOutlook scenario={outlook} teamNames={teamName} matchId={m.id} compact />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <p className="flex items-center justify-between border-t border-line-soft pt-3 text-xs text-muted group-hover/match:text-info">
                  <span>Match details & check-in</span>
                  <span aria-hidden>→</span>
                </p>
              </Link>
              {pick ? (
                <PickemTray
                  control={pick}
                  matchId={m.id}
                  roundLabel={matchRoundLabel(m, playoffRounds)}
                  home={pickSide(m.homeTeamId)}
                  away={pickSide(m.awayTeamId)}
                  locksAt={m.scheduledAt?.getTime() ?? null}
                  className="border-t border-line-soft px-4 py-3"
                />
              ) : null}
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}
