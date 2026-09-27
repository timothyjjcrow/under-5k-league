import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { projectPlayoffField } from "@/lib/playoff-field";
import { draftRecap } from "@/lib/draft-recap";
import { readDraftSales } from "@/lib/draft-history";
import { AuctionHistory } from "@/components/auction-history";
import { draftBudgetsForDisplay } from "@/lib/draft-budgets";
import { powerRankings } from "@/lib/power-rankings";
import { formByTeam } from "@/lib/team-matches";
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
import { TeamJerseyPreview } from "@/components/team-jersey-preview";
import { PowerRankingsCard } from "@/components/power-rankings-card";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FormStrip,
  PageTitle,
  PlayerLink,
  RankBadge,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";

export const metadata = { title: "Teams" };

export default async function TeamsPage() {
  const season = await getActiveSeason();
  if (!season) {
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
              <Link
                href="/hall-of-fame"
                className={buttonClasses("secondary", "sm")}
              >
                Hall of Fame
              </Link>
              <Link href="/inhouse" className={buttonClasses("accent", "sm")}>
                Play an inhouse →
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  const [teams, matches, draft] = await Promise.all([
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
      orderBy: [{ week: "asc" }, { createdAt: "asc" }],
    }),
    prisma.draft.findUnique({
      where: { seasonId: season.id },
      select: { status: true, activeRunId: true, activeRun: { select: { provenance: true } } },
    }),
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

  const standings = projectPlayoffField(teams, matches).standings;
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

  // Draft-night superlatives (biggest spend, best steal, …) — MMR from signups.
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
  const hasAuctionReceipts = draft?.activeRunId && draft.activeRun?.provenance === "COMMAND";
  const recap = draftRecap(hasAuctionReceipts
    ? await readDraftSales(prisma, draft.activeRunId!)
    : teams.flatMap((t) =>
      t.members.map((m) => ({
        name: m.user.name,
        teamName: t.name,
        teamId: t.id,
        price: m.price,
        isCaptain: m.isCaptain,
        mmr: null,
      })),
    ),
  );

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
  const jerseys = ordered.flatMap((team) => {
    const jersey = getTeamJersey(team.members.map((member) => member.user));
    return jersey ? [jersey] : [];
  });

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
    <div className="space-y-6">
      <PageTitle
        title="Teams"
        subtitle={`${season.name} · ${teams.length} teams`}
        action={
          isDraft ? (
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

      <section aria-label="Team rosters" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Rosters</h2>
          <span className="text-xs text-muted">
            {teams.length} teams · {season.teamSize} players per roster
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {ordered.map((t) => {
            const rank = rankOf.get(t.id) ?? 0;
            const seed = playoffStatus.size > 0 ? seedOf.get(t.id) : undefined;
            const status = playoffStatus.get(t.id);
            const row = rowOf.get(t.id);
            const isChampion = championPresentation.championTeamId === t.id;
            const budget = displayBudgets.byTeam.get(t.id) ?? t.budget;
            return (
              <Card
                key={t.id}
                interactive
                className={cn(
                  "min-w-0 overflow-hidden border-t-2",
                  isChampion
                    ? "border-t-accent ring-1 ring-accent/30"
                    : t.withdrawn
                      ? "border-t-danger/70"
                      : "border-t-cyan-300/40",
                )}
              >
                <div className="border-b border-line-soft bg-gradient-to-br from-surface-2/65 to-surface px-4 py-4 sm:px-5">
                  <div className="grid grid-cols-[4rem_minmax(0,1fr)_auto] items-center gap-3">
                    <TeamCrest
                      name={t.name}
                      seed={t.id}
                      logoUrl={t.logoUrl}
                      size={64}
                      imageFit="cover"
                    />
                    <div className="min-w-0">
                      {seed ? (
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
                          Seed{" "}
                          <span className="text-cyan-300">
                            {String(seed).padStart(2, "0")}
                          </span>
                        </p>
                      ) : played && rank > 0 ? (
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
                          Rank{" "}
                          <span className="text-cyan-300">
                            {String(rank).padStart(2, "0")}
                          </span>
                          {row?.idDecided ? (
                            <span
                              className="ml-2 text-accent"
                              title="Points, game differential, wins and head-to-head are tied"
                            >
                              Tied
                            </span>
                          ) : null}
                        </p>
                      ) : null}
                      <Link
                        href={`/teams/${t.id}`}
                        className="inline-flex min-h-11 items-center gap-1.5 font-display text-xl font-semibold leading-tight hover:text-info sm:text-2xl [overflow-wrap:anywhere]"
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
                    </div>
                    <div className="shrink-0 text-right">
                      {isDraft || displayBudgets.isProjected ? (
                        <div
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
                      ) : played && row ? (
                        <div>
                          <span className="font-display text-3xl font-semibold leading-none tabular-nums text-fg">
                            {row.points}
                          </span>
                          <span className="mt-1 block text-[10px] uppercase tracking-wider text-muted">
                            Pts
                          </span>
                        </div>
                      ) : (
                        <div>
                          <span className="font-display text-2xl tabular-nums">
                            {t.members.length}
                            <span className="text-base text-muted">
                              /{season.teamSize}
                            </span>
                          </span>
                          <span className="mt-1 block text-[10px] text-muted">
                            Players
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <span>Captain</span>
                    <PlayerLink
                      userId={t.captainId}
                      className="my-0 min-w-0 py-1 font-medium text-fg [overflow-wrap:anywhere]"
                    >
                      {t.captain.name}
                    </PlayerLink>
                    {t.withdrawn ? (
                      <Badge
                        tone="danger"
                        className="ml-auto shrink-0"
                        title="Remaining fixtures were forfeited; this team is excluded from playoff seeding"
                      >
                        Withdrawn
                      </Badge>
                    ) : null}
                  </div>
                  {status ? (
                    <PlayoffStatusLine
                      status={status}
                      teamName={teamName}
                      className="mt-2 text-sm"
                    />
                  ) : null}
                  {played && row ? (
                    <div className="mt-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <span className="text-muted">
                          Regular season ·{" "}
                          <span className="tabular-nums">{row.played}</span>{" "}
                          series
                        </span>
                        <span
                          className="flex items-center gap-3 font-mono tabular-nums"
                          aria-label={`${row.wins} wins, ${row.draws} draws, ${row.losses} losses`}
                        >
                          <span className="text-cyan-300">
                            {row.wins}
                            <span className="ml-0.5 text-muted">W</span>
                          </span>
                          <span className="text-muted">
                            {row.draws}
                            <span className="ml-0.5">D</span>
                          </span>
                          <span className="text-danger">
                            {row.losses}
                            <span className="ml-0.5 text-muted">L</span>
                          </span>
                        </span>
                      </div>
                      <div
                        aria-hidden
                        className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-bg/75"
                      >
                        {row.wins > 0 ? (
                          <span
                            className="bg-cyan-300"
                            style={{ flex: row.wins }}
                          />
                        ) : null}
                        {row.draws > 0 ? (
                          <span
                            className="bg-slate-400"
                            style={{ flex: row.draws }}
                          />
                        ) : null}
                        {row.losses > 0 ? (
                          <span
                            className="bg-danger"
                            style={{ flex: row.losses }}
                          />
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
                <CardBody className="space-y-4 p-4 sm:p-5">
                  {/* Custom padding must reset PlayerLink's TAP_SAFE outdent so
                      wrapped roster links never overlap another tap target. */}
                  <div className="flex flex-wrap gap-2">
                    {t.members.map((m) => (
                      <PlayerLink
                        key={m.id}
                        userId={m.userId}
                        className="my-0 flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-line-soft bg-surface-2/40 py-1 pl-1 pr-2 text-xs hover:border-muted/60 hover:no-underline"
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
                          <Badge tone="accent" className="px-1.5 py-0">
                            C
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
                    {Array.from({
                      length: Math.max(0, season.teamSize - t.members.length),
                    }).map((_, i) => (
                      <span
                        key={`empty-${i}`}
                        className="inline-flex min-h-8 items-center rounded-lg border border-dashed border-line/70 px-3 py-1 text-xs text-muted"
                      >
                        Open slot
                      </span>
                    ))}
                  </div>
                  {played && row ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-3 text-xs">
                      <div className="flex items-center gap-4">
                        <span className="text-muted">
                          Games{" "}
                          <span className="ml-1 font-mono tabular-nums text-fg">
                            {row.gameWins}–{row.gameLosses}
                          </span>
                        </span>
                        <span className="text-muted">
                          Diff{" "}
                          <span
                            className={cn(
                              "ml-1 font-mono tabular-nums",
                              row.gameDiff > 0
                                ? "text-cyan-300"
                                : row.gameDiff < 0
                                  ? "text-danger"
                                  : "text-fg",
                            )}
                          >
                            {row.gameDiff > 0 ? "+" : ""}
                            {row.gameDiff}
                          </span>
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted">Recent</span>
                        <FormStrip form={forms.get(t.id) ?? []} size={5} />
                      </div>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            );
          })}
        </div>
      </section>

      <PowerRankingsCard rows={power} teams={powerTeams} frozen={powerFrozen} />

      {recap.totalSpent > 0 ? (
        <Card>
          <CardHeader
            title={hasAuctionReceipts ? (isDraft ? "Draft night — so far" : "Draft night") : "Surviving roster prices"}
            subtitle={hasAuctionReceipts ? `$${recap.totalSpent} total spent · original auction values` : `$${recap.totalSpent} in current roster rows · original auction history is incomplete`}
          />
          <CardBody className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {recap.biggestSpend ? (
              <div className="min-w-0 rounded-lg border border-line bg-surface-2/40 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-muted">
                  💸 Biggest spend
                </div>
                <div className="mt-1 truncate font-medium">
                  {recap.biggestSpend.name} · ${recap.biggestSpend.price}
                </div>
                <div className="truncate text-xs text-muted">
                  {recap.biggestSpend.teamName}
                </div>
              </div>
            ) : null}
            {recap.bestValue ? (
              <div className="min-w-0 rounded-lg border border-line bg-surface-2/40 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-muted">
                  🕵️ Best steal
                </div>
                <div className="mt-1 truncate font-medium">
                  {recap.bestValue.name} · ${recap.bestValue.price}
                </div>
                <div className="truncate text-xs text-muted">
                  {recap.bestValue.mmr} MMR for {recap.bestValue.teamName}
                </div>
              </div>
            ) : null}
            {recap.topSpender ? (
              <div className="min-w-0 rounded-lg border border-line bg-surface-2/40 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-muted">
                  🐳 Top spender
                </div>
                <div className="mt-1 truncate font-medium">
                  {recap.topSpender.teamName}
                </div>
                <div className="text-xs text-muted">
                  ${recap.topSpender.spent} total
                </div>
              </div>
            ) : null}
            {recap.bargainHunter &&
            (recap.bargainHunter.teamId ?? recap.bargainHunter.teamName) !== (recap.topSpender?.teamId ?? recap.topSpender?.teamName) ? (
              <div className="min-w-0 rounded-lg border border-line bg-surface-2/40 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-muted">
                  🧾 Bargain hunter
                </div>
                <div className="mt-1 truncate font-medium">
                  {recap.bargainHunter.teamName}
                </div>
                <div className="text-xs text-muted">
                  ${recap.bargainHunter.spent} total
                </div>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {jerseys.length > 0 ? (
        <section aria-labelledby="team-jerseys-title" className="space-y-4">
          <div>
            <h2 id="team-jerseys-title" className="text-lg font-semibold">
              Team jerseys
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
              Your team, front and back. Explore the Fourthwall previews, then
              choose a player&apos;s personalized jersey.
            </p>
          </div>
          <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
            {jerseys.map((jersey) => (
              <TeamJerseyPreview key={jersey.teamName} jersey={jersey} />
            ))}
          </div>
        </section>
      ) : null}
      <AuctionHistory seasonId={season.id} />
    </div>
  );
}
