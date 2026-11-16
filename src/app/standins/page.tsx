import type { Metadata } from "next";
import Link from "@/components/app-link";
import { getSessionUser, type SessionUser } from "@/lib/auth";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { MATCH_ANCHOR, matchAnchorPath } from "@/lib/match-anchors";
import { prisma } from "@/lib/prisma";
import { singleSearchParam } from "@/lib/search-params";
import { getActiveSeason } from "@/lib/season";
import { shareMetadata } from "@/lib/share-metadata";
import {
  standinArrivalAction,
  standinNeedLabel,
  standinOfferCountLabel,
  standinOfferOutcomeLine,
  standinOfferPath,
  standinSeatLine,
  type StandinOfferStanding,
} from "@/lib/standin-offer";
import {
  loadStandinBoard,
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
  StandinOfferOnArrival,
} from "@/components/standin-offer-link";
import { SteamSignInButton, SteamSignInNote } from "@/components/steam-sign-in";
import {
  Badge,
  buttonClasses,
  Card,
  CardBody,
  EmptyState,
  LinkArrow,
  PageTitle,
  textLink,
} from "@/components/ui";
import { cn } from "@/lib/utils";

const DESCRIPTION =
  "Games that need a standin this week. Say you can play, and that team's captain picks from everyone who did.";

type StandinsSearch = {
  match?: string | string[];
  team?: string | string[];
  play?: string | string[];
};

/** The game a shared link names, when its address is well-formed. */
function linkedGame(params: StandinsSearch) {
  const matchId = singleSearchParam(params.match);
  const teamId = singleSearchParam(params.team);
  return typeof matchId === "string" && typeof teamId === "string"
    ? { matchId, teamId }
    : null;
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
          `${team} vs ${opponent}${when}. Open this to say you can play; their captain picks from everyone who does.`,
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
  const play = singleSearchParam(params.play) === "1";
  const [viewer, season] = await Promise.all([
    getSessionUser(),
    getActiveSeason(),
  ]);
  // Async server component: Date.now is request-time state, not render replay.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const [needs, offerViewer] = await Promise.all([
    season ? loadStandinBoard(season, nowMs) : Promise.resolve([]),
    season && viewer
      ? loadStandinOfferViewer(season.id, viewer.id)
      : Promise.resolve(null),
  ]);

  const isLinked = (n: StandinBoardNeed) =>
    !!linked && n.matchId === linked.matchId && n.teamId === linked.teamId;
  const linkedNeed = needs.find(isLinked) ?? null;
  // The game the link names leads the list; the rest stay soonest first.
  const ordered = linkedNeed
    ? [linkedNeed, ...needs.filter((n) => n !== linkedNeed)]
    : needs;
  const arrivalStanding = linkedNeed ? standingOn(linkedNeed, offerViewer) : null;
  const arrival = standinArrivalAction(play, arrivalStanding);

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle
        title="Standins"
        subtitle="Games that need a player. Say you can play, and that team's captain picks from everyone who did."
      />
      {linked && linkedNeed ? (
        <StandinOfferOnArrival
          matchId={linked.matchId}
          teamId={linked.teamId}
          action={arrival}
          blockedReason={
            arrivalStanding?.kind === "blocked"
              ? arrivalStanding.reason
              : undefined
          }
        />
      ) : null}
      <div className="space-y-4">
        {linked && !linkedNeed ? (
          <p className="rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-sm text-muted">
            That game has its standin now, or isn&apos;t coming up any more.
            {needs.length > 0 ? " These games still need someone:" : ""}
          </p>
        ) : null}
        {ordered.length === 0 ? (
          <EmptyState
            title="No game needs a standin right now"
            description="A game shows here as soon as a player says they can't make it, or a team is a player short. Captains are told when you say you can play."
            action={
              viewer && offerViewer?.activeSignup ? undefined : (
                <SignupStep viewer={viewer} next="/standins" />
              )
            }
          />
        ) : (
          <ul className="space-y-3">
            {ordered.map((need, index) => (
              <li key={`${need.matchId}:${need.teamId}`}>
                <NeedCard
                  need={need}
                  standing={standingOn(need, offerViewer)}
                  viewer={viewer}
                  highlighted={isLinked(need)}
                  first={index === 0}
                />
              </li>
            ))}
          </ul>
        )}
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
}: {
  viewer: SessionUser | null;
  /** Where sign-in comes back to: the game's own link, so it ends on the list. */
  next: string;
  /** The game the signup should also put them on the list for. */
  game?: { matchId: string; teamId: string };
  /**
   * What signing in with Steam shares, under the button. Off for every game
   * but the first: one page, one notice, not one per button.
   */
  steamNote?: boolean;
}) {
  if (!viewer) {
    return (
      <div className="flex max-w-sm flex-col gap-2">
        <SteamSignInButton next={next} size="md" className="self-start">
          Sign in with Steam to play
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
  highlighted,
  first,
}: {
  need: StandinBoardNeed;
  standing: StandinOfferStanding;
  viewer: SessionUser | null;
  /** The game a shared link opened. */
  highlighted: boolean;
  /** The first game listed: it carries the page's one Steam notice. */
  first: boolean;
}) {
  const hidden = { matchId: need.matchId, teamId: need.teamId };
  const offers = standinOfferCountLabel(need.offerCount);
  const isCaptain = viewer?.id === need.captainId;
  return (
    <Card
      tone={highlighted ? "feature" : "default"}
      className="overflow-hidden"
      id={`need-${need.matchId}-${need.teamId}`}
    >
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Badge tone="info">{need.roundLabel}</Badge>
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
        {isCaptain ? (
          // The side's own captain: this is their list to pick from.
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={matchAnchorPath(need.matchId, MATCH_ANCHOR.standins)}
              className={buttonClasses("accent", "sm")}
            >
              {need.offerCount > 0 ? "Pick your standin" : "Find a standin"}
              <LinkArrow />
            </Link>
            <CopyStandinLink matchId={need.matchId} teamId={need.teamId} />
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
