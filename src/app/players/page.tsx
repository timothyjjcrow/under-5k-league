import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { steamIdToAccountId } from "@/lib/dota";
import { PlayerPool, type PoolDraftInfo } from "@/components/player-pool";
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
  RankBadge,
  RoleBadges,
  SectionTitle,
  TeamCrest,
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

  const viewer = await getSessionUser();

  const [players, standins, teams, viewerReg] = await Promise.all([
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
    viewer
      ? prisma.registration.findUnique({
          where: {
            seasonId_userId: { seasonId: season.id, userId: viewer.id },
          },
        })
      : Promise.resolve(null),
  ]);

  const draftDone = teams.length > 0 && season.status !== "DRAFT";
  const draftedUserIds = new Set(
    teams.flatMap((t) => t.members.map((m) => m.userId)),
  );
  // Who drafted each rostered player, so the pool list can chip the team
  // (captains have no draft price → null suppresses the "$0").
  const draftInfo: PoolDraftInfo = {};
  for (const t of teams) {
    for (const m of t.members) {
      draftInfo[m.userId] = {
        teamId: t.id,
        teamName: t.name,
        price: m.isCaptain ? null : m.price,
      };
    }
  }
  // During SIGNUPS this is where shared links land — offer a join affordance
  // unless the viewer already holds an ACTIVE registration (/me covers login).
  const canSignUp =
    season.status === "SIGNUPS" && viewerReg?.status !== "ACTIVE";
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
    // Contact info is for league members, not the public internet.
    discordName: viewer ? p.user.discordName : "",
  }));
  const captainHopefuls = players.filter((p) => p.wantsCaptain);
  const preDraft = season.status === "SIGNUPS" || season.status === "DRAFT";

  return (
    <div className="space-y-8">
      <PageTitle
        title="Players"
        subtitle={`${season.name} · ${players.length} players, ${standins.length} standins`}
        action={
          <span className="flex flex-wrap items-center gap-3">
            {canSignUp ? (
              <Link href="/me" className={buttonClasses("primary", "sm")}>
                Join the season →
              </Link>
            ) : null}
            <Link
              href="/players/compare"
              className="text-sm text-info hover:underline"
            >
              Compare players →
            </Link>
          </span>
        }
      />

      {teams.length > 0 ? (
        <section className="space-y-4">
          <SectionTitle>Teams</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {teams.map((t) => (
              <Card key={t.id} interactive>
                <CardHeader
                  title={
                    <Link
                      href={`/teams/${t.id}`}
                      className="flex items-center gap-2 hover:text-info"
                    >
                      <TeamCrest
                        name={t.name}
                        seed={t.id}
                        size={24}
                        className="rounded-md"
                      />
                      {t.name}
                    </Link>
                  }
                  subtitle={`${t.members.length}/${season.teamSize} players`}
                  action={
                    season.status === "DRAFT" ? (
                      <Badge tone="accent">${t.budget} left</Badge>
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
          <SectionTitle
            aside={`· ${captainHopefuls.length} volunteered to lead a team`}
          >
            Captain hopefuls
          </SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            {captainHopefuls.map((p) => {
              const accountId =
                p.user.dotaAccountId ?? steamIdToAccountId(p.user.steamId);
              return (
                <Card key={p.id} interactive>
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
                        {p.mmr > 0 ? <span>{p.mmr} MMR</span> : null}
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
        <SectionTitle>
          {draftDone ? "Player pool" : "Signed up to play"}
        </SectionTitle>
        {players.length === 0 ? (
          <EmptyState
            title="No players yet"
            description="Signups will appear here."
          />
        ) : (
          <PlayerPool
            players={poolPlayers}
            showDraftStatus={season.status !== "SIGNUPS"}
            draftInfo={draftInfo}
          />
        )}
      </section>

      <section className="space-y-4">
        <SectionTitle>Standins</SectionTitle>
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
                {s.mmr > 0 ? (
                  <span className="text-xs text-muted">{s.mmr}</span>
                ) : null}
              </PlayerLink>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
