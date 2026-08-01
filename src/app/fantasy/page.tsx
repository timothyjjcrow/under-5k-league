import Link from "next/link";
import { notFound } from "next/navigation";
import { getSeasonGameScores } from "@/lib/cached-queries";
import { parseGamePlayers } from "@/lib/player-stats";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import {
  fantasyCap,
  fantasyStandings,
  ownershipByPlayer,
  pointsByPlayer,
  type FantasyGame,
} from "@/lib/fantasy";
import { FANTASY } from "@/lib/constants";
import { saveFantasyRoster } from "@/app/actions/fantasy";
import { ActionForm, SubmitButton } from "@/components/action-form";
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

export const metadata = { title: "Fantasy" };


export default async function FantasyPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season: seasonParam } = await searchParams;
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
  const [members, regs, games, rosters] = await Promise.all([
    prisma.teamMember.findMany({
      where: { seasonId: season.id },
      include: { user: true, team: true },
      orderBy: { price: "desc" },
    }),
    prisma.registration.findMany({
      where: { seasonId: season.id, status: "ACTIVE" },
      select: { userId: true, mmr: true },
    }),
    getSeasonGameScores(season.id),
    prisma.fantasyRoster.findMany({
      where: { seasonId: season.id },
      include: { user: true, picks: { include: { player: true } } },
    }),
  ]);

  if (members.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle title="Fantasy" subtitle={season.name} />
        <EmptyState
          title="Fantasy opens after the draft"
          description="Once teams are drafted you'll pick a fantasy five from the rosters — points score from their real games."
        />
      </div>
    );
  }

  const mmrByUser = new Map(regs.map((r) => [r.userId, r.mmr]));
  const candidates = members.map((m) => ({
    userId: m.userId,
    name: m.user.name,
    avatar: m.user.avatar,
    rankTier: m.user.rankTier,
    mmr: mmrByUser.get(m.userId) ?? 0,
    teamName: m.team.name,
    isCaptain: m.isCaptain,
  }));
  const cap = fantasyCap(candidates.map((c) => c.mmr));
  // `readOnly` folds into `locked`, which is the ONE branch that decides
  // whether the picker renders. That makes the archived view structurally
  // read-only rather than visually so: there is no path to a FantasyPicker
  // whose submit would edit the CURRENT season (saveFantasyRoster resolves
  // the active season itself and would accept it silently).
  const locked = readOnly || games.length > 0;

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
        teamName: "released",
        isCaptain: false,
      });
    }
  }

  const playerPoints = pointsByPlayer(
    games.map((g) => ({ radiantWin: g.radiantWin, players: parseGamePlayers<FantasyGame["players"][number]>(g.players) })),
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
      return {
        id: userId,
        name: m?.user.name ?? playerName.get(userId) ?? "?",
        avatar: m?.user.avatar ?? null,
        rankTier: m?.user.rankTier ?? null,
        value: points,
        valueLabel: `${points} pts`,
        hint: m ? `picked by ${pct}% · ${m.team.name}` : `picked by ${pct}%`,
        isViewer: viewer?.id === userId,
      };
    });

  return (
    <div className="space-y-8">
      <PageTitle
        title="Fantasy"
        // cap 0 = no roster MMRs are known — "under 0 MMR" would read as
        // nonsense, so drop the cap phrasing until there's a real number.
        subtitle={`${season.name} · ${
          cap > 0
            ? `pick five under ${cap.toLocaleString()} MMR`
            : "pick your fantasy five"
        } — points from real games`}
        action={
          locked ? (
            <Badge tone="accent">Rosters locked</Badge>
          ) : (
            <Badge tone="info">Picks open</Badge>
          )
        }
      />

      {standings.length > 0 ? (
        <Card>
          <CardHeader
            title="Fantasy standings"
            subtitle={`${standings.length} manager${standings.length === 1 ? "" : "s"} · scoring: ${FANTASY.KILL}/kill, ${FANTASY.ASSIST}/assist, ${FANTASY.DEATH}/death, +${FANTASY.WIN}/win, economy bonus`}
          />
          <CardBody className="divide-y divide-line/60 p-0">
            {standings.map((s, i) => (
              <div
                key={s.managerId}
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm",
                  viewer?.id === s.managerId && "bg-info/[0.07]",
                )}
              >
                <span className="w-6 text-center text-muted">{i + 1}</span>
                <Avatar
                  name={managerName.get(s.managerId) ?? "?"}
                  src={managerAvatar.get(s.managerId) ?? null}
                  size={24}
                />
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <PlayerLink
                    userId={s.managerId}
                    className="min-w-0 truncate font-medium"
                  >
                    {managerName.get(s.managerId) ?? "?"}
                  </PlayerLink>
                  {viewer?.id === s.managerId ? (
                    <span className="shrink-0 rounded bg-info/20 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-info">
                      You
                    </span>
                  ) : null}
                </span>
                <span className="hidden flex-wrap gap-1 text-xs text-muted sm:flex">
                  {s.breakdown.slice(0, 5).map((b) => (
                    <span
                      key={b.userId}
                      className="rounded bg-surface-2 px-1.5 py-0.5"
                    >
                      <PlayerLink userId={b.userId}>
                        {playerName.get(b.userId) ?? "?"}
                      </PlayerLink>{" "}
                      <span className="font-mono tabular-nums">{b.points}</span>
                    </span>
                  ))}
                </span>
                <span className="shrink-0 font-mono text-base font-semibold tabular-nums">
                  {s.points}
                </span>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {locked && topScorers.length > 0 ? (
        <LeaderBoard
          title="Top scorers"
          subtitle={`fantasy points from every imported game · ownership across ${rosters.length} roster${rosters.length === 1 ? "" : "s"}`}
          rows={topScorers}
        />
      ) : null}

      <section className="space-y-4">
        <SectionTitle
          aside={
            readOnly
              ? "· archived — these were the final fives"
              : locked
                ? "· locked for the season — scores update as games are imported"
                : "· picks lock when the first game is imported"
          }
        >
          {myRoster
            ? "Your fantasy five"
            : readOnly
              ? "Fantasy fives"
              : "Pick your fantasy five"}
        </SectionTitle>

        {/* An archived season falls through to the `locked` branch instead:
            "Sign in to play fantasy" over a closed season promises a game that
            cannot be played — the same class as the SIGNUPS dashboard's ask
            with no control behind it. */}
        {!viewer && !readOnly ? (
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
              <CardBody className="flex flex-wrap gap-2">
                {myRoster.picks.map((p) => (
                  <span
                    key={p.id}
                    className="flex items-center gap-2 rounded-full border border-line bg-surface-2/50 py-1 pl-1 pr-3 text-sm"
                  >
                    <Avatar name={p.player.name} src={p.player.avatar} size={24} />
                    <PlayerLink userId={p.userId}>{p.player.name}</PlayerLink>
                    <span className="font-mono text-xs tabular-nums text-muted">
                      {playerPoints.get(p.userId) ?? 0} pts
                    </span>
                  </span>
                ))}
              </CardBody>
            </Card>
          ) : (
            <EmptyState
              title={readOnly ? "No fantasy five on record" : "Rosters are locked"}
              description={
                readOnly
                  ? "This season's fantasy league is closed — the final standings are above."
                  : "The first game of the season is in — fantasy signups closed. Catch the next season!"
              }
            />
          )
        ) : (
          <Card>
            <CardBody>
              <ActionForm action={saveFantasyRoster} className="space-y-4">
                <FantasyPicker
                  candidates={candidates}
                  slots={FANTASY.SLOTS}
                  cap={cap}
                  initial={myPicks}
                />
                <SubmitButton variant="accent">
                  {myRoster ? "Update fantasy five" : "Save fantasy five"}
                </SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        )}
      </section>
    </div>
  );
}
