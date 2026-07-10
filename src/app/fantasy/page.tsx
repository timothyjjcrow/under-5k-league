import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import {
  fantasyCap,
  fantasyStandings,
  pointsByPlayer,
  type FantasyGame,
} from "@/lib/fantasy";
import { FANTASY } from "@/lib/constants";
import { saveFantasyRoster } from "@/app/actions/fantasy";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { FantasyPicker } from "@/components/fantasy-picker";
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
} from "@/components/ui";

export const metadata = { title: "Fantasy" };

function safeParse(json: string): FantasyGame["players"] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export default async function FantasyPage() {
  const season = await getActiveSeason();
  if (!season) {
    return (
      <div>
        <PageTitle title="Fantasy" />
        <EmptyState title="No active season" />
      </div>
    );
  }

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
    prisma.game.findMany({
      where: { match: { seasonId: season.id } },
      select: { players: true, radiantWin: true },
    }),
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
  const locked = games.length > 0;

  const playerPoints = pointsByPlayer(
    games.map((g) => ({ radiantWin: g.radiantWin, players: safeParse(g.players) })),
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
  const playerName = new Map(members.map((m) => [m.userId, m.user.name]));

  const myRoster = viewer ? rosters.find((r) => r.userId === viewer.id) : null;
  const myPicks = myRoster?.picks.map((p) => p.userId) ?? [];

  return (
    <div className="space-y-8">
      <PageTitle
        title="Fantasy"
        subtitle={`${season.name} · pick five under ${cap.toLocaleString()} MMR — points from real games`}
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
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm"
              >
                <span className="w-6 text-center text-muted">{i + 1}</span>
                <Avatar
                  name={managerName.get(s.managerId) ?? "?"}
                  src={managerAvatar.get(s.managerId) ?? null}
                  size={24}
                />
                <PlayerLink
                  userId={s.managerId}
                  className="min-w-0 flex-1 truncate font-medium"
                >
                  {managerName.get(s.managerId) ?? "?"}
                </PlayerLink>
                <span className="hidden flex-wrap gap-1 text-xs text-muted sm:flex">
                  {s.breakdown.slice(0, 5).map((b) => (
                    <span
                      key={b.userId}
                      className="rounded bg-surface-2 px-1.5 py-0.5"
                    >
                      {playerName.get(b.userId) ?? "?"}{" "}
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

      <section className="space-y-4">
        <SectionTitle
          aside={
            locked
              ? "· locked for the season — scores update as games are imported"
              : "· picks lock when the first game is imported"
          }
        >
          {myRoster ? "Your fantasy five" : "Pick your fantasy five"}
        </SectionTitle>

        {!viewer ? (
          <EmptyState
            title="Sign in to play fantasy"
            description="Anyone with a Steam login can manage a fantasy five — you don't need to be on a team."
            action={
              <Link href="/login" className="text-info hover:underline">
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
                    {p.player.name}
                    <span className="font-mono text-xs tabular-nums text-muted">
                      {playerPoints.get(p.userId) ?? 0} pts
                    </span>
                  </span>
                ))}
              </CardBody>
            </Card>
          ) : (
            <EmptyState
              title="Rosters are locked"
              description="The first game of the season is in — fantasy signups closed. Catch the next season!"
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
