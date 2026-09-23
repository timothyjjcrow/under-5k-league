import { LEAGUE_CONFIG } from "@/lib/league-config";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSeasonGameScores } from "@/lib/cached-queries";
import { decodeGamePlayers, trustedGamePlayers } from "@/lib/player-stats";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import {
  fantasyCap,
  fantasyPrices,
  fantasyStandings,
  fantasyTotalsByPlayer,
  ownershipByPlayer,
} from "@/lib/fantasy";
import { FANTASY } from "@/lib/constants";
import { saveFantasyRoster } from "@/app/actions/fantasy";
import { ActionForm } from "@/components/action-form";
import { FantasyPicker } from "@/components/fantasy-picker";
import { LeaderBoard, type LeaderBoardRow } from "@/components/leader-board";
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
  textLink,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { postAuctionWorkOpen } from "@/lib/league-lifecycle";
import { shareMetadata } from "@/lib/share-metadata";
import { singleSearchParam } from "@/lib/search-params";
import { parseRoles } from "@/lib/roles";

type FantasySearchParams = { season?: string | string[] };

function FantasySeasonSwitcher({
  season,
  pastSeasons,
}: {
  season: { id: string; name: string; isActive: boolean };
  pastSeasons: { id: string; name: string }[];
}) {
  if (pastSeasons.length === 0 && season.isActive) return null;
  return (
    <nav aria-label="Fantasy seasons" className="flex flex-wrap items-center gap-2 text-xs text-muted">
      <span>Season:</span>
      {season.isActive ? (
        <Badge tone="info">{season.name}</Badge>
      ) : (
        <Link href="/fantasy" className={buttonClasses("secondary", "sm")}>Current season</Link>
      )}
      {pastSeasons.filter((past) => past.id !== season.id).map((past) => (
        <Link key={past.id} href={`/fantasy?season=${past.id}`} className={buttonClasses("secondary", "sm")}>{past.name}</Link>
      ))}
      {!season.isActive ? <Badge tone="neutral">{season.name}</Badge> : null}
    </nav>
  );
}

function ScoringGuide() {
  return (
    <Card id="scoring" className="scroll-mt-24 overflow-hidden">
      <CardHeader
        title="One score, three ways to contribute"
        subtitle="Every player gets the same base points. Their best contribution bonus counts each game, capped at eight points, so farm and damage cannot stack into an overwhelming lead."
        headingLevel={2}
      />
      <CardBody className="space-y-4">
        <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-sm">
          <span className="font-semibold">Every game</span>
          <span className="ml-2 text-muted">+{FANTASY.KILL} / kill · +{FANTASY.ASSIST} / assist · {FANTASY.DEATH} / death · +{FANTASY.WIN} / win</span>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-line bg-surface/70 p-4">
            <div className="text-sm font-semibold">Farm</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">Gold per minute above {FANTASY.ECONOMY_GPM_FLOOR} × {FANTASY.ECONOMY_GPM}, plus last hits × {FANTASY.ECONOMY_LAST_HIT}.</p>
          </div>
          <div className="rounded-lg border border-line bg-surface/70 p-4">
            <div className="text-sm font-semibold">Playmaking</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">Assists × {FANTASY.PLAYMAKING_ASSIST}, plus hero healing × {FANTASY.PLAYMAKING_HEALING}.</p>
          </div>
          <div className="rounded-lg border border-line bg-surface/70 p-4">
            <div className="text-sm font-semibold">Pressure</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">Hero damage × {FANTASY.PRESSURE_HERO_DAMAGE}, tower damage × {FANTASY.PRESSURE_TOWER_DAMAGE}, plus denies × {FANTASY.PRESSURE_DENY}.</p>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted">Only the highest of these three bonuses is added, up to +{FANTASY.BONUS_CAP} per game. Scores use complete imported 5v5 box scores. Preferred positions help browse the draft pool; they do not change scoring.</p>
      </CardBody>
    </Card>
  );
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<FantasySearchParams>;
}): Promise<Metadata> {
  const seasonId = singleSearchParam((await searchParams).season);
  if (seasonId === null) notFound();
  const generic = () =>
    shareMetadata(
      "Fantasy",
      `Build a salary-capped fantasy five from the drafted league and score from real ${LEAGUE_CONFIG.name} games.`,
      "/fantasy",
    );
  if (!seasonId) return generic();
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { name: true, isActive: true },
  });
  if (!season) notFound();
  if (season.isActive) return generic();
  const path = `/fantasy?${new URLSearchParams({ season: seasonId })}`;
  return shareMetadata(
    `${season.name} fantasy`,
    `Final fantasy standings and rosters from ${season.name}.`,
    path,
  );
}

export default async function FantasyPage({
  searchParams,
}: {
  searchParams: Promise<FantasySearchParams>;
}) {
  const seasonParam = singleSearchParam((await searchParams).season);
  if (seasonParam === null) notFound();
  // ?season=<id> shows an archived season's fantasy league (the leaders/meta/
  // recap pattern). FantasyRoster rows outlive archival — they cascade only on
  // season DELETE — so without this every past season's fantasy champion
  // became unreachable the instant season N+1 was created: the data survived
  // and no page could render it.
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
        <PageTitle title="Fantasy" />
        <EmptyState
          title="No active season"
          description={
            archived.length > 0
              ? "Browse a past season's fantasy league instead."
              : undefined
          }
          action={
            archived.length > 0 ? (
              <div className="flex flex-wrap justify-center gap-2">
                {archived.map((s) => (
                  <Link
                    key={s.id}
                    href={`/fantasy?season=${s.id}`}
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
  // STRUCTURALLY read-only, not merely visually: saveFantasyRoster resolves
  // the ACTIVE season itself, so a picker rendered over an archived season
  // would silently edit the CURRENT season's roster with no error anywhere.
  const readOnly = !season.isActive;

  const viewer = await getSessionUser();
  const [draft, members, regs, games, gameCount, rosters, pastSeasons] = await Promise.all([
    prisma.draft.findUnique({
      where: { seasonId: season.id },
      select: { status: true },
    }),
    prisma.teamMember.findMany({
      where: { seasonId: season.id },
      include: { user: true, team: true },
      orderBy: { price: "desc" },
    }),
    prisma.registration.findMany({
      where: { seasonId: season.id, status: "ACTIVE" },
      select: { userId: true, mmr: true, roles: true },
    }),
    getSeasonGameScores(season.id),
    // Unlike the cached scoring scan above, the competitive lock must be an
    // authoritative read. Immediate invalidation keeps boards fresh, but a
    // cache is still not the right source for enabling a competitive write.
    prisma.game.count({ where: { match: { seasonId: season.id } } }),
    prisma.fantasyRoster.findMany({
      where: { seasonId: season.id },
      include: { user: true, picks: { include: { player: true } } },
    }),
    prisma.season.findMany({
      where: { isActive: false },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
    }),
  ]);

  const phaseOpen = postAuctionWorkOpen(season.status, draft?.status);
  const isFinal = readOnly || season.status === "COMPLETE";
  if (members.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle
          title="Fantasy"
          subtitle={`${season.name}${readOnly ? " · archived" : ""}`}
        />
        <FantasySeasonSwitcher season={season} pastSeasons={pastSeasons} />
        <EmptyState
          title={
            isFinal
              ? "No fantasy league on record"
              : "Fantasy opens after the draft"
          }
          description={
            isFinal
              ? "This season has no drafted roster pool to build final fantasy standings from."
              : "Once teams are drafted you'll pick a fantasy five from the rosters — points score from their real games."
          }
        />
      </div>
    );
  }
  // COMPLETE is a read-only final-board phase, not a reason to hide the
  // feature. Only pre-auction active phases stop here; archived and completed
  // seasons continue through the same standings renderer with writes locked.
  if (!readOnly && !phaseOpen && season.status !== "COMPLETE") {
    return (
      <div className="space-y-6">
        <PageTitle title="Fantasy" subtitle={season.name} />
        <FantasySeasonSwitcher season={season} pastSeasons={pastSeasons} />
        <EmptyState
          title="Fantasy opens after the draft"
          description="When the auction is complete, build your five before the first league game is imported."
        />
      </div>
    );
  }

  const mmrByUser = new Map(regs.map((r) => [r.userId, r.mmr]));
  const rolesByUser = new Map(regs.map((r) => [r.userId, parseRoles(r.roles)]));
  const priceByUser = fantasyPrices(
    new Map(members.map((m) => [m.userId, mmrByUser.get(m.userId) ?? 0])),
  );
  const candidates = members.map((m) => ({
    userId: m.userId,
    name: m.user.name,
    avatar: m.user.avatar,
    rankTier: m.user.rankTier,
    mmr: priceByUser.get(m.userId) ?? 0,
    mmrEstimated:
      (mmrByUser.get(m.userId) ?? 0) <= 0 &&
      (priceByUser.get(m.userId) ?? 0) > 0,
    teamName: m.team.name,
    isCaptain: m.isCaptain,
    roles: rolesByUser.get(m.userId) ?? [],
    released: false,
  }));
  const cap = fantasyCap([...priceByUser.values()]);
  // `readOnly` folds into `locked`, which is the ONE branch that decides
  // whether the picker renders. That makes the archived view structurally
  // read-only rather than visually so: there is no path to a FantasyPicker
  // whose submit would edit the CURRENT season (saveFantasyRoster resolves
  // the active season itself and would accept it silently).
  const locked =
    readOnly || !phaseOpen || season.fantasyLockedAt != null || gameCount > 0;

  // A saved pick can reference a since-released player. Pre-lock, that pick
  // must stay visible in the picker (and removable) or the manager is stuck:
  // the phantom id keeps counting toward slots/cap with no checkbox to clear.
  const viewerRoster = viewer
    ? rosters.find((r) => r.userId === viewer.id)
    : undefined;
  if (!locked && viewerRoster) {
    const candidateIds = new Set(candidates.map((c) => c.userId));
    for (const p of viewerRoster.picks) {
      if (candidateIds.has(p.userId)) continue;
      candidates.push({
        userId: p.userId,
        name: `${p.player.name} (released)`,
        avatar: p.player.avatar,
        rankTier: p.player.rankTier,
        mmr: mmrByUser.get(p.userId) ?? 0,
        mmrEstimated: false,
        teamName: "released",
        isCaptain: false,
        roles: [],
        released: true,
      });
    }
  }

  const scoredGames = games.map((g) => ({
    radiantWin: g.radiantWin,
    players: trustedGamePlayers(decodeGamePlayers(g.players)),
  }));
  const scoredGameCount = scoredGames.filter((g) => g.players.length === 10).length;
  const playerTotals = fantasyTotalsByPlayer(scoredGames);
  const playerPoints = new Map(
    [...playerTotals].map(([id, total]) => [id, total.points]),
  );
  const standings = fantasyStandings(
    rosters.map((r) => ({
      managerId: r.userId,
      pickUserIds: r.picks.map((p) => p.userId),
    })),
    playerPoints,
  );
  const managerName = new Map(rosters.map((r) => [r.userId, r.user.name]));
  const managerAvatar = new Map(rosters.map((r) => [r.userId, r.user.avatar]));
  // Picks legally outlive roster membership (locked rosters + releases) —
  // resolve names from the picks' own player relation too, or a released
  // player's chip reads "?" for the rest of the season.
  const playerName = new Map(members.map((m) => [m.userId, m.user.name]));
  for (const r of rosters) {
    for (const p of r.picks) {
      if (!playerName.has(p.userId)) playerName.set(p.userId, p.player.name);
    }
  }

  const myRoster = viewer ? rosters.find((r) => r.userId === viewer.id) : null;
  const myPicks = myRoster?.picks.map((p) => p.userId) ?? [];
  const myStandingIndex = viewer
    ? standings.findIndex((standing) => standing.managerId === viewer.id)
    : -1;

  // Which players are actually producing, and how contested each one was.
  const ownership = ownershipByPlayer(
    rosters.map((r) => ({ pickUserIds: r.picks.map((p) => p.userId) })),
  );
  const memberByUser = new Map(members.map((m) => [m.userId, m]));
  const topScorers: LeaderBoardRow[] = [...playerPoints.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([userId, points]) => {
      const m = memberByUser.get(userId);
      const pct = Math.round((ownership.get(userId) ?? 0) * 100);
      const total = playerTotals.get(userId);
      const impact = total
        ? Object.entries(total.impacts).sort((a, b) => b[1] - a[1])[0]
        : null;
      return {
        id: userId,
        name: m?.user.name ?? playerName.get(userId) ?? "?",
        avatar: m?.user.avatar ?? null,
        rankTier: m?.user.rankTier ?? null,
        value: points,
        valueLabel: `${points} pts`,
        hint: `${total?.games ?? 0} games · ${total ? (points / total.games).toFixed(1) : "0"} pts/game${impact && impact[1] > 0 ? ` · ${impact[0]} bonus most often` : ""}${rosters.length > 0 ? ` · picked by ${pct}%` : ""}`,
        team: m?.team.name ?? null,
        isViewer: viewer?.id === userId,
      };
    });

  return (
    <div className="space-y-7">
      <PageTitle
        title="Fantasy"
        subtitle={`${season.name}${readOnly ? " · archived" : ""}. ${locked ? "Follow the fantasy standings from real league games." : "Build a five from drafted players before the first game."}`}
        action={
          readOnly ? (
            <Badge tone="neutral">Archived</Badge>
          ) : locked ? (
            <Badge tone="accent">{isFinal ? "Final standings" : "Live scoring"}</Badge>
          ) : (
            <Badge tone="success">Picks open</Badge>
          )
        }
      />

      <nav aria-label="Fantasy sections" className="flex flex-wrap gap-2 text-xs font-medium">
        <a href="#lineup" className={buttonClasses("secondary", "sm")}>{locked ? "Your five" : "Build your five"}</a>
        {locked && standings.length > 0 ? <a href="#standings" className={buttonClasses("secondary", "sm")}>Standings</a> : null}
        {locked && topScorers.length > 0 ? <a href="#scorers" className={buttonClasses("secondary", "sm")}>Player scores</a> : null}
        <a href="#scoring" className={buttonClasses("secondary", "sm")}>Scoring rules</a>
      </nav>

      <FantasySeasonSwitcher season={season} pastSeasons={pastSeasons} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card tone="feature"><CardBody className="py-4"><div className="text-xs uppercase tracking-wide text-muted">Entries</div><div className="mt-1 font-display text-2xl font-semibold tabular-nums">{rosters.length}</div><p className="mt-1 text-xs text-muted">{locked ? "Locked fantasy fives" : "Saved fantasy fives"}</p></CardBody></Card>
        <Card><CardBody className="py-4"><div className="text-xs uppercase tracking-wide text-muted">Games scored</div><div className="mt-1 font-display text-2xl font-semibold tabular-nums">{scoredGameCount}</div><p className="mt-1 text-xs text-muted">Complete imported games</p></CardBody></Card>
        <Card><CardBody className="py-4"><div className="text-xs uppercase tracking-wide text-muted">Draft pool</div><div className="mt-1 font-display text-2xl font-semibold tabular-nums">{members.length}</div><p className="mt-1 text-xs text-muted">Players to choose from</p></CardBody></Card>
        <Card><CardBody className="py-4"><div className="text-xs uppercase tracking-wide text-muted">{locked && myStandingIndex >= 0 ? "Your rank" : "Salary cap"}</div><div className="mt-1 font-display text-2xl font-semibold tabular-nums">{locked && myStandingIndex >= 0 ? `#${myStandingIndex + 1}` : cap > 0 ? cap.toLocaleString() : "Open"}</div><p className="mt-1 text-xs text-muted">{locked && myStandingIndex >= 0 ? `${standings[myStandingIndex].points} points` : cap > 0 ? "MMR across five players" : "No ratings available"}</p></CardBody></Card>
      </div>

      {locked && standings.length > 0 ? (
        <Card id="standings" className="scroll-mt-24 overflow-hidden">
          <CardHeader
            title="Fantasy standings"
            subtitle={`${standings.length} manager${standings.length === 1 ? "" : "s"} · open any row to see how each pick contributed`}
            headingLevel={2}
          />
          <CardBody className="p-0">
            <ol className="divide-y divide-line-soft">
            {standings.map((s, i) => (
              <li
                key={s.managerId}
                className={cn(
                  "px-4 py-3 text-sm sm:px-5",
                  i === 0 && "bg-accent/[0.04]",
                  viewer?.id === s.managerId && "bg-info/[0.07]",
                )}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full border text-xs font-bold tabular-nums", i === 0 ? "border-accent/50 bg-accent/15 text-accent" : "border-line bg-surface-2 text-muted")}>{i + 1}</span>
                  <Avatar name={managerName.get(s.managerId) ?? "?"} src={managerAvatar.get(s.managerId) ?? null} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <PlayerLink userId={s.managerId} className="min-w-0 truncate font-semibold">{managerName.get(s.managerId) ?? "?"}</PlayerLink>
                      {viewer?.id === s.managerId ? <Badge tone="info">You</Badge> : null}
                    </div>
                    <span className="text-xs text-muted">{s.breakdown.length} player{s.breakdown.length === 1 ? "" : "s"} scoring</span>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className={cn("font-display text-2xl font-semibold leading-none tabular-nums", i === 0 && "text-accent")}>{s.points}</div>
                    <div className="mt-1 text-[10px] uppercase tracking-wide text-muted">points</div>
                  </div>
                </div>
                <details className="mt-2 pl-11 text-xs">
                  <summary className="w-fit cursor-pointer py-1 font-medium text-info underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60">View fantasy five</summary>
                  <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-5">
                    {s.breakdown.map((b) => (
                      <div key={b.userId} className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-line bg-surface-2/45 px-2.5 py-2">
                        <PlayerLink userId={b.userId} className="min-w-0 truncate">{playerName.get(b.userId) ?? "?"}</PlayerLink>
                        <span className="shrink-0 font-mono tabular-nums">{b.points}</span>
                      </div>
                    ))}
                  </div>
                </details>
              </li>
            ))}
            </ol>
          </CardBody>
        </Card>
      ) : null}

      {!locked && rosters.length > 0 ? (
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              <b>{rosters.length}</b> manager
              {rosters.length === 1 ? " has" : "s have"} entered.
            </span>
            <span className="text-muted">
              Everyone else&apos;s five stays private until rosters lock.
            </span>
          </CardBody>
        </Card>
      ) : null}

      {locked && topScorers.length > 0 ? (
        <LeaderBoard
          id="scorers"
          title="Player scores"
          subtitle="Ranked by total points. Each row shows games played, points per game, strongest contribution, and how often the player was picked."
          rows={topScorers}
          headingLevel={2}
        />
      ) : locked && gameCount > 0 ? (
        <EmptyState title="No linked player scores yet" description="Imported games are present, but fantasy needs complete 5v5 box scores with league players linked before points appear." />
      ) : null}

      <section id="lineup" className="scroll-mt-24 space-y-4">
        <SectionTitle
          aside={
            readOnly
              ? "· archived — these were the final fives"
              : season.status === "COMPLETE"
                ? "· season complete — these are the final fives"
                : locked
                  ? "· locked for the season — scores update as games are imported"
                  : "· picks lock when the first game is imported"
          }
        >
          {myRoster
            ? "Your fantasy five"
            : locked
              ? "Fantasy fives"
              : "Pick your fantasy five"}
        </SectionTitle>

        {/* An archived season falls through to the `locked` branch instead:
            "Sign in to play fantasy" over a closed season promises a game that
            cannot be played — the same class as the SIGNUPS dashboard's ask
            with no control behind it. */}
        {!viewer && !locked ? (
          <EmptyState
            title="Sign in to play fantasy"
            description="Anyone with a Steam login can manage a fantasy five — you don't need to be on a team."
            action={
              <Link href="/login?next=/fantasy" className={textLink()}>
                Sign in →
              </Link>
            }
          />
        ) : locked ? (
          myRoster ? (
          <Card>
            <CardBody className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {myRoster.picks.map((p) => (
                  <div
                    key={p.id}
                    className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-2/50 p-2.5 text-sm"
                  >
                    <Avatar
                      name={p.player.name}
                      src={p.player.avatar}
                      size={28}
                    />
                    <span className="min-w-0 flex-1">
                      <PlayerLink userId={p.userId} className="block truncate font-medium">{p.player.name}</PlayerLink>
                      <span className="block text-xs text-muted">{playerTotals.get(p.userId)?.games ?? 0} games</span>
                    </span>
                    <span className="shrink-0 font-mono text-xs font-semibold tabular-nums">{playerPoints.get(p.userId) ?? 0}<span className="block text-[10px] font-normal text-muted">pts</span></span>
                  </div>
                ))}
              </CardBody>
            </Card>
          ) : !viewer ? (
            <EmptyState
              title={
                rosters.length > 0
                  ? isFinal
                    ? "Final fantasy fives"
                    : "Fantasy fives are locked"
                  : "No fantasy entries on record"
              }
              description={
                rosters.length > 0
                  ? "The standings above show every manager's locked five and current score."
                  : "Nobody submitted a fantasy five before entries locked."
              }
            />
          ) : (
            <EmptyState
              title={
                readOnly ? "No fantasy five on record" : "Rosters are locked"
              }
              description={
                readOnly
                  ? "This season's fantasy league is closed — the final standings are above."
                  : "The first game of the season is in — fantasy signups closed. Catch the next season!"
              }
            />
          )
        ) : (
          <Card tone="feature">
            <CardBody>
              <ActionForm
                action={saveFantasyRoster}
                hidden={{ expectedSeasonId: season.id }}
              >
                <FantasyPicker
                  candidates={candidates}
                  slots={FANTASY.SLOTS}
                  cap={cap}
                  initial={myPicks}
                  saveLabel={myRoster ? "Update fantasy five" : "Save fantasy five"}
                />
              </ActionForm>
            </CardBody>
          </Card>
        )}
      </section>
      <ScoringGuide />
    </div>
  );
}
