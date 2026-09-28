import { LEAGUE_CONFIG } from "@/lib/league-config";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  loadSeasonChoices,
  resolveSeasonScope,
  seasonScopeMetadata,
} from "@/lib/season-scope";
import { NoSeasonYet, SeasonSwitcher } from "@/components/season-scope";
import { getSessionUser } from "@/lib/auth";
import {
  calledItCount,
  groupOpenByWeek,
  partitionPickemMatches,
  PICKEM_RANKING_NOTE,
  pickemStandings,
  pickHistory,
  type PickResult,
  pickSplit,
} from "@/lib/pickem";
import { LocalTime } from "@/components/local-time";
import { Countdown } from "@/components/countdown";
import { formatMatchTime } from "@/lib/match-time";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  PlayerLink,
  SectionTitle,
  textLink,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { postAuctionWorkOpen } from "@/lib/league-lifecycle";
import { PickemPickForm } from "@/components/pickem-pick-form";
import { PickemDeadlineRefresh } from "@/components/pickem-deadline-refresh";
import { singleSearchParam } from "@/lib/search-params";
import {
  matchRoundLabel,
  playoffTotalRounds,
  roundGroupLabel,
} from "@/lib/schedule";

type PickemSearchParams = { season?: string | string[] };

/** The mark on each row of "Your picks". */
const PICK_MARK: Record<
  PickResult | "locked",
  { glyph: string; label: string; className: string }
> = {
  right: { glyph: "✓", label: "Correct pick", className: "text-success" },
  wrong: { glyph: "✗", label: "Wrong pick", className: "text-danger-soft" },
  locked: {
    glyph: "🔒",
    label: "Locked, waiting for the result",
    className: "",
  },
  void: { glyph: "➖", label: "Void pick", className: "text-muted" },
};

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<PickemSearchParams>;
}): Promise<Metadata> {
  return seasonScopeMetadata((await searchParams).season, {
    path: "/pickem",
    title: "Pick'em",
    description: `Call every ${LEAGUE_CONFIG.name} match before kickoff and climb the season's oracle board.`,
    archived: (name) => ({
      title: `${name} Pick'em`,
      description: `Final predictions and oracle standings from ${name}.`,
    }),
  });
}

export default async function PickemPage({
  searchParams,
}: {
  searchParams: Promise<PickemSearchParams>;
}) {
  const seasonParam = singleSearchParam((await searchParams).season);
  if (seasonParam === null) notFound();
  // ?season=<id> shows an archived season's oracle board. Prediction rows
  // hang off Match and outlive archival, so without this the season's oracle
  // champion became unreachable the moment season N+1 was created. With no
  // season running the page opens on the most recent one.
  const season = await resolveSeasonScope(seasonParam);
  if (!season) return <NoSeasonYet title="Pick'em" />;
  // Structurally read-only: savePrediction resolves the ACTIVE season itself,
  // and predictionOpen returns true for any SCHEDULED match with no kickoff —
  // so an archived season would otherwise render live pick buttons that can
  // only error.
  const readOnly = !season.isActive;

  const viewer = await getSessionUser();
  const [draft, matches, teams, predictions, users, seasonChoices] =
    await Promise.all([
      prisma.draft.findUnique({
        where: { seasonId: season.id },
        select: { status: true },
      }),
      prisma.match.findMany({
        where: { seasonId: season.id },
        orderBy: [{ week: "asc" }, { createdAt: "asc" }],
      }),
      prisma.team.findMany({ where: { seasonId: season.id } }),
      prisma.prediction.findMany({ where: { match: { seasonId: season.id } } }),
      prisma.user.findMany({
        where: { predictions: { some: { match: { seasonId: season.id } } } },
        select: { id: true, name: true, avatar: true },
      }),
      loadSeasonChoices("predictions", season.id),
    ]);
  const switcher = (
    <SeasonSwitcher
      label="pick'em"
      basePath="/pickem"
      seasons={seasonChoices}
      selectedId={season.id}
    />
  );

  const phaseOpen = postAuctionWorkOpen(season.status, draft?.status);
  const canPlay = !readOnly && phaseOpen;

  if (matches.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle
          title="Pick'em"
          subtitle={`${season.name}${readOnly ? " · archived" : ""}`}
        />
        {switcher}
        <EmptyState
          title={
            readOnly || season.status === "COMPLETE"
              ? "No Pick'em board on record"
              : "No matches to predict yet"
          }
          description={
            readOnly || season.status === "COMPLETE"
              ? "This season has no scheduled match history to grade."
              : "Pick'em opens once the schedule is generated — call every winner, top the oracle board."
          }
        />
      </div>
    );
  }

  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const teamLogoUrl = new Map(teams.map((t) => [t.id, t.logoUrl]));
  // Playoff rows keep counting weeks; name them by their round instead.
  const playoffRounds = playoffTotalRounds(matches);
  const roundLabel = (m: (typeof matches)[number]) =>
    matchRoundLabel(m, playoffRounds);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const userAvatar = new Map(users.map((u) => [u.id, u.avatar]));
  const myPicks = viewer
    ? new Map(
        predictions
          .filter((p) => p.userId === viewer.id)
          .map((p) => [p.matchId, p.pickedTeamId]),
      )
    : new Map<string, string>();

  const standings = pickemStandings(predictions, matches);
  const buckets = partitionPickemMatches(matches);
  // Structurally read-only in archives and closed phases: no match can reach
  // the branch that renders a server-action form.
  const open = canPlay ? buckets.open : [];
  // A future fixture from a closed phase is review-only too; direct actions
  // are rejected by the same phase gate in savePrediction.
  const lockedForReview = canPlay
    ? buckets.locked
    : [...buckets.locked, ...buckets.open];
  const graded = buckets.graded;
  const voided = buckets.voided;
  // Every closed match the viewer picked, as one newest-first list.
  const history = viewer
    ? pickHistory([...lockedForReview, ...graded, ...voided], myPicks)
    : [];
  const nextOpenDeadline = open.reduce<number | null>((next, match) => {
    const at = match.scheduledAt?.getTime();
    return at == null || (next != null && next <= at) ? next : at;
  }, null);

  return (
    <div className="space-y-8">
      <PageTitle
        title="Pick'em"
        subtitle={`${season.name}${readOnly ? " · archived" : ""} · call every match, top the oracle board`}
        action={
          readOnly ? (
            <Badge tone="neutral">Archived</Badge>
          ) : !phaseOpen ? (
            <Badge tone="accent">
              {season.status === "COMPLETE"
                ? "Pick'em closed"
                : "Opens after draft"}
            </Badge>
          ) : viewer ? null : (
            <Link href="/login?next=/pickem" className={textLink("text-sm")}>
              Sign in to play →
            </Link>
          )
        }
      />
      {switcher}

      {standings.length > 0 ? (
        <Card>
          <CardHeader
            title="Oracle board"
            subtitle={`${graded.length} decided match${graded.length === 1 ? "" : "es"} graded · draws void picks`}
            headingLevel={2}
          />
          <CardBody className="divide-y divide-line/60 p-0">
            {standings.map((s) => (
              <div
                key={s.userId}
                className={cn(
                  "flex items-center gap-3 px-5 py-2.5 text-sm",
                  viewer?.id === s.userId && "bg-info/[0.07]",
                )}
              >
                {/* Equal records share a place, so several rows can be 🔮. */}
                <span className="w-6 shrink-0 text-center text-muted">
                  {s.place === 1 ? (
                    <>
                      <span aria-hidden>🔮</span>
                      <span className="sr-only">1</span>
                    </>
                  ) : (
                    s.place
                  )}
                </span>
                <Avatar
                  name={userName.get(s.userId) ?? "?"}
                  src={userAvatar.get(s.userId) ?? null}
                  size={24}
                />
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <PlayerLink
                    userId={s.userId}
                    className="min-w-0 truncate font-medium"
                  >
                    {userName.get(s.userId) ?? "?"}
                  </PlayerLink>
                  {viewer?.id === s.userId ? (
                    <span className="shrink-0 rounded bg-info/20 px-1 py-0.5 text-xs font-semibold uppercase tracking-wide text-info-soft">
                      You
                    </span>
                  ) : null}
                </span>
                <span className="font-mono text-xs tabular-nums text-muted">
                  {Math.round(s.accuracy * 100)}%
                </span>
                <span className="shrink-0 font-mono text-base font-semibold tabular-nums">
                  {s.correct}/{s.graded}
                </span>
              </div>
            ))}
            <p className="px-5 py-3 text-xs text-muted">{PICKEM_RANKING_NOTE}</p>
          </CardBody>
        </Card>
      ) : null}

      {canPlay ? (
        <section className="space-y-4">
          {nextOpenDeadline != null ? (
            <PickemDeadlineRefresh targetMs={nextOpenDeadline} />
          ) : null}
          <SectionTitle aside="Picks lock at kickoff; the crowd's picks stay hidden until then">
            Upcoming matches
          </SectionTitle>
          {open.length === 0 ? (
            <EmptyState
              title="Nothing open to predict"
              description="Every remaining match is locked or finished — check the oracle board."
            />
          ) : (
            <div className="space-y-4">
              {groupOpenByWeek(open).map(
                ({ week, matches: weekMatches }, wi) => {
                  const isFirstGroup = wi === 0;
                  const picked = viewer
                    ? weekMatches.filter((wm) => myPicks.has(wm.id)).length
                    : 0;
                  const grid = (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {weekMatches.map((m) => {
                        const pickSide = (teamId: string) => ({
                          id: teamId,
                          name: teamName.get(teamId) ?? "?",
                          logoUrl: teamLogoUrl.get(teamId) ?? null,
                        });
                        return (
                          <Card key={m.id}>
                            <CardBody className="space-y-2.5">
                              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted">
                                {/* A regular week is already the group's
                                    heading; a playoff card still names its
                                    round and series length. */}
                                {m.phase === "REGULAR" ? null : (
                                  <span className="shrink-0 whitespace-nowrap">
                                    <Badge tone="accent">
                                      {matchRoundLabel(m, playoffRounds, {
                                        bestOf: true,
                                      })}
                                    </Badge>
                                  </span>
                                )}
                                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                  {m.scheduledAt ? (
                                    <>
                                      <LocalTime
                                        ts={m.scheduledAt.getTime()}
                                        variant="full"
                                        initial={formatMatchTime(
                                          m.scheduledAt,
                                          "full",
                                        )}
                                      />
                                      {/* A deadline, not an event: on an already-open
                                page this turns into "picks locked" exactly at
                                kickoff while the adjacent buttons disable. */}
                                      <Countdown
                                        targetMs={m.scheduledAt.getTime()}
                                        eventLabel="Picks"
                                        futureVerb="lock"
                                        passedLabel="picks locked"
                                        passesAtTarget
                                      />
                                    </>
                                  ) : (
                                    "time TBD"
                                  )}
                                  <Link
                                    href={`/matches/${m.id}`}
                                    className={textLink("whitespace-nowrap")}
                                  >
                                    preview →
                                  </Link>
                                </span>
                              </div>
                              <PickemPickForm
                                matchId={m.id}
                                roundLabel={roundLabel(m)}
                                home={pickSide(m.homeTeamId)}
                                away={pickSide(m.awayTeamId)}
                                pickedTeamId={myPicks.get(m.id) ?? null}
                                signInHref={
                                  viewer ? undefined : "/login?next=/pickem"
                                }
                                locksAt={m.scheduledAt?.getTime() ?? null}
                              />
                            </CardBody>
                          </Card>
                        );
                      })}
                    </div>
                  );
                  const headerAside = viewer
                    ? ` — you've picked ${picked} of ${weekMatches.length}`
                    : ` — ${weekMatches.length} match${weekMatches.length === 1 ? "" : "es"}`;
                  const nextKickoff = weekMatches.find(
                    (match) => match.scheduledAt,
                  )?.scheduledAt;
                  const groupLabel = roundGroupLabel(weekMatches, playoffRounds);
                  return isFirstGroup ? (
                    <section key={week} className="space-y-3">
                      <h3 className="text-sm font-semibold">
                        {groupLabel}
                        <span className="font-normal text-muted">
                          {headerAside}
                        </span>
                      </h3>
                      {grid}
                    </section>
                  ) : (
                    // Later weeks stay pickable but collapsed — the weekly ritual
                    // is about what locks NEXT, not week 7's coin flips.
                    <details
                      key={week}
                      className="rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3"
                    >
                      <summary className="cursor-pointer text-sm font-semibold marker:text-muted">
                        {groupLabel}
                        <span className="font-normal text-muted">
                          {headerAside}
                        </span>
                        {nextKickoff ? (
                          <span className="ml-1 font-normal text-muted">
                            · next lock{" "}
                            <LocalTime
                              ts={nextKickoff.getTime()}
                              variant="short"
                              initial={formatMatchTime(nextKickoff, "short")}
                            />
                          </span>
                        ) : null}
                      </summary>
                      <div className="mt-4">{grid}</div>
                    </details>
                  );
                },
              )}
            </div>
          )}
        </section>
      ) : standings.length === 0 ? (
        <EmptyState
          title={
            predictions.length > 0
              ? "No Pick'em results graded"
              : readOnly
                ? "No Pick'em entries on record"
                : season.status === "COMPLETE"
                  ? "Pick'em is closed"
                  : "Pick'em opens after the draft"
          }
          description={
            predictions.length > 0
              ? "Predictions were recorded, but no completed match has a winner. Drawn or voided picks do not affect the oracle board."
              : readOnly
                ? "This archived season has no submitted predictions."
                : season.status === "COMPLETE"
                  ? "The season is complete. Final oracle standings appear here when picks were recorded."
                  : "Once the auction is complete and fixtures are published, every signed-in visitor can call the winners."
          }
        />
      ) : null}

      {history.length > 0 ? (
        <section className="space-y-4">
          <SectionTitle aside="Newest first">Your picks</SectionTitle>
          <Card>
            <CardBody className="divide-y divide-line/60 p-0">
              {history.map(({ match: m, pickedTeamId: pick, result }) => {
                const mark = PICK_MARK[result ?? "locked"];
                // Locked rows show how the crowd split; decided ones how
                // many called it. Draws have neither.
                const split =
                  result === null
                    ? pickSplit(predictions, m.id, m.homeTeamId)
                    : null;
                const splitTotal = split ? split.home + split.away : 0;
                const called = calledItCount(predictions, m);
                return (
                  <div
                    key={m.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm"
                  >
                    <span
                      role="img"
                      aria-label={mark.label}
                      title={mark.label}
                      className={cn("w-5 shrink-0 text-center", mark.className)}
                    >
                      <span aria-hidden>{mark.glyph}</span>
                    </span>
                    <Link
                      href={`/matches/${m.id}`}
                      className="min-w-0 flex-1 basis-48 truncate hover:text-info hover:underline"
                    >
                      {roundLabel(m)}: {teamName.get(m.homeTeamId) ?? "?"}{" "}
                      {result === null ? (
                        "vs "
                      ) : (
                        <>
                          <span className="font-mono text-xs">
                            {m.homeScore}–{m.awayScore}
                          </span>{" "}
                        </>
                      )}
                      {teamName.get(m.awayTeamId) ?? "?"}
                    </Link>
                    <span className="w-full pl-8 text-xs text-muted sm:w-auto sm:pl-0">
                      you picked{" "}
                      <Link
                        href={`/teams/${pick}`}
                        className="font-medium text-fg hover:text-info hover:underline"
                      >
                        {teamName.get(pick) ?? "?"}
                      </Link>
                      {result === "void"
                        ? " · void (draw or no-contest)"
                        : null}
                      {called
                        ? ` · ${called.called} of ${called.total} called it`
                        : null}
                    </span>
                    {split && splitTotal > 0 ? (
                      <span className="w-full pl-8 text-xs text-muted sm:w-auto sm:pl-0">
                        crowd: {Math.round((split.home / splitTotal) * 100)}%{" "}
                        {teamName.get(m.homeTeamId) ?? "?"}
                        {" · "}
                        {Math.round((split.away / splitTotal) * 100)}%{" "}
                        {teamName.get(m.awayTeamId) ?? "?"}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </CardBody>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
