import { MATCH_LIST_ORDER } from "@/lib/schedule";
import type { ReactNode } from "react";
import { seasonPageMetadata } from "@/lib/link-preview-metadata";
import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { getPublicLeagueContent } from "@/lib/public-navigation";
import { prisma } from "@/lib/prisma";
import {
  projectPlayoffField,
  publicDeadHeatTeamIds,
} from "@/lib/playoff-field";
import { TiedChip } from "@/components/standings-table";
import { draftRecap } from "@/lib/draft-recap";
import { readDraftSales } from "@/lib/draft-history";
import { AuctionHistory } from "@/components/auction-history";
import { DraftRecapCard } from "@/components/draft-recap-card";
import { draftBudgetsForDisplay } from "@/lib/draft-budgets";
import { powerRankings } from "@/lib/power-rankings";
import { formByTeam } from "@/lib/team-matches";
import { rosterOrder } from "@/lib/team-roster";
import { rosterAverageMmr } from "@/lib/pool-stats";
import { SeriesRecord } from "@/components/series-record";
import {
  MATCH_PHASE,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "@/lib/constants";
import {
  orderByPlayoffRun,
  playoffStatuses,
  type TeamPlayoffStatus,
} from "@/lib/playoff-status";
import { seedsFromFirstRound } from "@/lib/bracket-view";
import { PlayoffStatusLine } from "@/components/playoff-status-line";
import { cn } from "@/lib/utils";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import { getTeamJersey } from "@/lib/team-jerseys";
import { PowerRankingsCard } from "@/components/power-rankings-card";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  EmptyState,
  FormStrip,
  LinkArrow,
  PageTitle,
  PlayerLink,
  RankBadge,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";

// The link preview names the page and the season.
export function generateMetadata() {
  return seasonPageMetadata("teams");
}

export default async function TeamsPage() {
  const season = await getActiveSeason();
  if (!season) {
    // The Hall of Fame is linked once a season has a champion.
    const { hasChampion } = await getPublicLeagueContent(null);
    return (
      <div className="space-y-6">
        <PageTitle title="Teams" />
        <EmptyState
          title="League offseason"
          description="There are no active rosters right now. Past teams, standings, and champions remain available in Season history."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link
                href="/seasons"
                className={buttonClasses("secondary", "sm")}
              >
                Season history
              </Link>
              {hasChampion ? (
                <Link
                  href="/hall-of-fame"
                  className={buttonClasses("secondary", "sm")}
                >
                  Hall of Fame
                </Link>
              ) : null}
              <Link href="/inhouse" className={buttonClasses("accent", "sm")}>
                Play an inhouse →
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  const [teams, matches, draft, viewer] = await Promise.all([
    prisma.team.findMany({
      where: { seasonId: season.id },
      orderBy: { draftOrder: "asc" },
      include: {
        captain: true,
        members: { include: { user: true }, orderBy: { price: "desc" } },
      },
    }),
    prisma.match.findMany({
      where: { seasonId: season.id },
      orderBy: MATCH_LIST_ORDER,
    }),
    prisma.draft.findUnique({
      where: { seasonId: season.id },
      select: { status: true, activeRunId: true, activeRun: { select: { provenance: true } } },
    }),
    getSessionUser(),
  ]);

  if (teams.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle title="Teams" subtitle={season.name} />
        <EmptyState
          title="No teams yet"
          description={
            season.status === "SIGNUPS"
              ? "Teams appear here as league administrators designate captains during signups."
              : "Teams will appear here once captains are designated and rosters are formed."
          }
        />
      </div>
    );
  }

  const field = projectPlayoffField(teams, matches);
  const standings = field.standings;
  // Level teams waiting on a tiebreaker match: the standings table swaps
  // their "Tied" chip for the tiebreaker badge, so these cards drop it too.
  const tiebreakerPending = new Set(publicDeadHeatTeamIds(field, matches));
  const rankOf = new Map(standings.map((s, i) => [s.teamId, i + 1]));
  const rowOf = new Map(standings.map((s) => [s.teamId, s]));
  const played = matches.some(
    (m) => m.status === "COMPLETED" && m.phase === "REGULAR",
  );
  const isDraft = season.status === "DRAFT";
  // Recent W/L/D per team (matches are already ordered chronologically above).
  const forms = formByTeam(
    teams.map((t) => t.id),
    matches,
  );

  // Captains' signup MMR sets the projected (MMR-weighted) draft budgets, and
  // every member's sets the card's average MMR.
  const registrationUserIds = [
    ...new Set([
      ...teams.map((team) => team.captainId),
      ...teams.flatMap((team) => team.members.map((member) => member.userId)),
    ]),
  ];
  const regs = registrationUserIds.length
    ? await prisma.registration.findMany({
        where: { seasonId: season.id, userId: { in: registrationUserIds } },
        select: { userId: true, mmr: true, status: true, type: true },
      })
    : [];
  const displayBudgets = draftBudgetsForDisplay({
    seasonIsActive: season.isActive,
    seasonStatus: season.status,
    draftStatus: draft?.status,
    baseBudget: season.draftBudget,
    budgetMmrWeight: season.budgetMmrWeight,
    teamSize: season.teamSize,
    teams,
    captainMmrs: regs.filter(
      (registration) =>
        registration.status === REGISTRATION_STATUS.ACTIVE &&
        registration.type === REGISTRATION_TYPE.PLAYER,
    ),
  });
  // Draft-night superlatives come from the auction's own receipts. A season
  // drafted before receipts were recorded has no card: today's roster prices
  // aren't the auction's (moves and refunds change them), and the full
  // "Draft night" recap returns with the next draft.
  const recap =
    draft?.activeRunId && draft.activeRun?.provenance === "COMMAND"
      ? draftRecap(await readDraftSales(prisma, draft.activeRunId))
      : null;

  const championPresentation = resolveChampionPresentation(season, matches);
  // Once the bracket exists, each card says where the team stands in it.
  const postseason =
    season.status === SEASON_STATUS.PLAYOFFS ||
    season.status === SEASON_STATUS.COMPLETE;
  const playoffStatus = postseason
    ? playoffStatuses(
        teams,
        matches,
        championPresentation.championTeamId,
        // eslint-disable-next-line react-hooks/purity -- async server component
        Date.now(),
      )
    : new Map<string, TeamPlayoffStatus>();
  const seedOf = seedsFromFirstRound(
    matches.filter(
      (m) => m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL,
    ),
  );
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  // The signed-in player's own card gets a "Your team" tag.
  const viewerTeamId = viewer
    ? teams.find(
        (t) =>
          t.captainId === viewer.id ||
          t.members.some((m) => m.userId === viewer.id),
      )?.id
    : undefined;
  // Playoffs: teams still alive first by seed, then the deepest runs. After
  // matches start, standings order; before that, draft order.
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const ordered =
    playoffStatus.size > 0
      ? orderByPlayoffRun(
          teams.map((t) => t.id),
          playoffStatus,
          seedOf,
          rankOf,
        ).map((id) => teamById.get(id)!)
      : played
        ? [...teams].sort(
            (a, b) => (rankOf.get(a.id) ?? 99) - (rankOf.get(b.id) ?? 99),
          )
        : teams;
  // Teams with a Fourthwall jersey link to its preview on their own page.
  const withJersey = new Set(
    teams
      .filter((team) =>
        getTeamJersey({
          id: team.id,
          roster: team.members.map((m) => m.user),
        }),
      )
      .map((team) => team.id),
  );

  // Elo power rankings: only regular-season series feed the rating, so it
  // stops moving once the regular season is over.
  const power = powerRankings(
    matches.filter((m) => m.phase === "REGULAR"),
    teams.map((t) => t.id),
  );
  const powerTeams = new Map(
    teams.map((t) => [
      t.id,
      { name: t.name, logoUrl: t.logoUrl, withdrawn: t.withdrawn },
    ]),
  );
  const powerFrozen = postseason;

  return (
    <div className="space-y-5">
      <PageTitle
        title="Teams"
        subtitle={`${season.name} · ${teams.length} teams`}
        action={
          // Signup week has no standings yet; captains are scouting the pool.
          season.status === SEASON_STATUS.SIGNUPS ? (
            <Link href="/players" className={textLink("text-sm")}>
              Player pool →
            </Link>
          ) : isDraft ? (
            <Link href="/draft" className={textLink("text-sm")}>
              Draft room →
            </Link>
          ) : (
            <Link href="/schedule" className={textLink("text-sm")}>
              Standings →
            </Link>
          )
        }
      />

      <section aria-label="Team rosters" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Rosters</h2>
          {/* The title's subtitle already counts the teams. */}
          <span className="text-xs text-muted">
            {season.teamSize} players per roster
          </span>
        </div>
        {/* Three across on a desktop: two left a 12-team league four
            screens tall, each card a wide band with its chips on the left. */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {ordered.map((t) => {
            const rank = rankOf.get(t.id) ?? 0;
            const seed = playoffStatus.size > 0 ? seedOf.get(t.id) : undefined;
            const status = playoffStatus.get(t.id);
            const row = played ? rowOf.get(t.id) : undefined;
            const isChampion = championPresentation.championTeamId === t.id;
            const budget = displayBudgets.byTeam.get(t.id) ?? t.budget;
            const showBudget = isDraft || displayBudgets.isProjected;
            const form = forms.get(t.id) ?? [];
            const short = t.members.length < season.teamSize;
            // One line in place of the standings: where the team sits, its
            // record and points. Before any result, how full the roster is.
            const summary: ReactNode[] = [];
            if (seed) {
              summary.push(
                <span key="seed" className="font-medium text-fg">
                  Seed {seed}
                </span>,
              );
            } else if (row && rank > 0) {
              summary.push(
                <span key="rank" className="font-medium text-fg">
                  Rank {rank}
                </span>,
              );
            }
            if (row) {
              summary.push(
                <span key="record" className="tabular-nums">
                  {seed ? "Regular season " : null}
                  <span className="font-medium text-fg">
                    <SeriesRecord record={row} />
                  </span>
                </span>,
                <span key="points" className="tabular-nums">
                  <span className="font-medium text-fg">{row.points}</span>{" "}
                  {row.points === 1 ? "pt" : "pts"}
                </span>,
              );
            }
            if (!row || short) {
              summary.push(
                <span key="players" className="tabular-nums">
                  {t.members.length}/{season.teamSize} players
                </span>,
              );
            }
            // The roster's strength at a glance, the same figure as the team
            // page's "Avg MMR". Left out while no member's MMR is known.
            const avgMmr = rosterAverageMmr(
              t.members.map((m) => m.userId),
              regs,
            );
            if (avgMmr > 0) {
              summary.push(
                <span key="mmr" className="tabular-nums">
                  <span className="font-medium text-fg">{avgMmr}</span> avg MMR
                </span>,
              );
            }
            return (
              <Card
                key={t.id}
                className={cn(
                  "min-w-0 overflow-hidden border-t-2",
                  isChampion
                    ? "border-t-accent ring-1 ring-accent/30"
                    : t.withdrawn
                      ? "border-t-danger/70"
                      : "border-t-cyan-300/40",
                )}
              >
                <div className="border-b border-line-soft bg-gradient-to-br from-surface-2/65 to-surface px-4 py-3">
                  <div
                    className={cn(
                      "grid items-center gap-3",
                      showBudget
                        ? "grid-cols-[3.5rem_minmax(0,1fr)_auto]"
                        : "grid-cols-[3.5rem_minmax(0,1fr)]",
                    )}
                  >
                    {/* The crest opens the team too. Only the name is
                        announced and focusable, so the team is one stop. */}
                    <Link
                      href={`/teams/${t.id}`}
                      tabIndex={-1}
                      aria-hidden
                      className="block rounded-xl"
                    >
                      <TeamCrest
                        name={t.name}
                        seed={t.id}
                        logoUrl={t.logoUrl}
                        size={56}
                        imageFit="cover"
                      />
                    </Link>
                    <div className="min-w-0">
                      <Link
                        href={`/teams/${t.id}`}
                        className="inline-flex min-h-11 items-center gap-1.5 font-display text-xl font-semibold leading-tight hover:text-info [overflow-wrap:anywhere]"
                      >
                        <span>{t.name}</span>
                        {isChampion ? (
                          <span
                            className="shrink-0"
                            role="img"
                            aria-label="Champion"
                          >
                            🏆
                          </span>
                        ) : null}
                      </Link>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                        {summary.flatMap((part, i) =>
                          i === 0
                            ? [part]
                            : [
                                <span key={`dot-${i}`} aria-hidden>
                                  ·
                                </span>,
                                part,
                              ],
                        )}
                        {row?.idDecided &&
                        !seed &&
                        !(tiebreakerPending.has(t.id) && !t.withdrawn) ? (
                          <TiedChip className="font-medium" />
                        ) : null}
                        {form.length > 0 ? (
                          <FormStrip form={form} size={4} />
                        ) : null}
                        {t.id === viewerTeamId ? (
                          // Neutral, as in the standings: blue reads as a link.
                          <span className="rounded bg-surface-3 px-1.5 py-0.5 font-medium text-fg">
                            Your team
                          </span>
                        ) : null}
                        {t.withdrawn ? (
                          <Badge
                            tone="danger"
                            title="Remaining fixtures were forfeited; this team is excluded from playoff seeding"
                          >
                            Withdrawn
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    {showBudget ? (
                      <div
                        className="shrink-0 text-right"
                        title={
                          displayBudgets.isProjected
                            ? "Projected starting budget; finalized when the auction starts"
                            : "Remaining auction budget"
                        }
                      >
                        <span className="font-display text-2xl font-semibold leading-none tabular-nums text-accent">
                          ${budget}
                        </span>
                        <span className="mt-1 block text-[10px] text-muted">
                          {displayBudgets.isProjected ? "projected" : "left"}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  {status ? (
                    <PlayoffStatusLine
                      status={status}
                      teamName={teamName}
                      className="mt-2 text-sm"
                    />
                  ) : null}
                </div>
                <CardBody className="p-4">
                  {/* Custom padding must reset PlayerLink's TAP_SAFE outdent so
                      wrapped roster links never overlap another tap target. */}
                  {t.members.length === 0 ? (
                    <p className="text-sm text-muted">No players yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {rosterOrder(t.members).map((m) => (
                        <PlayerLink
                          key={m.id}
                          userId={m.userId}
                          className="my-0 flex max-w-full min-w-6 items-center gap-1.5 rounded-lg border border-line-soft bg-surface-2/40 py-1 pl-1 pr-2 text-xs hover:border-muted/60 hover:no-underline"
                        >
                          <Avatar
                            name={m.user.name}
                            src={m.user.avatar}
                            size={24}
                          />
                          <span className="min-w-0 [overflow-wrap:anywhere]">
                            {m.user.name}
                          </span>
                          {m.isCaptain ? (
                            <Badge
                              tone="accent"
                              className="px-1.5 py-0"
                              title="Captain"
                            >
                              <span aria-hidden>C</span>
                              <span className="sr-only">Captain</span>
                            </Badge>
                          ) : null}
                          <RankBadge rankTier={m.user.rankTier} />
                          {isDraft && !m.isCaptain ? (
                            <span className="tabular-nums text-muted">
                              ${m.price}
                            </span>
                          ) : null}
                        </PlayerLink>
                      ))}
                    </div>
                  )}
                  {withJersey.has(t.id) ? (
                    <div className="mt-3 flex justify-end">
                      <Link
                        href={`/teams/${t.id}#team-jersey`}
                        className={textLink("text-xs")}
                      >
                        Team jersey
                        <span className="sr-only"> for {t.name}</span>{" "}
                        <LinkArrow />
                      </Link>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            );
          })}
        </div>
      </section>

      <PowerRankingsCard rows={power} teams={powerTeams} frozen={powerFrozen} />

      {/* The finished draft room renders the same card. */}
      {recap ? (
        <DraftRecapCard
          recap={recap}
          title={isDraft ? "Draft night — so far" : "Draft night"}
        />
      ) : null}

      <AuctionHistory seasonId={season.id} />
    </div>
  );
}
