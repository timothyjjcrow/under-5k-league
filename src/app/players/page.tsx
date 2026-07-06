import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { parseRoles } from "@/lib/roles";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  RankBadge,
} from "@/components/ui";

export const metadata = { title: "Players · Under 5k League" };

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
                        {m.user.name}
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
          <Card>
            <CardBody className="p-0">
              <ul className="divide-y divide-line/60">
                {players.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between px-5 py-3"
                  >
                    <span className="flex items-center gap-3">
                      <Avatar name={p.user.name} src={p.user.avatar} size={32} />
                      <span>
                        <span className="block text-sm font-medium">
                          {p.user.name}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                          {p.mmr} MMR
                          <RankBadge rankTier={p.user.rankTier} />
                          {parseRoles(p.roles).length > 0 ? (
                            <span>Pos {parseRoles(p.roles).join("/")}</span>
                          ) : null}
                        </span>
                        {p.favoriteHeroes ? (
                          <span className="mt-0.5 block text-xs text-muted">
                            Heroes: {p.favoriteHeroes}
                          </span>
                        ) : null}
                        {p.captainNote ? (
                          <span className="mt-0.5 block max-w-xl text-xs italic text-muted">
                            &ldquo;{p.captainNote}&rdquo;
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      {p.wantsCaptain ? (
                        <Badge tone="brand">Wants captain</Badge>
                      ) : null}
                      {draftedUserIds.has(p.userId) ? (
                        <Badge tone="success">Drafted</Badge>
                      ) : season.status !== "SIGNUPS" ? (
                        <Badge>Undrafted</Badge>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
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
              <div
                key={s.id}
                className="flex items-center gap-2 rounded-full border border-line bg-surface-2/50 py-1 pl-1 pr-3"
              >
                <Avatar name={s.user.name} src={s.user.avatar} size={26} />
                <span className="text-sm">{s.user.name}</span>
                <RankBadge rankTier={s.user.rankTier} />
                <span className="text-xs text-muted">{s.mmr}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
