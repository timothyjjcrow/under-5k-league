import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import { draftRecap } from "@/lib/draft-recap";
import { draftBudgetsForDisplay } from "@/lib/draft-budgets";
import { powerRankings } from "@/lib/power-rankings";
import { formByTeam } from "@/lib/team-matches";
import { REGISTRATION_STATUS, REGISTRATION_TYPE } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
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
      select: { status: true },
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

  const standings = computeStandings(
    teams.map((t) => t.id),
    matches,
  );
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
  const mmrByUser = new Map(regs.map((r) => [r.userId, r.mmr]));
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
  const recap = draftRecap(
    teams.flatMap((t) =>
      t.members.map((m) => ({
        name: m.user.name,
        teamName: t.name,
        price: m.price,
        isCaptain: m.isCaptain,
        mmr: mmrByUser.get(m.userId) ?? null,
      })),
    ),
  );

  // After matches start, order by standings; before that, keep draft order.
  const ordered = played
    ? [...teams].sort(
        (a, b) => (rankOf.get(a.id) ?? 99) - (rankOf.get(b.id) ?? 99),
      )
    : teams;

  // Elo power rankings — only regular-season series feed the rating.
  const power = powerRankings(
    matches.filter((m) => m.phase === "REGULAR"),
    teams.map((t) => t.id),
  );
  const powerChangeScale = Math.max(
    10,
    Math.ceil(Math.max(0, ...power.map((row) => Math.abs(row.delta))) / 10) *
      10,
  );
  const powerName = new Map(teams.map((t) => [t.id, t.name]));
  const teamLogoUrl = new Map(teams.map((t) => [t.id, t.logoUrl]));
  const withdrawnTeamIds = new Set(
    teams.filter((team) => team.withdrawn).map((team) => team.id),
  );
  const championPresentation = resolveChampionPresentation(season, matches);

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

      {power.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader
            title="Power rankings"
            headingLevel={2}
            subtitle="Elo rating · latest week's movement"
            action={
              <span className="inline-flex items-center gap-3 text-[10px] font-medium uppercase tracking-wider text-muted">
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-danger"
                    aria-hidden
                  />
                  Lost
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-cyan-300"
                    aria-hidden
                  />
                  Gained
                </span>
              </span>
            }
          />
          <CardBody className="p-3 sm:p-4">
            <ol className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
              {power.map((row) => {
                const hasMovement = row.prevRank > 0;
                const moved = hasMovement ? row.prevRank - row.rank : 0;
                const name = powerName.get(row.teamId) ?? "?";
                return (
                  <li
                    key={row.teamId}
                    className="min-w-0 rounded-lg border border-line-soft bg-surface-2/35 px-3 py-3 sm:px-4"
                  >
                    <div className="grid grid-cols-[1.25rem_1.75rem_minmax(0,1fr)_auto] items-center gap-2.5">
                      <span
                        className="font-display text-xl tabular-nums text-muted"
                        aria-label={`Power rank ${row.rank}`}
                      >
                        {String(row.rank).padStart(2, "0")}
                      </span>
                      <TeamCrest
                        name={name}
                        seed={row.teamId}
                        logoUrl={teamLogoUrl.get(row.teamId)}
                        size={28}
                        className="shrink-0 rounded-md"
                      />
                      <div className="min-w-0">
                        <Link
                          href={`/teams/${row.teamId}`}
                          className="inline-flex min-h-11 items-center text-sm font-semibold leading-snug hover:text-info [overflow-wrap:anywhere]"
                        >
                          {name}
                        </Link>
                        {withdrawnTeamIds.has(row.teamId) ? (
                          <Badge
                            tone="danger"
                            className="mt-1 px-1.5 py-0 text-[10px]"
                            title="Withdrawn teams retain played results but cannot qualify for playoffs"
                          >
                            Withdrawn
                          </Badge>
                        ) : null}
                      </div>
                      <div className="text-right">
                        <span
                          className="font-display text-2xl leading-none tabular-nums text-fg"
                          title="Elo rating: higher is stronger"
                        >
                          {row.rating}
                        </span>
                        <span
                          className={cn(
                            "mt-1 block font-mono text-[10px] tabular-nums",
                            moved > 0
                              ? "text-cyan-300"
                              : moved < 0
                                ? "text-danger"
                                : "text-muted",
                          )}
                          title={
                            row.prevRank > 0
                              ? `Power rank last week: ${row.prevRank}`
                              : "No previous week to compare"
                          }
                          aria-label={
                            row.prevRank > 0
                              ? `Power rank ${moved > 0 ? "up" : moved < 0 ? "down" : "unchanged"}${moved ? ` ${Math.abs(moved)}` : ""} since last week`
                              : "No previous rank"
                          }
                        >
                          {moved > 0
                            ? `▲ ${moved}`
                            : moved < 0
                              ? `▼ ${-moved}`
                              : "—"}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-[minmax(0,1fr)_2.75rem] items-center gap-3">
                      <div
                        role="img"
                        aria-label={
                          hasMovement
                            ? `Weekly Elo change: ${row.delta > 0 ? "+" : ""}${row.delta}`
                            : "No previous completed week to compare"
                        }
                        className="relative h-2 rounded-full bg-bg/80"
                      >
                        <span
                          aria-hidden
                          className="absolute -top-1 bottom-[-4px] left-1/2 w-px bg-muted/50"
                        />
                        <span
                          aria-hidden
                          className={cn(
                            "absolute inset-y-0 rounded-full",
                            row.delta < 0 ? "bg-danger" : "bg-cyan-300",
                          )}
                          style={{
                            left: `${row.delta < 0 ? 50 - (Math.abs(row.delta) / powerChangeScale) * 50 : 50}%`,
                            width: `${(Math.abs(row.delta) / powerChangeScale) * 50}%`,
                          }}
                        />
                      </div>
                      <span
                        className={cn(
                          "text-right font-mono text-xs font-semibold tabular-nums",
                          row.delta > 0
                            ? "text-cyan-300"
                            : row.delta < 0
                              ? "text-danger"
                              : "text-muted",
                        )}
                      >
                        {hasMovement
                          ? `${row.delta > 0 ? "+" : ""}${row.delta}`
                          : "—"}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="mt-3 flex items-center justify-between gap-3 px-1 text-[10px] text-muted">
              <span>Weekly Elo change</span>
              <span className="font-mono tabular-nums">
                −{powerChangeScale}{" "}
                <span className="px-2 text-muted/60">/ 0 /</span> +
                {powerChangeScale}
              </span>
            </div>
          </CardBody>
        </Card>
      ) : null}

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
                      {played && rank > 0 ? (
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

      {recap.totalSpent > 0 ? (
        <Card>
          <CardHeader
            title={isDraft ? "Draft night — so far" : "Draft night"}
            subtitle={`$${recap.totalSpent} total spent`}
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
            recap.bargainHunter.teamName !== recap.topSpender?.teamName ? (
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
    </div>
  );
}
