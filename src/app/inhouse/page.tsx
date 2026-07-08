import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { INHOUSE_STATUS } from "@/lib/constants";
import { summarizeInhouse, type FinishedLobby } from "@/lib/inhouse-stats";
import { heroById } from "@/lib/heroes";
import { InhouseRoom } from "@/components/inhouse-room";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  HeroIcon,
  PageTitle,
  PlayerLink,
} from "@/components/ui";
import { cn } from "@/lib/utils";

// One per-player line of a stored inhouse box score (see inhouse-service).
type BoxPlayer = {
  userId: string | null;
  name: string | null;
  team: number | null;
  isRadiant: boolean;
  heroId: number;
  kills: number;
  deaths: number;
  assists: number;
  netWorth: number | null;
  gpm: number | null;
};

function parseBox(json: string): BoxPlayer[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as BoxPlayer[]) : [];
  } catch {
    return [];
  }
}

export const metadata = { title: "Inhouse · Under 5k League" };

export default async function InhousePage() {
  const user = await getSessionUser();

  // Seed the MMR field from the player's most recent league signup, if any.
  const lastReg = user
    ? await prisma.registration.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        select: { mmr: true },
      })
    : null;

  const completed = await prisma.inhouseLobby.findMany({
    where: { status: INHOUSE_STATUS.COMPLETED },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { players: { include: { user: true } } },
  });

  const finished: FinishedLobby[] = completed.map((l) => ({
    id: l.id,
    winnerTeam: l.winnerTeam,
    createdAt: l.createdAt,
    players: l.players.map((p) => ({
      userId: p.userId,
      name: p.user.name,
      avatar: p.user.avatar,
      team: p.team,
    })),
  }));
  const leaderboard = summarizeInhouse(finished);

  // Recent games that have a fetched box score → rich result cards.
  const results = completed
    .map((l) => ({ lobby: l, players: parseBox(l.boxScore) }))
    .filter((r) => r.players.length > 0)
    .slice(0, 4);
  const avatarIds = [
    ...new Set(
      results.flatMap((r) =>
        r.players.map((p) => p.userId).filter((x): x is string => !!x),
      ),
    ),
  ];
  const avatarUsers = avatarIds.length
    ? await prisma.user.findMany({
        where: { id: { in: avatarIds } },
        select: { id: true, avatar: true },
      })
    : [];
  const avatarMap = new Map(avatarUsers.map((u) => [u.id, u.avatar]));

  return (
    <div className="space-y-8">
      <PageTitle
        title="Inhouse"
        subtitle="Pick-up games, drafted live. Queue up, get captained, and play — no season required."
        action={<Badge tone="accent">Casual mode</Badge>}
      />

      <InhouseRoom defaultMmr={lastReg?.mmr ?? 0} />

      <OpenDotaGuide />

      {results.length > 0 ? (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Recent results</h2>
          {results.map((r) => (
            <GameResultCard
              key={r.lobby.id}
              lobby={r.lobby}
              players={r.players}
              avatarMap={avatarMap}
            />
          ))}
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="Inhouse leaderboard"
          subtitle="All-time records across completed inhouse games"
        />
        <CardBody className="p-0">
          <Leaderboard rows={leaderboard} meId={user?.id ?? null} />
        </CardBody>
      </Card>
    </div>
  );
}

// ---------- OpenDota "be findable" guide ----------

function OpenDotaGuide() {
  return (
    <details
      open
      className="group rounded-[var(--radius)] border border-line bg-surface/80 shadow-sm backdrop-blur"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-info/15 text-info">
            🔎
          </span>
          <div>
            <h3 className="text-base font-semibold text-fg">
              Make your games auto-detect
            </h3>
            <p className="mt-0.5 text-sm text-muted">
              Inhouse results are pulled from OpenDota — here&apos;s how to be
              findable.
            </p>
          </div>
        </div>
        <span className="shrink-0 text-muted transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="space-y-3 border-t border-line px-5 py-4 text-sm">
        <ol className="space-y-3">
          <li className="flex gap-3">
            <GuideStep n={1} />
            <span>
              In Dota 2, open <b>Settings → Options</b> and turn on{" "}
              <b>&ldquo;Expose Public Match Data&rdquo;</b>. This lets OpenDota
              (and us) see your match history.
            </span>
          </li>
          <li className="flex gap-3">
            <GuideStep n={2} />
            <span>
              Link your Dota account on your{" "}
              <Link href="/me" className="text-info hover:underline">
                profile
              </Link>{" "}
              so we can match you in games — or we derive it from your Steam ID.
            </span>
          </li>
          <li className="flex gap-3">
            <GuideStep n={3} />
            <span>
              Play your inhouse. When it ends, the result is fetched from OpenDota
              automatically (usually within a few minutes) — or anyone in the game
              can paste the match ID.
            </span>
          </li>
        </ol>
        <p className="rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-xs text-muted">
          Not everyone needs this on — a few players per side is enough — but the
          more the better. It only exposes games played <b>after</b> you enable
          it, and OpenDota can take a few minutes to index a finished game.
        </p>
      </div>
    </details>
  );
}

function GuideStep({ n }: { n: number }) {
  return (
    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-accent/40 bg-accent/10 text-xs font-semibold text-accent">
      {n}
    </span>
  );
}

// ---------- Box-score result card ----------

function GameResultCard({
  lobby,
  players,
  avatarMap,
}: {
  lobby: {
    id: string;
    winnerTeam: number | null;
    radiantTeam: number;
    dotaMatchId: string | null;
    durationSecs: number | null;
    radiantScore: number | null;
    direScore: number | null;
  };
  players: BoxPlayer[];
  avatarMap: Map<string, string | null>;
}) {
  const radiantWin = lobby.winnerTeam != null && lobby.winnerTeam === lobby.radiantTeam;
  const radiant = players.filter((p) => p.isRadiant);
  const dire = players.filter((p) => !p.isRadiant);
  const dur = lobby.durationSecs ?? 0;
  const durStr = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex items-center gap-3">
          <span className={cn("text-sm font-semibold", radiantWin ? "text-success" : "text-muted")}>
            Radiant
          </span>
          <span className="font-mono text-xl font-bold tabular-nums">
            {lobby.radiantScore ?? 0}
            <span className="px-1.5 text-muted">–</span>
            {lobby.direScore ?? 0}
          </span>
          <span className={cn("text-sm font-semibold", !radiantWin ? "text-danger" : "text-muted")}>
            Dire
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <Badge tone={radiantWin ? "success" : "danger"}>
            {radiantWin ? "Radiant" : "Dire"} victory
          </Badge>
          <span className="tabular-nums">{durStr}</span>
          {lobby.dotaMatchId ? (
            <a
              href={`https://www.opendota.com/matches/${lobby.dotaMatchId}`}
              target="_blank"
              rel="noreferrer"
              className="text-info hover:underline"
            >
              OpenDota ↗
            </a>
          ) : null}
        </div>
      </div>
      <CardBody className="grid gap-4 md:grid-cols-2">
        <SideBox label="Radiant" win={radiantWin} players={radiant} avatarMap={avatarMap} />
        <SideBox label="Dire" win={!radiantWin} players={dire} avatarMap={avatarMap} />
      </CardBody>
    </Card>
  );
}

function SideBox({
  label,
  win,
  players,
  avatarMap,
}: {
  label: string;
  win: boolean;
  players: BoxPlayer[];
  avatarMap: Map<string, string | null>;
}) {
  const isRadiant = label === "Radiant";
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        win
          ? isRadiant
            ? "border-success/40 bg-success/5"
            : "border-danger/40 bg-danger/5"
          : "border-line",
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <span className={cn("h-2.5 w-2.5 rounded-full", isRadiant ? "bg-success" : "bg-danger")} />
          {label}
        </span>
        <Badge tone={win ? "success" : "neutral"}>{win ? "Win" : "Loss"}</Badge>
      </div>
      <ul className="space-y-1">
        {players.map((p, i) => {
          const hero = heroById(p.heroId);
          return (
            <li key={i} className="flex items-center gap-2 text-sm">
              {hero ? (
                <HeroIcon hero={hero} size={26} />
              ) : (
                <span className="h-[26px] w-[26px] shrink-0 rounded-md border border-line/70 bg-surface-2" />
              )}
              {p.userId ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <Avatar name={p.name ?? "?"} src={avatarMap.get(p.userId) ?? null} size={18} />
                  <PlayerLink userId={p.userId} className="truncate">
                    {p.name ?? "Unknown"}
                  </PlayerLink>
                </span>
              ) : (
                <span className="truncate text-muted">{p.name ?? "Unknown"}</span>
              )}
              <span className="ml-auto shrink-0 font-mono text-xs tabular-nums">
                <span className="text-fg">{p.kills}</span>
                <span className="text-muted">/{p.deaths}/</span>
                <span className="text-muted">{p.assists}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Leaderboard({
  rows,
  meId,
}: {
  rows: ReturnType<typeof summarizeInhouse>;
  meId: string | null;
}) {
  if (rows.length === 0) {
    return (
      <div className="p-5">
        <EmptyState
          title="No games played yet"
          description="Win some inhouses to climb the board."
        />
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs uppercase text-muted">
          <th className="px-5 py-2.5 font-medium">#</th>
          <th className="px-2 py-2.5 font-medium">Player</th>
          <th className="px-2 py-2.5 text-center font-medium">W</th>
          <th className="px-2 py-2.5 text-center font-medium">L</th>
          <th className="px-2 py-2.5 text-center font-medium">Win%</th>
          <th className="px-2 py-2.5 text-center font-medium">Streak</th>
          <th className="px-5 py-2.5 text-right font-medium">GP</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={r.userId}
            className={cn(
              "border-b border-line/50 last:border-0",
              r.userId === meId ? "bg-accent/5" : "",
            )}
          >
            <td className="px-5 py-2.5 text-muted tabular-nums">{i + 1}</td>
            <td className="px-2 py-2.5">
              <span className="flex items-center gap-2">
                <Avatar name={r.name} src={r.avatar} size={24} />
                <PlayerLink userId={r.userId} className="font-medium">
                  {r.name}
                </PlayerLink>
              </span>
            </td>
            <td className="px-2 py-2.5 text-center text-success">{r.wins}</td>
            <td className="px-2 py-2.5 text-center text-muted">{r.losses}</td>
            <td className="px-2 py-2.5 text-center tabular-nums">
              {Math.round(r.winRate * 100)}%
            </td>
            <td className="px-2 py-2.5 text-center">
              {r.streak !== 0 ? (
                <span
                  className={cn(
                    "font-medium tabular-nums",
                    r.streak > 0 ? "text-success" : "text-danger",
                  )}
                >
                  {r.streak > 0 ? `W${r.streak}` : `L${-r.streak}`}
                </span>
              ) : (
                <span className="text-muted">—</span>
              )}
            </td>
            <td className="px-5 py-2.5 text-right tabular-nums">{r.games}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

