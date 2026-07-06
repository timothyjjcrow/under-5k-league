import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getHeroNames } from "@/lib/dota";
import type { PlayerStat } from "@/lib/match-import";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  buttonClasses,
} from "@/components/ui";

export const metadata = { title: "Match · Under 5k League" };

export default async function MatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const match = await prisma.match.findUnique({
    where: { id },
    include: {
      homeTeam: true,
      awayTeam: true,
      games: { orderBy: { startTime: "asc" } },
    },
  });
  if (!match) notFound();

  const heroes = await getHeroNames();
  const games = match.games.map((g) => ({
    ...g,
    parsed: safeParse(g.players),
  }));

  const userIds = [
    ...new Set(
      games.flatMap((g) => g.parsed.map((p) => p.userId).filter(Boolean)),
    ),
  ] as string[];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } } })
    : [];
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const userAvatar = new Map(users.map((u) => [u.id, u.avatar]));
  const teamName = new Map([
    [match.homeTeamId, match.homeTeam.name],
    [match.awayTeamId, match.awayTeam.name],
  ]);

  return (
    <div className="space-y-6">
      <PageTitle
        title={`${match.homeTeam.name} vs ${match.awayTeam.name}`}
        subtitle={`Week ${match.week}${match.phase !== "REGULAR" ? ` · ${match.phase}` : ""}`}
        action={
          <Link href="/schedule" className={buttonClasses("secondary", "sm")}>
            ← Schedule
          </Link>
        }
      />

      <Card>
        <CardBody className="flex items-center justify-center gap-6 py-6">
          <TeamSide name={match.homeTeam.name} score={match.homeScore} win={match.winnerTeamId === match.homeTeamId} />
          <span className="text-sm text-muted">series</span>
          <TeamSide name={match.awayTeam.name} score={match.awayScore} win={match.winnerTeamId === match.awayTeamId} right />
        </CardBody>
      </Card>

      {games.length === 0 ? (
        <EmptyState
          title="No games recorded yet"
          description="Games are pulled from Dota (OpenDota) once the match has been played."
        />
      ) : (
        games.map((g, i) => {
          const radiant = g.parsed.filter((p) => p.isRadiant);
          const dire = g.parsed.filter((p) => !p.isRadiant);
          const winnerName = g.winnerTeamId ? teamName.get(g.winnerTeamId) : null;
          return (
            <Card key={g.id}>
              <CardHeader
                title={`Game ${i + 1}`}
                subtitle={`${Math.floor(g.durationSecs / 60)}m ${g.durationSecs % 60}s · ${g.radiantScore}-${g.direScore} kills`}
                action={
                  <div className="flex items-center gap-2">
                    {winnerName ? <Badge tone="success">{winnerName} won</Badge> : null}
                    <a
                      href={`https://www.opendota.com/matches/${g.dotaMatchId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-info hover:underline"
                    >
                      OpenDota ↗
                    </a>
                  </div>
                }
              />
              <CardBody className="grid gap-6 md:grid-cols-2">
                <SidePlayers
                  label={g.radiantTeamId ? teamName.get(g.radiantTeamId) ?? "Radiant" : "Radiant"}
                  win={g.radiantWin}
                  players={radiant}
                  heroes={heroes}
                  userName={userName}
                  userAvatar={userAvatar}
                />
                <SidePlayers
                  label={g.direTeamId ? teamName.get(g.direTeamId) ?? "Dire" : "Dire"}
                  win={!g.radiantWin}
                  players={dire}
                  heroes={heroes}
                  userName={userName}
                  userAvatar={userAvatar}
                />
              </CardBody>
            </Card>
          );
        })
      )}
    </div>
  );
}

function TeamSide({
  name,
  score,
  win,
  right,
}: {
  name: string;
  score: number;
  win: boolean;
  right?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 ${right ? "flex-row-reverse" : ""}`}>
      <span className={`text-lg font-semibold ${win ? "text-fg" : "text-muted"}`}>
        {name}
      </span>
      <span className="text-3xl font-bold tabular-nums">{score}</span>
    </div>
  );
}

function SidePlayers({
  label,
  win,
  players,
  heroes,
  userName,
  userAvatar,
}: {
  label: string;
  win: boolean;
  players: PlayerStat[];
  heroes: Record<number, string>;
  userName: Map<string, string>;
  userAvatar: Map<string, string | null>;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold">{label}</span>
        {win ? <Badge tone="success">Win</Badge> : <Badge>Loss</Badge>}
      </div>
      <div className="space-y-1">
        {players.map((p, idx) => {
          const displayName = p.userId
            ? (userName.get(p.userId) ?? p.personaname ?? "Unknown")
            : (p.personaname ?? "Unknown");
          return (
            <div
              key={idx}
              className="flex items-center justify-between rounded-md border border-line/60 px-2.5 py-1.5 text-sm"
            >
              <span className="flex min-w-0 items-center gap-2">
                {p.userId ? (
                  <Avatar name={displayName} src={userAvatar.get(p.userId) ?? null} size={20} />
                ) : null}
                <span className="truncate">{displayName}</span>
                <span className="shrink-0 text-xs text-muted">
                  {heroes[p.heroId] ?? `Hero ${p.heroId}`}
                </span>
              </span>
              <span className="shrink-0 font-mono text-xs">
                {p.kills}/{p.deaths}/{p.assists}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function safeParse(json: string): PlayerStat[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
