import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import {
  groupOpenByWeek,
  partitionPickemMatches,
  pickemStandings,
  pickSplit,
} from "@/lib/pickem";
import { savePrediction } from "@/app/actions/pickem";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { Countdown } from "@/components/countdown";
import { formatMatchTime } from "@/lib/match-time";
import {
  Avatar,
  Badge,
  buttonClasses,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  PlayerLink,
  SectionTitle,
  TeamCrest,
  textLink,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { postAuctionWorkOpen } from "@/lib/league-lifecycle";
import { PickemSubmitButton } from "@/components/pickem-submit-button";
import { PickemDeadlineRefresh } from "@/components/pickem-deadline-refresh";
import { shareMetadata } from "@/lib/share-metadata";
import { singleSearchParam } from "@/lib/search-params";

type PickemSearchParams = { season?: string | string[] };

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<PickemSearchParams>;
}): Promise<Metadata> {
  const seasonId = singleSearchParam((await searchParams).season);
  if (seasonId === null) notFound();
  const generic = () =>
    shareMetadata(
      "Pick'em",
      "Call every GGD2L match before kickoff and climb the season's oracle board.",
      "/pickem",
    );
  if (!seasonId) return generic();
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { name: true, isActive: true },
  });
  if (!season) notFound();
  if (season.isActive) return generic();
  const path = `/pickem?${new URLSearchParams({ season: seasonId })}`;
  return shareMetadata(
    `${season.name} Pick'em`,
    `Final predictions and oracle standings from ${season.name}.`,
    path,
  );
}

export default async function PickemPage({
  searchParams,
}: {
  searchParams: Promise<PickemSearchParams>;
}) {
  const seasonParam = singleSearchParam((await searchParams).season);
  if (seasonParam === null) notFound();
  // ?season=<id> shows an archived season's oracle board (the leaders/meta/
  // recap pattern). Prediction rows hang off Match and outlive archival, so
  // without this the season's oracle champion became unreachable the moment
  // season N+1 was created.
  const season = seasonParam
    ? await prisma.season.findUnique({ where: { id: seasonParam } })
    : await getActiveSeason();
  if (seasonParam && !season) notFound();
  if (!season) {
    const archived = await prisma.season.findMany({
      where: { isActive: false },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
    });
    return (
      <div>
        <PageTitle title="Pick'em" />
        <EmptyState
          title="No active season"
          description={
            archived.length > 0
              ? "Browse a past season's oracle board instead."
              : undefined
          }
          action={
            archived.length > 0 ? (
              <div className="flex flex-wrap justify-center gap-2">
                {archived.map((s) => (
                  <Link
                    key={s.id}
                    href={`/pickem?season=${s.id}`}
                    className={buttonClasses("secondary", "sm")}
                  >
                    {s.name} →
                  </Link>
                ))}
              </div>
            ) : undefined
          }
        />
      </div>
    );
  }
  // Structurally read-only: savePrediction resolves the ACTIVE season itself,
  // and predictionOpen returns true for any SCHEDULED match with no kickoff —
  // so an archived season would otherwise render live pick buttons that can
  // only error.
  const readOnly = !season.isActive;

  const viewer = await getSessionUser();
  const [draft, matches, teams, predictions, users] = await Promise.all([
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
  ]);

  const phaseOpen = postAuctionWorkOpen(season.status, draft?.status);
  const canPlay = !readOnly && phaseOpen;

  if (matches.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle
          title="Pick'em"
          subtitle={`${season.name}${readOnly ? " · archived" : ""}`}
        />
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

      {standings.length > 0 ? (
        <Card>
          <CardHeader
            title="Oracle board"
            subtitle={`${graded.length} decided match${graded.length === 1 ? "" : "es"} graded · draws void picks`}
            headingLevel={2}
          />
          <CardBody className="divide-y divide-line/60 p-0">
            {standings.map((s, i) => (
              <div
                key={s.userId}
                className={cn(
                  "flex items-center gap-3 px-5 py-2.5 text-sm",
                  viewer?.id === s.userId && "bg-info/[0.07]",
                )}
              >
                <span className="w-6 text-center text-muted">
                  {i === 0 ? "🔮" : i + 1}
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
                    <span className="shrink-0 rounded bg-info/20 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-info">
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
          </CardBody>
        </Card>
      ) : null}

      {canPlay ? (
        <section className="space-y-4">
          {nextOpenDeadline != null ? (
            <PickemDeadlineRefresh targetMs={nextOpenDeadline} />
          ) : null}
          <SectionTitle
            aside={
              viewer
                ? "· picks lock at the match's scheduled start"
                : "· sign in to lock in your calls"
            }
          >
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
                        const myPick = myPicks.get(m.id);
                        const side = (teamId: string) => {
                          const name = teamName.get(teamId) ?? "?";
                          const mine = myPick === teamId;
                          return (
                            <PickemSubmitButton
                              selected={mine}
                              canSubmit={viewer != null}
                              locksAt={m.scheduledAt?.getTime() ?? null}
                              name="pickedTeamId"
                              value={teamId}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <TeamCrest
                                  name={name}
                                  seed={teamId}
                                  size={20}
                                  className="rounded"
                                />
                                <span className="truncate">{name}</span>
                                {mine ? (
                                  <>
                                    <span aria-hidden>✓</span>
                                    <span className="sr-only">(your pick)</span>
                                  </>
                                ) : null}
                              </span>
                            </PickemSubmitButton>
                          );
                        };
                        const homeName = teamName.get(m.homeTeamId) ?? "?";
                        const awayName = teamName.get(m.awayTeamId) ?? "?";
                        return (
                          <Card key={m.id}>
                            <CardBody className="space-y-2.5">
                              <div className="flex items-center justify-between text-xs text-muted">
                                <span>
                                  Week {m.week}
                                  {m.phase !== "REGULAR" ? (
                                    <Badge tone="accent" className="ml-2">
                                      {m.phase === "FINAL"
                                        ? "Final"
                                        : "Playoff"}
                                    </Badge>
                                  ) : null}
                                </span>
                                <span className="flex items-center gap-2">
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
                                    className={textLink()}
                                  >
                                    preview →
                                  </Link>
                                </span>
                              </div>
                              <ActionForm
                                action={savePrediction}
                                hidden={{ matchId: m.id }}
                                className="min-w-0"
                              >
                                <fieldset className="min-w-0">
                                  <legend className="sr-only">
                                    Pick the winner of Week {m.week}: {homeName}{" "}
                                    versus {awayName}
                                  </legend>
                                  <div className="flex items-center gap-2">
                                    <div className="min-w-0 flex-1">
                                      {side(m.homeTeamId)}
                                    </div>
                                    <span className="shrink-0 text-xs text-muted">
                                      vs
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      {side(m.awayTeamId)}
                                    </div>
                                  </div>
                                </fieldset>
                              </ActionForm>
                              <div className="text-center text-[11px] text-muted">
                                Community split stays hidden until picks lock.
                              </div>
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
                  return isFirstGroup ? (
                    <section key={week} className="space-y-3">
                      <h3 className="text-sm font-semibold">
                        Week {week}
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
                        Week {week}
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

      {viewer && lockedForReview.some((m) => myPicks.has(m.id)) ? (
        <section className="space-y-4">
          <SectionTitle aside="· submitted and no longer editable">
            Your locked picks
          </SectionTitle>
          <Card>
            <CardBody className="divide-y divide-line/60 p-0">
              {lockedForReview
                .filter((m) => myPicks.has(m.id))
                .map((m) => {
                  const pick = myPicks.get(m.id)!;
                  const split = pickSplit(predictions, m.id, m.homeTeamId);
                  const total = split.home + split.away;
                  return (
                    <div
                      key={m.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm"
                    >
                      <span aria-hidden className="shrink-0">
                        🔒
                      </span>
                      <Link
                        href={`/matches/${m.id}`}
                        className="min-w-0 flex-1 basis-48 truncate hover:text-info hover:underline"
                      >
                        Week {m.week}: {teamName.get(m.homeTeamId) ?? "?"} vs{" "}
                        {teamName.get(m.awayTeamId) ?? "?"}
                      </Link>
                      <span className="shrink-0 text-xs text-muted">
                        you picked{" "}
                        <Link
                          href={`/teams/${pick}`}
                          className="font-medium text-fg hover:text-info hover:underline"
                        >
                          {teamName.get(pick) ?? "?"}
                        </Link>
                      </span>
                      {total > 0 ? (
                        <span className="w-full pl-7 text-xs text-muted sm:w-auto sm:pl-0">
                          crowd: {Math.round((split.home / total) * 100)}%{" "}
                          {teamName.get(m.homeTeamId) ?? "?"}
                          {" · "}
                          {Math.round((split.away / total) * 100)}%{" "}
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

      {viewer && voided.some((m) => myPicks.has(m.id)) ? (
        <section className="space-y-4">
          <SectionTitle aside="· draw or no-contest — no point awarded">
            Your void picks
          </SectionTitle>
          <Card>
            <CardBody className="divide-y divide-line/60 p-0">
              {voided
                .filter((m) => myPicks.has(m.id))
                .map((m) => {
                  const pick = myPicks.get(m.id)!;
                  return (
                    <div
                      key={m.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm"
                    >
                      <span role="img" aria-label="Void pick">
                        <span aria-hidden>➖</span>
                      </span>
                      <Link
                        href={`/matches/${m.id}`}
                        className="min-w-0 flex-1 basis-48 truncate hover:text-info hover:underline"
                      >
                        Week {m.week}: {teamName.get(m.homeTeamId) ?? "?"}{" "}
                        <span className="font-mono text-xs">
                          {m.homeScore}–{m.awayScore}
                        </span>{" "}
                        {teamName.get(m.awayTeamId) ?? "?"}
                      </Link>
                      <span className="w-full pl-7 text-xs text-muted sm:w-auto sm:pl-0">
                        you picked{" "}
                        <Link
                          href={`/teams/${pick}`}
                          className="hover:text-info hover:underline"
                        >
                          {teamName.get(pick) ?? "?"}
                        </Link>
                      </span>
                    </div>
                  );
                })}
            </CardBody>
          </Card>
        </section>
      ) : null}

      {/* `graded` counts every decided match; without the myPicks filter here
          a viewer who never predicted got a "Your graded picks" heading over
          an empty bordered card. */}
      {viewer && graded.some((m) => myPicks.has(m.id)) ? (
        <section className="space-y-4">
          <SectionTitle>Your graded picks</SectionTitle>
          <Card>
            <CardBody className="divide-y divide-line/60 p-0">
              {graded
                .filter((m) => myPicks.has(m.id))
                .map((m) => {
                  const pick = myPicks.get(m.id)!;
                  const right = pick === m.winnerTeamId;
                  return (
                    <div
                      key={m.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm"
                    >
                      <span
                        role="img"
                        aria-label={right ? "Correct pick" : "Wrong pick"}
                      >
                        <span aria-hidden>{right ? "✅" : "❌"}</span>
                      </span>
                      <Link
                        href={`/matches/${m.id}`}
                        className="min-w-0 flex-1 basis-48 truncate hover:text-info hover:underline"
                      >
                        Week {m.week}: {teamName.get(m.homeTeamId)}{" "}
                        <span className="font-mono text-xs">
                          {m.homeScore}–{m.awayScore}
                        </span>{" "}
                        {teamName.get(m.awayTeamId)}
                      </Link>
                      <span className="w-full pl-7 text-xs text-muted sm:w-auto sm:pl-0">
                        you picked{" "}
                        <Link
                          href={`/teams/${pick}`}
                          className="hover:text-info hover:underline"
                        >
                          {teamName.get(pick)}
                        </Link>
                      </span>
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
