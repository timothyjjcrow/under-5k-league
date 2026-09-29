import { seasonPageMetadata } from "@/lib/link-preview-metadata";
import { SteamJoin } from "@/components/steam-sign-in";
import Link from "next/link";
import { Suspense } from "react";
import { hasText } from "@/lib/utils";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { getPublicLeagueContent } from "@/lib/public-navigation";
import { prisma } from "@/lib/prisma";
import { effectiveDotaAccountId } from "@/lib/dota-account";
import { PlayerPool, type PoolDraftInfo } from "@/components/player-pool";
import { averageMmr } from "@/lib/pool-stats";
import { loadInhouseLadder } from "@/lib/inhouse-ladder";
import { loadPoolLastSeasons } from "@/lib/pool-history";
import {
  buildPoolInhouseInfo,
  type PoolScout,
  type PoolScoutInfo,
} from "@/lib/player-pool";
import { poolPubRecord } from "@/lib/pub-stats";
import { REGISTRATION_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  playerDirectoryPresentation,
  poolDetailsByDefault,
} from "@/lib/player-directory-lifecycle";
import {
  canViewLeagueContact,
  canViewLeagueDirectoryContact,
} from "@/lib/visibility";
import {
  EmptyState,
  LinkArrow,
  PageTitle,
  SectionTitle,
  Skeleton,
  StatCell,
  StatStrip,
  buttonClasses,
  textLink,
} from "@/components/ui";

// The link preview names the page and the season.
export function generateMetadata() {
  return seasonPageMetadata("players");
}

export default async function PlayersPage() {
  // Compare players fills from imported games; before the league's first one
  // it would only open onto "No player careers yet".
  const [season, { hasGames }] = await Promise.all([
    getActiveSeason(),
    getPublicLeagueContent(null),
  ]);
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
              {hasGames ? (
                <Link
                  href="/players/compare"
                  className={buttonClasses("secondary", "sm")}
                >
                  Compare players
                </Link>
              ) : null}
              <Link href="/inhouse" className={buttonClasses("accent", "sm")}>
                Play an inhouse <LinkArrow />
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
        select: {
          id: true,
          name: true,
          logoUrl: true,
          captain: { select: { name: true } },
          members: { select: { userId: true, price: true, isCaptain: true } },
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
    standins.length > 0,
  );
  // After the final nobody is "on call" any more.
  const seasonOver = season.status === SEASON_STATUS.COMPLETE;
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
        captain: m.isCaptain,
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
  // Standins share the pool table (one list, so search, roles, sort and the
  // scouting line work for everyone); the parallel id list marks them.
  const poolRegistrations = [...players, ...standins];
  const poolPlayers = poolRegistrations.map((p) => ({
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
  const poolUserIds = poolRegistrations.map((p) => p.userId);
  const inhouseInfo = buildPoolInhouseInfo(ladder, poolUserIds);
  // Returning players' last league season (team, series record, price,
  // title). One small query and nothing else until an earlier season exists.
  const lastSeasons = await loadPoolLastSeasons(season, poolUserIds);
  const scout: PoolScoutInfo = {};
  for (const p of poolRegistrations) {
    const entry: PoolScout = {};
    if (lastSeasons[p.userId]) entry.lastSeason = lastSeasons[p.userId];
    if (inhouseInfo[p.userId]) entry.inhouse = inhouseInfo[p.userId];
    const pub = poolPubRecord(p.user.pubStats, p.user.pubStatsAt);
    if (pub) entry.pub = pub;
    // An older signup's goals ride along only when they add something to
    // the captain note the row already carries (payload trimming); the row
    // shows the two joined (about-you.ts).
    if (
      hasText(p.statement) &&
      p.statement.trim() !== p.captainNote.trim()
    ) {
      entry.statement = p.statement;
    }
    if (entry.lastSeason || entry.inhouse || entry.pub || entry.statement) {
      scout[p.userId] = entry;
    }
  }

  return (
    <div className="space-y-5">
      <PageTitle
        title="Players"
        subtitle={`${season.name} · every signup and standin in one place`}
        action={
          <span className="flex flex-wrap items-center gap-3">
            {signupRemoved ? (
              <Link href="/me" className={buttonClasses("secondary", "sm")}>
                Signup removed — see details
              </Link>
            ) : canSignUp && !viewer ? (
              // Straight to Steam, then back to the signup form.
              <SteamJoin next="/me" size="sm">
                Sign in with Steam to join
              </SteamJoin>
            ) : canSignUp ? (
              <Link href="/me" className={buttonClasses("primary", "sm")}>
                Join the season <LinkArrow />
              </Link>
            ) : null}
            {hasGames ? (
              <Link
                href="/players/compare"
                className={textLink("text-sm")}
              >
                Compare players <LinkArrow />
              </Link>
            ) : null}
          </span>
        }
      />

      {/* The shape of the pool in one line: only the figures a visitor or a
          captain acts on, so the list itself starts on the first phone
          screen. Rosters live on /teams (linked under the pool), and the
          scouting detail rides on each row. */}
      {players.length > 0 || standins.length > 0 ? (
        <StatStrip>
          <StatCell label="Signed up" value={players.length} hint="players" />
          {avgMmr > 0 ? (
            <StatCell label="Average MMR" value={avgMmr} />
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
            hint={seasonOver ? undefined : "on call"}
          />
        </StatStrip>
      ) : null}

      {/* The pool is the page: this page is named Players, and post-draft
          "who is still available" is the question that brings a captain
          here. Rosters are /teams' job — each row already chips its team. */}
      <section className="space-y-3">
        <SectionTitle aside={directory.poolAside}>
          {directory.poolTitle}
        </SectionTitle>
        {poolRegistrations.length === 0 ? (
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
              standinIds={standins.map((s) => s.userId)}
              showDraftStatus={directory.showDraftStatus}
              captainSelectionOpen={directory.captainSelectionOpen}
              draftInfo={draftInfo}
              scout={scout}
              now={nowMs}
              showContact={viewerCanViewLeagueDirectory}
              detailsByDefault={poolDetailsByDefault(directory.stage)}
            />
          </Suspense>
        )}
      </section>

      {/* One line instead of a second copy of every roster. During captain
          selection it names who has been picked so far (they also wear the
          Captain badge in the pool). */}
      {teams.length > 0 ? (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted">
          {directory.captainSelectionOpen ? (
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {teams.length === 1 ? "Captain so far: " : "Captains so far: "}
              <span className="text-fg">
                {teams.map((t) => t.captain.name).join(", ")}
              </span>
            </span>
          ) : null}
          <Link href="/teams" className={textLink()}>
            See team rosters →
          </Link>
        </p>
      ) : null}
    </div>
  );
}
