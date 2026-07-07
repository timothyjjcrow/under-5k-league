import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { steamIdToAccountId } from "@/lib/dota";
import { PlayerPool } from "@/components/player-pool";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  PlayerLink,
  RankBadge,
  RoleBadges,
} from "@/components/ui";

export const metadata = { title: "Players" };

export default async function PlayersPage() {
  const season = await getActiveSeason();
  if (!season) {
    return (
      <div>
        <PageTitle title="Players" />
        <EmptyState title="No active season" />
      </div>
    );
  }

  const [players, standins, teams] = await Promise.all([
    prisma.registration.findMany({
      where: { seasonId: season.id, status: "ACTIVE", type: "PLAYER" },
      include: { user: true },
      orderBy: { mmr: "desc" },
    }),
    prisma.registration.findMany({
      where: { seasonId: season.id, status: "ACTIVE", type: "STANDIN" },
      include: { user: true },
      orderBy: { mmr: "desc" },
    }),
    prisma.team.findMany({
      where: { seasonId: season.id },
      orderBy: { draftOrder: "asc" },
      include: {
        captain: true,
        members: { include: { user: true }, orderBy: { price: "desc" } },
      },
    }),
  ]);

  const draftDone = teams.length > 0 && season.status !== "DRAFT";
  const draftedUserIds = new Set(
    teams.flatMap((t) => t.members.map((m) => m.userId)),
  );
  const poolPlayers = players.map((p) => ({
    userId: p.userId,
    name: p.user.name,
    avatar: p.user.avatar,
    mmr: p.mmr,
    rankTier: p.user.rankTier,
    roles: p.roles,
    favoriteHeroes: p.favoriteHeroes,
    captainNote: p.captainNote,
    wantsCaptain: p.wantsCaptain,
    drafted: draftedUserIds.has(p.userId),
    accountId: p.user.dotaAccountId ?? steamIdToAccountId(p.user.steamId),
  }));
  const captainHopefuls = players.filter((p) => p.wantsCaptain);
  const preDraft = season.status === "SIGNUPS" || season.status === "DRAFT";

  return (
    <div className="space-y-8">
      <PageTitle
        title="Players"
        subtitle={`${season.name} · ${players.length} players, ${standins.length} standins`}
      />

      {teams.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Teams</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {teams.map((t) => (
              <Card key={t.id}>
                <CardHeader
                  title={
                    <Link href={`/teams/${t.id}`} className="hover:text-info">
                      {t.name}
                    </Link>
                  }
                  subtitle={`${t.members.length}/${season.teamSize} players`}
                  action={
                    season.status === "DRAFT" ? (
                      <Badge tone="accent">${t.budget}</Badge>
                    ) : null
                  }
                />
                <CardBody className="space-y-1.5">
                  {t.members.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="flex items-center gap-2">
                        <Avatar name={m.user.name} src={m.user.avatar} size={24} />
                        <PlayerLink userId={m.userId}>{m.user.name}</PlayerLink>
                        {m.isCaptain ? <Badge tone="accent">Captain</Badge> : null}
                        <RankBadge rankTier={m.user.rankTier} />
                      </span>
                      <span className="text-muted">
                        {m.isCaptain ? "—" : `$${m.price}`}
                      </span>
                    </div>
                  ))}
                </CardBody>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {preDraft && captainHopefuls.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">
            Captain hopefuls{" "}
            <span className="text-sm font-normal text-muted">
              · {captainHopefuls.length} volunteered to lead a team
            </span>
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {captainHopefuls.map((p) => {
              const accountId =
                p.user.dotaAccountId ?? steamIdToAccountId(p.user.steamId);
              return (
                <Card key={p.id}>
                  <CardBody className="flex items-start gap-3">
                    <PlayerLink userId={p.userId}>
                      <Avatar name={p.user.name} src={p.user.avatar} size={40} />
                    </PlayerLink>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <PlayerLink userId={p.userId} className="font-medium">
                          {p.user.name}
                        </PlayerLink>
                        <Badge tone="brand">Wants to captain</Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                        {p.mmr} MMR
                        <RankBadge rankTier={p.user.rankTier} />
                        <RoleBadges roles={p.roles} />
                        {accountId ? (
                          <a
                            href={`https://www.dotabuff.com/players/${accountId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-info hover:underline"
                          >
                            Dotabuff ↗
                          </a>
                        ) : null}
                      </div>
                      {p.captainNote ? (
                        <p className="mt-1.5 line-clamp-2 text-xs italic text-muted">
                          &ldquo;{p.captainNote}&rdquo;
                        </p>
                      ) : null}
                    </div>
                  </CardBody>
                </Card>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">
          {draftDone ? "Player pool" : "Signed up to play"}
        </h2>
        {players.length === 0 ? (
          <EmptyState
            title="No players yet"
            description="Signups will appear here."
          />
        ) : (
          <PlayerPool
            players={poolPlayers}
            showDraftStatus={season.status !== "SIGNUPS"}
          />
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Standins</h2>
        {standins.length === 0 ? (
          <EmptyState
            title="No standins yet"
            description="Standins fill in when a rostered player can't make a match."
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {standins.map((s) => (
              <PlayerLink
                key={s.id}
                userId={s.userId}
                className="flex items-center gap-2 rounded-full border border-line bg-surface-2/50 py-1 pl-1 pr-3 hover:border-muted/60 hover:no-underline"
              >
                <Avatar name={s.user.name} src={s.user.avatar} size={26} />
                <span className="text-sm">{s.user.name}</span>
                <RankBadge rankTier={s.user.rankTier} />
                <span className="text-xs text-muted">{s.mmr}</span>
              </PlayerLink>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
