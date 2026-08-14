import Link from "next/link";
import { Suspense } from "react";
import { hasText } from "@/lib/utils";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { effectiveDotaAccountId } from "@/lib/dota-account";
import { PlayerPool, type PoolDraftInfo } from "@/components/player-pool";
import { averageMmr } from "@/lib/pool-stats";
import { loadInhouseLadder } from "@/lib/inhouse-ladder";
import {
  buildPoolInhouseInfo,
  inhouseTitle,
  inhouseToken,
  pubHeroTitle,
  pubTitle,
  pubToken,
  type PoolScout,
  type PoolScoutInfo,
} from "@/lib/player-pool";
import { poolPubRecord } from "@/lib/pub-stats";
import { heroById } from "@/lib/heroes";
import { REGISTRATION_STATUS } from "@/lib/constants";
import { playerDirectoryPresentation } from "@/lib/player-directory-lifecycle";
import {
  canViewLeagueContact,
  canViewLeagueDirectoryContact,
} from "@/lib/visibility";
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
  RankBadge,
  RoleBadges,
  SectionTitle,
  Skeleton,
  StatCell,
  StatStrip,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";

export const metadata = { title: "Players" };

export default async function PlayersPage() {
  const season = await getActiveSeason();
  if (!season) {
    return (
      <div className="space-y-6">
        <PageTitle title="Players" />
        <EmptyState
          title="League offseason"
          description="There is no active player pool right now. Browse past rosters and careers, compare league players, or join an inhouse while the next season is organized."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link href="/seasons" className={buttonClasses("secondary", "sm")}>
                Season history
              </Link>
              <Link
                href="/players/compare"
                className={buttonClasses("secondary", "sm")}
              >
                Compare players
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

  const viewer = await getSessionUser();

  const [players, standins, teams, viewerReg, draft, ladder] =
    await Promise.all([
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
      prisma.draft.findUnique({
        where: { seasonId: season.id },
        select: { status: true },
      }),
      // Full-history inhouse ladder — memoised in-process (60s TTL), so this is
      // one indexed scan per cold minute, not per view.
      loadInhouseLadder(),
    ]);

  const directory = playerDirectoryPresentation(
    season.status,
    draft?.status,
  );
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
        teamLogoUrl: t.logoUrl,
        price: m.isCaptain ? null : m.price,
      };
    }
  }
  // During SIGNUPS this is where shared links land — offer a join affordance
  // unless the viewer already holds an ACTIVE registration (/me covers login).
  const canSignUp =
    season.status === "SIGNUPS" &&
    viewerReg?.status !== REGISTRATION_STATUS.ACTIVE &&
    viewerReg?.status !== REGISTRATION_STATUS.REMOVED;
  const signupRemoved =
    viewerReg?.status === REGISTRATION_STATUS.REMOVED;
  const viewerHasActiveRegistration =
    viewerReg?.status === REGISTRATION_STATUS.ACTIVE;
  const viewerCanViewLeagueDirectory = canViewLeagueDirectoryContact(
    viewer,
    viewerHasActiveRegistration,
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
    accountId: effectiveDotaAccountId(p.user),
    // Contact info is for league members, not the public internet.
    discordName: canViewLeagueContact(
      viewer,
      p.userId,
      viewerHasActiveRegistration,
    )
      ? p.user.discordName
      : "",
    discordVerified:
      canViewLeagueContact(
        viewer,
        p.userId,
        viewerHasActiveRegistration,
      ) && !!p.user.discordId,
  }));
  const captainHopefuls = players.filter((p) => p.wantsCaptain);
  const freeAgents = players.filter((p) => !draftedUserIds.has(p.userId));
  const avgMmr = averageMmr(players);

  // Scouting extras, one parallel record per pool player (the PoolDraftInfo
  // precedent — PoolPlayer stays frozen). Everything is data-presence gated:
  // an empty league ships an empty map and the pool renders as before.
  // eslint-disable-next-line react-hooks/purity -- async server component
  const nowMs = Date.now();
  const inhouseInfo = buildPoolInhouseInfo(
    ladder,
    players.map((p) => p.userId),
  );
  const scout: PoolScoutInfo = {};
  for (const p of players) {
    const entry: PoolScout = {};
    if (inhouseInfo[p.userId]) entry.inhouse = inhouseInfo[p.userId];
    const pub = poolPubRecord(p.user.pubStats);
    if (pub) entry.pub = pub;
    // The quote fallback only ships when it would render (payload trimming).
    if (!hasText(p.captainNote) && hasText(p.statement)) {
      entry.statement = p.statement;
    }
    if (entry.inhouse || entry.pub || entry.statement) scout[p.userId] = entry;
  }
  const inhouseActives = players.filter(
    (p) => scout[p.userId]?.inhouse,
  ).length;
  // "Active" = a visible pub game in the last 30 days — for an admin planning
  // a draft, the count of signups who actually still play Dota.
  const pubActive30 = players.filter((p) => {
    const last = scout[p.userId]?.pub?.lastPlayedAt;
    return last != null && last * 1000 > nowMs - 30 * 86_400_000;
  }).length;
  const anyPub = players.some((p) => scout[p.userId]?.pub);

  return (
    <div className="space-y-8">
      <PageTitle
        title="Players"
        subtitle={`${season.name} · every signup, standin and roster in one place`}
        action={
          <span className="flex flex-wrap items-center gap-3">
            {signupRemoved ? (
              <Link href="/me" className={buttonClasses("secondary", "sm")}>
                Signup removed — see details
              </Link>
            ) : canSignUp ? (
              <Link href="/me" className={buttonClasses("primary", "sm")}>
                Join the season →
              </Link>
            ) : null}
            <Link
              href="/players/compare"
              className={textLink("text-sm")}
            >
              Compare players →
            </Link>
          </span>
        }
      />

      {/* The shape of the pool in one line. Every figure here was already on
          the page, but only as something you could count by hand. */}
      {players.length > 0 || standins.length > 0 ? (
        <StatStrip>
          <StatCell label="Signed up" value={players.length} hint="players" />
          {avgMmr > 0 ? (
            <StatCell label="Average MMR" value={avgMmr} />
          ) : null}
          {inhouseActives > 0 ? (
            <StatCell
              label="Inhouse actives"
              value={inhouseActives}
              hint={`of ${players.length}`}
            />
          ) : null}
          {anyPub ? (
            <StatCell
              label="Active in pubs"
              value={pubActive30}
              tone={pubActive30 > 0 ? "default" : "muted"}
              hint="last 30 days"
            />
          ) : null}
          {directory.captainSelectionOpen ? (
            <StatCell
              label={directory.availabilityLabel}
              value={captainHopefuls.length}
              tone={captainHopefuls.length > 0 ? "accent" : "muted"}
            />
          ) : (
            <StatCell
              label={directory.availabilityLabel}
              value={freeAgents.length}
              tone={freeAgents.length > 0 ? "accent" : "muted"}
              hint={directory.availabilityHint}
            />
          )}
          <StatCell
            label="Standins"
            value={standins.length}
            tone={standins.length > 0 ? "default" : "muted"}
            hint="on call"
          />
          {teams.length > 0 ? (
            <StatCell label="Teams" value={teams.length} />
          ) : null}
        </StatStrip>
      ) : null}

      {/* The pool leads: this page is named Players, and post-draft "who is
          still available" is the question that brings a captain here. The
          rosters below are the reference copy — /teams is their real home. */}
      <section className="space-y-4">
        <SectionTitle aside={directory.poolAside}>
          {directory.poolTitle}
        </SectionTitle>
        {players.length === 0 ? (
          <EmptyState
            title="No players yet"
            description={directory.emptyDescription}
          />
        ) : (
          // Suspense: PlayerPool seeds its filters from useSearchParams, which
          // Next requires a boundary around.
          <Suspense
            fallback={<Skeleton className="h-96 w-full rounded-[var(--radius)]" />}
          >
            <PlayerPool
              players={poolPlayers}
              showDraftStatus={directory.showDraftStatus}
              draftInfo={draftInfo}
              scout={scout}
              now={nowMs}
              showContact={viewerCanViewLeagueDirectory}
            />
          </Suspense>
        )}
      </section>

      {directory.captainSelectionOpen && captainHopefuls.length > 0 ? (
        <section className="space-y-4">
          <SectionTitle
            aside={`· ${captainHopefuls.length} volunteered to lead a team`}
          >
            Captain hopefuls
          </SectionTitle>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {captainHopefuls.map((p) => {
              const accountId = effectiveDotaAccountId(p.user);
              const sc = scout[p.userId];
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
                        {/* Same scouting tokens as the pool rows — a captain
                            vote is exactly where the observed record matters. */}
                        {sc?.inhouse ? (
                          <span
                            className="tabular-nums"
                            title={inhouseTitle(sc.inhouse)}
                          >
                            {inhouseToken(sc.inhouse)}
                          </span>
                        ) : null}
                        {sc?.pub ? (
                          <span
                            className="tabular-nums"
                            title={pubTitle(sc.pub, nowMs)}
                          >
                            {pubToken(sc.pub)}
                          </span>
                        ) : null}
                        {sc?.pub && sc.pub.topHeroes.length > 0 ? (
                          <span
                            role="img"
                            aria-label={`Most played: ${sc.pub.topHeroes
                              .map(
                                (h) =>
                                  heroById(h.heroId)?.name ?? `Hero #${h.heroId}`,
                              )
                              .join(", ")}`}
                            className="flex items-center gap-1"
                          >
                            {sc.pub.topHeroes.map((h) => {
                              const hero = heroById(h.heroId);
                              // title on the ICON — the innermost title wins.
                              return hero ? (
                                <span key={h.heroId} aria-hidden>
                                  <HeroIcon
                                    hero={hero}
                                    size={18}
                                    title={pubHeroTitle(h)}
                                  />
                                </span>
                              ) : null;
                            })}
                          </span>
                        ) : null}
                        {accountId ? (
                          <a
                            href={`https://www.dotabuff.com/players/${accountId}`}
                            target="_blank"
                            rel="noreferrer"
                            className={textLink()}
                          >
                            Dotabuff ↗
                          </a>
                        ) : null}
                      </div>
                      {hasText(p.captainNote) ? (
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

      {teams.length > 0 ? (
        <section className="space-y-4">
          <div className="flex items-baseline justify-between gap-3">
            <SectionTitle aside={`· ${teams.length} teams`}>Rosters</SectionTitle>
            <Link
              href="/teams"
              className={textLink("shrink-0 text-sm")}
            >
              Full team pages →
            </Link>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {teams.map((t) => (
              <Card key={t.id} interactive className="flex flex-col">
                <CardHeader
                  className="px-4 py-3"
                  title={
                    <Link
                      href={`/teams/${t.id}`}
                      className="flex min-w-0 items-center gap-2 text-base hover:text-info"
                    >
                      <TeamCrest
                        name={t.name}
                        seed={t.id}
                        logoUrl={t.logoUrl}
                        size={22}
                        className="rounded-md"
                      />
                      <span className="truncate">{t.name}</span>
                    </Link>
                  }
                  subtitle={`${t.members.length}/${season.teamSize} players`}
                  action={
                    season.status === "DRAFT" ? (
                      <Badge tone="accent">${t.budget} left</Badge>
                    ) : null
                  }
                />
                <CardBody className="space-y-1 px-4 py-3">
                  {t.members.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Avatar name={m.user.name} src={m.user.avatar} size={22} />
                      <PlayerLink
                        userId={m.userId}
                        className="min-w-0 flex-1 truncate"
                      >
                        {m.user.name}
                      </PlayerLink>
                      {m.isCaptain ? (
                        <Badge tone="accent" title="Captain">
                          C
                        </Badge>
                      ) : null}
                      <RankBadge rankTier={m.user.rankTier} />
                      <span className="w-8 shrink-0 text-right tabular-nums text-muted">
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
        <SectionTitle
          aside={
            standins.length > 0
              ? `· ${standins.length} on call for match night`
              : undefined
          }
        >
          Standins
        </SectionTitle>
        {standins.length === 0 ? (
          // Compact: this section is empty for most of a season and is not
          // what anyone came for — a full 240px dashed box below a populated
          // pool made the page look like it had failed to load.
          <EmptyState
            compact
            title="No standins yet"
            description="Standins fill in when a rostered player can't make a match."
          />
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {standins.map((s) => (
              <PlayerLink
                key={s.id}
                userId={s.userId}
                className="flex min-w-0 items-center gap-2.5 rounded-lg border border-line bg-surface/80 px-3 py-2 hover:border-muted/60 hover:no-underline"
              >
                <Avatar name={s.user.name} src={s.user.avatar} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {s.user.name}
                  </span>
                  {/* Standins are the people a captain has to find at 7pm on a
                      match night — they get the same roles/MMR legibility as
                      the pool, not a bare name in a pill. Contact rides along
                      for active league participants, the subject, and admins:
                      the whole point of this list is "who can I actually
                      reach tonight", and it made captains open profiles one by one.
                      Plain text, not the copy-chip — the card is one link and
                      a button inside a link is a tap-target trap. */}
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                    <RoleBadges roles={s.roles} />
                    {canViewLeagueContact(
                      viewer,
                      s.userId,
                      viewerHasActiveRegistration,
                    ) ? (
                      s.user.discordName || s.user.discordId ? (
                        <span className="truncate text-xs text-muted">
                          {s.user.discordName
                            ? `@${s.user.discordName}`
                            : "Discord linked"}
                          {s.user.discordId ? " ✓" : ""}
                        </span>
                      ) : (
                        <span className="text-xs text-muted">
                          no Discord
                        </span>
                      )
                    ) : null}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <RankBadge rankTier={s.user.rankTier} />
                  <span className="text-sm tabular-nums text-muted">
                    {s.mmr > 0 ? s.mmr : "—"}
                  </span>
                </span>
              </PlayerLink>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
