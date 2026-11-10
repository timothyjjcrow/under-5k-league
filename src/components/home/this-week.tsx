import type { Match } from "@prisma/client";
import Link from "@/components/app-link";
import { Fragment } from "react";
import { Countdown } from "@/components/countdown";
import { KickoffCountdown } from "@/components/kickoff-countdown";
import { LocalTime } from "@/components/local-time";
import { PickemTray } from "@/components/pickem-pick-form";
import { PlayoffOutlook, slateStakeLine } from "@/components/playoff-outlook";
import { StreamPlayer } from "@/components/stream-player";
import { WatchLink } from "@/components/watch-link";
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
import { matchWatchWindow, streamEmbed } from "@/lib/broadcast";
import { MATCH_PHASE } from "@/lib/constants";
import { orderSlate, sharedKickoff } from "@/lib/home-slate";
import { pickemControlFor } from "@/lib/pickem";
import { prisma } from "@/lib/prisma";
import { getLeagueStream, type SeasonSnapshot } from "@/lib/queries";
import type { ScenarioReport } from "@/lib/scenarios";
import {
  focusSlate,
  matchRoundLabel,
  playoffTotalRounds,
} from "@/lib/schedule";
import { cn } from "@/lib/utils";
import { fmtWhen } from "./when";

/**
 * The matches everyone cares about right now: this week's slate during the
 * regular season, the open round during playoffs.
 *
 * Two shapes. A slate of ONE (a round down to its last series, the grand
 * final) is a face-off card with the big kickoff clock and the stream. A
 * slate of two or more is a list of compact rows: both sides, each side's
 * check-in count and its stake in one line, and the pick on one line under
 * them, with the viewer's own series first. Six full cards with a stacked
 * pick tray each stood ~1,800px tall on a desktop and pushed the standings to
 * the third screen (the 2026-11 Home audit).
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
  viewerTeamId,
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
  /** The viewer's own team: its series leads the list and is marked. */
  viewerTeamId?: string;
}) {
  // Same helper the "Coming up" card partitions against — see focusSlate.
  const { slate, title } = focusSlate(season.status, matches);
  if (slate.length === 0) return null;
  const focus = orderSlate(slate, viewerTeamId);
  // One kickoff for the whole slate goes in the header, once.
  const kickoff = sharedKickoff(focus);
  const playoffRounds = playoffTotalRounds(matches);
  // The last series standing is the grand final: say so, and give it the
  // gold clock, instead of dressing it like any other round.
  const finalOnly =
    focus.length === 1 && focus[0].phase === MATCH_PHASE.FINAL;

  // The league stream, read only when a playoff or final card could link it.
  const stream = focus.some((m) => matchWatchWindow(m, season.isActive))
    ? await getLeagueStream()
    : null;
  // Its player goes only on a card standing alone (the grand final, a round's
  // last series): one stream can't play under two matches at once.
  const embed = stream && focus.length === 1 ? streamEmbed(stream) : null;

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

  const pickSide = (teamId: string) => ({
    id: teamId,
    name: teamName.get(teamId) ?? "?",
    logoUrl: teamLogoUrl.get(teamId) ?? null,
  });
  const pickFor = (m: Match) =>
    pickemControlFor(m, {
      signedIn: myPicks != null,
      canPlay: pickemPlayable,
      pickedTeamId: myPicks?.get(m.id),
    });
  const scheduleHref =
    season.status === "PLAYOFFS"
      ? "/schedule#playoff-bracket"
      : "/schedule#fixtures";
  const fullSchedule = (
    <Link href={scheduleHref} className={textLink("text-sm")}>
      Full schedule <LinkArrow />
    </Link>
  );

  if (focus.length > 1) {
    return (
      <Card>
        <CardHeader
          headingLevel={2}
          title={title}
          subtitle={
            kickoff ? (
              <>
                <LocalTime
                  ts={kickoff.getTime()}
                  variant="full"
                  initial={fmtWhen(kickoff) ?? ""}
                />
                <Countdown targetMs={kickoff.getTime()} />
              </>
            ) : undefined
          }
          action={fullSchedule}
        />
        {/* auto-fit, not sm:grid-cols-2: a league plays an ODD number of
            matches per week whenever it has a bye, and a fixed two-up left a
            permanently empty cell next to the last fixture. items-start: a
            LIVE row has no pick line. */}
        <CardBody className="p-3 sm:p-4">
          <ul className="grid items-start gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(19rem,100%),1fr))]">
            {focus.map((m) => {
              const pick = pickFor(m);
              const watch = stream ? matchWatchWindow(m, season.isActive) : null;
              const live = m.status === "LIVE";
              const mine =
                !!viewerTeamId &&
                (m.homeTeamId === viewerTeamId || m.awayTeamId === viewerTeamId);
              // The week is in the card's title; a playoff or tiebreaker row
              // names its own round, since a slate can hold two.
              const round =
                m.phase === MATCH_PHASE.REGULAR
                  ? null
                  : matchRoundLabel(m, playoffRounds, { bestOf: true });
              const ownTime = !live && !kickoff;
              return (
                // The row is a wrapper, not the link itself: the pick line
                // holds a <form>, and interactive content inside an <a> is
                // invalid HTML (a tap on a pick would also be a tap on the
                // link).
                <li
                  key={m.id}
                  className={cn(
                    "relative min-w-0 overflow-hidden rounded-xl border text-sm transition-colors has-[>a:hover]:border-info/60",
                    live
                      ? "border-danger/45 bg-surface-2/40"
                      : mine
                        ? "border-accent/50 bg-accent/5"
                        : "border-line bg-surface-2/40",
                  )}
                >
                  <Link
                    href={`/matches/${m.id}`}
                    className="group/match relative block rounded-xl py-2.5 pl-3 pr-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                  >
                    {mine || live || round || ownTime ? (
                      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted">
                        <span className="flex flex-wrap items-center gap-x-2">
                          {mine ? (
                            <span className="font-semibold uppercase tracking-wider text-accent">
                              Your match
                            </span>
                          ) : null}
                          {round ? (
                            <span className="uppercase tracking-wider">
                              {round}
                            </span>
                          ) : null}
                        </span>
                        {live ? (
                          <LiveChip home={m.homeScore} away={m.awayScore} />
                        ) : ownTime ? (
                          m.scheduledAt ? (
                            <span>
                              <LocalTime
                                ts={m.scheduledAt.getTime()}
                                variant="full"
                                initial={fmtWhen(m.scheduledAt) ?? ""}
                              />
                              <Countdown targetMs={m.scheduledAt.getTime()} />
                            </span>
                          ) : (
                            <span>Kickoff time not set</span>
                          )
                        ) : null}
                      </div>
                    ) : null}
                    {[m.homeTeamId, m.awayTeamId].map((teamId) => {
                      const c = checkins(m.id, teamId);
                      const stake = slateStakeLine(
                        report?.teams.get(teamId),
                        m.id,
                      );
                      return (
                        <div
                          key={teamId}
                          className="flex min-w-0 items-center gap-2 py-1"
                        >
                          <TeamCrest
                            name={teamName.get(teamId) ?? "?"}
                            seed={teamId}
                            logoUrl={teamLogoUrl.get(teamId)}
                            size={26}
                            className="shrink-0 rounded-md"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block font-semibold leading-snug [overflow-wrap:anywhere]">
                              {teamName.get(teamId) ?? "?"}
                            </span>
                            {stake ? (
                              <span
                                className={cn(
                                  "block text-xs leading-snug",
                                  stake.tone === "success"
                                    ? "text-success"
                                    : stake.tone === "accent"
                                      ? "text-accent"
                                      : "text-muted",
                                )}
                              >
                                {stake.text}
                              </span>
                            ) : null}
                          </span>
                          {c ? <CheckinCount checkins={c} /> : null}
                          {live ? (
                            <span
                              aria-hidden
                              className="w-7 shrink-0 rounded bg-surface-2 text-center font-display text-base leading-6 tabular-nums text-fg"
                            >
                              {teamId === m.homeTeamId ? m.homeScore : m.awayScore}
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                    <span className="sr-only">Match details and check-in</span>
                    <span
                      aria-hidden
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted group-hover/match:text-info"
                    >
                      →
                    </span>
                  </Link>
                  {/* Outside the row's link, like the pick line: a link
                      can't hold another. */}
                  {stream && watch ? (
                    <WatchLink
                      stream={stream}
                      watch={watch}
                      matchLabel={`${teamName.get(m.homeTeamId) ?? "?"} vs ${teamName.get(m.awayTeamId) ?? "?"}`}
                      wrapperClassName="border-t border-line-soft px-3 py-2"
                    />
                  ) : null}
                  {pick ? (
                    <PickemTray
                      control={pick}
                      matchId={m.id}
                      roundLabel={matchRoundLabel(m, playoffRounds)}
                      home={pickSide(m.homeTeamId)}
                      away={pickSide(m.awayTeamId)}
                      locksAt={m.scheduledAt?.getTime() ?? null}
                      layout="inline"
                      className="border-t border-line-soft px-3 py-2"
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>
    );
  }

  // A slate of one (a playoff round down to its last series, the grand
  // final): a row built for a third of the width stretched across all of it
  // was two short lines and a sea of blank. Alone, the sides face each other,
  // home left and away right, around the big kickoff clock.
  const m = focus[0];
  const pick = pickFor(m);
  const watch = stream ? matchWatchWindow(m, season.isActive) : null;
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title={finalOnly ? "The grand final" : title}
        action={fullSchedule}
      />
      <CardBody className="p-3 sm:p-4">
        <div
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
                <LiveChip home={m.homeScore} away={m.awayScore} />
              ) : m.scheduledAt ? (
                // No countdown chip: the big clock below counts it down.
                <LocalTime
                  ts={m.scheduledAt.getTime()}
                  variant="full"
                  initial={fmtWhen(m.scheduledAt) ?? ""}
                />
              ) : (
                <span>Kickoff time not set</span>
              )}
            </div>
            <div className="my-4 flex-1 space-y-3 sm:grid sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center sm:gap-x-6 sm:space-y-0">
              {[m.homeTeamId, m.awayTeamId].map((teamId, sideIndex) => {
                const c = checkins(m.id, teamId);
                const scenario = report?.teams.get(teamId);
                // The outlook sits UNDER the row, not inside the name's
                // column: in there the ~110px Win/Draw/Loss block made the
                // crest and check-in count centre on the whole block,
                // beside "Win Qualify" instead of the team name.
                const outlook =
                  scenario && scenario.nextMatchId === m.id ? scenario : null;
                // The away side mirrors the home side.
                const mirrored = sideIndex === 1;
                const row = (
                  <div key={teamId} className="min-w-0">
                    <div
                      className={cn(
                        "flex min-w-0 items-center gap-2 sm:gap-3",
                        mirrored && "sm:flex-row-reverse sm:text-right",
                      )}
                    >
                      <TeamCrest
                        name={teamName.get(teamId) ?? "?"}
                        seed={teamId}
                        logoUrl={teamLogoUrl.get(teamId)}
                        size={40}
                        className="shrink-0 rounded-lg"
                      />
                      <p className="min-w-0 flex-1 font-semibold leading-snug [overflow-wrap:anywhere] sm:text-base">
                        {teamName.get(teamId) ?? "?"}
                      </p>
                      {c ? (
                        <span
                          role="img"
                          aria-label={checkinsLabel(c)}
                          className={cn(
                            "shrink-0 text-xs tabular-nums",
                            checkinsTone(c),
                          )}
                          title={checkinsLabel(c)}
                        >
                          <span
                            aria-hidden
                            className={cn(
                              "flex flex-col items-end gap-1",
                              mirrored && "sm:items-start",
                            )}
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
                          // From sm the score sits between the sides.
                          className="ml-1 font-display text-3xl tabular-nums text-fg sm:hidden"
                        >
                          {teamId === m.homeTeamId ? m.homeScore : m.awayScore}
                        </span>
                      ) : null}
                    </div>
                    {outlook ? (
                      // Indented by the crest plus the gap, so it lines
                      // up under the team name (mirrored for the away side).
                      <div
                        className={cn(
                          "mt-1 pl-12 sm:pl-[3.25rem]",
                          mirrored &&
                            "sm:flex sm:justify-end sm:pl-0 sm:pr-[3.25rem]",
                        )}
                      >
                        <PlayoffOutlook scenario={outlook} teamNames={teamName} matchId={m.id} compact />
                      </div>
                    ) : null}
                  </div>
                );
                return sideIndex === 0 ? (
                  <Fragment key={teamId}>
                    {row}
                    <span
                      aria-hidden
                      className="hidden text-center font-display text-2xl tabular-nums text-muted sm:block"
                    >
                      {m.status === "LIVE" ? (
                        <span className="text-fg">
                          {m.homeScore}
                          <span className="mx-1.5 text-muted">–</span>
                          {m.awayScore}
                        </span>
                      ) : (
                        "vs"
                      )}
                    </span>
                  </Fragment>
                ) : (
                  row
                );
              })}
            </div>
            {m.status !== "LIVE" && m.scheduledAt ? (
              <KickoffCountdown
                targetMs={m.scheduledAt.getTime()}
                tone={m.phase === MATCH_PHASE.FINAL ? "final" : "default"}
                nowText={
                  m.phase === MATCH_PHASE.FINAL
                    ? "The grand final is on"
                    : "It's kickoff time"
                }
                className="mb-4"
              />
            ) : null}
            <p className="flex items-center justify-between border-t border-line-soft pt-3 text-xs text-muted group-hover/match:text-info">
              <span>Match details & check-in</span>
              <span aria-hidden>→</span>
            </p>
          </Link>
          {/* Outside the card's link, like the pick tray: a link can't
              hold another. */}
          {stream && watch ? (
            <WatchLink
              stream={stream}
              watch={watch}
              matchLabel={`${teamName.get(m.homeTeamId) ?? "?"} vs ${teamName.get(m.awayTeamId) ?? "?"}`}
              wrapperClassName="border-t border-line-soft px-4 py-3"
            />
          ) : null}
          {stream && watch && embed ? (
            <StreamPlayer
              embed={embed}
              platform={stream.platform}
              watch={watch}
              matchLabel={`${teamName.get(m.homeTeamId) ?? "?"} vs ${teamName.get(m.awayTeamId) ?? "?"}`}
              className="border-t border-line-soft"
            />
          ) : null}
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
      </CardBody>
    </Card>
  );
}

/** "LIVE" with the series score spoken: the e2e and screen readers read it. */
function LiveChip({ home, away }: { home: number; away: number }) {
  return (
    <span
      role="img"
      aria-label={`Live — series at ${home}–${away}`}
      className="inline-flex items-center gap-1.5 rounded-md bg-danger/10 px-1.5 py-0.5 font-mono text-xs tabular-nums text-danger-soft"
    >
      <span aria-hidden className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75 motion-reduce:animate-none" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-danger" />
      </span>
      <span aria-hidden>LIVE</span>
    </span>
  );
}

type SideCheckins = { confirmed: number; size: number; short: number };

const checkinsLabel = (c: SideCheckins) =>
  c.short
    ? `${c.confirmed} of ${c.size} checked in — ${c.short} seat(s) unfilled`
    : `${c.confirmed} of ${c.size} checked in`;

const checkinsTone = (c: SideCheckins) =>
  c.confirmed === c.size
    ? "text-success"
    : c.short
      ? "text-danger"
      : "text-muted";

/** A side's check-ins on a compact row: "3/5 in", named in full when read. */
function CheckinCount({ checkins: c }: { checkins: SideCheckins }) {
  return (
    <span
      role="img"
      aria-label={checkinsLabel(c)}
      title={checkinsLabel(c)}
      className={cn("shrink-0 text-xs tabular-nums", checkinsTone(c))}
    >
      <span aria-hidden>
        {c.confirmed}/{c.size} in
      </span>
    </span>
  );
}
