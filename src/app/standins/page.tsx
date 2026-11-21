import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "@/components/app-link";
import { getSessionUser, type SessionUser } from "@/lib/auth";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { prisma } from "@/lib/prisma";
import { singleSearchParam } from "@/lib/search-params";
import { getActiveSeason } from "@/lib/season";
import { getCaptainTeam } from "@/lib/captains-service";
import { shareMetadata } from "@/lib/share-metadata";
import {
  orderStandinBoard,
  standinNeedLabel,
  standinOfferCountLabel,
  standinOfferOutcomeLine,
  standinOfferPath,
  standinSeatLine,
  type StandinOfferStanding,
} from "@/lib/standin-offer";
import {
  loadStandinBoard,
  loadStandinNeed,
  loadStandinOfferViewer,
  standingOn,
  type StandinBoardNeed,
} from "@/lib/standin-offer-service";
import {
  offerToStandInAction,
  withdrawStandinOfferAction,
} from "@/app/actions/standin-offers";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import {
  CopyStandinLink,
  RegisterForStandinGame,
  ScrollToStandinGame,
} from "@/components/standin-offer-link";
import { SteamSignInButton, SteamSignInNote } from "@/components/steam-sign-in";
import {
  Badge,
  buttonClasses,
  Card,
  CardBody,
  EmptyState,
  CardSkeleton,
  PageTitle,
  textLink,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { StandinAcceptCard } from "./accept-card";
import { coverCardId } from "./cover-card";
import { MyStandinGames } from "./my-games";
import { TeamCover } from "./team-cover";

const DESCRIPTION =
  "Games that need a standin this week. Say you can play, and that team's captain picks from everyone who did.";

/**
 * The Standins page is the one place standins are coordinated (Tim,
 * 2026-11-17): a captain lines up their team's cover here (`TeamCover`), a
 * standin sees and answers for their own games here (`MyStandinGames`), and
 * everyone sees the games that need someone and says "I can play". Every
 * other page and every standin post on Discord links here
 * (`standinHubPath`, `standinOfferPath`).
 */

type StandinsSearch = {
  match?: string | string[];
  team?: string | string[];
};

/** The game a shared link names, when its address is well-formed. */
function linkedGame(params: StandinsSearch) {
  const matchId = singleSearchParam(params.match);
  const teamId = singleSearchParam(params.team);
  return typeof matchId === "string" && typeof teamId === "string"
    ? { matchId, teamId }
    : null;
}

/** The match a link opened (`standinHubPath`, or a share link's). */
function focusedMatch(params: StandinsSearch): string | null {
  const matchId = singleSearchParam(params.match);
  return typeof matchId === "string" && matchId ? matchId : null;
}

/**
 * A shared link unfurls as its game: which team needs someone, against whom
 * and when (the league's clock, zone named). Only team names and the kickoff,
 * which /schedule already shows everyone: never who is out.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<StandinsSearch>;
}): Promise<Metadata> {
  const linked = linkedGame(await searchParams);
  if (linked) {
    const match = await prisma.match.findUnique({
      where: { id: linked.matchId },
      select: {
        scheduledAt: true,
        homeTeamId: true,
        awayTeamId: true,
        homeTeam: { select: { name: true } },
        awayTeam: { select: { name: true } },
        season: { select: { isActive: true } },
      },
    });
    const home = match?.homeTeamId === linked.teamId;
    if (
      match?.season.isActive &&
      (home || match.awayTeamId === linked.teamId)
    ) {
      const team = home ? match.homeTeam.name : match.awayTeam.name;
      const opponent = home ? match.awayTeam.name : match.homeTeam.name;
      const when = match.scheduledAt
        ? ` · ${formatLeagueMatchTime(match.scheduledAt, "full")}`
        : "";
      return {
        ...shareMetadata(
          `${team} needs a standin`,
          `${team} vs ${opponent}${when}. Open this and tap Accept to say you can play; their captain picks from everyone who does.`,
          "/standins",
        ),
        title: "Standins",
      };
    }
  }
  return shareMetadata("Standins", DESCRIPTION, "/standins");
}

export default async function StandinsPage({
  searchParams,
}: {
  searchParams: Promise<StandinsSearch>;
}) {
  const params = await searchParams;
  const linked = linkedGame(params);
  const focus = focusedMatch(params);
  const [viewer, season] = await Promise.all([
    getSessionUser(),
    getActiveSeason(),
  ]);
  // Async server component: Date.now is request-time state, not render replay.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const [needs, offerViewer, captainTeam] = await Promise.all([
    season ? loadStandinBoard(season, nowMs) : Promise.resolve([]),
    season && viewer
      ? loadStandinOfferViewer(season.id, viewer.id)
      : Promise.resolve(null),
    season && viewer
      ? getCaptainTeam(season.id, viewer.id)
      : Promise.resolve(null),
  ]);
  // A withdrawn team has no fixtures left to cover.
  const myTeam = captainTeam && !captainTeam.withdrawn ? captainTeam : null;
  // A standin's own games: any ACTIVE unrostered signup can be booked.
  const standinViewer =
    !!offerViewer && offerViewer.activeSignup && !offerViewer.rostered;

  const isLinked = (n: StandinBoardNeed) =>
    !!linked && n.matchId === linked.matchId && n.teamId === linked.teamId;
  // A shared link opens its game's accept card (Tim, 2026-11-21) for anyone
  // who could stand in: never a rostered viewer (that side's captain lands on
  // their team's cover, a teammate on the game marked as theirs).
  const acceptAudience = !!linked && !myTeam && !offerViewer?.rostered;
  // The board lists the coming week; a link may name a later game, which the
  // offer write takes just the same. A kickoff still to come only.
  const linkedNeed =
    needs.find(isLinked) ??
    (season && linked && acceptAudience
      ? await loadStandinNeed(season, linked.matchId, linked.teamId).then(
          (need) =>
            need?.scheduledAt && need.scheduledAt.getTime() > nowMs ? need : null,
        )
      : null);
  const acceptNeed = acceptAudience ? linkedNeed : null;
  // A captain's own sides are in their team's section above, never twice.
  const others = needs.filter((n) => n.teamId !== myTeam?.id);
  // A player's own team (Tim, 2026-11-20): any of its players may share its
  // game's link, as the captain can. Never the captain's: theirs is above.
  const ownTeamId = myTeam ? null : (offerViewer?.rosterTeamId ?? null);
  // Their own team's games lead, then the game the link names; the rest stay
  // soonest first. The accept card's game is on the card, never twice: one
  // Accept button.
  const ordered = orderStandinBoard(others, { ownTeamId, linked }).filter(
    (n) => !acceptNeed || !isLinked(n),
  );
  const yourTeamsGame =
    !!linked && !!myTeam && linked.teamId === myTeam.id;
  const sectionsAbove = !!myTeam || standinViewer || !!acceptNeed;

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle
        title="Standins"
        subtitle={
          myTeam
            ? "Line up your team's cover, and see every game that needs a player. Standins say they can play; each team's captain picks."
            : "Games that need a player. Say you can play, and that team's captain picks from everyone who did."
        }
      />
      {focus && !acceptNeed ? (
        // The accept card is first on the page: nothing to scroll to.
        <ScrollToStandinGame
          ids={[coverCardId(focus), ...needs
            .filter((n) => n.matchId === focus)
            .map((n) => `need-${n.matchId}-${n.teamId}`)]}
        />
      ) : null}
      <div className="space-y-6">
        {acceptNeed ? (
          <StandinAcceptCard
            need={acceptNeed}
            standing={standingOn(acceptNeed, offerViewer)}
            viewerMmr={offerViewer?.mmr ?? 0}
            signup={
              <SignupStep
                viewer={viewer}
                next={standinOfferPath(acceptNeed.matchId, acceptNeed.teamId)}
                game={{ matchId: acceptNeed.matchId, teamId: acceptNeed.teamId }}
                signInLabel="Sign in with Steam to accept"
              />
            }
          />
        ) : null}
        {season && viewer && myTeam ? (
          <Suspense fallback={<CardSkeleton rows={4} />}>
            <TeamCover
              season={season}
              team={myTeam}
              viewer={viewer}
              focusMatchId={focus}
            />
          </Suspense>
        ) : null}
        {season && viewer && standinViewer ? (
          <Suspense fallback={<CardSkeleton rows={2} />}>
            <MyStandinGames season={season} viewer={viewer} nowMs={nowMs} />
          </Suspense>
        ) : null}
        <section aria-labelledby={sectionsAbove ? "board-title" : undefined} className="space-y-4">
        {sectionsAbove ? (
          <h2 id="board-title" className="font-display text-xl font-semibold">
            {myTeam || acceptNeed
              ? "Other games that need a standin"
              : "Games that need a standin"}
          </h2>
        ) : null}
        {linked && !linkedNeed && !yourTeamsGame ? (
          <p className="rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-sm text-muted">
            That game has its standin now, or isn&apos;t coming up any more.
            {needs.length > 0 ? " These games still need someone:" : ""}
          </p>
        ) : null}
        {ordered.length === 0 ? (
          myTeam || acceptNeed ? (
            <p className="text-sm text-muted">
              No other team needs a standin right now.
            </p>
          ) : (
            <EmptyState
              title="No game needs a standin right now"
              description="A game shows here as soon as a player says they can't make it, or a team is a player short. Captains are told when you say you can play."
              action={
                viewer && offerViewer?.activeSignup ? undefined : (
                  <SignupStep viewer={viewer} next="/standins" />
                )
              }
            />
          )
        ) : (
          <ul className="space-y-3">
            {ordered.map((need, index) => (
              <li key={`${need.matchId}:${need.teamId}`}>
                <NeedCard
                  need={need}
                  standing={standingOn(need, offerViewer)}
                  viewer={viewer}
                  ownTeam={ownTeamId !== null && need.teamId === ownTeamId}
                  highlighted={isLinked(need)}
                  first={index === 0 && !acceptNeed}
                />
              </li>
            ))}
          </ul>
        )}
        </section>
        <p className="text-sm text-muted">
          A standin plays one match for a team that is a player down. Your own
          captain always picks; up to 100 MMR above the seat that pick is
          final, and higher also needs the other captain&apos;s OK.{" "}
          <Link href="/rules#rosters" className={textLink("whitespace-nowrap")}>
            Standin rules
          </Link>
          {" · "}
          <Link
            href="/players?status=standin"
            className={textLink("whitespace-nowrap")}
          >
            The standin pool
          </Link>
          {viewer?.role === "ADMIN" ? (
            <>
              {" · "}
              <Link href="/admin" className={textLink("whitespace-nowrap")}>
                Admins: book any team&apos;s cover on /admin
              </Link>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/** What a visitor who can't offer yet does first: sign in, or register. */
function SignupStep({
  viewer,
  next,
  game,
  steamNote = true,
  signInLabel = "Sign in with Steam to play",
}: {
  viewer: SessionUser | null;
  /**
   * Where sign-in comes back to: the game's own link, so it ends on the
   * game's accept card.
   */
  next: string;
  /** The game the signup should also put them on the list for. */
  game?: { matchId: string; teamId: string };
  /**
   * What signing in with Steam shares, under the button. Off for every game
   * but the first: one page, one notice, not one per button.
   */
  steamNote?: boolean;
  /** The sign-in button's words. */
  signInLabel?: string;
}) {
  if (!viewer) {
    return (
      <div className="flex max-w-sm flex-col gap-2">
        <SteamSignInButton next={next} size="md" className="self-start">
          {signInLabel}
        </SteamSignInButton>
        {steamNote ? <SteamSignInNote /> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {game ? (
        <RegisterForStandinGame {...game} className="self-start" />
      ) : (
        <Link
          href="/me#profile-signup"
          className={buttonClasses("accent", "md", "self-start")}
        >
          Register as a standin
        </Link>
      )}
      <p className="text-xs text-muted">
        {game
          ? "One short signup on your account page. Saving it also puts you on this game's list."
          : "One short signup on your account page. Then say you can play for any game here."}
      </p>
    </div>
  );
}

function NeedCard({
  need,
  standing,
  viewer,
  ownTeam,
  highlighted,
  first,
}: {
  need: StandinBoardNeed;
  standing: StandinOfferStanding;
  viewer: SessionUser | null;
  /**
   * The viewer plays for this side (not as its captain). They can't stand
   * in for it, but sharing its link is how they help fill the seat.
   */
  ownTeam: boolean;
  /** The game a shared link opened. */
  highlighted: boolean;
  /** The first game listed: it carries the page's one Steam notice. */
  first: boolean;
}) {
  const hidden = { matchId: need.matchId, teamId: need.teamId };
  // A captain's own sides are in their team's section, never here.
  const offers = standinOfferCountLabel(need.offerCount);
  return (
    <Card
      tone={highlighted ? "feature" : "default"}
      className="overflow-hidden"
      id={`need-${need.matchId}-${need.teamId}`}
    >
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Badge tone="info">{need.roundLabel}</Badge>
          {ownTeam ? <Badge tone="accent">Your team</Badge> : null}
          <span className="text-muted">
            {need.scheduledAt ? (
              <LocalTime
                ts={need.scheduledAt.getTime()}
                variant="full"
                initial={formatLeagueMatchTime(need.scheduledAt, "full")}
              />
            ) : (
              "Time to be set"
            )}
          </span>
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold [overflow-wrap:anywhere]">
            {need.teamName} {standinNeedLabel(need.seats)}
          </h2>
          <p className="text-sm text-muted [overflow-wrap:anywhere]">
            vs {need.opponentName}
            {" · "}
            <Link
              href={`/matches/${need.matchId}`}
              className={textLink("whitespace-nowrap")}
            >
              Match page
            </Link>
          </p>
        </div>
        <p className="text-sm text-muted">
          {standinSeatLine(need.baselineMmr)}
          {offers ? (
            <>
              {" "}
              <strong className="font-medium text-fg">{offers}.</strong>
            </>
          ) : null}
        </p>
        {ownTeam ? (
          // Their own side: the link, where a standin would see "I can play".
          <div className="space-y-2">
            <p className="text-sm">
              Share this game in Discord: a standin who opens the link can
              accept it in one tap, and your captain picks.
            </p>
            <CopyStandinLink
              matchId={need.matchId}
              teamId={need.teamId}
              variant="secondary"
            />
          </div>
        ) : standing.kind === "open" ? (
          <div className="space-y-2">
            <p className="text-sm">
              {standinOfferOutcomeLine(standing.outcome, need.opponentName)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <ActionForm action={offerToStandInAction} hidden={hidden}>
                <SubmitButton variant="accent" size="sm">
                  I can play
                </SubmitButton>
              </ActionForm>
              <CopyStandinLink matchId={need.matchId} teamId={need.teamId} />
            </div>
          </div>
        ) : standing.kind === "offered" ? (
          <div className="space-y-2">
            <p
              className={cn(
                "rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm",
              )}
            >
              <span aria-hidden>✓ </span>
              You&apos;re on the list.{" "}
              {standinOfferOutcomeLine(
                standing.outcome,
                need.opponentName,
                true,
              )}{" "}
              You&apos;re pinged on Discord if it&apos;s you.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <ActionForm action={withdrawStandinOfferAction} hidden={hidden}>
                <SubmitButton variant="ghost" size="sm">
                  Take me off the list
                </SubmitButton>
              </ActionForm>
              <CopyStandinLink matchId={need.matchId} teamId={need.teamId} />
            </div>
          </div>
        ) : standing.kind === "blocked" ? (
          <p className="text-sm text-muted">{standing.reason}</p>
        ) : (
          <SignupStep
            viewer={viewer}
            next={standinOfferPath(need.matchId, need.teamId)}
            game={{ matchId: need.matchId, teamId: need.teamId }}
            steamNote={first}
          />
        )}
      </CardBody>
    </Card>
  );
}
